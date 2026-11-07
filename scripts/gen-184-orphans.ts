// #184 stage 2, PR B (D-5 of 2026-11-05): the orphans. Before #184 the NL-1 normaliser merged RWS's daily mean
// (WaardeBewerkingsMethode GEM24H) into the 10-minute series, and where the 10-minute list was silent it stored the
// daily mean as an instantaneous primary row. PR A (#256) loads those daily means into the `<key>/GEM24H` twins; this
// generator writes the one data migration that deletes the old rows, and the owner's read-only check of it.
//
//   node scripts/gen-184-orphans.ts <census-184.jsonl[.gz]>
//
// The input is the stage-1 census attached to #184 (sha256 pinned, CENSUS_SHA256): its `orphan` lines, less Megen Q
// F103, whose "GEM24H" list of 2024–25 is the instantaneous series (D-1: those rows stay). It writes
//   db/migrations/20261120000001_184_orphans.sql   the migration (one DO block; never edit it by hand)
//   scripts/sql/184-orphans-check.sql              the owner's pre-check and post-check (one read-only SELECT)
// Both carry the same rows and the same guards. CI reads the rows back from the migration and holds both files equal
// to what migrationSql and checkSql write for them (test/gen-184-orphans.test.ts); the census itself is not in the
// repository, so census → rows is the lead's local run (twice, no diff), pinned by the migration's sha256.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { MISLABELLED } from '../apps/server/src/adapters/nl-1/normalise.ts';
import { DATA_FLOOR } from '../apps/server/src/load/dirty.ts';
import { CENSUS_SHA256 } from './gen-nl1-stations.ts';

const ROOT = new URL('../', import.meta.url);
export const MIGRATION = new URL('db/migrations/20261120000001_184_orphans.sql', ROOT);
export const CHECK = new URL('scripts/sql/184-orphans-check.sql', ROOT);
const NL1_YAML = new URL('registry/stations/nl-1.yaml', ROOT);

/** The key D-1 keeps: Megen Q's mislabelled list (its 105,406 orphans are the instantaneous series). */
export const KEPT = MISLABELLED.key;
/** The suffix of the daily-mean twin each orphan's value must be in (PR A, D-2). */
const TWIN = '/GEM24H';

// The census is untrusted data: every field of an orphan line must match a strict pattern, anything else stops the run.
const KEY = /^[a-z0-9]+(?:\.[a-z0-9]+)*\/(?:WATHTE\/NAP|Q\/NVT)\/other:F\d{3}$/;
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/;
/** A daily mean is stamped on a whole hour (23:00Z, 11:00Z or 07:00Z); Megen's 10-minute readings are not kept. */
const WHOLE_HOUR = /T\d\d:00:00\.000Z$/;

export type Orphans = {
  /** The primary series keys, sorted; a row's `ix` is 1-based into this list (as SQL arrays are). */
  keys: string[];
  /** Sorted by key, then instant. `value` is the census number; SQL reads its String() as `real`, as the loader does. */
  rows: { ix: number; epoch: number; value: number }[];
};

type StationRow = { source?: unknown; provider_key?: unknown; role?: unknown; aggregate?: unknown };

/** The NL-1 rows of registry/stations/nl-1.yaml (the registry the twins of PR A are in). */
export function readStations(text = readFileSync(NL1_YAML, 'utf8')): StationRow[] {
  const doc = parse(text) as { stations?: unknown };
  if (!Array.isArray(doc.stations)) throw new Error('registry/stations/nl-1.yaml: no stations list');
  return doc.stations as StationRow[];
}

/**
 * The orphans of a census (JSON lines) outside Megen Q F103, checked against the registry. Pure. Every kept series must
 * be a registered NL-1 primary with a registered `<key>/GEM24H` twin (aggregate mean), and every instant must lie
 * before DATA_FLOOR; the totals line must count exactly the orphans read.
 */
export function orphanRows(census: string, stations: readonly StationRow[]): Orphans {
  const byKey = new Map<string, StationRow>();
  for (const s of stations) if (s.source === 'NL-1' && typeof s.provider_key === 'string') byKey.set(s.provider_key, s);
  const floor = Date.parse(DATA_FLOOR);
  const seen = new Set<string>();
  const kept: { key: string; epoch: number; value: number }[] = [];
  let megen = 0;
  let totals: number | null = null;
  for (const [n, line] of census.split('\n').entries()) {
    if (line === '') continue;
    const at = `census line ${n + 1}`;
    const doc = JSON.parse(line) as Record<string, unknown>;
    if (typeof doc !== 'object' || doc === null) throw new Error(`${at}: not an object`);
    if ('totals' in doc) {
      const t = doc.totals as Record<string, unknown>;
      if (typeof t?.orphan !== 'number') throw new Error(`${at}: totals without an orphan count`);
      totals = t.orphan;
      continue;
    }
    if (!('orphan' in doc)) continue;
    const o = doc.orphan as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) throw new Error(`${at}: orphan is not an object`);
    const { series, ts, value } = o;
    if (typeof series !== 'string' || !KEY.test(series)) throw new Error(`${at}: series is not an NL-1 key`);
    if (typeof ts !== 'string' || !TS.test(ts)) throw new Error(`${at}: ts is not a UTC instant`);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at}: value is not a finite number`);
    const id = `${series}\n${ts}`;
    if (seen.has(id)) throw new Error(`${at}: the same series and instant twice`);
    seen.add(id);
    if (series === KEPT) {
      megen += 1;
      continue;
    }
    if (!WHOLE_HOUR.test(ts)) throw new Error(`${at}: a daily mean not on a whole hour`);
    const epoch = Date.parse(ts);
    if (!(epoch < floor)) throw new Error(`${at}: instant not before DATA_FLOOR`);
    kept.push({ key: series, epoch: epoch / 1000, value });
  }
  if (totals === null) throw new Error('census: no totals line (an interrupted census is no census)');
  if (kept.length === 0) throw new Error(`census: no orphan outside ${KEPT}, so there is nothing to delete`);
  if (totals !== megen + kept.length)
    throw new Error(`census: totals.orphan ${totals} is not ${megen} + ${kept.length}`);
  const keys = [...new Set(kept.map((r) => r.key))].sort();
  for (const key of keys) {
    const p = byKey.get(key);
    if (p?.role !== 'primary') throw new Error(`${key}: not a registered NL-1 primary series`);
    const t = byKey.get(key + TWIN);
    if (t?.role !== 'twin' || t.aggregate !== 'mean') throw new Error(`${key}: no registered ${TWIN} twin`);
  }
  const ix = new Map(keys.map((k, i) => [k, i + 1]));
  const rows = kept
    .map((r) => ({ ix: ix.get(r.key) as number, epoch: r.epoch, value: r.value }))
    .sort((a, b) => a.ix - b.ix || a.epoch - b.epoch);
  return { keys, rows };
}

// --- SQL --------------------------------------------------------------------------------------------------------------

const DAY = 86_400;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace('T', ' ').replace('.000Z', '+00');
/** The constant time range every statement on obs carries, so the yearly partitions prune at plan time (#190). */
function range(o: Orphans): { lo: string; hi: string } {
  const first = o.rows.reduce((m, r) => Math.min(m, r.epoch), Number.POSITIVE_INFINITY);
  const last = o.rows.reduce((m, r) => Math.max(m, r.epoch), Number.NEGATIVE_INFINITY);
  return { lo: iso(Math.floor(first / DAY) * DAY), hi: iso((Math.floor(last / DAY) + 1) * DAY) };
}

/** A PostgreSQL array literal, `per` elements to a line (whitespace between elements is ignored by array_in). */
function arrayLiteral(items: readonly string[], indent: string, per = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += per) lines.push(items.slice(i, i + per).join(','));
  return `'{${lines.join(`,\n${indent}`)}}'`;
}

function arrays(o: Orphans, indent: string) {
  return {
    keys: arrayLiteral(
      o.keys.map((k) => `"${k}"`),
      indent,
      1,
    ),
    ix: arrayLiteral(
      o.rows.map((r) => String(r.ix)),
      indent,
      40,
    ),
    epoch: arrayLiteral(
      o.rows.map((r) => String(r.epoch)),
      indent,
    ),
    value: arrayLiteral(
      o.rows.map((r) => String(r.value)),
      indent,
    ),
  };
}

function header(o: Orphans, what: string): string {
  const per = o.keys.map((k, i) => {
    const n = o.rows.filter((r) => r.ix === i + 1).length;
    return `--   ${String(n).padStart(5)}  ${k}`;
  });
  return [
    `-- #184 stage 2, PR B (D-5): ${what}`,
    '-- Generated by scripts/gen-184-orphans.ts from the stage-1 census of #184',
    `-- (uncompressed sha256 ${CENSUS_SHA256}).`,
    '-- Never edit by hand: change the generator and run it again.',
    `-- The ${o.rows.length} orphans outside ${KEPT} (D-1 keeps those), per primary series:`,
    ...per,
  ].join('\n');
}

/**
 * The guard columns, one boolean per guard of D-5, over `o` (the listed row in obs), `l` (the listed row: series and
 * twin id, instant, census value), `b` (its batch), `w` (the twin's row at the instant) and `x` (the series' obs_latest
 * row at the instant). The migration and the check use these very expressions.
 */
const GUARDS: readonly [string, string][] = [
  ['bit512', '(o.qc & 512) = 0'],
  ['origin', "b.origin IS DISTINCT FROM 'backfill'"],
  ['floor', `o.ts >= timestamptz '${DATA_FLOOR.replace('T', ' ').replace('Z', '+00')}'`],
  ['value', 'o.value <> l.v'],
  ['twin_series', 'l.tid IS NULL'],
  ['twin_row', 'l.tid IS NOT NULL AND (w.value IS NULL OR w.value <> l.v)'],
  ['latest', 'x.series_id IS NOT NULL'],
  ['revision', 'EXISTS (SELECT 1 FROM obs_revision r WHERE r.series_id = o.series_id AND r.ts = o.ts)'],
];

/** The joins from the listed rows `l` to obs and the guards' tables (inner join: present rows only). */
function presentJoins(lo: string, hi: string, outer: boolean): string {
  return [
    `${outer ? 'LEFT JOIN' : 'JOIN'} obs o ON o.series_id = l.sid AND o.ts = l.ts`,
    `       AND o.ts >= timestamptz '${lo}' AND o.ts < timestamptz '${hi}'`,
    'LEFT JOIN ingest_batch b ON b.id = o.batch_id',
    'LEFT JOIN obs w ON w.series_id = l.tid AND w.ts = l.ts',
    `       AND w.ts >= timestamptz '${lo}' AND w.ts < timestamptz '${hi}'`,
    'LEFT JOIN obs_latest x ON x.series_id = o.series_id AND x.ts = o.ts',
  ].join('\n');
}

/** The rollup expressions of apps/server/src/load/store.ts (upsertObs), recomputed for the touched buckets only. */
function rollup(table: 'obs_1h' | 'obs_1d', width: '1 hour' | '1 day', lo: string, hi: string): string {
  const origin = "timestamptz '2000-01-01 00:00:00+00'";
  const touched = `(SELECT DISTINCT u.series_id, date_bin('${width}', u.ts, ${origin}) AS bucket
          FROM unnest(d_sid, d_ts) AS u(series_id, ts))`;
  return `  INSERT INTO ${table} AS r (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
  SELECT o.series_id, t.bucket, min(o.value), max(o.value), avg(o.value)::real,
         (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)
  FROM ${touched} t
  JOIN obs o ON o.series_id = t.series_id AND o.ts >= t.bucket AND o.ts < t.bucket + interval '${width}'
            AND date_bin('${width}', o.ts, ${origin}) = t.bucket
            AND o.ts >= timestamptz '${lo}' AND o.ts < timestamptz '${hi}'
  GROUP BY o.series_id, t.bucket
  ON CONFLICT (series_id, bucket) DO UPDATE
    SET vmin = EXCLUDED.vmin, vmax = EXCLUDED.vmax, vavg = EXCLUDED.vavg, vlast = EXCLUDED.vlast,
        n = EXCLUDED.n, qc_or = EXCLUDED.qc_or
    WHERE (r.vmin, r.vmax, r.vavg, r.vlast, r.n, r.qc_or)
          IS DISTINCT FROM (EXCLUDED.vmin, EXCLUDED.vmax, EXCLUDED.vavg, EXCLUDED.vlast, EXCLUDED.n, EXCLUDED.qc_or);
  -- A bucket no row holds any more is deleted (n > 0 is a CHECK, and the store never empties one).
  DELETE FROM ${table} r
  USING ${touched} t
  WHERE r.series_id = t.series_id AND r.bucket = t.bucket
    AND NOT EXISTS (SELECT 1 FROM obs o WHERE o.series_id = t.series_id
                      AND o.ts >= t.bucket AND o.ts < t.bucket + interval '${width}'
                      AND o.ts >= timestamptz '${lo}' AND o.ts < timestamptz '${hi}');`;
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((s) => `  ${s}`)
    .join('\n');

/** The migration: one DO block (atomic under dbmate's transaction and a plain query alike). Pure. */
export function migrationSql(o: Orphans): string {
  const { lo, hi } = range(o);
  const a = arrays(o, '    ');
  const failed = GUARDS.map(([name, expr]) => `      count(*) FILTER (WHERE ${expr}) AS ${name}`).join(',\n');
  return `${header(o, 'delete the daily means the old NL-1 code stored as instantaneous rows.')}
--
-- Every listed row is deleted only when every guard holds: it carries qc bit 512, its batch has origin 'backfill',
-- its ts lies before DATA_FLOOR, its value equals the census value as real, the series' /GEM24H twin holds a row at
-- the same instant with the same value, it is not the series' obs_latest row, and it has no obs_revision. A listed
-- row that is absent is counted and skipped (a fresh database holds none, so this is a no-op there). A present row
-- that fails a guard aborts the whole migration: nothing is deleted. The touched hourly and daily buckets are
-- recomputed with the store's expressions, and a bucket no row holds any more is deleted. Under the loader lock, as
-- the nightly reconciliation runs. One NOTICE per series: listed, found, deleted, absent.

-- migrate:up
DO $$
DECLARE
  p_keys constant text[] := ${a.keys};
  p_ix constant int[] := ${a.ix};
  p_epoch constant bigint[] := ${a.epoch};
  p_value constant real[] := ${a.value};
  p_sid int[];
  p_tid int[];
  g record;
  d_sid int[];
  d_ts timestamptz[];
  n_deleted int;
  n_listed int[];
  n_found int[];
  n_gone int[];
BEGIN
  PERFORM 1 FROM app_meta WHERE key = 'loader_lock' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '184 orphans: no loader_lock row';
  END IF;

  -- Each key's primary series and its daily-mean twin (null where the registry sync has not made them).
  SELECT array_agg(p.id ORDER BY q.ix), array_agg(t.id ORDER BY q.ix)
    INTO p_sid, p_tid
    FROM unnest(p_keys) WITH ORDINALITY AS q(key, ix)
    LEFT JOIN series p ON p.source_id = 'NL-1' AND p.provider_key = q.key AND p.role = 'primary'
    LEFT JOIN series t ON t.source_id = 'NL-1' AND t.provider_key = q.key || '${TWIN}' AND t.role = 'twin'
                      AND t.aggregate = 'mean';

  -- The guards, over the listed rows that are present.
  WITH l AS (SELECT p_sid[u.ix] AS sid, p_tid[u.ix] AS tid, to_timestamp(u.e) AS ts, u.v
             FROM unnest(p_ix, p_epoch, p_value) AS u(ix, e, v))
  SELECT count(*) AS present,
${failed}
    INTO g
    FROM l
${presentJoins(lo, hi, false)
  .split('\n')
  .map((s) => `    ${s}`)
  .join('\n')};
  IF g.bit512 + g.origin + g.floor + g.value + g.twin_series + g.twin_row + g.latest + g.revision > 0 THEN
    RAISE EXCEPTION '184 orphans: % of % present rows fail a guard (bit512 %, origin %, floor %, value %, twin_series %, twin_row %, latest %, revision %): nothing deleted',
      g.bit512 + g.origin + g.floor + g.value + g.twin_series + g.twin_row + g.latest + g.revision, g.present,
      g.bit512, g.origin, g.floor, g.value, g.twin_series, g.twin_row, g.latest, g.revision;
  END IF;

  -- Per key: the rows listed, and those present (before the delete).
  SELECT array_agg(c.n ORDER BY c.ix) INTO n_listed
    FROM (SELECT q.ix, count(u.ix)::int AS n
          FROM generate_subscripts(p_keys, 1) AS q(ix) LEFT JOIN unnest(p_ix) AS u(ix) ON u.ix = q.ix
          GROUP BY q.ix) c;
  SELECT array_agg(coalesce(c.n, 0) ORDER BY q.ix) INTO n_found
    FROM generate_subscripts(p_keys, 1) AS q(ix)
    LEFT JOIN (SELECT u.ix, count(*)::int AS n
               FROM unnest(p_ix, p_epoch) AS u(ix, e)
               JOIN obs o ON o.series_id = p_sid[u.ix] AND o.ts = to_timestamp(u.e)
                         AND o.ts >= timestamptz '${lo}' AND o.ts < timestamptz '${hi}'
               GROUP BY u.ix) c ON c.ix = q.ix;

  WITH l AS (SELECT p_sid[u.ix] AS sid, to_timestamp(u.e) AS ts
             FROM unnest(p_ix, p_epoch) AS u(ix, e)),
       d AS (DELETE FROM obs o USING l
             WHERE o.series_id = l.sid AND o.ts = l.ts
               AND o.ts >= timestamptz '${lo}' AND o.ts < timestamptz '${hi}'
             RETURNING o.series_id, o.ts)
  SELECT array_agg(d.series_id), array_agg(d.ts), count(*) INTO d_sid, d_ts, n_deleted FROM d;
  IF n_deleted <> g.present THEN
    RAISE EXCEPTION '184 orphans: deleted % rows, % were present', n_deleted, g.present;
  END IF;

  IF n_deleted > 0 THEN
${indent(rollup('obs_1h', '1 hour', lo, hi))}
${indent(rollup('obs_1d', '1 day', lo, hi))}
  END IF;

  SELECT array_agg(coalesce(c.n, 0) ORDER BY q.ix) INTO n_gone
    FROM generate_subscripts(p_keys, 1) AS q(ix)
    LEFT JOIN (SELECT u.s, count(*)::int AS n FROM unnest(d_sid) AS u(s) GROUP BY u.s) c ON c.s = p_sid[q.ix];
  FOR i IN 1 .. array_length(p_keys, 1) LOOP
    RAISE NOTICE '184 orphans: % listed %, found %, deleted %, absent %',
      p_keys[i], n_listed[i], n_found[i], n_gone[i], n_listed[i] - n_found[i];
  END LOOP;
END
$$;

-- migrate:down
-- Nothing: the deleted rows do not come back (data is never restored by a down, and a replay with today's
-- normaliser does not produce them; their values are in the /GEM24H twins).
`;
}

/** The owner's pre-check and post-check: one read-only SELECT, the same rows and guards. Pure. */
export function checkSql(o: Orphans): string {
  const { lo, hi } = range(o);
  const a = arrays(o, '  ');
  const failed = GUARDS.map(
    ([name, expr]) => `       count(*) FILTER (WHERE o.ts IS NOT NULL AND (${expr})) AS fail_${name}`,
  ).join(',\n');
  return `${header(o, 'the read-only check of the orphan migration (20261120000001_184_orphans.sql).')}
--
-- Before the merge every fail_* column must be 0 (else the migration would abort the deploy) and present + absent
-- must equal listed. After the deploy present must be 0, and twin_rows unchanged. It writes nothing: READ ONLY.
--   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -v ON_ERROR_STOP=1 < 184-orphans-check.sql

BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';
WITH q AS (SELECT u.key, u.ix FROM unnest(${a.keys}::text[]) WITH ORDINALITY AS u(key, ix)),
     s AS (SELECT q.ix, q.key, p.id AS sid, t.id AS tid FROM q
           LEFT JOIN series p ON p.source_id = 'NL-1' AND p.provider_key = q.key AND p.role = 'primary'
           LEFT JOIN series t ON t.source_id = 'NL-1' AND t.provider_key = q.key || '${TWIN}' AND t.role = 'twin'
                             AND t.aggregate = 'mean'),
     l AS (SELECT s.key, s.sid, s.tid, to_timestamp(u.e) AS ts, u.v
           FROM unnest(${a.ix}::int[],
  ${a.epoch}::bigint[],
  ${a.value}::real[]) AS u(ix, e, v)
           JOIN s ON s.ix = u.ix)
SELECT l.key, count(*) AS listed, count(o.ts) AS present, count(*) - count(o.ts) AS absent,
${failed},
       (SELECT count(*) FROM obs c WHERE c.series_id = l.tid) AS twin_rows
FROM l
${presentJoins(lo, hi, true)}
GROUP BY l.key, l.tid
ORDER BY l.key;
ROLLBACK;
`;
}

/** The rows back from a migration this generator wrote (CI holds the file equal to migrationSql of them). Pure. */
export function parseMigration(text: string): Orphans {
  const literal = (name: string) => {
    const m = new RegExp(`${name} constant [a-z]+\\[\\] := '\\{([^}]*)\\}';`).exec(text);
    if (m === null) throw new Error(`migration: no ${name} array`);
    return (m[1] as string).split(',').map((s) => s.trim());
  };
  const keys = literal('p_keys').map((k) => k.replace(/^"|"$/g, ''));
  const ix = literal('p_ix').map(Number);
  const epoch = literal('p_epoch').map(Number);
  const value = literal('p_value').map(Number);
  if (ix.length !== epoch.length || ix.length !== value.length) throw new Error('migration: arrays of unequal length');
  return { keys, rows: ix.map((i, n) => ({ ix: i, epoch: epoch[n] as number, value: value[n] as number })) };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error('usage: node scripts/gen-184-orphans.ts <census-184.jsonl[.gz]>');
  const raw = readFileSync(file);
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== CENSUS_SHA256) throw new Error(`${file}: sha256 ${sha} is not the census of #184`);
  const orphans = orphanRows(bytes.toString('utf8'), readStations());
  writeFileSync(MIGRATION, migrationSql(orphans));
  writeFileSync(CHECK, checkSql(orphans));
  console.log(
    `wrote ${MIGRATION.pathname} and ${CHECK.pathname}: ${orphans.rows.length} rows, ${orphans.keys.length} series`,
  );
}
