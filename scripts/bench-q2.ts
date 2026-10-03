import { FORECAST_AT } from '../apps/server/src/db/audience.ts';
import { createTestDb } from '../apps/server/test/db/testdb.ts';

// The Q2 benchmark of issue #23 (P8a): "the latest forecast run of every series as of T" on a synthetic seed of
// 60 days of runs at twice the volume the forecast sources will have must run in < 50 ms. It runs exactly as
// production does: a real rws_api login (read-only, 2 s statement timeout), through the public latest-run function
// of audience.ts (A§8 Q2: per (series, source) the latest run known at `asof`, kept only if it reaches `t`).
//
// The seed is the volume table of the plan (§4.8), per source: series × runs a day × values a run, the runs a day
// multiplied by VOLUME (2: the headroom). The set of series stays the registry's (296). Owner sources (DE-2, DE-3,
// LU-3) hang on public series, as the registry attaches them; the public function scans and drops them.
//
//   DATABASE_URL=<superuser of a throw-away PostgreSQL 18> node scripts/bench-q2.ts [days] [volume]

const DAYS = Number(process.argv[2] ?? 60);
const VOLUME = Number(process.argv[3] ?? 2);
const LIMIT_MS = 50;
const REPEATS = 3;

type Cfg = {
  group: string; // the provider_key prefix of its series
  seriesSource: string; // the source of the series (the run's source differs for DE-2 and LU-3)
  series: number;
  runSource: string;
  runsPerDay: number; // before VOLUME
  values: number;
  step: string;
  issued: boolean; // the provider states the issue time (else it is inferred: NULL)
  kind: 'deterministic' | 'quantiles';
};
const CONFIGS: Cfg[] = [
  {
    group: 'nl',
    seriesSource: 'NL-1',
    series: 196,
    runSource: 'NL-1',
    runsPerDay: 4,
    values: 205,
    step: '10 minutes',
    issued: false,
    kind: 'deterministic',
  },
  {
    group: 'de2',
    seriesSource: 'DE-1',
    series: 7,
    runSource: 'DE-2',
    runsPerDay: 1,
    values: 49,
    step: '2 hours',
    issued: true,
    kind: 'deterministic',
  },
  {
    group: 'lu3',
    seriesSource: 'LU-1',
    series: 11,
    runSource: 'LU-3',
    runsPerDay: 24,
    values: 46,
    step: '1 hour',
    issued: false,
    kind: 'quantiles',
  },
  {
    group: 'ch4',
    seriesSource: 'CH-4',
    series: 55,
    runSource: 'CH-4',
    runsPerDay: 4,
    values: 115,
    step: '30 minutes',
    issued: true,
    kind: 'deterministic',
  },
  {
    group: 'de3',
    seriesSource: 'DE-1',
    series: 7,
    runSource: 'DE-3',
    runsPerDay: 1,
    values: 15,
    step: '3 hours',
    issued: true,
    kind: 'deterministic',
  },
  {
    group: 'fr4',
    seriesSource: 'FR-4',
    series: 20,
    runSource: 'FR-4',
    runsPerDay: 24,
    values: 21,
    step: '2 hours',
    issued: false,
    kind: 'deterministic',
  },
];
const PUBLIC_SOURCES = ['NL-1', 'DE-1', 'LU-1', 'CH-4', 'FR-4'];
const OWNER_SOURCES = ['DE-2', 'DE-3', 'LU-3'];
const BASIS = `'{"clause": "bench", "url": "https://example.org/terms", "retrieved": "2026-09-24"}'::jsonb`;

const t = await createTestDb();
let failed = false;
try {
  const started = Date.now();
  await t.admin.query(`SET synchronous_commit = off`);
  await t.admin.query(`INSERT INTO provider (id, name, country) VALUES ('bench', 'bench', 'NL')`);
  await t.admin.query(
    `INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled)
     SELECT v, 'bench', 'bench', 'public', NULL, true, true, true, true, true FROM unnest($1::text[]) v`,
    [PUBLIC_SOURCES],
  );
  await t.admin.query(
    `INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled)
     SELECT v, 'bench', 'bench', 'owner', ${BASIS}, true, true, false, true, true FROM unnest($1::text[]) v`,
    [OWNER_SOURCES],
  );
  for (const c of CONFIGS) {
    await t.admin.query(
      `INSERT INTO station (id, name, country, tier) SELECT 'nl.bench.' || $1::text || '-' || g, 'bench', 'NL', 1 FROM generate_series(1, $2::int) g`,
      [c.group, c.series],
    );
    await t.admin.query(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role)
       SELECT 'nl.bench.' || $1::text || '-' || g, $2::text, 'H', 'stage', $1::text || '-' || g, 'cm', 1, 'LOCAL',
              '15 min', '15 min', '45 min', 'primary'
       FROM generate_series(1, $3::int) g`,
      [c.group, c.seriesSource, c.series],
    );
  }
  const now0 = (
    await t.admin.query<{ now0: Date }>(
      `SELECT date_bin('1 hour', now(), timestamptz '2000-01-01 00:00:00+00') AS now0`,
    )
  ).rows[0]?.now0 as Date;
  await t.admin.query(
    `SELECT ensure_partitions($1::timestamptz - make_interval(days => $2::int + 1), $1::timestamptz + interval '6 days')`,
    [now0, DAYS],
  );

  // Runs: per series `runs` of them, evenly spaced, the newest at `now0` (a minute or two of phase per series, a few
  // minutes between the issue and the fetch). A run without a stated issue time is placed by its fetch time.
  let totalRuns = 0;
  for (const c of CONFIGS) {
    const runs = c.runsPerDay * VOLUME * DAYS;
    const spacing = 86_400 / (c.runsPerDay * VOLUME); // seconds
    const { rowCount } = await t.admin.query(
      `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                 content_hash, kind, step, batch_id)
       SELECT x.series_id, $2::text, CASE WHEN $3::boolean THEN x.base END, NOT $3::boolean,
              CASE WHEN $3::boolean THEN x.base ELSE x.base + x.lag END,
              CASE WHEN $3::boolean THEN x.base ELSE x.base + x.lag END + ($4::int - 1) * $5::interval,
              x.base + x.lag, sha256(convert_to(x.series_id::text || ':' || x.k, 'UTF8')), $6::text, $5::interval, 1
       FROM (SELECT s.id AS series_id, k,
                    $7::timestamptz - make_interval(secs => ($8::int - 1 - k) * $9::double precision) - make_interval(mins => p.j % 7) AS base,
                    make_interval(mins => 1 + p.j % 5) AS lag
             FROM series s
             CROSS JOIN LATERAL (SELECT split_part(s.provider_key, '-', 2)::int AS j) p
             CROSS JOIN generate_series(0, $8::int - 1) k
             WHERE s.provider_key LIKE $1::text || '-%') x
       ORDER BY x.base, x.series_id`,
      [c.group, c.runSource, c.issued, c.values, c.step, c.kind, now0, runs, spacing],
    );
    totalRuns += rowCount ?? 0;
  }

  // Values: every run's points, in run-id chunks so that no statement holds the whole 25 M rows. A quantile run
  // (LU-3) also states p10 … p90.
  await t.admin.query(`CREATE TEMP TABLE bench_values (source_id text PRIMARY KEY, n int, quantiles boolean)`);
  await t.admin.query(`INSERT INTO bench_values SELECT * FROM unnest($1::text[], $2::int[], $3::boolean[])`, [
    CONFIGS.map((c) => c.runSource),
    CONFIGS.map((c) => c.values),
    CONFIGS.map((c) => c.kind === 'quantiles'),
  ]);
  const ids = (await t.admin.query<{ lo: string; hi: string }>(`SELECT min(id) AS lo, max(id) AS hi FROM forecast_run`))
    .rows[0] as {
    lo: string;
    hi: string;
  };
  const CHUNK = 5_000;
  for (let lo = Number(ids.lo); lo <= Number(ids.hi); lo += CHUNK) {
    await t.admin.query(
      `INSERT INTO forecast_value (run_id, valid_ts, value, p10, p30, p50, p70, p90, flags)
       SELECT r.id, r.first_valid + g * r.step, v.x::real,
              CASE WHEN b.quantiles THEN (v.x * 0.8)::real END, CASE WHEN b.quantiles THEN (v.x * 0.9)::real END,
              CASE WHEN b.quantiles THEN v.x::real END, CASE WHEN b.quantiles THEN (v.x * 1.1)::real END,
              CASE WHEN b.quantiles THEN (v.x * 1.2)::real END, 0
       FROM forecast_run r
       JOIN bench_values b ON b.source_id = r.source_id
       CROSS JOIN LATERAL generate_series(0, b.n - 1) g
       CROSS JOIN LATERAL (SELECT random() * 1000 AS x) v
       WHERE r.id >= $1 AND r.id < $1 + $2
       ORDER BY r.id, g`,
      [lo, CHUNK],
    );
  }
  await t.admin.query('RESET synchronous_commit');
  // What autovacuum does in production: hint bits, the visibility map and statistics.
  await t.admin.query('VACUUM (ANALYZE) forecast_run');
  await t.admin.query('VACUUM (ANALYZE) forecast_value');
  await t.admin.query('ANALYZE');
  const size = (
    await t.admin.query<{ runs: string; vals: string }>(
      `SELECT (SELECT count(*) FROM forecast_run) AS runs, (SELECT count(*) FROM forecast_value) AS vals`,
    )
  ).rows[0] as { runs: string; vals: string };
  console.log(
    `seed: ${CONFIGS.reduce((n, c) => n + c.series, 0)} series, ${DAYS} days at ${VOLUME}× = ${size.runs} runs, ${size.vals} values in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  if (Number(size.runs) !== totalRuns) {
    console.error(`bench-q2: FAIL: ${size.runs} runs stored, ${totalRuns} inserted`);
    failed = true;
  }

  const api = await t.connectAs('rws_api');
  const who = await api.query('SELECT current_user AS u, current_setting($1) AS st', ['statement_timeout']);
  console.log(`as ${who.rows[0].u} (statement_timeout ${who.rows[0].st}), function ${FORECAST_AT.public}`);

  // The plan of the function body, as the object owner sees it (EXPLAIN does not look inside a function): the body of
  // the migration itself, read from the catalogue, planned generically as a SQL function is (the instants unknown).
  const src = (
    await t.admin.query<{ s: string }>('SELECT prosrc AS s FROM pg_proc WHERE proname = $1', [FORECAST_AT.public])
  ).rows[0]?.s as string;
  const body = src.replaceAll(/\bp_asof\b/g, '$1').replaceAll(/\bp_t\b/g, '$2');
  const instant = new Date(now0.getTime() + 30 * 60_000);
  await t.admin.query(`PREPARE q2(timestamptz, timestamptz) AS ${body}`);
  await t.admin.query('SET plan_cache_mode = force_generic_plan');
  const iso = instant.toISOString();
  const plan = (
    await t.admin.query({ text: `EXPLAIN (ANALYZE, BUFFERS) EXECUTE q2('${iso}', '${iso}')`, rowMode: 'array' })
  ).rows
    .map((r: unknown[]) => String(r[0]))
    .join('\n');
  await t.admin.query('RESET plan_cache_mode');
  console.log(plan);
  const usesAsof = /forecast_run_asof/.test(plan);
  console.log(`plan uses forecast_run_asof: ${usesAsof}; forecast_run_merge: ${/forecast_run_merge/.test(plan)}`);
  if (!usesAsof) {
    console.error('bench-q2: FAIL: the plan does not use the index forecast_run_asof');
    failed = true;
  }

  // Q2 as the readers call it. The instants: now (asof = t, every run current), a past asof (a replayed or "as it
  // was" view) and t up to 48 h ahead (the runs that no longer reach it drop out).
  const Q2 = `SELECT run_id, series_id, source_id, valid_ts, value, flags FROM ${FORECAST_AT.public}($1::timestamptz, $2::timestamptz)`;
  const HOUR = 3_600_000;
  const asofs = [0, 1, 3, 6, 12, 24, 72, 7 * 24, 30 * 24, (DAYS - 3) * 24].map(
    (h) => new Date(instant.getTime() - h * HOUR),
  );
  const aheads = [0, 1, 6, 24, 48];
  const pairs = asofs.flatMap((asof, a) =>
    aheads.map((h) => ({ a, asof, t: new Date(asof.getTime() + h * HOUR), ahead: h })),
  );
  const scans = async () =>
    Object.fromEntries(
      (
        await t.admin.query<{ indexrelname: string; idx_scan: string }>(
          `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE relname = 'forecast_run'`,
        )
      ).rows.map((r) => [r.indexrelname, Number(r.idx_scan)]),
    );
  // The seeding session's own statistics are flushed a second after it goes idle: let them land first.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await t.admin.query('SELECT pg_stat_clear_snapshot()');
  const before = await scans();
  for (let i = 0; i < 3; i++) await api.query(Q2, [instant, instant]); // warm-up
  const times: { ms: number; rows: number; now: boolean }[] = [];
  for (let r = 0; r < REPEATS; r++) {
    for (const p of pairs) {
      const t0 = process.hrtime.bigint();
      const result = await api.query(Q2, [p.asof, p.t]);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      times.push({ ms, rows: result.rowCount ?? 0, now: p.a === 0 });
    }
  }
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      median: s[Math.floor(s.length / 2)] as number,
      p95: s[Math.ceil(s.length * 0.95) - 1] as number,
      max: s.at(-1) as number,
    };
  };
  const all = stats(times.map((x) => x.ms));
  const now = stats(times.filter((x) => x.now).map((x) => x.ms));
  console.log(
    `Q2 "latest run as of T": median ${all.median.toFixed(1)} ms, p95 ${all.p95.toFixed(1)} ms, max ${all.max.toFixed(1)} ms over ${times.length} runs of ${pairs.length} (asof, t) pairs (limit ${LIMIT_MS} ms)`,
  );
  console.log(
    `  asof = now (t from now to +48 h): median ${now.median.toFixed(1)} ms, p95 ${now.p95.toFixed(1)} ms, max ${now.max.toFixed(1)} ms`,
  );
  const rowsAtNow = (await api.query(Q2, [instant, instant])).rowCount;
  const publicSeries = CONFIGS.filter((c) => PUBLIC_SOURCES.includes(c.runSource)).reduce((n, c) => n + c.series, 0);
  console.log(`rows at asof = t = now: ${rowsAtNow} (the public sources' series: ${publicSeries})`);
  if (rowsAtNow !== publicSeries) {
    console.error(`bench-q2: FAIL: ${rowsAtNow} rows at now, expected ${publicSeries}`);
    failed = true;
  }
  // Index use by the function itself (the statistics of a session are flushed a second after it goes idle).
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await t.admin.query('SELECT pg_stat_clear_snapshot()');
  const after = await scans();
  for (const name of Object.keys(after).sort())
    console.log(`index ${name}: ${(after[name] as number) - (before[name] ?? 0)} scans during the timed calls`);
  if (all.median >= LIMIT_MS) {
    console.error(`bench-q2: FAIL: median ${all.median.toFixed(1)} ms is not under ${LIMIT_MS} ms`);
    failed = true;
  }
  if (now.median >= LIMIT_MS) {
    console.error(`bench-q2: FAIL: median at now ${now.median.toFixed(1)} ms is not under ${LIMIT_MS} ms`);
    failed = true;
  }
} finally {
  await t.drop();
}
process.exitCode = failed ? 1 : 0;
if (!failed) console.log('bench-q2: OK');
