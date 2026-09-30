import { createHash } from 'node:crypto';
import { type Normalised, SchemaDrift } from '@rws/core';
import type { Kysely } from 'kysely';
import { ManifestLine } from '../archive/manifest.ts';
import { ArchiveError, type ArchiveReader, type RawLine } from '../archive/reader.ts';
import type { DB } from '../db/generated.ts';
import { LOAD_ADAPTERS, type LoadAdapter, type SpecLoader } from './adapters.ts';
import {
  advanceCursor,
  applyFetchHealth,
  applyGaugeZeros,
  type BatchInput,
  closeBatch,
  cursors,
  emptyFold,
  type FetchFold,
  lock,
  openBatch,
  type SeriesRow,
  seriesOf,
  type Tx,
  upsertObs,
} from './store.ts';

// The loader (A§7.4 steps 1–5): it tails the manifest from load_cursor and
// turns each archived payload into rows. One payload is one transaction:
// observations, revisions, latest values, rollups, the batch row, the source's
// health and the cursor commit together or not at all, so a kill -9 anywhere
// neither loses, skips nor double-applies a manifest line.

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

/** A poison payload must not stall every source: after this many deterministic failures it is quarantined. */
const MAX_ATTEMPTS = 3;

export class Loader {
  private readonly deps: LoadDeps;
  private readonly series = new Map<string, Map<string, SeriesRow>>();
  private readonly attempts = new Map<string, number>();
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

  private async registry(source: string): Promise<Map<string, SeriesRow>> {
    let known = this.series.get(source);
    if (known === undefined) {
      known = await seriesOf(this.deps.db, source);
      this.series.set(source, known);
    }
    return known;
  }

  /**
   * One pass over every manifest file that has unread bytes. Late lines land
   * in older files (a line is filed under the day its fetch STARTED, and the
   * recorder's recovery appends to past days), so no file is ever "done".
   */
  async tick(): Promise<{ lines: number; loaded: number }> {
    const done = await cursors(this.deps.db);
    let lines = 0;
    let loaded = 0;
    for (const { file, size } of await this.deps.reader.manifests()) {
      let offset = done.get(file) ?? 0;
      while (offset < size) {
        const chunk = await this.deps.reader.lines(file, offset);
        if (chunk.length === 0) break;
        const result = await this.consume(file, offset, chunk);
        lines += result.lines;
        loaded += result.loaded;
        if (result.stalled) return { lines, loaded };
        offset = result.offset;
      }
    }
    return { lines, loaded };
  }

  /** Bytes of manifest not yet consumed, over all files. */
  async backlog(): Promise<{ files: number; bytes: number }> {
    const done = await cursors(this.deps.db);
    let files = 0;
    let bytes = 0;
    for (const { file, size } of await this.deps.reader.manifests()) {
      const left = size - (done.get(file) ?? 0);
      if (left > 0) {
        files += 1;
        bytes += left;
      }
    }
    return { files, bytes };
  }

  /**
   * Consumes whole lines in file order, starting at byte `start`. Lines without
   * a payload (304, dup_of, a closed gate, a fetch error, a source without an
   * adapter) only touch the fetch health; they are folded and committed
   * together with the next payload line or at the end of the chunk. Returns
   * the committed offset; `stalled` means a line could not be committed now
   * and the next tick starts again from that offset.
   */
  private async consume(
    file: string,
    start: number,
    chunk: readonly RawLine[],
  ): Promise<{ offset: number; lines: number; loaded: number; stalled: boolean }> {
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
    const flush = async (end: number, work?: (tx: Tx) => Promise<void>) => {
      await this.deps.db.transaction().execute(async (tx) => {
        await lock(tx);
        if (work) await work(tx);
        for (const [source, f] of pending) await applyFetchHealth(tx, source, f);
        await advanceCursor(tx, file, end);
      });
      pending.clear();
      committed = end;
      folded = end;
    };

    for (const raw of chunk) {
      const line = parseLine(raw.text);
      if (line === null) {
        this.badLines += 1;
        this.deps.alert('manifest_bad_line', { file });
        folded = raw.end;
        lines += 1;
        continue;
      }
      const fetchedAt = new Date(line.fetched_at.end ?? line.fetched_at.start);
      const lag = () => this.deps.onLag?.(line.source, fetchedAt, this.deps.now().getTime() - fetchedAt.getTime());
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
      const key = line.key as string;
      try {
        const outcome = await this.payload(line, plan, fetchedAt, (work) => flush(raw.end, work), fold(line.source));
        if (outcome.kind === 'loaded') loaded += 1;
      } catch (err) {
        // Nothing of this line was committed. A connection-level failure, or anything we cannot name,
        // is tried again next tick for as long as it takes; a failure that belongs to this payload
        // (a constraint, a bug in its parser) must not stall every source for ever.
        const n = isDeterministic(err) ? (this.attempts.get(key) ?? 0) + 1 : 0;
        if (n < MAX_ATTEMPTS) {
          if (n > 0) this.attempts.set(key, n);
          return { offset: committed, lines, loaded, stalled: true };
        }
        const batch = batchInput(line, plan.adapterVersion, fetchedAt);
        await flush(raw.end, async (tx) => {
          const state = await openBatch(tx, batch, 'quarantined');
          await closeBatch(tx, state.id, batch, {
            status: 'quarantined',
            n_rows: 0,
            n_new: 0,
            n_changed: 0,
            error: 'load_error',
          });
        });
        this.deps.alert('quarantined', { source: line.source, spec: line.spec, code: 'load_error' });
      }
      this.attempts.delete(key);
      lines += 1;
      lag();
    }
    if (folded > committed) await flush(folded);
    return { offset: committed, lines, loaded, stalled: false };
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
   * or an unreadable object quarantines that payload only and raises an alert.
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

    const setAside = async (status: 'quarantined' | 'skipped', code: string, path = ''): Promise<Outcome> => {
      const error = path === '' ? code : `${code} at ${path}`;
      await commit(async (tx) => {
        const state = await openBatch(tx, batch, status);
        // A replay never downgrades a payload that loaded before (e.g. its object was pruned since).
        if (state.existed && state.previous === 'ok') return;
        await closeBatch(tx, state.id, batch, { status, n_rows: 0, n_new: 0, n_changed: 0, error });
      });
      if (status === 'quarantined') this.deps.alert('quarantined', { source: line.source, spec: line.spec, code });
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
      if (!(err instanceof ArchiveError)) throw err;
      if (err.code === 'missing') return setAside('skipped', 'object_missing');
      return setAside('quarantined', `archive_${err.code}`);
    }
    if (line.sha256 !== null && createHash('sha256').update(body).digest('hex') !== line.sha256) {
      return setAside('quarantined', 'sha256_mismatch');
    }

    const registry = await this.registry(line.source);
    let result: Normalised;
    try {
      result = spec.run(body, { registry, fetchedAt: fetchedAt.getTime(), variant: line.variant });
    } catch (err) {
      if (err instanceof SchemaDrift) return setAside('quarantined', err.code, err.path);
      // A parser bug must not stall the loader either; the payload stays in the archive for a replay.
      return setAside('quarantined', 'adapter_error');
    }

    let outcome: Outcome = { kind: 'loaded', n_rows: 0, n_new: 0, n_changed: 0 };
    let zeroChanges: Awaited<ReturnType<typeof applyGaugeZeros>> = {};
    const before = health && { newestTs: health.newestTs, lastNewData: health.lastNewData };
    await commit(async (tx) => {
      const state = await openBatch(tx, batch, 'ok');
      const written = await upsertObs(tx, result.obs, registry, state.id, fetchedAt);
      zeroChanges = await applyGaugeZeros(tx, result.gaugeZeros, registry, state.id);
      const zeroWrites = (zeroChanges.new ?? 0) + (zeroChanges.corrected ?? 0) + (zeroChanges.superseded ?? 0);
      const n_rows = result.obs.length + result.gaugeZeros.length;
      outcome = { kind: 'loaded', n_rows, n_new: written.n_new, n_changed: written.n_changed };
      // A replay that changes nothing leaves the batch exactly as the first load wrote it.
      const changed = written.n_new + written.n_changed + zeroWrites > 0;
      if (!state.existed || changed || state.previous !== 'ok') {
        await closeBatch(tx, state.id, batch, {
          status: 'ok',
          n_rows,
          n_new: written.n_new + (zeroChanges.new ?? 0) + (zeroChanges.superseded ?? 0),
          n_changed: written.n_changed + (zeroChanges.corrected ?? 0),
          error: null,
        });
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

    const ids = { source: line.source, spec: line.spec };
    if ((result.dropped.unit_mismatch ?? 0) > 0)
      this.deps.alert('unit_mismatch', { ...ids, n: result.dropped.unit_mismatch ?? 0 });
    if ((result.dropped.unknown_zero_unit ?? 0) > 0)
      this.deps.alert('unknown_zero_unit', { ...ids, n: result.dropped.unknown_zero_unit ?? 0 });
    for (const change of ['corrected', 'superseded', 'older_ignored'] as const) {
      const n = zeroChanges[change] ?? 0;
      if (n > 0) this.deps.alert(`gauge_zero_${change}`, { ...ids, n });
    }
    if (result.unknown > 0) this.deps.info?.('series not in the registry', { ...ids, n: result.unknown });
    return outcome;
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

/** A failure that belongs to the statement or its data (a constraint, a bad value, a bug): retrying cannot fix it. */
function isDeterministic(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return /^(?:0A|21|22|23|42|P0)/.test(code);
  return err instanceof TypeError || err instanceof RangeError || err instanceof LoadError;
}

export class LoadError extends Error {}

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
