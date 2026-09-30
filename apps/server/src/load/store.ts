import type { GaugeZeroRow, ObsRow, SeriesDecl } from '@rws/core';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { DB } from '../db/generated.ts';

// The loader's SQL (A§8 Q6 and the rollups of catalogue §6.4), all of it
// parameterised. Every function runs inside the caller's transaction, which
// holds the loader lock, so load, replay, the health pass and the nightly
// reconciliation never interleave.

export type Tx = Transaction<DB>;

/**
 * One writer at a time: a rollup is recomputed from rows that no other
 * transaction is changing. The lock is a row lock on app_meta `loader_lock`
 * (the migration creates the row), which only rws_load can take: the reader
 * roles have no privilege on app_meta, so no reader session can hold the
 * loader up. A wait longer than 30 s fails the transaction (55P03), which the
 * loader treats as a transient stall: it alerts and tries again.
 */
export async function lock(tx: Tx): Promise<void> {
  await sql`SET LOCAL lock_timeout = '30s'`.execute(tx);
  const { rows } = await sql`SELECT 1 FROM app_meta WHERE key = 'loader_lock' FOR UPDATE`.execute(tx);
  // Without the row there is no mutual exclusion at all: never write then.
  if (rows.length !== 1) throw Object.assign(new Error('loader_lock_missing'), { code: 'loader_lock_missing' });
}

/** A small JSON value of app_meta (the loader's own state; no reader role can see this table). */
export async function readMeta<T>(db: Kysely<DB>, key: string): Promise<T | undefined> {
  const { rows } = await sql<{ value: T }>`SELECT value FROM app_meta WHERE key = ${key}`.execute(db);
  return rows[0]?.value;
}

export async function writeMeta(db: Kysely<DB>, key: string, value: unknown): Promise<void> {
  await sql`
    INSERT INTO app_meta (key, value, updated_at) VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`.execute(db);
}

/**
 * The tail's attempt at one payload (S1): `n` passes began, and `code` says
 * how the last one ended: `load_crashed` while it runs (so a process that dies
 * mid-payload leaves exactly that), else the fixed code of a failure that
 * belongs to the payload. Written in its own transaction before the payload is
 * touched; asynchronous commit is enough for a counter the database server
 * keeps even when our process dies.
 */
export type Attempt = { key: string; n: number; code: string };
const ATTEMPT = 'load_attempt';

export const readAttempt = (db: Kysely<DB>) => readMeta<Attempt>(db, ATTEMPT);

export async function writeAttempt(db: Kysely<DB>, attempt: Attempt): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`SET LOCAL synchronous_commit = off`.execute(tx);
    await writeMeta(tx, ATTEMPT, attempt);
  });
}

/**
 * The series keys of a source whose unit its newest unit-stating payload (the
 * DE-1 basin call) showed changed. Kept per source with that payload's fetch
 * time: an older payload (a late line, a replay) never replaces a newer list.
 */
type UnitMismatch = { at: string; keys: string[] };
const unitKey = (source: string) => `unit_mismatch:${source}`;

export async function unitMismatchOf(db: Kysely<DB>, source: string): Promise<Set<string>> {
  return new Set((await readMeta<UnitMismatch>(db, unitKey(source)))?.keys ?? []);
}

/** Returns the list now in force for the source (the stored one when this payload is older). */
export async function storeUnitMismatch(tx: Tx, source: string, at: Date, keys: string[]): Promise<Set<string>> {
  const current = await readMeta<UnitMismatch>(tx, unitKey(source));
  if (current !== undefined && Date.parse(current.at) > at.getTime()) return new Set(current.keys);
  await writeMeta(tx, unitKey(source), { at: at.toISOString(), keys });
  return new Set(keys);
}

/** Buckets are UTC, whatever the session's time zone is. */
const ORIGIN = sql`timestamptz '2000-01-01 00:00:00+00'`;

export type SeriesRow = SeriesDecl & {
  id: number;
  tier: number;
  /** Its effective audience is `off`: the loader stores nothing for it. */
  off: boolean;
  /** It shares its source's audience: only such series count in the source's health and batch numbers. */
  sameAudience: boolean;
};

/** The registered series of a source by provider key. Read once per process: the registry changes only at a deploy. */
export async function seriesOf(db: Kysely<DB>, source: string): Promise<Map<string, SeriesRow>> {
  const { rows } = await sql<{
    id: number;
    key: string;
    quantity: 'H' | 'Q';
    native_unit: string;
    to_canonical: number;
    value_kind: 'stage' | 'level' | null;
    native_step_ms: number;
    expected_step_ms: number;
    tier: number;
    off: boolean;
    same_audience: boolean;
  }>`
    SELECT s.id, s.provider_key AS key, s.quantity, s.native_unit, s.to_canonical, s.value_kind,
           (EXTRACT(EPOCH FROM s.native_step) * 1000)::double precision AS native_step_ms,
           (EXTRACT(EPOCH FROM s.expected_step) * 1000)::double precision AS expected_step_ms, st.tier,
           LEAST(src.audience, COALESCE(s.audience, src.audience)) = 'off' AS off,
           COALESCE(s.audience, src.audience) = src.audience AS same_audience
    FROM series s JOIN station st ON st.id = s.station_id JOIN source src ON src.id = s.source_id
    WHERE s.source_id = ${source} AND s.active`.execute(db);
  return new Map(
    rows.map((r) => [
      r.key,
      {
        id: r.id,
        key: r.key,
        quantity: r.quantity,
        native_unit: r.native_unit,
        to_canonical: r.to_canonical,
        value_kind: r.value_kind,
        native_step_ms: r.native_step_ms,
        expected_step_ms: r.expected_step_ms,
        tier: r.tier,
        off: r.off,
        sameAudience: r.same_audience,
      },
    ]),
  );
}

export type Written = {
  /** Rows inserted, and rows whose value or qc changed, of the series that share their source's audience. */
  n_new: number;
  n_changed: number;
  /** The newest timestamp among those rows. */
  newest: Date | null;
  /** Every row written, confirmations and narrowed series included. */
  writes: number;
};

type Series = Pick<SeriesRow, 'id' | 'off' | 'sameAudience'>;

/**
 * Q6: the idempotent upsert with its revision log, plus obs_latest and the
 * rollups of the touched buckets. Rules that keep it correct:
 *  - the input is `real[]`, so a value is compared as the type it is stored in;
 *  - a timestamp that occurs twice in one payload keeps its last value;
 *  - newest fetch wins: the stored row of a point is what the payload with the
 *    greatest (fetched_at, batch id) among all that stated it says, whatever
 *    order they arrive in. A point is written only when the batch that holds it
 *    is older than this one; the batch itself (a replay) or a newer one leaves
 *    it alone, so a replay writes nothing and a late payload reverts nothing;
 *  - a newer fetch that states the same value and qc is a confirmation: the
 *    row's batch_id moves to it (and obs_latest's, for the latest row), with no
 *    revision, no rollup and no count, so a late payload fetched in between
 *    cannot overwrite it;
 *  - a changed value or qc writes exactly one obs_revision row. The revision
 *    log records the changes of the stored value in the order they were
 *    stored, so it is the one thing here that depends on arrival order.
 */
// ponytail: every re-statement of an unchanged point rewrites its batch_id (about six row updates per insert
// for DE-1's hourly PT6H window). If obs bloat shows, keep the newest fetch per series in a coverage table,
// or lower obs's fillfactor for HOT updates.
export async function upsertObs(
  tx: Tx,
  rows: readonly ObsRow[],
  ids: ReadonlyMap<string, Series>,
  batch: string,
  fetchedAt: Date,
): Promise<Written> {
  const none: Written = { n_new: 0, n_changed: 0, newest: null, writes: 0 };
  const sid: number[] = [];
  const ts: string[] = [];
  const value: number[] = [];
  const qc: number[] = [];
  const counted = new Set<number>();
  for (const r of rows) {
    const series = ids.get(r.series);
    if (series === undefined || !Number.isFinite(r.value)) throw new RangeError('load: row outside the registry');
    if (series.off) continue;
    if (series.sameAudience) counted.add(series.id);
    sid.push(series.id);
    ts.push(r.ts);
    value.push(r.value);
    qc.push(r.qc);
  }
  if (sid.length === 0) return none;
  const sorted = [...ts].sort();
  await sql`SELECT ensure_partitions(${sorted[0]}::timestamptz, ${sorted.at(-1)}::timestamptz)`.execute(tx);

  const { rows: written } = await sql<{ series_id: number; ts: Date; inserted: boolean; changed: boolean }>`
    WITH incoming AS (
      SELECT DISTINCT ON (i.series_id, i.ts) i.series_id, i.ts, i.value, i.qc
      FROM unnest(${sid}::int[], ${ts}::timestamptz[], ${value}::real[], ${qc}::int2[])
           WITH ORDINALITY AS i(series_id, ts, value, qc, ord)
      ORDER BY i.series_id, i.ts, i.ord DESC
    ),
    older AS (
      SELECT i.series_id, i.ts, i.value, i.qc
      FROM incoming i
      LEFT JOIN obs o ON o.series_id = i.series_id AND o.ts = i.ts
      LEFT JOIN ingest_batch b ON b.id = o.batch_id
      WHERE o.series_id IS NULL OR b.id IS NULL
         OR (b.fetched_at, b.id) < (${fetchedAt}::timestamptz, ${batch}::bigint)
    ),
    up AS (
      INSERT INTO obs AS o (series_id, ts, value, qc, batch_id)
      SELECT series_id, ts, value, qc, ${batch}::bigint FROM older
      ON CONFLICT (series_id, ts) DO UPDATE
        SET value = EXCLUDED.value, qc = EXCLUDED.qc, batch_id = EXCLUDED.batch_id
      RETURNING old.series_id AS old_series, old.value AS old_value, old.qc AS old_qc,
                new.series_id, new.ts, new.value, new.qc
    ),
    revision AS (
      INSERT INTO obs_revision (series_id, ts, old_value, new_value, old_qc, new_qc, batch_id)
      SELECT series_id, ts, old_value, value, old_qc, qc, ${batch}::bigint FROM up
      WHERE old_series IS NOT NULL AND (old_value, old_qc) IS DISTINCT FROM (value, qc)
    ),
    latest AS (
      INSERT INTO obs_latest AS l (series_id, ts, value, qc, batch_id)
      SELECT DISTINCT ON (series_id) series_id, ts, value, qc, ${batch}::bigint FROM up
      ORDER BY series_id, ts DESC
      ON CONFLICT (series_id) DO UPDATE
        SET ts = EXCLUDED.ts, value = EXCLUDED.value, qc = EXCLUDED.qc, batch_id = EXCLUDED.batch_id
        WHERE EXCLUDED.ts >= l.ts
    )
    SELECT series_id, ts, old_series IS NULL AS inserted,
           (old_value, old_qc) IS DISTINCT FROM (value, qc) AS changed
    FROM up`.execute(tx);
  const changed = written.filter((w) => w.changed);
  if (changed.length === 0) return { ...none, writes: written.length };

  const wSid = changed.map((w) => w.series_id);
  const wTs = changed.map((w) => w.ts);
  // The rollups of every (series, bucket) this batch touched, recomputed from obs (catalogue §6.4 query 3).
  await sql`
    INSERT INTO obs_1h AS r (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
    SELECT o.series_id, t.bucket, min(o.value), max(o.value), avg(o.value)::real,
           (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)
    FROM (SELECT DISTINCT w.series_id, date_bin('1 hour', w.ts, ${ORIGIN}) AS bucket
          FROM unnest(${wSid}::int[], ${wTs}::timestamptz[]) AS w(series_id, ts)) t
    JOIN obs o ON o.series_id = t.series_id AND o.ts >= t.bucket AND o.ts < t.bucket + interval '1 hour'
    GROUP BY o.series_id, t.bucket
    ON CONFLICT (series_id, bucket) DO UPDATE
      SET vmin = EXCLUDED.vmin, vmax = EXCLUDED.vmax, vavg = EXCLUDED.vavg, vlast = EXCLUDED.vlast,
          n = EXCLUDED.n, qc_or = EXCLUDED.qc_or
      WHERE (r.vmin, r.vmax, r.vavg, r.vlast, r.n, r.qc_or)
            IS DISTINCT FROM (EXCLUDED.vmin, EXCLUDED.vmax, EXCLUDED.vavg, EXCLUDED.vlast, EXCLUDED.n, EXCLUDED.qc_or)`.execute(
    tx,
  );
  await sql`
    INSERT INTO obs_1d AS r (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
    SELECT o.series_id, t.bucket, min(o.value), max(o.value), avg(o.value)::real,
           (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)
    FROM (SELECT DISTINCT w.series_id, date_bin('1 day', w.ts, ${ORIGIN}) AS bucket
          FROM unnest(${wSid}::int[], ${wTs}::timestamptz[]) AS w(series_id, ts)) t
    JOIN obs o ON o.series_id = t.series_id AND o.ts >= t.bucket AND o.ts < t.bucket + interval '1 day'
    GROUP BY o.series_id, t.bucket
    ON CONFLICT (series_id, bucket) DO UPDATE
      SET vmin = EXCLUDED.vmin, vmax = EXCLUDED.vmax, vavg = EXCLUDED.vavg, vlast = EXCLUDED.vlast,
          n = EXCLUDED.n, qc_or = EXCLUDED.qc_or
      WHERE (r.vmin, r.vmax, r.vavg, r.vlast, r.n, r.qc_or)
            IS DISTINCT FROM (EXCLUDED.vmin, EXCLUDED.vmax, EXCLUDED.vavg, EXCLUDED.vlast, EXCLUDED.n, EXCLUDED.qc_or)`.execute(
    tx,
  );

  const mine = changed.filter((w) => counted.has(w.series_id));
  let newest: Date | null = null;
  for (const w of mine) if (newest === null || w.ts > newest) newest = w.ts;
  const n_new = mine.filter((w) => w.inserted).length;
  return { n_new, n_changed: mine.length - n_new, newest, writes: written.length };
}

export type ZeroChange = 'new' | 'corrected' | 'superseded' | 'older_ignored';

/**
 * The current gauge zero (PNP) of a series. Only the current one is kept up
 * to date (the history of zeros is P7): a newer validFrom closes the stored
 * range and opens a new one, the same validFrom with another value corrects
 * it, an older validFrom is reported and changes nothing. Changes of series
 * that do not share their source's audience are made but not counted.
 */
export async function applyGaugeZeros(
  tx: Tx,
  zeros: readonly GaugeZeroRow[],
  ids: ReadonlyMap<string, Series>,
  batch: string,
): Promise<Partial<Record<ZeroChange, number>>> {
  const changes: Partial<Record<ZeroChange, number>> = {};
  if (zeros.length === 0) return changes;
  const wanted = zeros.flatMap((z) => {
    const series = ids.get(z.series);
    return series === undefined || series.off ? [] : [{ ...z, id: series.id, counted: series.sameAudience }];
  });
  const { rows } = await sql<{ series_id: number; value_m: number; datum: string; valid_from: Date | null }>`
    SELECT series_id, value_m, datum, lower(valid) AS valid_from
    FROM gauge_zero WHERE upper_inf(valid) AND series_id = ANY(${wanted.map((w) => w.id)}::int[])`.execute(tx);
  const current = new Map(rows.map((r) => [r.series_id, { ...r, valid_from: r.valid_from?.toISOString() ?? null }]));
  for (const z of wanted) {
    const note = (c: ZeroChange) => {
      if (z.counted) changes[c] = (changes[c] ?? 0) + 1;
    };
    const from = sql`${z.valid_from}::timestamptz`;
    const now = current.get(z.id);
    if (now === undefined) {
      await sql`INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
                VALUES (${z.id}, ${z.value_m}, ${z.datum}, tstzrange(${from}, NULL), ${batch}::bigint)`.execute(tx);
      note('new');
    } else if (now.valid_from === z.valid_from) {
      if (now.value_m === z.value_m && now.datum === z.datum) continue;
      await sql`UPDATE gauge_zero SET value_m = ${z.value_m}, datum = ${z.datum}, batch_id = ${batch}::bigint
                WHERE series_id = ${z.id} AND upper_inf(valid)`.execute(tx);
      note('corrected');
    } else if (z.valid_from !== null && (now.valid_from === null || z.valid_from > now.valid_from)) {
      await sql`UPDATE gauge_zero SET valid = tstzrange(lower(valid), ${from})
                WHERE series_id = ${z.id} AND upper_inf(valid)`.execute(tx);
      await sql`INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
                VALUES (${z.id}, ${z.value_m}, ${z.datum}, tstzrange(${from}, NULL), ${batch}::bigint)`.execute(tx);
      note('superseded');
    } else {
      note('older_ignored');
    }
  }
  return changes;
}

export type BatchInput = {
  source: string;
  spec: string;
  key: string;
  sha256: string | null;
  fetchedAt: Date;
  status: number | null;
  bytes: number | null;
  adapterVersion: number;
};

export type BatchState = { id: string; existed: boolean; previous: string | null; skipped: number };

/** The batch row of an archive key: created on first sight, found again on a replay. */
export async function openBatch(tx: Tx, b: BatchInput, status: 'ok' | 'quarantined' | 'skipped'): Promise<BatchState> {
  const found = await sql<{ id: string; parse_status: string; n_skipped: number }>`
    SELECT id, parse_status, n_skipped FROM ingest_batch WHERE archive_key = ${b.key}`.execute(tx);
  const row = found.rows[0];
  if (row !== undefined) return { id: row.id, existed: true, previous: row.parse_status, skipped: row.n_skipped };
  const created = await sql<{ id: string }>`
    INSERT INTO ingest_batch (source_id, spec_id, archive_key, sha256, fetched_at, http_status, bytes, adapter_version,
                              parse_status)
    VALUES (${b.source}, ${b.spec}, ${b.key}, ${b.sha256}, ${b.fetchedAt}, ${b.status}, ${b.bytes}, ${b.adapterVersion},
            ${status})
    RETURNING id`.execute(tx);
  return { id: (created.rows[0] as { id: string }).id, existed: false, previous: null, skipped: 0 };
}

export async function closeBatch(
  tx: Tx,
  id: string,
  b: BatchInput,
  result: {
    status: 'ok' | 'quarantined' | 'skipped';
    n_rows: number;
    n_new: number;
    n_changed: number;
    /** Values a registry change could still load (see ingest_batch.n_skipped); the pruner keeps such objects. */
    n_skipped: number;
    error: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE ingest_batch
    SET parse_status = ${result.status}, n_rows = ${result.n_rows}, n_new = ${result.n_new},
        n_changed = ${result.n_changed}, n_skipped = ${result.n_skipped}, error = ${result.error},
        adapter_version = ${b.adapterVersion}, loaded_at = now()
    WHERE id = ${id}::bigint`.execute(tx);
}

/** A payload set aside with a fixed code. A payload that loaded before is never downgraded (e.g. its object was pruned since). */
export async function setBatchAside(
  tx: Tx,
  b: BatchInput,
  status: 'quarantined' | 'skipped',
  error: string,
): Promise<void> {
  const state = await openBatch(tx, b, status);
  if (state.existed && state.previous === 'ok') return;
  await closeBatch(tx, state.id, b, { status, n_rows: 0, n_new: 0, n_changed: 0, n_skipped: 0, error });
}

/** The cursor only ever moves forward. */
export async function advanceCursor(tx: Tx, file: string, offset: number): Promise<void> {
  await sql`
    INSERT INTO load_cursor (manifest_file, byte_offset) VALUES (${file}, ${offset})
    ON CONFLICT (manifest_file) DO UPDATE SET byte_offset = EXCLUDED.byte_offset, updated_at = now()
    WHERE load_cursor.byte_offset < EXCLUDED.byte_offset`.execute(tx);
}

export async function cursors(db: Kysely<DB>): Promise<Map<string, number>> {
  const { rows } = await sql<{ manifest_file: string; byte_offset: string }>`
    SELECT manifest_file, byte_offset FROM load_cursor`.execute(db);
  return new Map(rows.map((r) => [r.manifest_file, Number(r.byte_offset)]));
}

/** What a run of manifest lines says about fetching one source, folded in line order. */
export type FetchFold = {
  lastOk: Date | null;
  /** Failures since the last success inside this fold. */
  failures: number;
  /** A success was seen: the stored failure count starts again from `failures`. */
  reset: boolean;
  lastNewData: Date | null;
  newestTs: Date | null;
};

export const emptyFold = (): FetchFold => ({
  lastOk: null,
  failures: 0,
  reset: false,
  lastNewData: null,
  newestTs: null,
});

export async function applyFetchHealth(tx: Tx, source: string, f: FetchFold): Promise<void> {
  // A source the registry does not know has no health row: the manifest is data, not a registry.
  await sql`
    INSERT INTO source_health AS h (source_id, last_fetch_ok, consecutive_failures, last_new_data, newest_ts)
    SELECT s.id, ${f.lastOk}::timestamptz, ${f.failures}, ${f.lastNewData}::timestamptz, ${f.newestTs}::timestamptz
    FROM source s WHERE s.id = ${source}
    ON CONFLICT (source_id) DO UPDATE SET
      last_fetch_ok = greatest(h.last_fetch_ok, EXCLUDED.last_fetch_ok),
      consecutive_failures = CASE WHEN ${f.reset} THEN EXCLUDED.consecutive_failures
                                  ELSE h.consecutive_failures + EXCLUDED.consecutive_failures END,
      last_new_data = greatest(h.last_new_data, EXCLUDED.last_new_data),
      newest_ts = greatest(h.newest_ts, EXCLUDED.newest_ts),
      updated_at = now()`.execute(tx);
}
