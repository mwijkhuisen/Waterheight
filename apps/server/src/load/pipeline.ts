import { createHash } from 'node:crypto';
import { type Normalised, type ObsRow, obsParts, SchemaDrift } from '@rws/core';
import type { Kysely } from 'kysely';
import { ManifestLine } from '../archive/manifest.ts';
import { ArchiveError, type ArchiveReader, type RawLine } from '../archive/reader.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { LOAD_ADAPTERS, type LoadAdapter, type SpecLoader } from './adapters.ts';
import { type DirtyEntry, type DirtyKind, markDirty, narrow, type Touch } from './dirty.ts';
import {
  applyForecasts,
  type CheckedRun,
  checkForecasts,
  checkPart,
  type ForecastWritten,
  forecastDecl,
  type ResolvedRun,
  stagePart,
} from './forecasts.ts';
import { labelOffsetsOf } from './label-offset.ts';
import { applyClasses, applyReferences, applyWarnings, type Changes, type ResolvedRef } from './refs.ts';
import {
  type Attempt,
  advanceCursor,
  applyFetchHealth,
  applyGaugeZeros,
  type BatchInput,
  clearAttempt,
  closeBatch,
  cursors,
  emptyFold,
  type FetchFold,
  lock,
  openBatch,
  ownerSources,
  previousLoad,
  readAttempt,
  type SeriesRow,
  seriesOf,
  setBatchAside,
  storeProviderUpdated,
  storeUnitMismatch,
  type Tx,
  unitMismatchOf,
  upsertObs,
  type Written,
  writeAttempt,
  writeMeta,
} from './store.ts';

// The loader (A§7.4 steps 1–5): it tails the manifest from load_cursor and
// turns each archived payload into rows. One payload is one transaction:
// observations, revisions, latest values, rollups, the batch row, the source's
// health and the cursor commit together or not at all, so a kill -9 anywhere
// neither loses, skips nor double-applies a manifest line.
//
// The tail never stalls silently. A payload that fails for a reason of its own
// (a constraint, a bug in its parser, an unreadable object) is tried at most
// twice and then quarantined; the attempt is recorded before the payload is
// touched, so a payload that kills the process is quarantined too, untouched,
// on the pass after its second attempt. Anything else (the database, the
// deployment, the archive) stalls the tail, which alerts `load_stalled` when
// the stall starts and every 15 minutes while it lasts, and the health pass
// publishes the age of the oldest unconsumed line.

export type Alert = (code: string, fields?: Record<string, string | number>) => void;

export type LoadDeps = {
  db: Kysely<DB>;
  reader: ArchiveReader;
  /** A condition the owner must hear about: fixed codes and our own identifiers only, never provider text. */
  alert: Alert;
  info?: (msg: string, fields?: Record<string, string | number>) => void;
  now: () => Date;
  /** One sample per consumed manifest line: how long after its fetch it was loaded. */
  onLag?: (source: string, fetchedAt: Date, lagMs: number) => void;
  /** A constructor argument for tests (a fixed parser, a broken one); never set from env or config. */
  adapters?: Readonly<Record<string, LoadAdapter>>;
};

export type Outcome =
  | { kind: 'loaded'; n_rows: number; n_new: number; n_changed: number }
  | { kind: 'quarantined'; code: string }
  | { kind: 'skipped'; code: string }
  | { kind: 'no_adapter' };

/** `more`: the tick stopped between lines (its time budget, or a stop) and there is more to read now. */
export type TickResult = { lines: number; loaded: number; more?: true };
export type TickOptions = {
  /** Stop between lines once `now()` reaches this instant (epoch ms). */
  until?: number;
  /** Checked between lines: stop as soon as it says so. */
  stop?: () => boolean;
};

/**
 * Manifest bytes not consumed yet, and how old the oldest whole unconsumed
 * manifest line is. A damaged line is skipped (the next tick steps over it),
 * and a torn last line is not whole: `age_s` is null when no whole line is
 * left to load, whatever `bytes` still reports.
 */
export type Backlog = { files: number; bytes: number; age_s: number | null };

/**
 * How far the public backlog scan reads into one file's unread lines; the rest of a longer backlog counts whole, as
 * public (a backlog that long is an outage, whoever's lines it holds). The scan JSON-parses every line it reads on
 * every pass of the loop, so it stays small (review SR-5: 16 MiB before).
 */
export const PUBLIC_SCAN_BYTES = 2 * 1024 * 1024;

/** Nothing left to load: the gate of the checksums and the nightly jobs (a torn last line never blocks them). */
export const nothingToLoad = (b: Backlog): boolean => b.age_s === null;

/**
 * The `dropped` codes of values that were withheld, not discarded: we do not
 * store them as they stand, and a registry or parser change could. They count
 * in the batch's n_skipped (so the pruner keeps the object for a replay; the
 * lists or series the registry does not know add one each) and each raises an
 * alert under its own code, in a replay too. `unregistered_method`: a registered
 * RWS series arrived under another method code; `unknown_quality`: a quality
 * code we cannot read; `conflict`: two values for one instant;
 * `registered_dropped`: a registered RWS series arrived under another
 * ProcesType, compartment or grouping; `datum_mismatch` (P5a): a CH value that
 * contradicts its series' declared level or relative stage; `unmapped_class`
 * (P7a): a provider class or alert level the crosswalk (packages/core
 * crosswalk.ts) does not have, loaded by a replay once it is a reviewed row;
 * `geometry_too_big` and `texts_too_big` (P7a review SR-2): a warning row
 * whose geometry or texts the loader left out because they are over its byte
 * bound (WARNING_BYTES), so that no size CHECK quarantines a flood warning.
 * P8a: `beyond_horizon`, a forecast value past its provider's horizon (packages/core checkRun);
 * `before_window` (review SEC-1), a forecast value more than two days before its run's issue (else fetch) time;
 * `incomplete_run`, a staged LU-3 group whose five files never all arrived (evicted or expired); `combine_drift`,
 * a staged group that its combiner refused; `run_mismatch` and `step_mismatch`, a complete LU-3 group whose files
 * disagree on their times or are not one hour apart (the whole run is withheld, as for an incomplete one).
 */
export const RETAINED = [
  'unit_mismatch',
  'unknown_zero_unit',
  'unregistered_method',
  'unknown_quality',
  'conflict',
  'registered_dropped',
  'datum_mismatch',
  'unmapped_class',
  'geometry_too_big',
  'texts_too_big',
  'bad_text',
  'reference_out_of_range',
  'beyond_horizon',
  'before_window',
  'incomplete_run',
  'combine_drift',
  'run_mismatch',
  'step_mismatch',
] as const;

const NUL = String.fromCharCode(0);
/** A text PostgreSQL cannot store: U+0000 (text and jsonb) or a lone surrogate (jsonb refuses `\ud800`). */
const badString = (s: string) => s.includes(NUL) || !s.isWellFormed();
const badText = (v: unknown): boolean =>
  typeof v === 'string'
    ? badString(v)
    : typeof v === 'object' && v !== null && Object.entries(v).some(([key, value]) => badString(key) || badText(value));
/** A reference value is a `real`: beyond this it is a provider typo, not a level (and past 3.4e38 an insert error). */
const REFERENCE_MAX = 1e9;

/**
 * Rows PostgreSQL cannot store never fail the payload's transaction (round-2 review M1, M2): a reference, class or
 * warning row with U+0000 or a lone surrogate in any text is withheld as `bad_text`, a reference whose value is
 * beyond ±1e9 as `reference_out_of_range` (both RETAINED: alerted, the object kept for a replay). A withheld snapshot area stays
 * as stored, as a dropped one does (review CR-5).
 */
export function dropUnstorable(n: Normalised): void {
  const keep = <T>(rows: T[], bad: (r: T) => boolean, code: string): T[] => {
    const kept = rows.filter((r) => !bad(r));
    if (kept.length < rows.length) n.dropped[code] = (n.dropped[code] ?? 0) + rows.length - kept.length;
    return kept;
  };
  if (n.references) {
    n.references = keep(n.references, badText, 'bad_text');
    n.references = keep(n.references, (r) => !(Math.abs(r.value) <= REFERENCE_MAX), 'reference_out_of_range');
  }
  if (n.classes) n.classes = keep(n.classes, badText, 'bad_text');
  const w = n.warnings;
  if (w === undefined) return;
  const withheld = w.rows.filter(badText).flatMap((r) => (badString(r.area_key) ? [] : [r.area_key]));
  w.rows = keep(w.rows, badText, 'bad_text');
  if (w.mode === 'snapshot' && withheld.length > 0) w.kept = [...(w.kept ?? []), ...withheld];
}

/** The bytes the loader stores of a warning's geometry and of its texts (`warning_area.texts` holds 64 KiB). */
export const WARNING_BYTES = { geometry: 2 * 1024 * 1024, texts: 60_000 } as const;

/**
 * A warning row keeps its level whatever the size of its presentation: a geometry or texts over WARNING_BYTES is
 * left out of the row and counted (`geometry_too_big`, `texts_too_big`; RETAINED), so no size CHECK fails the
 * payload's transaction (P7a review SR-2). PostgreSQL prints jsonb with a space after each `:` and `,`: the margin
 * of 5,536 bytes under 65,536 covers about 2,700 key/value pairs, far beyond what any adapter emits (LU-5 at most
 * 8 blocks of 3 fields, DE-6 one headline); an adapter with many more keys sizes its texts itself. A left-out field
 * keeps what the row stored (refs.ts `present`).
 */
export function boundWarnings(n: Normalised): void {
  for (const r of n.warnings?.rows ?? []) {
    if (r.geometry !== null && Buffer.byteLength(r.geometry) > WARNING_BYTES.geometry) {
      r.geometry = null;
      n.dropped.geometry_too_big = (n.dropped.geometry_too_big ?? 0) + 1;
    }
    if (r.texts !== undefined && Buffer.byteLength(JSON.stringify(r.texts)) > WARNING_BYTES.texts) {
      delete r.texts;
      n.dropped.texts_too_big = (n.dropped.texts_too_big ?? 0) + 1;
    }
  }
}

/** A payload is tried at most this often; the next pass quarantines it without reading it. */
export const MAX_TRIES = 2;
/** While the tail is stalled for the same reason, its alert repeats at most this often. */
export const STALL_ALERT_MS = 15 * 60_000;

export class Loader {
  private readonly deps: LoadDeps;
  private readonly series = new Map<string, Map<string, SeriesRow>>();
  /** The owner-audience sources, read once (the registry changes only at a deploy). */
  private owners: Promise<Set<string>> | undefined;
  private readonly units = new Map<string, Set<string>>();
  /** What app_meta `load_attempt` says, once read (null: no line in flight). */
  private attempt: Attempt | undefined | null;
  /** An attempt record the database did not take (it was down): the next pass writes it first. */
  private owed: Attempt | undefined;
  /** The UTC day of the last registry drift report per source and spec. */
  private readonly driftDay = new Map<string, string>();
  /** The highest end offset of a damaged line counted per file: a line re-read after a stall is not counted again. */
  private readonly badSeen = new Map<string, number>();
  private stalled: { id: string; since: number; alerted: number } | undefined;
  private readonly adapters: Readonly<Record<string, LoadAdapter>>;
  badLines = 0;

  constructor(deps: LoadDeps) {
    this.deps = deps;
    this.adapters = deps.adapters ?? LOAD_ADAPTERS;
  }

  /** The loader of a payload line, if its source and spec have one. */
  specOf(source: string, spec: string): { spec: SpecLoader; adapterVersion: number } | undefined {
    const adapter = Object.hasOwn(this.adapters, source) ? this.adapters[source] : undefined;
    const loader = adapter !== undefined && Object.hasOwn(adapter.specs, spec) ? adapter.specs[spec] : undefined;
    return adapter === undefined || loader === undefined
      ? undefined
      : { spec: loader, adapterVersion: adapter.version };
  }

  /**
   * P9a: a payload's touches as dirty entries. A series' change takes its effective audience narrowed by the
   * payload source's (an owner reference or run on a public series is the owner family's alone); a station's or an
   * area's takes the payload source's.
   */
  private async dirtyEntries(
    source: string,
    touches: Readonly<Record<DirtyKind, readonly Touch[]>>,
    maps: readonly (ReadonlyMap<string, SeriesRow> | undefined)[],
  ): Promise<DirtyEntry[]> {
    this.owners ??= ownerSources(this.deps.db);
    const own = (await this.owners).has(source) ? 'owner' : 'public';
    const byId = new Map<number, SeriesRow>();
    for (const m of maps) for (const s of m?.values() ?? []) byId.set(s.id, s);
    const entries: DirtyEntry[] = [];
    for (const [kind, list] of Object.entries(touches) as [DirtyKind, readonly Touch[]][]) {
      for (const t of list) {
        const s = t.series === undefined ? undefined : byId.get(t.series);
        const station = s?.station ?? t.station;
        entries.push({
          kind,
          audience: s === undefined ? own : narrow(s.audience, own),
          from: t.from ?? Number.NEGATIVE_INFINITY,
          to: t.to ?? Number.POSITIVE_INFINITY,
          stations: station === undefined ? [] : [station],
        });
      }
    }
    return entries;
  }

  private async registry(source: string): Promise<Map<string, SeriesRow>> {
    let known = this.series.get(source);
    if (known === undefined) {
      known = await seriesOf(this.deps.db, source);
      this.series.set(source, known);
    }
    return known;
  }

  private async unitMismatch(source: string): Promise<Set<string>> {
    let keys = this.units.get(source);
    if (keys === undefined) {
      keys = await unitMismatchOf(this.deps.db, source);
      this.units.set(source, keys);
    }
    return keys;
  }

  /**
   * One pass over every manifest file that has unread bytes. Late lines land
   * in older files (a line is filed under the day its fetch STARTED, and the
   * recorder's recovery appends to past days), so no file is ever "done".
   * Every failure ends in a stall that is alerted, never in an exception.
   */
  async tick(opts: TickOptions = {}): Promise<TickResult> {
    let lines = 0;
    let loaded = 0;
    const cut = () => opts.stop?.() === true || (opts.until !== undefined && this.deps.now().getTime() >= opts.until);
    try {
      if (this.owed !== undefined) {
        await writeAttempt(this.deps.db, this.owed);
        this.owed = undefined;
      }
      const done = await cursors(this.deps.db);
      for (const { file, size } of await this.deps.reader.manifests()) {
        let offset = done.get(file) ?? 0;
        while (offset < size) {
          if (lines > 0 && cut()) return { lines, loaded, more: true };
          const chunk = await this.deps.reader.lines(file, offset);
          if (chunk.length === 0) break;
          const result = await this.consume(file, offset, chunk, cut);
          lines += result.lines;
          loaded += result.loaded;
          if (result.stalled) return { lines, loaded };
          if (result.cut) return this.resumed({ lines, loaded, more: true });
          offset = result.offset;
        }
      }
    } catch (err) {
      // Nothing of the failed step was committed: the next tick starts again from the cursor.
      this.stall(errorCode(err), {});
      return { lines, loaded };
    }
    return this.resumed({ lines, loaded });
  }

  private resumed(result: TickResult): TickResult {
    if (this.stalled !== undefined) this.deps.info?.('load resumed', { stalled_s: this.stalledFor() });
    this.stalled = undefined;
    return result;
  }

  /**
   * Manifest bytes not consumed yet, over all files, and the age of the oldest unconsumed line (the nightly gate);
   * `public`: the same over the lines of sources that are not owner audience only, which is what public health shows
   * (P5c, KG-075: an owner source's loading leaves no trace in a public number).
   */
  async backlog(now: Date = this.deps.now()): Promise<Backlog & { public: Backlog }> {
    const done = await cursors(this.deps.db);
    const owner = await ownerSources(this.deps.db);
    const age = (at: number | null) => (at === null ? null : Math.max(0, Math.round((now.getTime() - at) / 1000)));
    let files = 0;
    let bytes = 0;
    let oldest: number | null = null;
    const pub = { files: 0, bytes: 0, oldest: null as number | null };
    for (const { file, size } of await this.deps.reader.manifests()) {
      const offset = done.get(file) ?? 0;
      if (size <= offset) continue;
      files += 1;
      bytes += size - offset;
      const at = await this.firstLineAt(file, offset);
      if (at !== null && (oldest === null || at < oldest)) oldest = at;
      const p = owner.size === 0 ? { bytes: size - offset, at } : await this.publicPart(file, offset, size, owner);
      if (p.bytes > 0) pub.files += 1;
      pub.bytes += p.bytes;
      if (p.at !== null && (pub.oldest === null || p.at < pub.oldest)) pub.oldest = p.at;
    }
    return {
      files,
      bytes,
      age_s: age(oldest),
      public: { files: pub.files, bytes: pub.bytes, age_s: age(pub.oldest) },
    };
  }

  /** The unread bytes of one file's lines that are not an owner source's, and when the first of them was fetched. */
  private async publicPart(
    file: string,
    offset: number,
    size: number,
    owner: ReadonlySet<string>,
  ): Promise<{ bytes: number; at: number | null }> {
    let bytes = 0;
    let at: number | null = null;
    try {
      for (let pos = offset; pos < size; ) {
        if (pos - offset >= PUBLIC_SCAN_BYTES) {
          bytes += size - pos;
          at ??= Date.parse(`${file.slice(0, 10)}T00:00:00Z`);
          break;
        }
        const chunk = await this.deps.reader.lines(file, pos, 1024 * 1024);
        if (chunk.length === 0) {
          // A torn last line (still being written) names no source yet: its bytes count, as in the full backlog.
          bytes += size - pos;
          break;
        }
        for (const raw of chunk) {
          const line = parseLine(raw.text);
          // A damaged line names no source we can trust: it counts.
          if (line === null || !owner.has(line.source)) {
            bytes += raw.end - pos;
            if (line !== null) at ??= Date.parse(line.fetched_at.end ?? line.fetched_at.start);
          }
          pos = raw.end;
        }
      }
    } catch {
      return { bytes: size - offset, at: Date.parse(`${file.slice(0, 10)}T00:00:00Z`) };
    }
    return { bytes, at };
  }

  /**
   * When the first whole unconsumed manifest line of a file was fetched: a
   * damaged line is skipped, and null means no whole line is left (only an
   * unfinished last line, which the recorder is still writing, or tore). A
   * file that cannot be read counts from its day.
   */
  private async firstLineAt(file: string, offset: number): Promise<number | null> {
    try {
      for (let at = offset; ; ) {
        const chunk = await this.deps.reader.lines(file, at, 64 * 1024);
        if (chunk.length === 0) return null;
        for (const raw of chunk) {
          const line = parseLine(raw.text);
          if (line !== null) return Date.parse(line.fetched_at.end ?? line.fetched_at.start);
        }
        at = (chunk.at(-1) as RawLine).end;
      }
    } catch {
      return Date.parse(`${file.slice(0, 10)}T00:00:00Z`);
    }
  }

  private stalledFor(): number {
    return this.stalled === undefined ? 0 : Math.round((this.deps.now().getTime() - this.stalled.since) / 1000);
  }

  /** A stall is alerted when it starts (or its cause changes), then at most every STALL_ALERT_MS while it lasts. */
  private stall(code: string, fields: Record<string, string>): void {
    const now = this.deps.now().getTime();
    const id = [code, fields.source ?? '', fields.spec ?? ''].join(' ');
    if (this.stalled?.id !== id) this.stalled = { id, since: now, alerted: Number.NEGATIVE_INFINITY };
    if (now - this.stalled.alerted < STALL_ALERT_MS) return;
    this.stalled.alerted = now;
    this.deps.alert('load_stalled', { ...fields, code, stalled_s: this.stalledFor() });
  }

  private async attemptOf(file: string, end: number): Promise<Attempt> {
    if (this.attempt === undefined) this.attempt = (await readAttempt(this.deps.db)) ?? null;
    return this.attempt?.file === file && this.attempt.end === end
      ? this.attempt
      : { file, end, n: 0, code: 'load_crashed' };
  }

  /**
   * Records how a pass that committed nothing ended. When the database does
   * not take it (it is down), this process still knows, and the next pass
   * writes it first (R2-4; KG-073 is the process dying in that window).
   */
  private async settle(attempt: Attempt): Promise<void> {
    this.attempt = attempt;
    try {
      await writeAttempt(this.deps.db, attempt);
      this.owed = undefined;
    } catch {
      this.owed = attempt;
    }
  }

  /**
   * Consumes whole lines in file order, starting at byte `start`. Lines without
   * a payload (304, dup_of, a closed gate, a fetch error, a source without an
   * adapter) only touch the fetch health; they are folded and committed
   * together with the next payload line or at the end of the chunk. Returns
   * the committed offset; `stalled` means a line could not be committed now
   * and the next tick starts again from that offset; `cut` means `cut()` asked
   * to stop between lines.
   */
  private async consume(
    file: string,
    start: number,
    chunk: readonly RawLine[],
    cut: () => boolean,
  ): Promise<{ offset: number; lines: number; loaded: number; stalled: boolean; cut: boolean }> {
    const pending = new Map<string, FetchFold>();
    const fold = (source: string) => {
      let f = pending.get(source);
      if (f === undefined) {
        f = emptyFold();
        pending.set(source, f);
      }
      return f;
    };
    let committed = start;
    let folded = start;
    let lines = 0;
    let loaded = 0;
    let stopped = false;
    const flush = async (end: number, work?: (tx: Tx) => Promise<void>) => {
      await this.deps.db.transaction().execute(async (tx) => {
        await lock(tx);
        if (work) {
          await work(tx);
          // The payload line's pass ended (loaded or set aside): its attempt ends with it.
          await clearAttempt(tx);
        }
        for (const [source, f] of pending) await applyFetchHealth(tx, source, f);
        await advanceCursor(tx, file, end);
      });
      if (work) this.attempt = null;
      pending.clear();
      committed = end;
      folded = end;
    };

    for (const raw of chunk) {
      if (lines > 0 && cut()) {
        stopped = true;
        break;
      }
      const line = parseLine(raw.text);
      if (line === null) {
        if (raw.end > (this.badSeen.get(file) ?? 0)) {
          this.badSeen.set(file, raw.end);
          this.badLines += 1;
          this.deps.alert('manifest_bad_line', { file });
        }
        folded = raw.end;
        lines += 1;
        continue;
      }
      const fetchedAt = new Date(line.fetched_at.end ?? line.fetched_at.start);
      const lag = () => this.deps.onLag?.(line.source, fetchedAt, this.deps.now().getTime() - fetchedAt.getTime());
      // Every request of a scheduled run, whatever came back (dup_of, 304, an error): how often a spec asks.
      if (line.seed !== true && line.recovered !== true && line.variant !== '' && !/#\d+$/.test(line.variant)) {
        fold(line.source).starts.push({
          spec: line.spec,
          variant: line.variant,
          at: Date.parse(line.fetched_at.start),
        });
      }
      const plan = this.classify(line);
      if (plan.kind !== 'payload') {
        const f = fold(line.source);
        if (plan.kind === 'fetch_failed') f.failures += 1;
        else markFetchOk(f, fetchedAt);
        folded = raw.end;
        lines += 1;
        lag();
        continue;
      }
      // A payload line: its own transaction, which also commits everything folded before it.
      const ids = { source: line.source, spec: line.spec };
      const prior = await this.attemptOf(file, raw.end);
      if (prior.n >= MAX_TRIES) {
        // Two attempts failed or died: quarantine it without reading or parsing it, and move on.
        const batch = batchInput(line, plan.adapterVersion, fetchedAt);
        await flush(raw.end, (tx) => setBatchAside(tx, batch, 'quarantined', prior.code));
        this.deps.alert('quarantined', { ...ids, code: prior.code });
      } else {
        const next = { ...prior, n: prior.n + 1, code: 'load_crashed' };
        await writeAttempt(this.deps.db, next);
        this.attempt = next;
        try {
          const outcome = await this.payload(line, plan, fetchedAt, (work) => flush(raw.end, work), fold(line.source));
          if (outcome.kind === 'loaded') loaded += 1;
        } catch (err) {
          // Nothing of this line was committed.
          const failure = failureOf(err);
          await this.settle(failure.kind === 'payload' ? { ...next, code: failure.code } : prior);
          this.stall(failure.code, ids);
          return { offset: committed, lines, loaded, stalled: true, cut: false };
        }
      }
      lines += 1;
      lag();
    }
    if (folded > committed) await flush(folded);
    return { offset: committed, lines, loaded, stalled: false, cut: stopped };
  }

  private classify(
    line: ManifestLine,
  ):
    | { kind: 'fetch_ok' | 'fetch_failed' | 'no_adapter' }
    | { kind: 'payload'; spec: SpecLoader; adapterVersion: number } {
    if (line.error !== null) return { kind: 'fetch_failed' };
    if (line.status !== null && line.status >= 400) return { kind: 'fetch_failed' };
    // 304, an identical body (dup_of), a closed gate, 204: the fetch worked and there is nothing new to parse.
    if (line.key === null) return { kind: 'fetch_ok' };
    const found = this.specOf(line.source, line.spec);
    return found === undefined ? { kind: 'no_adapter' } : { kind: 'payload', ...found };
  }

  /**
   * Loads one archived payload. `commit` runs the given work in one
   * transaction, exactly once (the tail adds the cursor and the folded fetch
   * health to it; a replay adds nothing). Returns what happened; a SchemaDrift
   * or a damaged object quarantines that payload only and raises an alert. An
   * object that cannot be read now (`unreadable`) and every database failure
   * are thrown: the tail decides whether to try again.
   */
  async payload(
    line: ManifestLine,
    { spec, adapterVersion }: { spec: SpecLoader; adapterVersion: number },
    fetchedAt: Date,
    commit: (work: (tx: Tx) => Promise<void>) => Promise<void>,
    health?: FetchFold,
  ): Promise<Outcome> {
    if (line.key === null) return { kind: 'no_adapter' };
    const batch = batchInput(line, adapterVersion, fetchedAt);
    const ids = { source: line.source, spec: line.spec };

    const setAside = async (status: 'quarantined' | 'skipped', code: string, path = ''): Promise<Outcome> => {
      await commit((tx) => setBatchAside(tx, batch, status, path === '' ? code : `${code} at ${path}`));
      if (status === 'quarantined') this.deps.alert('quarantined', { ...ids, code });
      return { kind: status, code };
    };

    // The fetch itself worked, whatever the payload turns out to be.
    if (health) markFetchOk(health, fetchedAt);
    if (line.validity !== null && !line.validity.ok) return setAside('skipped', 'failed_validity');
    if (spec.needsVariant && line.variant === '') return setAside('skipped', 'recovered_unattributed');

    let body: Buffer;
    try {
      body = await this.deps.reader.readObject(line.key, spec.maxBytes);
    } catch (err) {
      if (!(err instanceof ArchiveError) || err.code === 'unreadable') throw err;
      if (err.code === 'missing') {
        const skipped = await setAside('skipped', 'object_missing');
        // The recorder writes an object before its line: in the tail, a missing object is news.
        if (health) this.deps.alert('object_missing', ids);
        return skipped;
      }
      return setAside('quarantined', `archive_${err.code}`);
    }
    if (line.sha256 !== null && createHash('sha256').update(body).digest('hex') !== line.sha256) {
      return setAside('quarantined', 'sha256_mismatch');
    }

    const registry = await this.registry(line.source);
    const fillRegistry = spec.fill === undefined ? undefined : await this.registry(spec.fill);
    const zeroRegistry = spec.zeroTarget === undefined ? undefined : await this.registry(spec.zeroTarget);
    const refRegistries =
      spec.refTarget === undefined
        ? undefined
        : new Map(await Promise.all(spec.refTarget.map(async (t) => [t, await this.registry(t)] as const)));
    const unitMismatch = await this.unitMismatch(line.source);
    // A re-stating payload loads from shortly before the previous loaded one (a seed loads whole); read per
    // payload, like the label offsets, which the nightly detector may have changed since the last one.
    const previous =
      spec.window === undefined || line.seed === true
        ? null
        : await previousLoad(this.deps.db, line.source, line.spec, fetchedAt);
    const labelOffsets = spec.labelOffsets === true ? await labelOffsetsOf(this.deps.db, line.source) : undefined;
    let result: Normalised;
    let checked: CheckedRun[];
    try {
      result = await spec.run(body, {
        registry,
        fetchedAt: fetchedAt.getTime(),
        variant: line.variant,
        unitMismatch,
        ...(fillRegistry === undefined ? {} : { fillRegistry }),
        ...(zeroRegistry === undefined ? {} : { zeroRegistry }),
        ...(refRegistries === undefined ? {} : { refRegistries }),
        ...(previous === null || spec.window === undefined ? {} : { since: previous.getTime() - spec.window }),
        ...(labelOffsets === undefined ? {} : { labelOffsets }),
      });
      // P8a: every forecast run passes the core bounds before anything is stored (drift quarantines the payload).
      checked = checkForecasts(result.forecasts, line.source, fetchedAt.getTime(), result.dropped);
      if (result.forecastPart !== undefined) checkPart(result.forecastPart);
    } catch (err) {
      if (err instanceof SchemaDrift) return setAside('quarantined', err.code, err.path);
      // A parser bug must not stall the loader either; the payload stays in the archive for a replay.
      return setAside('quarantined', 'adapter_error');
    }

    dropUnstorable(result);
    // Gap-fill rows go only into an active primary series of the fill source that is not withheld; a key that
    // source does not register is unknown (a registry change could still load it), any other is dropped.
    const fill: ObsRow[] = [];
    const fillUnknown = new Set<string>();
    for (const r of result.fill ?? []) {
      const target = fillRegistry?.get(r.series);
      if (target === undefined) fillUnknown.add(r.series);
      else if (target.role === 'primary' && !target.off) fill.push(r);
      else result.dropped.fill_not_primary = (result.dropped.fill_not_primary ?? 0) + 1;
    }
    // Only the series that share their source's audience count in its numbers (public health, batch counters).
    // A batch's n_rows counts its own rows and its fill rows: an FR-3 payload states each value twice, as a row of
    // its twin series and as a fill row of the FR-1 series of the same key (review CR-6).
    const counted = (key: string) => registry.get(key)?.sameAudience === true;
    const zeroIds = zeroRegistry ?? registry;
    // P7a: references belong to a series of the payload's own source or of a `refTarget` source; a key no
    // registry has is unknown (a registry change could still load it), a withheld (`off`) series takes none.
    const refRegistry = (target: string | undefined) =>
      target === undefined || target === line.source ? registry : refRegistries?.get(target);
    const refs: ResolvedRef[] = [];
    const refUnknown = new Set<string>();
    for (const r of result.references ?? []) {
      const s = refRegistry(r.target)?.get(r.series);
      if (s === undefined) refUnknown.add(`${r.target ?? line.source}\n${r.series}`);
      else if (!s.off) refs.push({ ...r, id: s.id, counted: s.sameAudience });
    }
    const refScope = new Set<number>();
    for (const k of result.refScope ?? []) {
      const s = refRegistry(k.target)?.get(k.series);
      if (s !== undefined && !s.off) refScope.add(s.id);
    }
    // P8a: a forecast run attaches to a primary series of its own source or of a `refTarget` source (DE-2 → DE-1,
    // LU-3 → LU-1); a withheld (`off`) series takes none, a key no registry has is unknown. Every stored point
    // counts in the batch, whatever the series' audience (review C10: a DE-1 series is not DE-2's audience).
    const resolveRuns = (runs: readonly CheckedRun[], dropped: Record<string, number>, unknown: Set<string>) => {
      const out: ResolvedRun[] = [];
      for (const r of runs) {
        const s = refRegistry(r.target)?.get(r.series);
        if (s === undefined) unknown.add(`${r.target ?? line.source}\n${r.series}`);
        else if (s.off) continue;
        else if (s.role !== 'primary') dropped.forecast_not_primary = (dropped.forecast_not_primary ?? 0) + 1;
        else out.push({ seriesId: s.id, run: r.run });
      }
      return out;
    };
    const forecastUnknown = new Set<string>();
    const forecasts = resolveRuns(checked, result.dropped, forecastUnknown);
    const headDrops = forecastDecl(line.source)?.headDrops ?? false;
    const points = (runs: readonly ResolvedRun[]) => runs.reduce((n, r) => n + r.run.points.length, 0);
    const classes = result.classes ?? [];
    boundWarnings(result);
    const warningRows = result.warnings?.rows.length ?? 0;
    let nObs = 0;
    for (const part of obsParts(result)) nObs += part.filter((r) => counted(r.series)).length;
    // Class rows count once the loader knows which stations take them (review CR-12).
    const n_rows_base =
      nObs +
      result.gaugeZeros.filter((z) => zeroIds.get(z.series)?.sameAudience === true).length +
      fill.length +
      refs.filter((r) => r.counted).length +
      warningRows +
      points(forecasts);
    let n_rows = n_rows_base;
    // Values a registry or parser change could still load: the pruner keeps this object until a replay stores them.
    const n_skipped_base =
      result.unknown +
      fillUnknown.size +
      refUnknown.size +
      forecastUnknown.size +
      RETAINED.reduce((n, code) => n + (result.dropped[code] ?? 0), 0);
    let n_skipped = n_skipped_base;
    let outcome: Outcome = { kind: 'loaded', n_rows, n_new: 0, n_changed: 0 };
    let zeroChanges: Awaited<ReturnType<typeof applyGaugeZeros>> = {};
    let refChanges: Changes = {};
    let warnChanges: Changes = {};
    let classChanged = 0;
    let closesFull = false;
    let units: Set<string> | undefined;
    const before = health && { newestTs: health.newestTs, lastNewData: health.lastNewData };
    const touches: Record<DirtyKind, Touch[]> = {
      obs: [],
      forecast: [],
      reference: [],
      class: [],
      warning: [],
      gauge_zero: [],
    };
    await commit(async (tx) => {
      for (const list of Object.values(touches)) list.length = 0;
      const state = await openBatch(tx, batch, 'ok');
      // A large payload comes in chunks of whole series (Normalised.obsChunks): one upsert each, one batch.
      let written: Written = { n_new: 0, n_changed: 0, newest: null, writes: 0 };
      for (const part of obsParts(result)) {
        const w = await upsertObs(tx, part, registry, state.id, fetchedAt, false, touches.obs);
        written = {
          n_new: written.n_new + w.n_new,
          n_changed: written.n_changed + w.n_changed,
          newest:
            written.newest === null || (w.newest !== null && w.newest > written.newest) ? w.newest : written.newest,
          writes: written.writes + w.writes,
        };
      }
      const filled =
        fill.length === 0 || fillRegistry === undefined
          ? { n_new: 0, n_changed: 0, writes: 0 }
          : await upsertObs(tx, fill, fillRegistry, state.id, fetchedAt, true, touches.obs);
      zeroChanges = await applyGaugeZeros(tx, result.gaugeZeros, zeroIds, state.id, fetchedAt, touches.gauge_zero);
      const refsApplied = await applyReferences(
        tx,
        line.source,
        refs,
        refScope,
        state.id,
        fetchedAt,
        touches.reference,
      );
      const cls = await applyClasses(tx, line.source, classes, state.id, fetchedAt, touches.class);
      const warn = await applyWarnings(tx, line.source, result.warnings, state.id, fetchedAt, touches.warning);
      if (result.providerUpdated !== undefined) await storeProviderUpdated(tx, line.source, result.providerUpdated);
      const fw = await applyForecasts(tx, line.source, forecasts, state.id, fetchedAt, headDrops, touches.forecast);
      const staged = await this.stage(tx, line, spec, result, refRegistry, state.id, fetchedAt, touches.forecast);
      // P9a: what the publishers render again, and the settled days this payload revised (under the loader lock).
      const maps = [registry, fillRegistry, zeroRegistry, ...(refRegistries?.values() ?? [])];
      await markDirty(tx, this.deps.now(), await this.dirtyEntries(line.source, touches, maps));
      const fc: ForecastWritten = {
        n_new: fw.n_new + staged.written.n_new,
        n_changed: fw.n_changed + staged.written.n_changed,
        writes: fw.writes + staged.written.writes,
        ambiguous: fw.ambiguous + staged.written.ambiguous,
        collision: fw.collision + staged.written.collision,
      };
      if (fc.ambiguous > 0) result.dropped.forecast_ambiguous = (result.dropped.forecast_ambiguous ?? 0) + fc.ambiguous;
      if (fc.collision > 0) result.dropped.forecast_collision = (result.dropped.forecast_collision ?? 0) + fc.collision;
      refChanges = refsApplied.changes;
      warnChanges = warn.changes;
      classChanged = cls.changed;
      closesFull = warn.full;
      n_rows = n_rows_base + cls.kept + staged.rows;
      n_skipped = n_skipped_base + cls.unknown + staged.skipped;
      if (result.unitMismatch !== undefined) {
        units = await storeUnitMismatch(tx, line.source, fetchedAt, result.unitMismatch);
      }
      const zeroWrites =
        (zeroChanges.new ?? 0) +
        (zeroChanges.corrected ?? 0) +
        (zeroChanges.superseded ?? 0) +
        (zeroChanges.changed ?? 0);
      const opened = (c: Changes) => (c.new ?? 0) + (c.changed ?? 0);
      const corrected = (c: Changes) => (c.corrected ?? 0) + (c.removed ?? 0);
      // The batch's own numbers include its fill rows (their provenance); the source's health does not.
      const n_new =
        written.n_new +
        filled.n_new +
        (zeroChanges.new ?? 0) +
        (zeroChanges.superseded ?? 0) +
        (zeroChanges.changed ?? 0) +
        opened(refChanges) +
        cls.new +
        cls.changed +
        opened(warnChanges) +
        fc.n_new;
      const n_changed =
        written.n_changed +
        filled.n_changed +
        (zeroChanges.corrected ?? 0) +
        corrected(refChanges) +
        corrected(warnChanges) +
        fc.n_changed;
      outcome = { kind: 'loaded', n_rows, n_new, n_changed };
      // A replay that changes nothing leaves the batch exactly as the first load wrote it.
      const changed =
        written.writes + filled.writes + zeroWrites + refsApplied.writes + cls.writes + warn.writes + fc.writes > 0 ||
        state.skipped !== n_skipped;
      if (!state.existed || changed || state.previous !== 'ok') {
        await closeBatch(tx, state.id, batch, { status: 'ok', n_rows, n_new, n_changed, n_skipped, error: null });
      }
      if (health && written.newest !== null) {
        if (health.newestTs === null || written.newest > health.newestTs) health.newestTs = written.newest;
        if (written.n_new > 0 && (health.lastNewData === null || fetchedAt > health.lastNewData)) {
          health.lastNewData = fetchedAt;
        }
      }
    }).catch((err: unknown) => {
      // Nothing was committed: the fold must not remember rows that were rolled back.
      if (health && before) Object.assign(health, before);
      throw err;
    });
    if (units !== undefined) this.units.set(line.source, units);

    // Tail only (a replay reports nothing new), once per UTC day.
    if (health && spec.drift) {
      const declared = spec.driftSource === undefined ? registry : await this.registry(spec.driftSource);
      await this.reportDrift(line, spec.drift, body, declared, fetchedAt);
    }
    for (const code of RETAINED) {
      const n = result.dropped[code] ?? 0;
      if (n > 0) this.deps.alert(code, { ...ids, n });
    }
    for (const change of ['corrected', 'superseded', 'changed'] as const) {
      const n = zeroChanges[change] ?? 0;
      if (n > 0) this.deps.alert(`gauge_zero_${change}`, { ...ids, n });
    }
    // P7a: a changed, removed or corrected reference and a changed class or warning are alerted by count only:
    // the text names no value (an owner-audience threshold must not reach a log; the details are in the views).
    for (const change of ['changed', 'removed', 'corrected'] as const) {
      const n = refChanges[change] ?? 0;
      if (n > 0) this.deps.alert(`reference_${change}`, { ...ids, n });
    }
    if (classChanged > 0) this.deps.alert('class_changed', { ...ids, n: classChanged });
    const warned = (warnChanges.new ?? 0) + (warnChanges.changed ?? 0) + (warnChanges.removed ?? 0);
    if (warned > 0) this.deps.alert('warning_changed', { ...ids, n: warned });
    if (closesFull) this.deps.alert('cap_closes_full', { ...ids, n: 1 });
    if (result.unknown > 0) this.deps.info?.('series not in the registry', { ...ids, n: result.unknown });
    return outcome;
  }

  /**
   * P8a: stages a part of a run that spans several payloads (LU-3: one percentile file) inside the payload's
   * transaction, and stores the run once its group is complete (`SpecLoader.combine`), with the fetch time of the
   * group's earliest part. A part of an unknown series is counted, of a withheld (`off`) one is not staged (Gemünd).
   * The counts it adds to `result.dropped` (evicted or refused groups, the combined runs' drops) are returned too.
   */
  private async stage(
    tx: Tx,
    line: ManifestLine,
    spec: SpecLoader,
    result: Normalised,
    refRegistry: (target: string | undefined) => ReadonlyMap<string, SeriesRow> | undefined,
    batch: string,
    fetchedAt: Date,
    touched: Touch[] = [],
  ): Promise<{ written: ForecastWritten; rows: number; skipped: number }> {
    const none: ForecastWritten = { n_new: 0, n_changed: 0, writes: 0, ambiguous: 0, collision: 0 };
    const part = result.forecastPart;
    if (part === undefined || spec.combine === undefined) return { written: none, rows: 0, skipped: 0 };
    const s = refRegistry(part.target)?.get(part.series);
    if (s === undefined) return { written: none, rows: 0, skipped: 1 };
    if (s.off || s.role !== 'primary') return { written: none, rows: 0, skipped: 0 };
    const add = (code: string, n: number) => {
      if (n > 0) result.dropped[code] = (result.dropped[code] ?? 0) + n;
    };
    const before = RETAINED.reduce((n, code) => n + (result.dropped[code] ?? 0), 0);
    const { complete, evicted } = await stagePart(
      tx,
      line.source,
      part,
      spec.combine.parts,
      fetchedAt,
      this.deps.now(),
    );
    add('incomplete_run', evicted);
    let written = none;
    let rows = 0;
    const unknown = new Set<string>();
    if (complete !== null) {
      const at = Math.min(...complete.map((p) => p.fetchedAt));
      const dropped: Record<string, number> = {};
      let runs: CheckedRun[] = [];
      try {
        const combined = spec.combine.run(complete);
        for (const [code, n] of Object.entries(combined.dropped)) dropped[code] = (dropped[code] ?? 0) + n;
        runs = checkForecasts(combined.runs, line.source, at, dropped);
      } catch (err) {
        if (!(err instanceof SchemaDrift)) throw err;
        dropped.combine_drift = (dropped.combine_drift ?? 0) + 1;
      }
      for (const [code, n] of Object.entries(dropped)) add(code, n);
      const resolved: ResolvedRun[] = [];
      for (const r of runs) {
        const t = refRegistry(r.target)?.get(r.series);
        if (t === undefined) unknown.add(`${r.target ?? line.source}\n${r.series}`);
        else if (!t.off && t.role === 'primary') resolved.push({ seriesId: t.id, run: r.run });
      }
      rows = resolved.reduce((n, r) => n + r.run.points.length, 0);
      const headDrops = forecastDecl(line.source)?.headDrops ?? false;
      written = await applyForecasts(tx, line.source, resolved, batch, new Date(at), headDrops, touched);
    }
    const after = RETAINED.reduce((n, code) => n + (result.dropped[code] ?? 0), 0);
    return { written, rows, skipped: after - before + unknown.size };
  }

  /**
   * The registry drift report (issue #17): stored in app_meta for the owner
   * and the runbook, alerted when a registered series vanished or the payload
   * states something else than its declaration (unit, step, position). It
   * never changes the registry and never fails a load.
   */
  private async reportDrift(
    line: ManifestLine,
    drift: NonNullable<SpecLoader['drift']>,
    body: Uint8Array,
    registry: Map<string, SeriesRow>,
    fetchedAt: Date,
  ): Promise<void> {
    const day = fetchedAt.toISOString().slice(0, 10);
    const slot = `${line.source}/${line.spec}`;
    if (this.driftDay.get(slot) === day) return;
    this.driftDay.set(slot, day);
    try {
      const report = drift(body, registry);
      await writeMeta(this.deps.db, `registry_drift:${line.source}`, {
        at: fetchedAt.toISOString(),
        spec: line.spec,
        ...report,
      });
      const counts = {
        unregistered: report.unregistered.length,
        vanished: report.vanished.length,
        changed: report.changed.length,
      };
      if (counts.vanished + counts.changed > 0) this.deps.alert('registry_drift', { source: line.source, ...counts });
      else if (counts.unregistered > 0) this.deps.info?.('registry drift', { source: line.source, ...counts });
    } catch {
      // A report, not a load: try again tomorrow.
    }
  }
}

/** A manifest line, or null when it is not one (damage, or a version this loader does not know). */
export function parseLine(text: string): ManifestLine | null {
  if (text === '') return null;
  try {
    const parsed = ManifestLine.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function markFetchOk(f: FetchFold, at: Date): void {
  if (f.lastOk === null || at > f.lastOk) f.lastOk = at;
  f.failures = 0;
  f.reset = true;
}

/**
 * What a failed payload means. `payload`: the failure belongs to this payload
 * (a constraint, a bad value, a bug that its data triggers: SQLSTATE classes
 * 21, 22, 23 and P0; an object that cannot be read) and counts towards its
 * quarantine, with the code the batch gets then. `stall`: the database, the
 * deployment or the archive is at fault (a connection, a lock timeout, anything
 * we cannot name, and every class 42 and 0A error: with bound parameters a
 * payload's values cannot cause a syntax or access-rule error, so our SQL or
 * schema did), so the tail waits and tries again for as long as it takes;
 * `code` is what the alert names.
 */
export function failureOf(err: unknown): { kind: 'payload' | 'stall'; code: string } {
  if (err instanceof ArchiveError) return { kind: 'payload', code: `archive_${err.code}` };
  const code = errorCode(err);
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return /^(?:21|22|23|P0)/.test(code) ? { kind: 'payload', code: 'load_error' } : { kind: 'stall', code };
  }
  if (err instanceof TypeError || err instanceof RangeError) return { kind: 'payload', code: 'load_error' };
  return { kind: 'stall', code };
}

function batchInput(line: ManifestLine, adapterVersion: number, fetchedAt: Date): BatchInput {
  return {
    source: line.source,
    spec: line.spec,
    key: line.key as string,
    sha256: line.sha256,
    fetchedAt,
    status: line.status,
    bytes: line.bytes,
    adapterVersion,
  };
}
