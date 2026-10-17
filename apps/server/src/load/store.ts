import { type GaugeZeroRow, type ObsRow, QC, type SeriesDecl, type TideRowIn } from '@rws/core';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { DB } from '../db/generated.ts';
import type { Audience, Touch } from './dirty.ts';

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
 * The tail's attempt at one payload line (S1), named by its position in the
 * manifest (file and end offset), which is what the tail retries: `n` passes
 * began, and `code` says how the last one ended: `load_crashed` while it runs
 * (so a process that dies mid-payload leaves exactly that), else the fixed
 * code of a failure that belongs to the payload. Written in its own
 * transaction before the payload is touched; asynchronous commit is enough for
 * a counter the database server keeps even when our process dies. The commit
 * that ends the line's pass (loaded or set aside) clears it (`null`).
 */
export type Attempt = { file: string; end: number; n: number; code: string };
const ATTEMPT = 'load_attempt';

export const readAttempt = (db: Kysely<DB>) => readMeta<Attempt | null>(db, ATTEMPT);

export async function writeAttempt(db: Kysely<DB>, attempt: Attempt): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`SET LOCAL synchronous_commit = off`.execute(tx);
    await writeMeta(tx, ATTEMPT, attempt);
  });
}

/** Inside the transaction that ends a line's pass. */
export const clearAttempt = (tx: Tx) => writeMeta(tx, ATTEMPT, null);

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

/**
 * When the spec's previous loaded payload was fetched (P5b: the start of a re-stating payload's window,
 * SpecLoader.window): the newest `ok` batch of the spec fetched before this one, within 8 days (an older one
 * leaves the whole payload to load). The same in the tail and in a replay, so a replay writes what the tail did.
 */
export async function previousLoad(db: Kysely<DB>, source: string, spec: string, before: Date): Promise<Date | null> {
  const { rows } = await sql<{ at: Date | null }>`
    SELECT max(fetched_at) AS at FROM ingest_batch
    WHERE source_id = ${source} AND spec_id = ${spec} AND parse_status = 'ok'
      AND fetched_at < ${before}::timestamptz AND fetched_at >= ${before}::timestamptz - interval '8 days'`.execute(db);
  return rows[0]?.at ?? null;
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
  /** Its effective audience (P9a: which publisher family a change of it dirties). */
  audience: Audience;
  /** Its staleness limit: a value is carried forward this long, so a change at ts reaches the buckets up to ts + it. */
  staleness_ms: number;
  /** primary, twin or mirror: only a primary series takes gap-fill rows (FR-3, CH-3). */
  role: 'primary' | 'twin' | 'mirror';
  /** Its station's registered position (a drift report compares it with what a payload states). */
  lon: number | null;
  lat: number | null;
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
    audience: Audience;
    staleness_ms: number;
    role: 'primary' | 'twin' | 'mirror';
    lon: number | null;
    lat: number | null;
    station: string;
  }>`
    SELECT s.id, s.station_id AS station, s.provider_key AS key, s.quantity, s.native_unit, s.to_canonical, s.value_kind,
           (EXTRACT(EPOCH FROM s.native_step) * 1000)::double precision AS native_step_ms,
           (EXTRACT(EPOCH FROM s.expected_step) * 1000)::double precision AS expected_step_ms, st.tier,
           LEAST(src.audience, COALESCE(s.audience, src.audience)) = 'off' AS off,
           COALESCE(s.audience, src.audience) = src.audience AS same_audience,
           LEAST(src.audience, COALESCE(s.audience, src.audience))::text AS audience,
           (EXTRACT(EPOCH FROM s.staleness_limit) * 1000)::double precision AS staleness_ms, s.role, st.lon, st.lat
    FROM series s JOIN station st ON st.id = s.station_id JOIN source src ON src.id = s.source_id
    WHERE s.source_id = ${source} AND s.active`.execute(db);
  return new Map(
    rows.map((r) => [
      r.key,
      {
        id: r.id,
        station: r.station,
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
        audience: r.audience,
        staleness_ms: r.staleness_ms,
        role: r.role,
        lon: r.lon,
        lat: r.lat,
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
  /**
   * P14a, per input row whatever its series' audience (the backfill ledger, plan §3.6): `inserted`, a row written
   * where the series had none or held a 512 row (fill or backfill), with a changed value or qc; `revised`, a live row
   * whose value or qc changed (exactly the obs_revision rows); `skipped`, every other input row: an `off` series, a
   * timestamp stated again later in the payload, a row the precedence rules keep out, and a confirmation. Each class is
   * counted on its own, so inserted + revised + skipped = the input rows is a check, not a definition.
   */
  inserted: number;
  revised: number;
  skipped: number;
};

/** Which loader path the rows come through (P14a): a source's own payload, a gap-fill, or a backfill payload. */
export type UpsertMode = 'live' | 'fill' | 'backfill';

type Series = Pick<SeriesRow, 'id' | 'off' | 'sameAudience' | 'staleness_ms'>;

/**
 * Q6: the idempotent upsert with its revision log, plus obs_latest and the
 * rollups of the touched buckets. Rules that keep it correct:
 *  - the input is `real[]`, so a value is compared as the type it is stored in;
 *  - a timestamp that occurs twice in one payload keeps its last value;
 *  - a stored row has a kind: `live` (qc bit 512 clear), `fill` (512, its batch's
 *    origin `live`: the FR-3 and CH-3 seeds) or `backfill` (512, origin
 *    `backfill`, P14a). A batch never changes its origin, so a confirmation that
 *    only moves batch_id keeps the kind. Whether an incoming row replaces the
 *    stored one (`wins`), with N = "newest fetch wins" below and V = qc bit 2
 *    (provider-validated: RWS Gecontroleerd and Definitief):
 *
 *      stored ↓ / incoming →  live                      fill        backfill
 *      none                   insert                    insert      insert
 *      live                   N                         no          V(in) ∧ ¬V(stored) ∧ differs
 *      fill                   yes                       N           yes
 *      backfill               unless V(stored) ∧ ¬V(in)  no          N
 *
 *    Under the assumption that the provider never takes a value back from
 *    validated to unvalidated for one (series, ts), the final rows are the
 *    same in every load order of live, fill and backfill payloads;
 *  - newest fetch wins (N): the stored row of a point is what the payload with
 *    the greatest (fetched_at, batch id) among all that stated it says. A point is
 *    written when the batch that holds it is older than this one, or is this
 *    very batch and the value or qc differs (a replay after a fix of the
 *    parser, the normaliser or a registry factor corrects what its own batch
 *    stored). A newer batch's row is never touched, so a late payload reverts
 *    nothing, and a replay with an unchanged parser writes nothing. Payloads
 *    fetched in the same instant are ordered by batch id, which follows the
 *    order a database first loaded them (KG-066);
 *  - a newer fetch that states the same value and qc is a confirmation: the
 *    row's batch_id moves to it (and obs_latest's, for the latest row), with no
 *    revision, no rollup and no count, so a late payload fetched in between
 *    cannot overwrite it;
 *  - every change of a live row's value or qc writes exactly one obs_revision
 *    row, whoever changes it (a newer live payload, a validated backfill). The
 *    revision log records the changes of the stored value in the order they
 *    were stored, so it is the one thing here that depends on arrival order. A
 *    change of a fill or backfill row is not a revision of the source's value;
 *  - `fill` and `backfill` mark every row with the backfilled bit (512). A fill
 *    row never replaces a live or backfill row, and any row of the series' own
 *    source replaces a fill row whatever its fetch time, so the rows, rollups
 *    and revisions are the same in either load order of a source and its fill;
 *  - `backfill` leaves obs_latest alone: history never makes a series look
 *    fresh or stale. The rollups of the buckets it changes are refreshed inline,
 *    as for every other row (plan §3.7).
 * Returns the audience-counted numbers of the batch (n_new, n_changed, newest,
 * writes) and the per-row ledger classes (inserted, revised, skipped).
 */
// ponytail: every re-statement of an unchanged point rewrites its batch_id (about six row updates per insert
// for DE-1's hourly PT6H window, about 17 for FR-1's 15-minute PT4H window since #53; R-069). If obs bloat shows, keep the newest fetch per series in a coverage table,
// or lower obs's fillfactor for HOT updates.
export async function upsertObs(
  tx: Tx,
  rows: readonly ObsRow[],
  ids: ReadonlyMap<string, Series>,
  batch: string,
  fetchedAt: Date,
  mode: UpsertMode = 'live',
  touched: Touch[] = [],
): Promise<Written> {
  const sid: number[] = [];
  const ts: string[] = [];
  const value: number[] = [];
  const qc: number[] = [];
  const counted = new Set<number>();
  let off = 0;
  for (const r of rows) {
    const series = ids.get(r.series);
    if (series === undefined || !Number.isFinite(r.value)) throw new RangeError('load: row outside the registry');
    if (series.off) {
      off += 1;
      continue;
    }
    if (series.sameAudience) counted.add(series.id);
    sid.push(series.id);
    ts.push(r.ts);
    value.push(r.value);
    qc.push(mode === 'live' ? r.qc : r.qc | QC.BACKFILLED);
  }
  const none: Written = { n_new: 0, n_changed: 0, newest: null, writes: 0, inserted: 0, revised: 0, skipped: off };
  if (sid.length === 0) return none;
  const sorted = [...ts].sort();
  // Live rows keep the 2000-01-01 partition floor; a backfill may go down to 1900 (review C7).
  if (mode === 'backfill')
    await sql`SELECT ensure_history_partitions(${sorted[0]}::timestamptz, ${sorted.at(-1)}::timestamptz)`.execute(tx);
  else await sql`SELECT ensure_partitions(${sorted[0]}::timestamptz, ${sorted.at(-1)}::timestamptz)`.execute(tx);

  // N: the stored row's batch is older than this one, or is this very batch and the row differs.
  const newer = sql`(b.id IS NULL
                     OR (b.fetched_at, b.id) < (${fetchedAt}::timestamptz, ${batch}::bigint)
                     OR (b.id = ${batch}::bigint AND (o.value, o.qc) IS DISTINCT FROM (i.value, i.qc)))`;
  const BF = sql`${QC.BACKFILLED}::int2`;
  const V = sql`${QC.VALIDATED}::int2`;
  const { rows: result } = await sql<{
    series_id: number | null;
    ts: Date | null;
    inserted: boolean | null;
    changed: boolean | null;
    revised: boolean | null;
    n_distinct: number;
    n_wins: number;
  }>`
    WITH incoming AS (
      SELECT DISTINCT ON (i.series_id, i.ts) i.series_id, i.ts, i.value, i.qc
      FROM unnest(${sid}::int[], ${ts}::timestamptz[], ${value}::real[], ${qc}::int2[])
           WITH ORDINALITY AS i(series_id, ts, value, qc, ord)
      ORDER BY i.series_id, i.ts, i.ord DESC
    ),
    wins AS (
      SELECT i.series_id, i.ts, i.value, i.qc
      FROM incoming i
      LEFT JOIN obs o ON o.series_id = i.series_id AND o.ts = i.ts
      LEFT JOIN ingest_batch b ON b.id = o.batch_id
      WHERE o.series_id IS NULL
         OR CASE
              -- a live row: a newer live fetch, or a validated backfill over an unvalidated value; never a fill
              WHEN (o.qc & ${BF}) = 0 THEN
                CASE ${mode}::text
                  WHEN 'live' THEN ${newer}
                  WHEN 'backfill' THEN (i.qc & ${V}) <> 0 AND (o.qc & ${V}) = 0
                                       AND (o.value, o.qc) IS DISTINCT FROM (i.value, i.qc)
                  ELSE false
                END
              -- a fill row: the series' own source replaces it whatever its fetch time; a newer fill too
              WHEN COALESCE(b.origin, 'live') = 'live' THEN ${mode}::text <> 'fill' OR ${newer}
              -- a backfill row: live unless it would take a validated value back; a newer backfill; never a fill
              ELSE
                CASE ${mode}::text
                  WHEN 'live' THEN NOT ((o.qc & ${V}) <> 0 AND (i.qc & ${V}) = 0)
                  WHEN 'backfill' THEN ${newer}
                  ELSE false
                END
            END
    ),
    up AS (
      INSERT INTO obs AS o (series_id, ts, value, qc, batch_id)
      SELECT series_id, ts, value, qc, ${batch}::bigint FROM wins
      -- No WHERE here: wins read the stored row, and nothing can change it before this write only because every
      -- obs writer (live, fill, backfill, replay) holds the loader lock (review C8). A writer without it would race.
      ON CONFLICT (series_id, ts) DO UPDATE
        SET value = EXCLUDED.value, qc = EXCLUDED.qc, batch_id = EXCLUDED.batch_id
      RETURNING old.series_id AS old_series, old.value AS old_value, old.qc AS old_qc,
                new.series_id, new.ts, new.value, new.qc
    ),
    revision AS (
      INSERT INTO obs_revision (series_id, ts, old_value, new_value, old_qc, new_qc, batch_id)
      SELECT series_id, ts, old_value, value, old_qc, qc, ${batch}::bigint FROM up
      WHERE old_series IS NOT NULL AND (old_value, old_qc) IS DISTINCT FROM (value, qc)
        AND (old_qc & ${BF}) = 0
    ),
    latest AS (
      INSERT INTO obs_latest AS l (series_id, ts, value, qc, batch_id)
      SELECT DISTINCT ON (series_id) series_id, ts, value, qc, ${batch}::bigint FROM up
      WHERE ${mode}::text <> 'backfill'
      ORDER BY series_id, ts DESC
      ON CONFLICT (series_id) DO UPDATE
        SET ts = EXCLUDED.ts, value = EXCLUDED.value, qc = EXCLUDED.qc, batch_id = EXCLUDED.batch_id
        WHERE EXCLUDED.ts >= l.ts
    )
    SELECT w.series_id, w.ts, w.inserted, w.changed, w.changed AND NOT w.inserted AS revised,
           (SELECT count(*) FROM incoming)::int AS n_distinct, (SELECT count(*) FROM wins)::int AS n_wins
    FROM (SELECT 1) AS one
    LEFT JOIN (SELECT series_id, ts, old_series IS NULL OR (old_qc & ${BF}) <> 0 AS inserted,
                      (old_value, old_qc) IS DISTINCT FROM (value, qc) AS changed
               FROM up) w ON true`.execute(tx);
  const head = result[0] as { n_distinct: number; n_wins: number };
  const written = result.flatMap((w) =>
    w.series_id === null || w.ts === null
      ? []
      : [
          {
            series_id: w.series_id,
            ts: w.ts,
            inserted: w.inserted === true,
            changed: w.changed === true,
            revised: w.revised === true,
          },
        ],
  );
  // The ledger classes, each counted on its own: the payload's repeats, the rows the rules keep out, confirmations.
  const inserted = written.filter((w) => w.changed && w.inserted).length;
  const revised = written.filter((w) => w.revised).length;
  const skipped =
    off + (sid.length - head.n_distinct) + (head.n_distinct - head.n_wins) + written.filter((w) => !w.changed).length;
  const changed = written.filter((w) => w.changed);
  if (changed.length === 0) return { ...none, writes: written.length, skipped };
  // P9a: a changed value at ts is what every bucket up to ts + the staleness limit shows (LOCF).
  const staleness = new Map([...ids.values()].map((s) => [s.id, s.staleness_ms]));
  for (const w of changed) {
    const at = w.ts.getTime();
    touched.push({ series: w.series_id, from: at, to: at + (staleness.get(w.series_id) ?? 0) });
  }

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
  return { n_new, n_changed: mine.length - n_new, newest, writes: written.length, inserted, revised, skipped };
}

/** P16b: a tide row with the id of the series it attaches to; `counted`: the series shares its source's audience. */
export type ResolvedTide = TideRowIn & { id: number; counted: boolean };

/**
 * P16b: the astronomical tide and the high and low waters (`tide`, never `obs`). Newest fetch wins, as in upsertObs:
 * a row is written where none is stored, or where the stored row's batch is older than this one, or is this very
 * batch (a replay after a fix), and only when its value or high/low label differs. A newer fetch that states the same
 * row changes nothing, not even its batch_id: a monthly re-fetch of an unchanged curve writes no tuple (79 series ×
 * 57,600 values a month). So a replay of the same lines writes nothing. A timestamp stated twice in a payload keeps
 * its last value. No touch: tide is in no published file yet (P18), so it dirties nothing and bumps no day.
 * Returns the rows inserted and updated of the series that share their source's audience, and every write.
 */
// ponytail: a confirmation keeps the older batch_id, so a value that flaps A→B→A over three fetches and is replayed
// in the order 1, 3, 2 ends as B (fetch 2 is newer than the holder, fetch 1). The tide is near-static; move batch_id on
// a confirmation, as upsertObs does, if that order ever matters.
export async function applyTide(
  tx: Tx,
  rows: readonly ResolvedTide[],
  batch: string,
  fetchedAt: Date,
): Promise<{ n_new: number; n_changed: number; writes: number }> {
  if (rows.length === 0) return { n_new: 0, n_changed: 0, writes: 0 };
  for (const r of rows) if (!Number.isFinite(r.value)) throw new RangeError('load: tide value is not finite');
  const counted = new Set(rows.filter((r) => r.counted).map((r) => r.id));
  const { rows: written } = await sql<{ series_id: number; inserted: boolean }>`
    WITH incoming AS (
      SELECT DISTINCT ON (i.series_id, i.kind, i.ts) i.series_id, i.kind, i.ts, i.value, i.hilo
      FROM unnest(${rows.map((r) => r.id)}::int[], ${rows.map((r) => r.kind)}::text[],
                  ${rows.map((r) => r.ts)}::timestamptz[], ${rows.map((r) => r.value)}::real[],
                  ${rows.map((r) => r.hilo)}::text[])
           WITH ORDINALITY AS i(series_id, kind, ts, value, hilo, ord)
      ORDER BY i.series_id, i.kind, i.ts, i.ord DESC
    ),
    wins AS (
      SELECT i.series_id, i.kind, i.ts, i.value, i.hilo
      FROM incoming i
      LEFT JOIN tide t ON t.series_id = i.series_id AND t.kind = i.kind AND t.ts = i.ts
      LEFT JOIN ingest_batch b ON b.id = t.batch_id
      WHERE t.series_id IS NULL
         OR ((t.value, t.hilo) IS DISTINCT FROM (i.value, i.hilo)
             AND (b.id IS NULL OR b.id = ${batch}::bigint
                  OR (b.fetched_at, b.id) < (${fetchedAt}::timestamptz, ${batch}::bigint)))
    )
    -- Under the loader lock, like every obs write: nothing changes the stored row between wins and this write.
    INSERT INTO tide AS t (series_id, kind, ts, value, hilo, batch_id)
    SELECT series_id, kind, ts, value, hilo, ${batch}::bigint FROM wins
    ON CONFLICT (series_id, kind, ts) DO UPDATE
      SET value = EXCLUDED.value, hilo = EXCLUDED.hilo, batch_id = EXCLUDED.batch_id
    RETURNING t.series_id, old.series_id IS NULL AS inserted`.execute(tx);
  const mine = written.filter((w) => counted.has(w.series_id));
  const n_new = mine.filter((w) => w.inserted).length;
  return { n_new, n_changed: mine.length - n_new, writes: written.length };
}

export type ZeroChange = 'new' | 'corrected' | 'superseded' | 'changed';

const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

/**
 * The current gauge zero (PNP) of a series. Only the current one is kept up
 * to date (the history of zeros is P7): a newer validFrom closes the stored
 * range and opens a new one, an older validFrom is reported and changes
 * nothing. The same validFrom follows the observations' newest fetch wins: a
 * payload with the same value becomes its holder (a confirmation, not
 * counted), the holding payload itself corrects it when its value now differs
 * (a replay after a fix), and an older payload (a late line, a partial replay)
 * leaves it alone. P7a (R-072): nothing is overwritten by another payload. A
 * newer payload that states another value without a later validity (the same
 * date, an earlier one, or none, as DE-8's `Nullpunkt` and an FR-1 zero without
 * `date_debut_ref_alti_station`) ends the stored zero at its own fetch time and
 * opens a new range from there (`changed`, alerted); before P7a the dated case
 * was corrected in place and the dateless one withheld. At most one range a
 * day comes from such a change (review SR-5): while the open range began on the
 * fetch's own UTC day (or later), a newer payload with another value corrects
 * it in place (`changed` all the same), so a zero that flaps A→B→A adds one
 * row a day, not one per payload; a range of an earlier day is never touched.
 * Changes of series that do not share their source's audience are made but not
 * counted.
 */
export async function applyGaugeZeros(
  tx: Tx,
  zeros: readonly GaugeZeroRow[],
  ids: ReadonlyMap<string, Series>,
  batch: string,
  fetchedAt: Date,
  touched: Touch[] = [],
): Promise<Partial<Record<ZeroChange, number>>> {
  const changes: Partial<Record<ZeroChange, number>> = {};
  if (zeros.length === 0) return changes;
  const wanted = zeros.flatMap((z) => {
    const series = ids.get(z.series);
    return series === undefined || series.off ? [] : [{ ...z, id: series.id, counted: series.sameAudience }];
  });
  const { rows } = await sql<{
    series_id: number;
    value_m: number;
    datum: string;
    valid_from: Date | null;
    mine: boolean;
    older: boolean;
  }>`
    SELECT g.series_id, g.value_m, g.datum, lower(g.valid) AS valid_from, g.batch_id = ${batch}::bigint AS mine,
           b.id IS NULL OR (b.fetched_at, b.id) < (${fetchedAt}::timestamptz, ${batch}::bigint) AS older
    FROM gauge_zero g LEFT JOIN ingest_batch b ON b.id = g.batch_id
    WHERE upper_inf(g.valid) AND g.series_id = ANY(${wanted.map((w) => w.id)}::int[])`.execute(tx);
  const current = new Map(rows.map((r) => [r.series_id, { ...r, valid_from: r.valid_from?.toISOString() ?? null }]));
  const confirmed: number[] = [];
  for (const z of wanted) {
    const note = (c: ZeroChange, since: string | Date | null) => {
      if (z.counted) changes[c] = (changes[c] ?? 0) + 1;
      // P9a: the snapshot's nap and zero change from the changed range's start on.
      touched.push({ series: z.id, from: since === null ? null : new Date(since).getTime() });
    };
    const from = sql`${z.valid_from}::timestamptz`;
    const now = current.get(z.id);
    const same = now !== undefined && now.value_m === z.value_m && now.datum === z.datum;
    const rewrite = () =>
      sql`UPDATE gauge_zero SET value_m = ${z.value_m}, datum = ${z.datum}, batch_id = ${batch}::bigint
          WHERE series_id = ${z.id} AND upper_inf(valid)`.execute(tx);
    if (now === undefined) {
      await sql`INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
                VALUES (${z.id}, ${z.value_m}, ${z.datum}, tstzrange(${from}, NULL), ${batch}::bigint)`.execute(tx);
      note('new', z.valid_from);
    } else if (
      now.valid_from !== z.valid_from &&
      z.valid_from !== null &&
      (now.valid_from === null || z.valid_from > now.valid_from)
    ) {
      await sql`UPDATE gauge_zero SET valid = tstzrange(lower(valid), ${from})
                WHERE series_id = ${z.id} AND upper_inf(valid)`.execute(tx);
      await sql`INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
                VALUES (${z.id}, ${z.value_m}, ${z.datum}, tstzrange(${from}, NULL), ${batch}::bigint)`.execute(tx);
      note('superseded', z.valid_from);
    } else if (!now.mine && !now.older) {
      // A newer payload holds it: a late line or a partial replay leaves it alone (no news, no alert).
    } else if (same) {
      if (now.older) confirmed.push(z.id);
    } else if (now.mine) {
      await rewrite();
      note('corrected', now.valid_from);
    } else if (now.valid_from !== null && utcDay(fetchedAt.getTime()) <= utcDay(Date.parse(now.valid_from))) {
      // The open range began this UTC day (or begins later): the newer payload's value wins in place.
      await rewrite();
      note('changed', now.valid_from);
    } else {
      await sql`UPDATE gauge_zero SET valid = tstzrange(lower(valid), ${fetchedAt}::timestamptz)
                WHERE series_id = ${z.id} AND upper_inf(valid)`.execute(tx);
      await sql`INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
                VALUES (${z.id}, ${z.value_m}, ${z.datum}, tstzrange(${fetchedAt}::timestamptz, NULL),
                        ${batch}::bigint)`.execute(tx);
      note('changed', fetchedAt);
    }
  }
  if (confirmed.length > 0) {
    await sql`UPDATE gauge_zero SET batch_id = ${batch}::bigint
              WHERE upper_inf(valid) AND series_id = ANY(${confirmed}::int[])`.execute(tx);
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
  /** P14a: a backfill payload's batch (`ingest_batch.origin`; fixed at creation, never changed by a replay). */
  origin?: 'live' | 'backfill';
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
                              parse_status, origin)
    VALUES (${b.source}, ${b.spec}, ${b.key}, ${b.sha256}, ${b.fetchedAt}, ${b.status}, ${b.bytes}, ${b.adapterVersion},
            ${status}, ${b.origin ?? 'live'})
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

/** The owner-audience sources (P5c): their manifest lines stay out of the public loader numbers (KG-075). */
export async function ownerSources(db: Kysely<DB>): Promise<Set<string>> {
  const { rows } = await sql<{ id: string }>`SELECT id FROM source WHERE audience = 'owner'`.execute(db);
  return new Set(rows.map((r) => r.id));
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
  /** When each root request of a scheduled run started (not a seed, a walk page or a recovered line), in order. */
  starts: { spec: string; variant: string; at: number }[];
};

export const emptyFold = (): FetchFold => ({
  lastOk: null,
  failures: 0,
  reset: false,
  lastNewData: null,
  newestTs: null,
  starts: [],
});

/**
 * Loader-private (app_meta `intervals:<source>`, only for a source the registry
 * knows): the last start per spec and variant, and per spec the shortest gap
 * between two starts of one variant in each UTC hour, both for the last 25
 * hours before the newest start (a variant that stopped is forgotten, so the
 * state stays bounded; review SR-4). Health publishes only the minimum per
 * spec over the last 24 hours (P5a; the CH-1 10-minute rule of BAFU).
 */
export type Intervals = { last: Record<string, number>; hours: Record<string, Record<string, number>> };

const HOUR_MS = 3_600_000;

/** Folds request starts into the interval state; a start not after the last one of its variant is ignored. */
export function foldIntervals(state: Intervals, starts: FetchFold['starts']): Intervals {
  const last = { ...state.last };
  const hours: Intervals['hours'] = Object.fromEntries(Object.entries(state.hours).map(([k, v]) => [k, { ...v }]));
  let newest = Math.max(0, ...Object.values(last));
  for (const { spec, variant, at } of starts) {
    const key = `${spec}|${variant}`;
    const before = last[key];
    if (before !== undefined && at <= before) continue;
    if (before !== undefined) {
      const hour = String(at - (at % HOUR_MS));
      const gap = Math.round((at - before) / 1000);
      const spec_ = hours[spec] ?? {};
      spec_[hour] = Math.min(spec_[hour] ?? gap, gap);
      hours[spec] = spec_;
    }
    last[key] = at;
    newest = Math.max(newest, at);
  }
  for (const spec of Object.keys(hours)) {
    const kept = Object.entries(hours[spec] ?? {}).filter(([h]) => Number(h) > newest - 25 * HOUR_MS);
    if (kept.length === 0) delete hours[spec];
    else hours[spec] = Object.fromEntries(kept);
  }
  for (const [key, at] of Object.entries(last)) if (at <= newest - 25 * HOUR_MS) delete last[key];
  return { last, hours };
}

export async function applyFetchHealth(tx: Tx, source: string, f: FetchFold): Promise<void> {
  // A source the registry does not know has no health row and no interval state: the manifest is data, not a
  // registry (review SR-4).
  const { rows: known } = await sql`
    INSERT INTO source_health AS h (source_id, last_fetch_ok, consecutive_failures, last_new_data, newest_ts)
    SELECT s.id, ${f.lastOk}::timestamptz, ${f.failures}, ${f.lastNewData}::timestamptz, ${f.newestTs}::timestamptz
    FROM source s WHERE s.id = ${source}
    ON CONFLICT (source_id) DO UPDATE SET
      last_fetch_ok = greatest(h.last_fetch_ok, EXCLUDED.last_fetch_ok),
      consecutive_failures = CASE WHEN ${f.reset} THEN EXCLUDED.consecutive_failures
                                  ELSE h.consecutive_failures + EXCLUDED.consecutive_failures END,
      last_new_data = greatest(h.last_new_data, EXCLUDED.last_new_data),
      newest_ts = greatest(h.newest_ts, EXCLUDED.newest_ts),
      updated_at = now()
    RETURNING h.source_id`.execute(tx);
  if (known.length > 0 && f.starts.length > 0) {
    const key = `intervals:${source}`;
    const state = (await readMeta<Intervals>(tx, key)) ?? { last: {}, hours: {} };
    await writeMeta(tx, key, foldIntervals(state, f.starts));
  }
}

/**
 * P9a: the newest provider `updated` instant of a source (DE-6's "Stand" date) in source_health.detail
 * `provider_updated`, under the loader lock. Only a newer value replaces it; the health pass keeps the key (it strips
 * named keys only). A source the registry does not know gets no row.
 */
export async function storeProviderUpdated(tx: Tx, source: string, at: string): Promise<void> {
  await sql`
    INSERT INTO source_health AS h (source_id, detail)
    SELECT s.id, jsonb_build_object('provider_updated', ${at}::text) FROM source s WHERE s.id = ${source}
    ON CONFLICT (source_id) DO UPDATE SET detail = jsonb_set(h.detail, '{provider_updated}', to_jsonb(${at}::text))
    WHERE h.detail ->> 'provider_updated' IS NULL
       OR (h.detail ->> 'provider_updated')::timestamptz < ${at}::timestamptz`.execute(tx);
}
