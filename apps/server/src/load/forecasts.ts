import { createHash } from 'node:crypto';
import {
  type CanonPoint,
  type CanonRun,
  checkRun,
  checkRunCount,
  encodeRun,
  FORECAST_COLUMNS,
  FORECAST_SOURCES,
  type ForecastKind,
  type ForecastPart,
  type ForecastRunIn,
  type ForecastSourceDecl,
  firstValid,
  float32,
  lastValid,
  mergeDecision,
  SchemaDrift,
  type StagedPart,
  type StoredRun,
} from '@rws/core';
import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';
import { lock, readMeta, type Tx, writeMeta } from './store.ts';

// P8a: forecast runs into forecast_run / forecast_value (A§6, A§7.4 item 9, ADR-0010). A run is immutable: the
// only updates are lowering fetched_at (and an inferred issued_at) to an earlier capture of the same run, and, for a
// source whose captures drop the run's head (NL-1), extending a stored run by the leading points an earlier capture
// had (packages/core mergeDecision). fetched_at is always the manifest line's, never the clock of a replay.

/** The forecast declaration of a source (units, horizon, head drops), or undefined when it has none. */
export const forecastDecl = (source: string): ForecastSourceDecl | undefined =>
  Object.hasOwn(FORECAST_SOURCES, source) ? FORECAST_SOURCES[source as keyof typeof FORECAST_SOURCES] : undefined;

/** A checked run and the series key it names (in the payload's own registry, or in `target`'s). */
export type CheckedRun = { target?: string; series: string; run: CanonRun };

/**
 * The bounds of every run of one payload (packages/core checkRun): drift throws, dropped points are counted into
 * `dropped`. A source that returns runs has a declaration, else it is our bug.
 */
export function checkForecasts(
  runs: readonly ForecastRunIn[] | undefined,
  source: string,
  fetchedAtMs: number,
  dropped: Record<string, number>,
): CheckedRun[] {
  if (runs === undefined || runs.length === 0) return [];
  const decl = forecastDecl(source);
  if (decl === undefined) throw new Error('load: forecast runs of a source without a forecast declaration');
  checkRunCount(runs);
  const out: CheckedRun[] = [];
  for (const r of runs) {
    const c = checkRun(r, fetchedAtMs, decl);
    for (const [code, n] of Object.entries(c.dropped)) dropped[code] = (dropped[code] ?? 0) + n;
    if (c.run !== null)
      out.push({ ...(r.target === undefined ? {} : { target: r.target }), series: r.series, run: c.run });
  }
  return out;
}

/** A checked run attached to a registered primary series. */
export type ResolvedRun = { seriesId: number; run: CanonRun };

export type ForecastWritten = {
  /** Points inserted. */
  n_new: number;
  /** Runs whose fetched_at was lowered or that were extended. */
  n_changed: number;
  writes: number;
  /** Captures whose tail matched more than one stored run (nothing changed). */
  ambiguous: number;
  /** A run whose key another source's run already holds (the key omits the source; nothing changed). */
  collision: number;
};

/** The content hash: sha256 over packages/core's canonical encoding, never over raw bytes. */
export const runHash = (run: CanonRun): Buffer => createHash('sha256').update(encodeRun(run)).digest();

type RunRow = {
  id: string;
  issued_at: Date | null;
  issued_inferred: boolean;
  first_valid: Date;
  last_valid: Date;
  content_hash: Buffer;
  kind: ForecastKind;
  step_ms: number | null;
  provider_segment_end: Date | null;
};
type ValueRow = { run_id: string; valid_ts: Date; flags: number } & Record<
  (typeof FORECAST_COLUMNS)[number],
  number | null
>;

/** The stored runs of a series and source that end at `last`, with their points, as packages/core reads them. */
async function storedRuns(tx: Tx, seriesId: number, source: string, last: number): Promise<StoredRun[]> {
  const { rows } = await sql<RunRow>`
    SELECT r.id::text AS id, r.issued_at, r.issued_inferred, r.first_valid, r.last_valid, r.content_hash, r.kind,
           (EXTRACT(EPOCH FROM r.step) * 1000)::double precision AS step_ms, r.provider_segment_end
    FROM forecast_run r
    WHERE r.series_id = ${seriesId} AND r.source_id = ${source} AND r.last_valid = ${new Date(last)}`.execute(tx);
  if (rows.length === 0) return [];
  const from = new Date(Math.min(...rows.map((r) => r.first_valid.getTime())));
  const { rows: values } = await sql<ValueRow>`
    SELECT v.run_id::text AS run_id, v.valid_ts, v.flags,
           v.value, v.p05, v.p10, v.p25, v.p30, v.p50, v.p70, v.p75, v.p90, v.p95, v.vmin, v.vmax
    FROM forecast_value v
    WHERE v.run_id = ANY(${rows.map((r) => r.id)}::bigint[]) AND v.valid_ts >= ${from} AND v.valid_ts <= ${new Date(last)}
    ORDER BY v.run_id, v.valid_ts`.execute(tx);
  const points = new Map<string, CanonPoint[]>();
  for (const v of values) {
    const list = points.get(v.run_id) ?? [];
    list.push({
      ms: v.valid_ts.getTime(),
      flags: v.flags,
      v: FORECAST_COLUMNS.map((c) => (v[c] === null ? null : float32(v[c] as number))),
    });
    points.set(v.run_id, list);
  }
  return rows
    .filter((r) => (points.get(r.id)?.length ?? 0) > 0)
    .map((r) => ({
      id: r.id,
      hash: r.content_hash.toString('hex'),
      kind: r.kind,
      stepMs: r.step_ms,
      issuedAt: r.issued_inferred || r.issued_at === null ? null : r.issued_at.getTime(),
      segmentEnd: r.provider_segment_end?.getTime() ?? null,
      points: points.get(r.id) as CanonPoint[],
    }));
}

async function insertValues(tx: Tx, runId: string, points: readonly CanonPoint[]): Promise<void> {
  if (points.length === 0) return;
  const col = (i: number) => points.map((p) => p.v[i] ?? null);
  await sql`
    INSERT INTO forecast_value (run_id, valid_ts, value, p05, p10, p25, p30, p50, p70, p75, p90, p95, vmin, vmax, flags)
    SELECT ${runId}::bigint, u.ts, u.value, u.p05, u.p10, u.p25, u.p30, u.p50, u.p70, u.p75, u.p90, u.p95, u.vmin,
           u.vmax, u.flags
    FROM unnest(${points.map((p) => new Date(p.ms).toISOString())}::timestamptz[], ${col(0)}::real[], ${col(1)}::real[],
                ${col(2)}::real[], ${col(3)}::real[], ${col(4)}::real[], ${col(5)}::real[], ${col(6)}::real[],
                ${col(7)}::real[], ${col(8)}::real[], ${col(9)}::real[], ${col(10)}::real[], ${col(11)}::real[],
                ${points.map((p) => p.flags)}::int2[])
         AS u(ts, value, p05, p10, p25, p30, p50, p70, p75, p90, p95, vmin, vmax, flags)`.execute(tx);
}

/**
 * Stores the runs of one payload (A§7.4 item 9). Per run: partitions over its valid range, the stored runs of the
 * same series and source that end where it ends, then the merge decision: insert, lower fetched_at (and an inferred
 * issued_at) to this capture's if it is earlier, or extend by the leading points (head-dropping sources only).
 * A replay of the same captures writes nothing, whatever their order.
 */
export async function applyForecasts(
  tx: Tx,
  source: string,
  runs: readonly ResolvedRun[],
  batch: string,
  fetchedAt: Date,
  headDrops: boolean,
): Promise<ForecastWritten> {
  const out: ForecastWritten = { n_new: 0, n_changed: 0, writes: 0, ambiguous: 0, collision: 0 };
  for (const { seriesId, run } of runs) {
    const first = new Date(firstValid(run));
    const last = lastValid(run);
    const hash = runHash(run);
    await sql`SELECT ensure_partitions(${first}::timestamptz, ${new Date(last)}::timestamptz)`.execute(tx);
    const d = mergeDecision(await storedRuns(tx, seriesId, source, last), run, hash.toString('hex'), headDrops);
    if (d.kind === 'ambiguous') {
      out.ambiguous++;
      continue;
    }
    if (d.kind === 'insert') {
      const issued = run.issuedAt === null ? fetchedAt : new Date(run.issuedAt);
      const { rows } = await sql<{ id: string }>`
        INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                  content_hash, kind, step, provider_segment_end, batch_id)
        VALUES (${seriesId}, ${source}, ${issued}, ${run.issuedAt === null}, ${first}, ${new Date(last)}, ${fetchedAt},
                ${hash}, ${run.kind}, ${run.stepMs}::bigint * interval '1 millisecond',
                ${run.segmentEnd === null ? null : new Date(run.segmentEnd)}::timestamptz, ${batch}::bigint)
        ON CONFLICT (series_id, first_valid, content_hash) DO NOTHING
        RETURNING id::text AS id`.execute(tx);
      const id = rows[0]?.id;
      if (id === undefined) {
        out.collision++;
        continue;
      }
      await insertValues(tx, id, run.points);
      out.n_new += run.points.length;
      out.writes++;
      continue;
    }
    if (d.kind === 'extend') await insertValues(tx, d.id, d.add);
    const extended = d.kind === 'extend';
    const { rows } = await sql<{ id: string }>`
      UPDATE forecast_run
      SET fetched_at = LEAST(fetched_at, ${fetchedAt}),
          issued_at = CASE WHEN issued_inferred THEN LEAST(issued_at, ${fetchedAt}) ELSE issued_at END,
          first_valid = CASE WHEN ${extended} THEN ${first}::timestamptz ELSE first_valid END,
          content_hash = CASE WHEN ${extended} THEN ${hash}::bytea ELSE content_hash END
      WHERE id = ${d.id}::bigint
        AND (${extended} OR fetched_at > ${fetchedAt} OR (issued_inferred AND issued_at > ${fetchedAt}))
      RETURNING id::text AS id`.execute(tx);
    if (rows.length > 0) {
      out.n_changed++;
      out.writes++;
    }
    if (extended) out.n_new += d.add.length;
  }
  return out;
}

// --------------------------------------------------------------------------- runs that span several payloads

/** At most this many fetch hours are staged per station (C3: a replay's old groups and the tail's current one). */
export const PART_GROUPS = 4;
/** The health pass drops a group staged longer ago than this (wall clock), counted as `incomplete_run`. */
export const PART_TTL_MS = 2 * 3_600_000;
const PART_PREFIX = 'forecast_part:';
const partsKey = (source: string, slot: string) => `${PART_PREFIX}${source}:${slot}`;

type Staged = {
  groups: Record<string, { staged_at: string; parts: Record<string, { fetched_at: string; data: unknown }> }>;
};

/** A part names its station, fetch hour and part with our own identifiers only (never provider text). */
export function checkPart(p: ForecastPart): void {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slot) ||
    p.slot.length > 80 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(p.group) ||
    !/^[a-z0-9]{1,8}$/.test(p.part)
  )
    throw new SchemaDrift('forecast_part');
}

/**
 * Stages one part in app_meta `forecast_part:<source>:<slot>` (one row per station: rws_load has no DELETE there).
 * A part stated again replaces itself (a replay), so the parts are counted distinct; once `need` distinct parts of a
 * group are there, the group leaves the map and its parts are returned. A group beyond PART_GROUPS evicts the one
 * staged longest ago (`evicted`, alerted as incomplete_run by the caller).
 */
export async function stagePart(
  tx: Tx,
  source: string,
  part: ForecastPart,
  need: number,
  fetchedAt: Date,
  now: Date,
): Promise<{ complete: StagedPart[] | null; evicted: number }> {
  const key = partsKey(source, part.slot);
  const state = (await readMeta<Staged>(tx, key)) ?? { groups: {} };
  const group = state.groups[part.group] ?? { staged_at: now.toISOString(), parts: {} };
  group.parts[part.part] = { fetched_at: fetchedAt.toISOString(), data: part.data };
  state.groups[part.group] = group;
  let complete: StagedPart[] | null = null;
  if (Object.keys(group.parts).length >= need) {
    complete = Object.entries(group.parts).map(([p, v]) => ({
      part: p,
      fetchedAt: Date.parse(v.fetched_at),
      data: v.data,
    }));
    delete state.groups[part.group];
  }
  let evicted = 0;
  for (;;) {
    const keys = Object.keys(state.groups);
    if (keys.length <= PART_GROUPS) break;
    const oldest = keys.reduce((a, b) =>
      (state.groups[a] as Staged['groups'][string]).staged_at <= (state.groups[b] as Staged['groups'][string]).staged_at
        ? a
        : b,
    );
    delete state.groups[oldest];
    evicted++;
  }
  await writeMeta(tx, key, state);
  return { complete, evicted };
}

/**
 * The health pass: drops every staged group older than PART_TTL_MS (its run never completed: a part missing, or a
 * partial dup_of hour), under the loader lock. Returns the groups dropped per source, alerted as incomplete_run.
 */
export async function pruneStagedParts(db: Kysely<DB>, now: Date): Promise<Map<string, number>> {
  return db.transaction().execute(async (tx) => {
    await lock(tx);
    const { rows } = await sql<{ key: string; value: Staged }>`
      SELECT key, value FROM app_meta WHERE starts_with(key, ${PART_PREFIX})`.execute(tx);
    const dropped = new Map<string, number>();
    const cutoff = now.getTime() - PART_TTL_MS;
    for (const { key, value } of rows) {
      const old = Object.keys(value.groups).filter(
        (g) => Date.parse((value.groups[g] as { staged_at: string }).staged_at) < cutoff,
      );
      if (old.length === 0) continue;
      for (const g of old) delete value.groups[g];
      await writeMeta(tx, key, value);
      const source = key.slice(PART_PREFIX.length).split(':')[0] as string;
      dropped.set(source, (dropped.get(source) ?? 0) + old.length);
    }
    return dropped;
  });
}
