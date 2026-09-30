import { OBS_AT } from '../apps/server/src/db/audience.ts';
import { createTestDb } from '../apps/server/test/db/testdb.ts';

// The Q1 benchmark of issue #17: "all series at T" on the synthetic seed of
// 3,000 series × 60 days × 15 min (17.3 M rows) must run in < 50 ms. It runs
// exactly as production does: a real rws_api login (read-only, 2 s statement
// timeout), through the public views of audience.ts, with the A§8 Q1 text.
//
//   DATABASE_URL=<superuser of a throw-away PostgreSQL 18> node scripts/bench-q1.ts [series] [days]

const SERIES = Number(process.argv[2] ?? 3000);
const DAYS = Number(process.argv[3] ?? 60);
const LIMIT_MS = 50;
const RUNS = 30;

const t = await createTestDb();
let failed = false;
try {
  const started = Date.now();
  await t.admin.query(`
    INSERT INTO provider (id, name, country) VALUES ('bench', 'bench', 'NL');
    INSERT INTO source (id, provider_id, name, audience, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled)
      VALUES ('NL-1', 'bench', 'bench', 'public', true, true, true, true, true);`);
  await t.admin.query(
    `INSERT INTO station (id, name, country, tier) SELECT 'nl.bench.' || g, 'bench ' || g, 'NL', 2 FROM generate_series(1, $1) g`,
    [SERIES],
  );
  // A third of the series have the 25 h limit of a slow gauge; the rest the default 45 min.
  await t.admin.query(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role)
     SELECT 'nl.bench.' || g, 'NL-1', 'H', 'level', 'k' || g, 'cm', 1, 'NAP', '15 min', '15 min',
            CASE WHEN g % 3 = 0 THEN interval '25 hours' ELSE interval '45 min' END, 'primary'
     FROM generate_series(1, $1) g`,
    [SERIES],
  );
  await t.admin.query(`SELECT ensure_partitions(now() - make_interval(days => $1), now())`, [DAYS + 1]);
  // Time-major, as the loader inserts: every series at each step.
  await t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT s.id, ts, (random() * 1000)::real, 1, 1
     FROM generate_series(date_bin('15 min', now(), timestamptz '2000-01-01 00:00:00+00') - make_interval(days => $1),
                          date_bin('15 min', now(), timestamptz '2000-01-01 00:00:00+00'), interval '15 min') ts
     CROSS JOIN series s`,
    [DAYS],
  );
  await t.admin.query('ANALYZE');
  const { rows: size } = await t.admin.query<{ n: string }>('SELECT count(*) AS n FROM obs');
  console.log(
    `seed: ${SERIES} series × ${DAYS} days = ${size[0]?.n} rows in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );

  const api = await t.connectAs('rws_api');
  const who = await api.query('SELECT current_user AS u, current_setting($1) AS st', ['statement_timeout']);
  console.log(`as ${who.rows[0].u} (statement_timeout ${who.rows[0].st}), function ${OBS_AT.public}`);
  // A§8 Q1: the value of every public series at :t, carrying the last observation forward within its staleness limit.
  const Q1 = `SELECT series_id, ts, value, qc, $1::timestamptz - ts AS age FROM ${OBS_AT.public}($1::timestamptz)`;
  const at = (i: number) => new Date(Date.now() - ((i * 37) % (DAYS - 2)) * 86_400_000 - i * 61_000);

  // The plan of the function body, as the object owner sees it (EXPLAIN does not look inside a function).
  const body = `
    SELECT e.series_id, o.ts, o.value, o.qc
    FROM series_eff e JOIN series s ON s.id = e.series_id
    CROSS JOIN LATERAL (
      SELECT o.ts, o.value, o.qc FROM obs o
      WHERE o.series_id = e.series_id AND o.ts <= $1::timestamptz AND o.ts > $1::timestamptz - s.staleness_limit
        AND (e.lic_history_export OR o.ts >= now() - e.history_window)
      ORDER BY o.ts DESC LIMIT 1) o
    WHERE s.active AND e.audience IN ('public') AND e.role = 'primary' AND e.lic_display`;
  const plan = (
    await t.admin.query({ text: `EXPLAIN (ANALYZE, BUFFERS) ${body}`, values: [at(3)], rowMode: 'array' })
  ).rows
    .map((r: unknown[]) => String(r[0]))
    .join('\n');
  console.log(plan);
  if (!/Index Scan Backward using obs_\d{4}_\d{2}_pkey/.test(plan)) {
    console.error('bench-q1: FAIL: not a backward index scan on (series_id, ts)');
    failed = true;
  }
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < RUNS + 3; i++) {
    const t0 = process.hrtime.bigint();
    const result = await api.query(Q1, [at(i)]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows = result.rowCount ?? 0;
    if (i >= 3) times.push(ms); // three warm-up runs
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] as number;
  const p95 = times[Math.ceil(times.length * 0.95) - 1] as number;
  console.log(
    `Q1 "all series at T": ${rows} rows; median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${(times.at(-1) as number).toFixed(1)} ms over ${RUNS} runs (limit ${LIMIT_MS} ms)`,
  );
  if (rows !== SERIES) {
    console.error(`bench-q1: FAIL: ${rows} rows, expected ${SERIES}`);
    failed = true;
  }
  if (median >= LIMIT_MS) {
    console.error(`bench-q1: FAIL: median ${median.toFixed(1)} ms is not under ${LIMIT_MS} ms`);
    failed = true;
  }
} finally {
  await t.drop();
}
process.exitCode = failed ? 1 : 0;
if (!failed) console.log('bench-q1: OK');
