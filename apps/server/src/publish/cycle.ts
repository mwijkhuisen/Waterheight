import {
  BUCKET_MS,
  CANARIES,
  DAY_MS,
  dayOf,
  dayStartMs,
  FramesFile,
  floorBucket,
  framesPath,
  isSettled,
  LatestFile,
  recentPath,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
  StationRecent,
  settledPath,
  WarningsFile,
} from '@rws/contracts';
import {
  OwnerLatestFile,
  OwnerSnapshotFile,
  OwnerStaticForecastLatest,
  OwnerStaticMeta,
  OwnerStaticSources,
  OwnerStaticStations,
  OwnerStationRecent,
  OwnerWarningsFile,
  StaticSources,
} from '@rws/contracts/static-owner';
import { OwnerStatusFile, StatusFile } from '@rws/contracts/status';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import { loaderRow } from '../api/health.ts';
import type { StaticCache } from '../api/states.ts';
import { coded, validated } from '../api/util.ts';
import type { DisplayWindow, Window } from '../api/window.ts';
import { type ChannelAudience, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import type { BumpReason } from '../load/dirty.ts';
import {
  type Complete,
  type DirtyRow,
  dirtyBuckets,
  metaDayVersions,
  nextSettled,
  ownerDayVersions,
  prunePlan,
  recentBuckets,
  settledDays,
  unsettledStart,
  type Version,
  versionOf,
} from './plan.ts';
import { type AttributionRow, attributionRows } from './render/attribution.ts';
import type { Output } from './write.ts';

// P9a: one publisher loop per family (A§9.1), at most once a minute. It only reads (invariant 2): the family's views
// through VIEWS[family], its dirty rows after an in-memory cursor and its day versions. A cycle renders the hot set
// (stations hourly, latest, forecast, warnings, sources), the recent buckets the dirty rows reach (newest first,
// within a time budget; the rest waits in memory), the dirty stations' files, the recent frames, at most one settled
// day (public), prunes, and writes status.json and then meta.json last. Every body is validated against the family's
// contract and a public body is refused when it holds a canary rendering, before anything is written.

/** What a renderer gets: the family's read-only connection, the cycle's clock and the boot-time tables. */
export type RenderCtx = {
  db: Kysely<DB>;
  family: ChannelAudience;
  /** The cycle's clock (ms); a renderer never reads its own. */
  now: number;
  window: Window;
  build: string;
  sections: ReadonlyMap<string, string>;
  cache: StaticCache;
  /** status.json's read-only input directory: public the root-checked ops copy (/srv/ops), owner capture's (/srv/capture). */
  inputs: string | undefined;
  /** The family's attribution rows, read once a cycle (render/attribution.ts `attributionFor`). */
  attribution: readonly AttributionRow[];
  /** Fixed codes only: a renderer that degrades a part to null says why here. */
  log?: Pick<Logger, 'error'>;
};

export type DayRender = { day: string; version: number; seconds: number; at: string };
export type PublisherStatus = {
  cycleAt: string;
  /** The previous cycle's duration (0 before the first ended). */
  cycleSeconds: number;
  lastDayRender: DayRender | null;
  /** Settled days whose current version is not complete (public; 0 for the owner family). */
  pendingDays: number;
  /** Bytes under settled/ and frames/ (plain files and their siblings). */
  settledBytes: number;
};
export type MetaInput = { dayVersions: Record<string, number>; degraded: boolean; latestFrom: string | null };

/**
 * The renderers (render/*.ts): each reads and returns one body; the cycle validates and writes it. Recent and settled
 * buckets use readStates with `current: false`, latest.json `current: true` (§9 C3). Bodies other than latest.json
 * leave out a series without history_export (`historyExcluded`, §9 C5).
 */
export type Renderers = {
  stations(c: RenderCtx): Promise<unknown>;
  /** latest.json at floorBucket(now) in stations.json's series order, and the newest loaded_at its read saw. */
  latest(c: RenderCtx, stations: StaticStations): Promise<{ body: unknown; latestFrom: string | null }>;
  /** A recent or settled bucket file at `t`. */
  snapshot(c: RenderCtx, t: number): Promise<unknown>;
  /** Hourly frames over [from, to). */
  frames(c: RenderCtx, from: number, to: number): Promise<unknown>;
  forecast(c: RenderCtx): Promise<unknown>;
  /** warnings/latest.geojson (day null) or an ended day's warnings/YYYY-MM-DD.json. */
  warnings(c: RenderCtx, day: string | null): Promise<unknown>;
  sources(c: RenderCtx): Promise<unknown>;
  /** series/{station}/recent.json. */
  station(c: RenderCtx, id: string): Promise<unknown>;
  status(c: RenderCtx, p: PublisherStatus): Promise<unknown>;
  meta(c: RenderCtx, m: MetaInput): Promise<unknown>;
};

type Kind = 'meta' | 'latest' | 'snapshot' | 'frames' | 'stations' | 'sources' | 'forecast' | 'station' | 'warnings';
/** The contract of every file per family. The owner family writes no frames: its schema refuses everything. */
const CONTRACTS: Record<ChannelAudience, Record<Kind | 'status', z.ZodType>> = {
  public: {
    meta: StaticMeta,
    latest: LatestFile,
    snapshot: SnapshotFile,
    frames: FramesFile,
    stations: StaticStations,
    sources: StaticSources,
    forecast: StaticForecastLatest,
    station: StationRecent,
    warnings: WarningsFile,
    status: StatusFile,
  },
  owner: {
    meta: OwnerStaticMeta,
    latest: OwnerLatestFile,
    snapshot: OwnerSnapshotFile,
    frames: z.never(),
    stations: OwnerStaticStations,
    sources: OwnerStaticSources,
    forecast: OwnerStaticForecastLatest,
    station: OwnerStationRecent,
    warnings: OwnerWarningsFile,
    status: OwnerStatusFile,
  },
};
/** No output holds the withheld canary; no public output holds the owner canary (invariant 11). */
const NEVER: Record<ChannelAudience, readonly string[]> = {
  public: [CANARIES.owner.text, CANARIES.owner.real, CANARIES.withheld.text, CANARIES.withheld.real],
  owner: [CANARIES.withheld.text, CANARIES.withheld.real],
};

export const STATIONS_EVERY_MS = 3_600_000;
const BACKLOG_DEGRADED_S = 15 * 60;
const BEHIND_DEGRADED_MS = 5 * 60_000;
const DIRTY_BATCH = 20_000;

export type CycleDeps = {
  db: Kysely<DB>;
  family: ChannelAudience;
  out: Output;
  render: Renderers;
  window: DisplayWindow;
  now: () => number;
  build: string;
  sections: ReadonlyMap<string, string>;
  cache: StaticCache;
  inputs: string | undefined;
  log: Pick<Logger, 'error'>;
  /** The time a cycle may spend on recent buckets and station files (production 35 s; publishOnce no limit). */
  budgetMs: number;
  /** Settled days per cycle (production 1; publishOnce every pending day). */
  settledPerCycle: number;
  /** A failing step throws instead of being logged and skipped (publishOnce). */
  strict: boolean;
};

export class Publisher {
  readonly #d: CycleDeps;
  #cursor: string | undefined;
  /** The newest bucket queued so far: every later bucket up to now is queued once. */
  #horizon = 0;
  readonly #buckets = new Set<number>();
  readonly #stations = new Set<string>();
  #framesDirty = true;
  #framesSpan = '';
  #stationsBody: StaticStations | undefined;
  #stationsAt = 0;
  #latestFrom: string | null = null;
  #behindSince: number | undefined;
  #lastCycleMs = 0;
  #lastDayRender: DayRender | null = null;
  #settledBytes: number | undefined;
  readonly #warningDays = new Set<string>();

  constructor(deps: CycleDeps) {
    this.#d = deps;
  }

  /** Runs one cycle. A failing step is logged by its fixed code and skipped; the others still run, meta last. */
  async cycle(): Promise<void> {
    const started = Date.now();
    const d = this.#d;
    const now = d.now();
    const first = this.#cursor === undefined;
    const v = VIEWS[d.family];
    if (first) {
      await d.out.start();
      const { rows } = await sql<{ id: string }>`
        SELECT COALESCE(max(id), 0)::text AS id FROM ${sql.table(v.dirty)}`.execute(d.db);
      this.#cursor = rows[0]?.id ?? '0';
      for (const e of await d.out.list('warnings')) {
        const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})\.json$/.exec(e.name);
        if (m !== null) this.#warningDays.add(m[1] as string);
      }
    }
    await d.window.refresh();
    const window = d.window.current;
    if (window === undefined) throw coded('no_display_window');
    const c: RenderCtx = {
      db: d.db,
      family: d.family,
      now,
      window,
      build: d.build,
      sections: d.sections,
      cache: d.cache,
      inputs: d.inputs,
      attribution: await attributionRows(d.db, d.family),
      log: d.log,
    };

    // Every bucket of the unsettled days is a file; a new one is queued once, a settled day's are dropped.
    for (const t of recentBuckets(now)) if (t > this.#horizon) this.#buckets.add(t);
    this.#horizon = Math.max(this.#horizon, floorBucket(now));
    for (const t of this.#buckets) if (isSettled(dayOf(t), now)) this.#buckets.delete(t);

    // 1. The hot set.
    if (this.#stationsBody === undefined || now - this.#stationsAt >= STATIONS_EVERY_MS)
      await this.#step('stations', async () => {
        const body = (await this.#put(c, 'stations', 'stations.json', await d.render.stations(c))) as StaticStations;
        this.#stationsBody = body;
        this.#stationsAt = now;
        for (const s of body.stations) this.#stations.add(s.id); // the hourly sweep (§9 C21)
      });
    const stations = this.#stationsBody;
    if (stations !== undefined)
      await this.#step('latest', async () => {
        const { body, latestFrom } = await d.render.latest(c, stations);
        await this.#put(c, 'latest', 'latest.json', body);
        this.#latestFrom = latestFrom;
      });
    await this.#step('forecast', async () => {
      await this.#put(c, 'forecast', 'forecast/latest.json', await d.render.forecast(c));
    });
    await this.#step('warnings', async () => {
      await this.#put(c, 'warnings', 'warnings/latest.geojson', await d.render.warnings(c, null));
    });
    await this.#step('sources', async () => {
      await this.#put(c, 'sources', 'sources.json', await d.render.sources(c));
    });

    // 2. The dirty rows: queued in memory, so the cursor moves on at once (a restart queues everything anyway).
    await this.#step('dirty', async () => {
      const { rows } = await sql<DirtyRow>`
        SELECT id::text AS id, kind, from_ts, to_ts, stations FROM ${sql.table(v.dirty)}
        WHERE id > ${this.#cursor}::bigint ORDER BY id LIMIT ${DIRTY_BATCH}`.execute(d.db);
      for (const t of dirtyBuckets(rows, now)) this.#buckets.add(t);
      for (const r of rows) {
        for (const s of r.stations) this.#stations.add(s);
        if (r.kind === 'obs' && r.to_ts.getTime() >= unsettledStart(now)) this.#framesDirty = true;
      }
      const last = rows.at(-1);
      if (last !== undefined) this.#cursor = last.id;
    });

    // 3. Recent buckets newest first, then station files, within the budget.
    const deadline = started + d.budgetMs;
    await this.#step('recent', async () => {
      for (const t of [...this.#buckets].sort((a, b) => b - a)) {
        if (Date.now() >= deadline) break;
        await this.#put(c, 'snapshot', recentPath(t), await d.render.snapshot(c, t));
        this.#buckets.delete(t);
      }
    });
    await this.#step('stations-recent', async () => {
      const known = new Set(stations?.stations.map((s) => s.id) ?? []);
      for (const id of [...this.#stations].sort()) {
        if (Date.now() >= deadline) break;
        if (known.has(id)) await this.#put(c, 'station', `series/${id}/recent.json`, await d.render.station(c, id));
        this.#stations.delete(id);
      }
    });
    if (this.#buckets.size === 0) this.#behindSince = undefined;
    else this.#behindSince ??= now;

    // 4. Public only: the recent frames, the ended days' warnings and at most `settledPerCycle` settled days.
    let versions = new Map<string, Version>();
    let complete: Complete = new Map();
    let settled: string[] = [];
    if (d.family === 'public') {
      const from = unsettledStart(now);
      const to = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
      if (`${from}/${to}` !== this.#framesSpan) this.#framesDirty = true;
      if (this.#framesDirty)
        await this.#step('frames', async () => {
          await this.#put(c, 'frames', 'frames/recent.json', await d.render.frames(c, from, to));
          this.#framesDirty = false;
          this.#framesSpan = `${from}/${to}`;
        });
      await this.#step('warnings-days', async () => {
        for (let day = dayStartMs(dayOf(window.displayStartMs)); day + DAY_MS <= now; day += DAY_MS) {
          const name = dayOf(day);
          if (this.#warningDays.has(name)) continue;
          await this.#put(c, 'warnings', `warnings/${name}.json`, await d.render.warnings(c, name), false);
          this.#warningDays.add(name);
        }
      });
      settled = settledDays(window.displayStartMs, now);
      versions = await this.#versions();
      complete = await this.#complete();
      for (let i = 0; i < d.settledPerCycle; i++) {
        const day = nextSettled(versions, complete, settled);
        if (day === undefined) break;
        const version = versionOf(versions, day);
        await this.#step('settled', () => this.#renderDay(c, day, version));
        versions = await this.#versions();
        complete = await this.#complete();
        // A failed render waits for the next cycle; a day bumped meanwhile is pending again under its new version.
        if (complete.get(day)?.has(version) !== true && versionOf(versions, day) === version) break;
      }
    } else {
      versions = await this.#versions();
    }

    // 5. Prune.
    await this.#step('prune', () => this.#prune(now, versions, complete));

    // 6. status.json, then meta.json last.
    const pendingDays = settled.filter((day) => complete.get(day)?.has(versionOf(versions, day)) !== true).length;
    if (this.#settledBytes === undefined)
      this.#settledBytes = (await d.out.size('settled')) + (await d.out.size('frames'));
    await this.#step('status', async () => {
      const p: PublisherStatus = {
        cycleAt: new Date(now).toISOString(),
        cycleSeconds: Math.round(this.#lastCycleMs / 1000),
        lastDayRender: this.#lastDayRender,
        pendingDays,
        settledBytes: this.#settledBytes ?? 0,
      };
      await this.#put(c, 'status', 'status.json', await d.render.status(c, p));
    });
    await this.#step('meta', async () => {
      const backlog = d.family === 'public' ? ((await loaderRow(d.db))?.backlog_age_s ?? null) : null;
      const degraded =
        (backlog !== null && backlog > BACKLOG_DEGRADED_S) ||
        (this.#behindSince !== undefined && now - this.#behindSince > BEHIND_DEGRADED_MS);
      const dayVersions =
        d.family === 'public' ? metaDayVersions(versions, complete, settled) : ownerDayVersions(versions);
      await this.#put(
        c,
        'meta',
        'meta.json',
        await d.render.meta(c, { dayVersions, degraded, latestFrom: this.#latestFrom }),
      );
    });
    this.#lastCycleMs = Date.now() - started;
  }

  /** Validates `body` against the family's contract, refuses a canary rendering, and writes it. */
  async #put(c: RenderCtx, kind: Kind | 'status', rel: string, body: unknown, remember = true): Promise<unknown> {
    const parsed = validated(CONTRACTS[c.family][kind], body);
    const text = JSON.stringify(parsed);
    if (NEVER[c.family].some((s) => text.includes(s))) throw coded('canary_in_output');
    await this.#d.out.put(rel, parsed, remember);
    return parsed;
  }

  async #step(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (this.#d.strict) throw err;
      this.#d.log.error({ code: errorCode(err), step: name, family: this.#d.family }, 'publish step failed');
    }
  }

  async #versions(): Promise<Map<string, Version>> {
    const { rows } = await sql<{ day: string; version: number; reason: BumpReason }>`
      SELECT day::text AS day, version, reason FROM ${sql.table(VIEWS[this.#d.family].dayVersion)}`.execute(this.#d.db);
    return new Map(rows.map((r) => [r.day, { v: r.version, reason: r.reason }]));
  }

  async #complete(): Promise<Map<string, Map<number, number>>> {
    const out = new Map<string, Map<number, number>>();
    for (const m of await this.#d.out.markers()) {
      const day = out.get(m.day) ?? new Map<number, number>();
      day.set(m.version, Date.parse(m.at));
      out.set(m.day, day);
    }
    return out;
  }

  /** One settled day: 144 bucket files and its frames under version `version`; the marker only if still current. */
  async #renderDay(c: RenderCtx, day: string, version: number): Promise<void> {
    const started = Date.now();
    const start = dayStartMs(day);
    let files = 0;
    for (let t = start; t < start + DAY_MS; t += BUCKET_MS) {
      await this.#put(c, 'snapshot', settledPath(t, version), await this.#d.render.snapshot(c, t), false);
      files++;
    }
    await this.#put(
      c,
      'frames',
      framesPath(day, version),
      await this.#d.render.frames(c, start, start + DAY_MS),
      false,
    );
    files++;
    this.#settledBytes = undefined;
    if (versionOf(await this.#versions(), day) !== version) {
      // Bumped while rendering: v{n} was never named in meta.
      await this.#d.out.remove(`settled/${day}/v${version}`);
      await this.#d.out.remove(framesPath(day, version));
      return;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const at = new Date(this.#d.now()).toISOString();
    await this.#d.out.writeMarker({ day, version, files, seconds, at });
    this.#lastDayRender = { day, version, seconds, at };
  }

  async #prune(now: number, versions: ReadonlyMap<string, Version>, complete: Complete): Promise<void> {
    const out = this.#d.out;
    const dirs = async (rel: string) => (await out.list(rel)).filter((e) => e.isDirectory()).map((e) => e.name);
    const versionsIn = async (rel: string, re: RegExp) => {
      const map = new Map<string, number[]>();
      for (const day of await dirs(rel))
        map.set(
          day,
          (await out.list(`${rel}/${day}`)).flatMap((e) => {
            const m = re.exec(e.name);
            return m === null ? [] : [Number(m[1])];
          }),
        );
      return map;
    };
    const plan = prunePlan({
      nowMs: now,
      family: this.#d.family,
      versions,
      complete,
      stations: this.#stationsBody === undefined ? undefined : new Set(this.#stationsBody.stations.map((s) => s.id)),
      recentDays: await dirs('recent'),
      settled: await versionsIn('settled', /^v([1-9][0-9]*)$/),
      frames: await versionsIn('frames', /^v([1-9][0-9]*)\.json$/),
      stationDirs: await dirs('series'),
    });
    for (const rel of plan.paths) await out.remove(rel);
    for (const [day, version] of plan.markers) await out.removeMarker(day, version);
    if (plan.paths.some((p) => p.startsWith('settled/') || p.startsWith('frames/'))) this.#settledBytes = undefined;
  }
}
