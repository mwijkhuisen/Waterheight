import { DisplayWindow } from '../apps/server/src/api/window.ts';
import { createApp } from '../apps/server/src/app.ts';
import { OBS_AT } from '../apps/server/src/db/audience.ts';
import { openApiDb } from '../apps/server/src/main.ts';
import { createTestDb } from '../apps/server/test/db/testdb.ts';

// The Q1 benchmark of issue #17: "all series at T" on the synthetic seed of
// 3,000 series × 60 days × 15 min (17.3 M rows) must run in < 50 ms. It runs
// exactly as production does: a real rws_api login (read-only, 2 s statement
// timeout), through the public at-T function of audience.ts (A§8 Q1).
//
// It then benchmarks the API on the same seed (issue #19): "/snapshot p95 is
// < 50 ms warm and < 150 ms cold; /series over 14 days raw is < 50 ms". The
// production app and pool (rws_api, 10 connections) are driven in process, one
// request at a time, and timed from the request to the whole body read.
//
//   DATABASE_URL=<superuser of a throw-away PostgreSQL 18> node scripts/bench-q1.ts [series] [days]

const SERIES = Number(process.argv[2] ?? 3000);
const DAYS = Number(process.argv[3] ?? 60);
const LIMIT_MS = 50;
const RUNS = 30;

const t = await createTestDb();

// P7b: the base tables the classified snapshot reads, at the size production will have and then some. Half the
// series carry about 4 statistical references (a DE-1 style set), 100 an NL-4 style seasonal pair, a third of the
// stations a DE-6 station class with a few changes over the days, ~200 warning areas of which 20 are valid
// throughout (polygons of 300 to 3,000 vertices), a gauge zero for half the series and a fresh fetch per source.
async function seedClassification(series: number, days: number) {
  await t.admin.query(`
    INSERT INTO source (id, provider_id, name, audience, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled)
      SELECT v, 'bench', 'bench', 'public', true, true, true, true, true FROM unnest(ARRAY['DE-1', 'NL-4', 'DE-6', 'FR-5']) v;`);
  // Stations spread over a 10 x 5 degree box, so that a polygon holds only a few of them.
  await t.admin.query(
    `UPDATE station SET lon = 3 + random() * 10, lat = 48 + random() * 5, tier = CASE WHEN id::text ~ '[05]$' THEN 1 ELSE 2 END`,
  );
  await t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, period, priority, valid)
     SELECT s.id, 'DE-1', k.kind, k.value + (s.id % 50), 'cm', 'statistical', daterange('2010-11-01', '2020-11-01'), 0,
            tstzrange(now() - interval '400 days', NULL)
     FROM series s, (VALUES ('MNW', 65), ('MW', 220), ('MHW', 544), ('HSW', 640)) k(kind, value)
     WHERE s.id % 2 = 0`,
  );
  await t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, season_from_md, season_to_md, priority, valid)
     SELECT s.id, 'NL-4', k.kind, k.value + (s.id % 40), 'cm', 'provider_class', k.f, k.t, k.p, tstzrange(now() - interval '400 days', NULL)
     FROM (SELECT id FROM series ORDER BY id LIMIT 100) s,
          (VALUES ('NL4_FROM', 150, 101, 1231, 1), ('NL4_TO', 250, 101, 1231, 1),
                  ('NL4_FROM', 200, 401, 930, 2), ('NL4_TO', 300, 401, 930, 2)) k(kind, value, f, t, p)`,
  );
  await t.admin.query(
    `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, provider_label, level_norm, batch_id)
     SELECT 'station', st.id, now() - make_interval(hours => c * (($1 * 24) / 3)::int / 3), 'DE-6', 'RP:' || ((hashtext(st.id) + c) % 4), 'class', 1, 1
     FROM (SELECT id FROM station WHERE hashtext(id) % 3 = 0) st, generate_series(0, 2) c`,
    [days],
  );
  const polygon = (n: string) => `json_build_object('type', 'Polygon', 'coordinates', json_build_array((
      SELECT json_agg(json_build_array(round((cx + r * cos(a))::numeric, 5), round((cy + r * sin(a))::numeric, 5)) ORDER BY i)
      FROM (SELECT i, 2 * pi() * i / ${n} AS a, r * (0.8 + 0.2 * ((i % ${n}) * 7919 % 10) / 10.0) AS r FROM generate_series(0, ${n}) i) v)))::text`;
  // 20 valid throughout, 180 that closed earlier; a ring closes on its first vertex (i = 0 and i = n alike).
  await t.admin.query(
    `INSERT INTO warning_area (id, source_id, area_key, name, geometry_geojson, level_norm, level_raw, valid, batch_id) OVERRIDING SYSTEM VALUE
     SELECT g, 'DE-6', 'area:' || g, 'area ' || g,
            (SELECT ${polygon('n')} FROM (SELECT 3 + random() * 10 AS cx, 48 + random() * 5 AS cy, 0.3 + random() AS r, 300 + (random() * 2700)::int AS n) p),
            1 + g % 5, (g % 5)::text,
            CASE WHEN g <= 20 THEN tstzrange(now() - interval '1 year', NULL)
                 ELSE tstzrange(now() - make_interval(days => 1 + g % ${days}), now() - make_interval(days => g % ${days}) - interval '3 hours') END,
            1
     FROM generate_series(1, 200) g`,
  );
  await t.admin.query(
    `INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
     SELECT id, (random() * 100)::numeric(8, 3), 'NHN', tstzrange(now() - interval '400 days', NULL), 1 FROM series WHERE id % 2 = 0 AND $1 > 0`,
    [series],
  );
  await t.admin.query(
    `INSERT INTO source_health (source_id, last_fetch_ok, status) SELECT v, now(), 'ok' FROM unnest(ARRAY['NL-1', 'DE-1', 'NL-4', 'DE-6', 'FR-5']) v`,
  );
}

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
  await seedClassification(SERIES, DAYS);
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
        AND (e.lic_history_export OR o.ts >= statement_timestamp() - e.history_window)
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

  // The API on the same seed. The display window starts at the seed's first
  // instant (on the 10-minute grid), so every instant of the seed may be asked.
  const SNAPSHOT_COLD_MS = 150;
  const SNAPSHOT_WARM_MS = 50;
  const SERIES_MS = 50;
  const BUCKET_MS = 600_000;
  const DAY_MS = 86_400_000;
  const SPAN_DAYS = Math.min(14, DAYS - 2); // 14 d unless the seed is shorter
  const ids = (await t.admin.query<{ id: number }>('SELECT id FROM series ORDER BY id')).rows.map((r) => r.id);
  const seed = (
    await t.admin.query<{ first: Date; last: Date }>(
      'SELECT min(ts) AS first, max(ts) AS last FROM obs WHERE series_id = $1',
      [ids[0]],
    )
  ).rows[0] as { first: Date; last: Date };
  const grid = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
  await t.admin.query(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [
    new Date(grid(seed.first.getTime())).toISOString(),
  ]);

  const db = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof db === 'string') throw new Error(`bench-q1: ${db}`);
  try {
    const displayWindow = new DisplayWindow(db.db);
    if (!(await displayWindow.refresh())) throw new Error('bench-q1: the display window is not loaded');
    const app = createApp({ db: db.db, window: displayWindow });
    let acquired = 0; // connections taken from the pool: an in-process cache hit takes none
    db.pool.on('acquire', () => acquired++);

    // RUNS distinct 10-minute buckets over the seeded days, from the first instant with a full
    // series span (14 d) behind it, an hour clear of the edge, to the newest. 7 is coprime to
    // RUNS: the order is shuffled and none repeats, so every first request is a cache miss.
    const lo = seed.first.getTime() + SPAN_DAYS * DAY_MS + 3_600_000;
    const instants = Array.from({ length: RUNS }, (_, i) =>
      grid(lo + (((i * 7) % RUNS) * (seed.last.getTime() - lo)) / (RUNS - 1)),
    );
    const snapshotPath = (ms: number) => `/api/v1/snapshot?t=${new Date(ms).toISOString()}`;
    const seriesPath = (id: number, ms: number) =>
      `/api/v1/series/${id}?from=${new Date(ms - SPAN_DAYS * DAY_MS).toISOString()}&to=${new Date(ms).toISOString()}&res=raw`;
    const snapshots = instants.map(snapshotPath);
    // Distinct series and instants: every key is new to the cache.
    const serieses = instants.map((ms, i) => seriesPath(ids[Math.floor((i * ids.length) / RUNS)] as number, ms));

    const ask = async (paths: string[]) => {
      const before = acquired;
      const answers: { status: number; body: string; ms: number }[] = [];
      for (const path of paths) {
        const t0 = process.hrtime.bigint();
        const res = await app.request(path);
        const body = await res.text();
        answers.push({ status: res.status, body, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
      }
      return { answers, acquired: acquired - before };
    };
    const report = (
      label: string,
      limit: number,
      run: Awaited<ReturnType<typeof ask>>,
      problem: (body: string) => string | undefined,
    ) => {
      const times = run.answers.map((a) => a.ms).sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)] as number;
      const p95 = times[Math.ceil(times.length * 0.95) - 1] as number;
      console.log(
        `API ${label}: p95 ${p95.toFixed(1)} ms, median ${median.toFixed(1)} ms, max ${(times.at(-1) as number).toFixed(1)} ms over ${times.length} runs (limit ${limit} ms)`,
      );
      const bad = run.answers
        .map((a) => (a.status === 200 ? problem(a.body) : `status ${a.status}`))
        .find((p) => p !== undefined);
      if (bad !== undefined) {
        console.error(`bench-q1: FAIL: API ${label}: ${bad}`);
        failed = true;
      }
      if (p95 >= limit) {
        console.error(`bench-q1: FAIL: API ${label}: p95 ${p95.toFixed(1)} ms is not under ${limit} ms`);
        failed = true;
      }
    };
    const snapshotProblem = (body: string) => {
      const values: { state: string }[] = JSON.parse(body).values;
      if (values.length !== SERIES) return `${values.length} values, expected ${SERIES}`;
      // The P7b seed must reach the classifier: some values carry a state.
      return values.some((v) => v.state !== 'no_ref') ? undefined : 'no value has a state';
    };
    const seriesProblem = (body: string) => {
      const s = JSON.parse(body);
      const n = SPAN_DAYS * 96; // 15-minute steps, from and to on the grid
      return s.points.length === n && !s.truncated ? undefined : `${s.points.length} points, expected ${n}`;
    };

    // Two warm-up requests (the pool's first connection, the code paths), not counted:
    // their instant lies before every measured one, so no measured key is warmed.
    await ask([snapshotPath(lo - BUCKET_MS), seriesPath(ids[0] as number, lo - BUCKET_MS)]);

    const cold = await ask(snapshots);
    report('/snapshot cold (LRU miss)', SNAPSHOT_COLD_MS, cold, snapshotProblem);
    const warm = await ask(snapshots);
    report('/snapshot warm (LRU hit)', SNAPSHOT_WARM_MS, warm, snapshotProblem);
    if (cold.acquired < RUNS || warm.acquired !== 0 || warm.answers.some((a, i) => a.body !== cold.answers[i]?.body)) {
      console.error(
        `bench-q1: FAIL: the cache did not behave: ${cold.acquired} database calls cold, ${warm.acquired} warm`,
      );
      failed = true;
    }
    report(`/series ${SPAN_DAYS} d raw (LRU miss)`, SERIES_MS, await ask(serieses), seriesProblem);
  } finally {
    await db.close();
  }
} finally {
  await t.drop();
}
process.exitCode = failed ? 1 : 0;
if (!failed) console.log('bench-q1: OK');
