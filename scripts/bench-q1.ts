import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { StaticCache } from '../apps/server/src/api/states.ts';
import { DisplayWindow } from '../apps/server/src/api/window.ts';
import { createApp } from '../apps/server/src/app.ts';
import { OBS_AT, TIDE_AT, VIEWS } from '../apps/server/src/db/audience.ts';
import { type DbConfig, dbConfig, openDb } from '../apps/server/src/db/pool.ts';
import { vigicruesSections } from '../apps/server/src/load/tables.ts';
import { openApiDb } from '../apps/server/src/main.ts';
import { type CycleDeps, Publisher, type Renderers } from '../apps/server/src/publish/cycle.ts';
import { BUDGET_MS, CYCLE_MS } from '../apps/server/src/publish/index.ts';
import { RENDERERS } from '../apps/server/src/publish/render/index.ts';
import { Output } from '../apps/server/src/publish/write.ts';
import { createTestDb } from '../apps/server/test/db/testdb.ts';
import { BUCKET_MS as BUCKET_STEP_MS, dayOf, isSettled } from '../packages/contracts/src/index.ts';

// The Q1 benchmark of issue #17: "all series at T" on the synthetic seed of
// 4,000 series × 60 days × 15 min (23 M rows; P20a, issue #68: 3,000 until then, roughly twice the public series
// of roadmap 2) must run in < 50 ms. It runs exactly as production does: a real rws_api login (read-only, 2 s
// statement timeout), through the public at-T function of audience.ts (A§8 Q1).
//
// It then benchmarks the API on the same seed (issue #19): "/snapshot p95 is
// < 50 ms warm and < 150 ms cold; /series over 14 days raw is < 50 ms". The
// production app and pool (rws_api, 10 connections) are driven in process, one
// request at a time, and timed from the request to the whole body read.
//
// Last, the publisher (P20a, A§9.1): the real renderers and Publisher of the `publish` role, as rws_publish, on a
// temporary output tree, for two cycles. Cycle 1 is a cold start (every bucket of the unsettled days queued, the 35 s
// budget of production, one settled day); then the steady state: one new value per series with the dirty row the
// loader would write and no settled day pending, cycled until the new bucket and every station file are published. The budgets B1 to B4 are asserted below; a breach is a finding for the
// owner and is reported, never tuned away.
//
// The seed mixes as production does: about 5 % of the series are tidal, and the fixed counts (NL-4 pairs, day-of-year
// series, warning areas) grow with the series, from their values at 3,000.
//
//   DATABASE_URL=<superuser of a throw-away PostgreSQL 18> node scripts/bench-q1.ts [--series N] [--days N]

function intFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const raw = process.argv[i + 1] ?? '';
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    console.error('usage: node scripts/bench-q1.ts [--series N] [--days N]  (integers >= 1; defaults 4000 and 60)');
    process.exit(2);
  }
  return n;
}
const args = process.argv.slice(2);
for (const [i, a] of args.entries()) {
  // A flag, or the value right after one; anything else (the retired positional form) is a usage error.
  if (a !== '--series' && a !== '--days' && args[i - 1] !== '--series' && args[i - 1] !== '--days') {
    console.error('usage: node scripts/bench-q1.ts [--series N] [--days N]  (integers >= 1; defaults 4000 and 60)');
    process.exit(2);
  }
}
const SERIES = intFlag('--series', 4000);
const DAYS = intFlag('--days', 60);
const LIMIT_MS = 50;
const RUNS = 30;
const TIDE_MS = 20;
const TIDAL = Math.round(SERIES * 0.05); // P18a: stations flagged tidal, staleness 1 h (the registry's); production has 4.9 %
// The fixed counts of the 3,000-series seed, scaled with the series (rounded).
const scaled = (n: number) => Math.round((n * SERIES) / 3000);
const NL4_PAIRS = scaled(100);
const DOY_SERIES = scaled(300);
const AREAS = scaled(200);
const VALID_AREAS = scaled(20);
// The publisher's budgets (P20a, owner decision Q1; B4 is derived: the work of one bucket period is done within one).
const B1_BUCKET_P95_MS = 500; // per 10-minute bucket: render, validation, canary scan, then the .zst/.gz/plain write
const B2_LATEST_GZ_BYTES = 200_000;
const B3_SNAPSHOT_GZ_BYTES = 150_000; // one recent/ or settled/ snapshot
const B4_DRAIN_MS = BUCKET_STEP_MS; // one bucket's new values fully published within one bucket period (600 s)
const B4_MAX_CYCLES = 12;
// A§11.4: the static files, images and logs line of the year-1 disk budget.
const STATIC_LINE_BYTES = 5e9;

const t = await createTestDb();
{
  const version = (await t.admin.query<{ v: string }>('SELECT version() AS v')).rows[0]?.v;
  console.log(
    `machine: ${cpus()[0]?.model ?? 'unknown CPU'}, ${availableParallelism()} cores, ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM; ${version}`,
  );
}

// P7b: the base tables the classified snapshot reads, at the size production will have and then some. Half the
// series carry about 4 statistical references (a DE-1 style set), NL4_PAIRS an NL-4 style seasonal pair, a third of the
// stations a DE-6 station class with a few changes over the days, AREAS warning areas of which VALID_AREAS are valid
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
     FROM (SELECT id FROM series ORDER BY id LIMIT $1) s,
          (VALUES ('NL4_FROM', 150, 101, 1231, 1), ('NL4_TO', 250, 101, 1231, 1),
                  ('NL4_FROM', 200, 401, 930, 2), ('NL4_TO', 300, 401, 930, 2)) k(kind, value, f, t, p)`,
    [NL4_PAIRS],
  );
  // P14f: the day-of-year rows of 300 series, 2 kinds × 365 day keys (a non-leap MMDD list: the CHECK refuses 0229),
  // so that the day read of a cold /snapshot is measured at the size of 300 eligible series.
  await t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, percentile_convention, period,
                                  season_from_md, season_to_md, priority, basis_label, valid)
     SELECT s.id, 'NL-1', k.kind, k.base + (s.id % 30), 'cm', 'statistical', 'non_exceedance',
            daterange('2010-01-01', '2020-01-01'), d.md, d.md, 0, 'DOY P10-P90, 2010-2019, 31 d/yr',
            tstzrange(now() - interval '400 days', NULL)
     FROM (SELECT id FROM series ORDER BY id LIMIT $1) s,
          (VALUES ('P10_DOY', 100), ('P90_DOY', 800)) k(kind, base),
          (SELECT to_char(g, 'MMDD')::int AS md FROM generate_series(date '2001-01-01', date '2001-12-31', interval '1 day') g) d`,
    [DOY_SERIES],
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
            CASE WHEN g <= $2 THEN tstzrange(now() - interval '1 year', NULL)
                 ELSE tstzrange(now() - make_interval(days => 1 + g % ${days}), now() - make_interval(days => g % ${days}) - interval '3 hours') END,
            1
     FROM generate_series(1, $1) g`,
    [AREAS, VALID_AREAS],
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

const p95Of = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)] as number,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] as number,
    max: sorted.at(-1) as number,
  };
};

/**
 * B1 to B4 on the real Publisher (publish/cycle.ts) with the real renderers, as rws_publish (the login of
 * flood-drill.int.test.ts), on a temporary root. The renderers and the Output are wrapped only to time them: the
 * wrappers call the originals with the same arguments. Returns false when a budget is breached.
 */
async function publisherPhase(): Promise<boolean> {
  let ok = true;
  const breach = (msg: string) => {
    console.error(`bench-q1: FAIL: ${msg}`);
    ok = false;
  };
  const cfg = dbConfig({ DATABASE_URL: t.urlFor('rws_publish') }, 'rws_publish');
  if (typeof cfg === 'string') throw new Error(`bench-q1: ${cfg}`);
  const pub = openDb(cfg as DbConfig, { max: 3 }); // the public publisher's pool (publish/index.ts POOL)
  const root = mkdtempSync(join(tmpdir(), 'bench-publish-'));
  // Per step: time in the renderer, time in Output.put (JSON, hash, .zst level 19, .gz level 9, plain), files.
  type Step = { render: number; write: number; files: number };
  let steps = new Map<string, Step>();
  const step = (name: string) => {
    const s = steps.get(name) ?? { render: 0, write: 0, files: 0 };
    steps.set(name, s);
    return s;
  };
  const stepOf = (rel: string) =>
    rel === 'stations.json'
      ? 'stations'
      : rel === 'latest.json'
        ? 'latest'
        : rel === 'sources.json'
          ? 'sources'
          : rel === 'status.json'
            ? 'status'
            : rel === 'meta.json'
              ? 'meta'
              : rel.startsWith('series/')
                ? 'station'
                : (/^[a-z]+/.exec(rel)?.[0] ?? rel); // forecast, warnings, recent, settled, frames
  let clock = Date.now();
  let pending: { start: bigint; settled: boolean } | undefined;
  const bucketMs = { recent: [] as number[], settled: [] as number[] };
  const written: string[] = []; // every rel put, in order
  const ms = (from: bigint) => Number(process.hrtime.bigint() - from) / 1e6;
  // ponytail: the cast keeps the ten wrappers to one loop; a renderer added to Renderers is timed with no edit here.
  const render = Object.fromEntries(
    Object.entries(RENDERERS).map(([name, fn]) => [
      name,
      async (...a: unknown[]) => {
        const start = process.hrtime.bigint();
        const key = name === 'snapshot' ? (isSettled(dayOf(a[1] as number), clock) ? 'settled' : 'recent') : name;
        if (name === 'snapshot') pending = { start, settled: key === 'settled' };
        try {
          return await (fn as (...x: unknown[]) => Promise<unknown>)(...a);
        } finally {
          step(key).render += ms(start);
        }
      },
    ]),
  ) as Renderers;
  class TimedOutput extends Output {
    override async put(rel: string, body: unknown, remember = true): Promise<number> {
      const start = process.hrtime.bigint();
      try {
        return await super.put(rel, body, remember);
      } finally {
        const s = step(stepOf(rel));
        s.write += ms(start);
        s.files++;
        written.push(rel);
        if ((rel.startsWith('recent/') || rel.startsWith('settled/')) && pending !== undefined) {
          bucketMs[pending.settled ? 'settled' : 'recent'].push(ms(pending.start)); // snapshot call to plain file
          pending = undefined;
        }
      }
    }
  }
  const deps: CycleDeps = {
    db: pub.db,
    family: 'public',
    out: new TimedOutput(root),
    render,
    window: new DisplayWindow(pub.db, { error: () => undefined }, 'public'),
    now: () => clock,
    build: 'dev',
    sections: vigicruesSections(),
    cache: new StaticCache(60_000, () => clock),
    inputs: undefined,
    log: { error: () => undefined },
    brownout: () => false,
    budgetMs: BUDGET_MS,
    settledPerCycle: 1, // production's
    strict: true,
  };
  const publisher = new Publisher(deps);
  const secs = (x: number) => (x / 1000).toFixed(1);
  const stepLines = (total: number) => {
    const lines = [...steps.entries()].map(
      ([name, s]) => `  ${name}: render ${s.render.toFixed(0)} ms, write ${s.write.toFixed(0)} ms, ${s.files} files`,
    );
    const timed = [...steps.values()].reduce((a, s) => a + s.render + s.write, 0);
    return [
      ...lines,
      `  other (database reads for versions and dirty rows, validation, canary scans, prune): ${(total - timed).toFixed(0)} ms`,
    ];
  };
  try {
    // Cycle 1: cold start. Production's budget and one settled day.
    const t1 = Date.now();
    clock = t1;
    await publisher.cycle();
    const cold = Date.now() - t1;
    console.log(
      `publisher cycle 1 (cold start, budget ${secs(BUDGET_MS)} s, 1 settled day): ${secs(cold)} s; ${bucketMs.recent.length} recent buckets and ${bucketMs.settled.length} settled buckets rendered, ${step('station').files} station files`,
    );
    for (const l of stepLines(cold)) console.log(l);
    for (const kind of ['recent', 'settled'] as const) {
      const xs = bucketMs[kind];
      if (xs.length === 0) {
        breach(`no ${kind} bucket was rendered in the cold cycle`);
        continue;
      }
      const { median, p95, max } = p95Of(xs);
      console.log(
        `publisher B1 ${kind} bucket (snapshot call to plain file): p95 ${p95.toFixed(0)} ms, median ${median.toFixed(0)} ms, max ${max.toFixed(0)} ms over ${xs.length} buckets${xs.length < RUNS ? ` (fewer than ${RUNS}: all the budget allowed)` : ''} (budget ${B1_BUCKET_P95_MS} ms)`,
      );
      if (p95 > B1_BUCKET_P95_MS)
        breach(`publisher B1: ${kind} bucket p95 ${p95.toFixed(0)} ms is over ${B1_BUCKET_P95_MS} ms`);
    }
    // Sizes of the files as written: plain, .gz and .zst.
    const sizes = (rel: string) => {
      const base = join(root, 'v1', rel);
      return { plain: statSync(base).size, gz: statSync(`${base}.gz`).size, zst: statSync(`${base}.zst`).size };
    };
    const firstOf = (prefix: string) => written.find((r) => r.startsWith(prefix));
    const latest = sizes('latest.json');
    const recentRel = firstOf('recent/');
    const settledRel = firstOf('settled/');
    if (recentRel === undefined || settledRel === undefined) {
      breach('the cold cycle wrote no recent or no settled file');
      return ok;
    }
    const recent = sizes(recentRel);
    const settled = sizes(settledRel);
    const line = (label: string, z: { plain: number; gz: number; zst: number }, limit?: number) =>
      console.log(
        `publisher ${label}: ${z.plain} B plain, ${z.gz} B gzip, ${z.zst} B zstd${limit === undefined ? '' : ` (gzip budget ${limit} B)`}`,
      );
    line('B2 latest.json', latest, B2_LATEST_GZ_BYTES);
    line(`B3 recent snapshot ${recentRel}`, recent, B3_SNAPSHOT_GZ_BYTES);
    line(`B3 settled snapshot ${settledRel}`, settled, B3_SNAPSHOT_GZ_BYTES);
    if (latest.gz > B2_LATEST_GZ_BYTES)
      breach(`publisher B2: latest.json ${latest.gz} B gzip is over ${B2_LATEST_GZ_BYTES} B`);
    for (const [rel, z] of [
      [recentRel, recent],
      [settledRel, settled],
    ] as const)
      if (z.gz > B3_SNAPSHOT_GZ_BYTES) breach(`publisher B3: ${rel} ${z.gz} B gzip is over ${B3_SNAPSHOT_GZ_BYTES} B`);
    const year = 144 * (settled.plain + settled.gz + settled.zst) * 365;
    console.log(
      `publisher projection: settled snapshots a year = 144 × (${settled.plain} + ${settled.gz} + ${settled.zst}) B × 365 = ${(year / 1e9).toFixed(2)} GB, ${(year / STATIC_LINE_BYTES).toFixed(2)} × the A§11.4 static line of ${STATIC_LINE_BYTES / 1e9} GB (frames, stations and logs not counted)`,
    );

    // The cold cycle stops at its budget with buckets and station files still queued (the publisher keeps them in
    // memory). A steady state starts once that backlog is gone, so one catch-up cycle without a budget drains it;
    // production gets there over its next cycles.
    steps = new Map();
    bucketMs.recent.length = 0;
    bucketMs.settled.length = 0;
    deps.budgetMs = Number.POSITIVE_INFINITY;
    deps.settledPerCycle = 0;
    const tc = Date.now();
    await publisher.cycle();
    console.log(
      `publisher catch-up cycle (no budget, no settled day): ${secs(Date.now() - tc)} s; ${bucketMs.recent.length} recent buckets, ${step('station').files} station files`,
    );

    // Cycle 2: steady state. Every series gets one new value at the next bucket, and the publish_dirty row the loader
    // would write for it (an obs entry, the instant, every station); no settled day is pending in production.
    const next = Math.floor(t1 / BUCKET_STEP_MS) * BUCKET_STEP_MS + BUCKET_STEP_MS;
    await t.admin.query('SELECT ensure_partitions($1::timestamptz, $2::timestamptz)', [
      new Date(next),
      new Date(next + 86_400_000),
    ]);
    await t.admin.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id) SELECT id, $1::timestamptz, (random() * 1000)::real, 1, 1 FROM series`,
      [new Date(next)],
    );
    await t.admin.query(
      `INSERT INTO publish_dirty (family, kind, from_ts, to_ts, stations)
       SELECT 'public', 'obs', $1::timestamptz, $1::timestamptz, array_agg(id ORDER BY id) FROM station`,
      [new Date(next)],
    );
    // B4 "keeps up": the new bucket and every station file are published within one bucket period of production time.
    // Production starts a cycle every CYCLE_MS, or at once when one ran longer, so a cycle costs max(CYCLE_MS, its ms).
    deps.budgetMs = BUDGET_MS;
    clock = next + 60_000;
    let drainMs = 0;
    let recentDone = 0;
    let stationsDone = 0;
    const perCycle: string[] = [];
    for (let n = 1; n <= B4_MAX_CYCLES && !(recentDone >= 1 && stationsDone >= SERIES); n++) {
      steps = new Map();
      bucketMs.recent.length = 0;
      const t2 = Date.now();
      await publisher.cycle();
      const took = Date.now() - t2;
      drainMs += Math.max(CYCLE_MS, took);
      recentDone += bucketMs.recent.length;
      stationsDone += step('station').files;
      perCycle.push(`${bucketMs.recent.length} bucket + ${step('station').files} station files in ${secs(took)} s`);
      if (n === 1) {
        console.log(`publisher steady-state cycle 1 (one new value per series): ${secs(took)} s`);
        for (const l of stepLines(took)) console.log(l);
      }
    }
    const done = recentDone >= 1 && stationsDone >= SERIES;
    console.log(
      `publisher B4 keeps up: ${perCycle.length} cycles at the ${secs(BUDGET_MS)} s budget (${perCycle.join('; ')}); ${done ? '' : `NOT drained, ${SERIES - stationsDone} of ${SERIES} station files still queued; `}drain ${secs(drainMs)} s = sum of max(${secs(CYCLE_MS)} s, cycle) (budget ${secs(B4_DRAIN_MS)} s, one bucket period)`,
    );
    if (!done)
      breach(
        `publisher B4: ${SERIES - stationsDone} of ${SERIES} station files still queued after ${B4_MAX_CYCLES} cycles`,
      );
    else if (drainMs > B4_DRAIN_MS)
      breach(`publisher B4: draining one bucket's values took ${secs(drainMs)} s, over ${secs(B4_DRAIN_MS)} s`);
  } finally {
    await pub.close();
    rmSync(root, { recursive: true, force: true });
  }
  return ok;
}

let failed = false;
try {
  const started = Date.now();
  await t.admin.query(`
    INSERT INTO provider (id, name, country) VALUES ('bench', 'bench', 'NL');
    INSERT INTO source (id, provider_id, name, audience, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled)
      VALUES ('NL-1', 'bench', 'bench', 'public', true, true, true, true, true);`);
  await t.admin.query(
    `INSERT INTO station (id, name, country, tier, flags)
     SELECT 'nl.bench.' || g, 'bench ' || g, 'NL', 2, CASE WHEN g <= $2 THEN '{"tidal": true}'::jsonb ELSE '{}'::jsonb END
     FROM generate_series(1, $1) g`,
    [SERIES, TIDAL],
  );
  // A third of the series have the 25 h limit of a slow gauge; the rest the default 45 min; the tidal ones 1 h.
  await t.admin.query(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role)
     SELECT 'nl.bench.' || g, 'NL-1', 'H', 'level', 'k' || g, 'cm', 1, 'NAP', '15 min', '15 min',
            CASE WHEN g <= $2 THEN interval '1 hour' WHEN g % 3 = 0 THEN interval '25 hours' ELSE interval '45 min' END, 'primary'
     FROM generate_series(1, $1) g`,
    [SERIES, TIDAL],
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
  // P18a: the astronomical curve every 10 min, and the astronomical and measured high and low waters 4 a day
  // (alternating, 6 h apart, the measured ones 7 min late), over the same days, for the tidal series.
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT s.id, 'astro', ts, (random() * 200 - 100)::real, NULL, 1
     FROM generate_series(date_bin('10 min', now(), timestamptz '2000-01-01 00:00:00+00') - make_interval(days => $1),
                          date_bin('10 min', now(), timestamptz '2000-01-01 00:00:00+00'), interval '10 min') ts
     CROSS JOIN (SELECT id FROM series ORDER BY id LIMIT $2) s`,
    [DAYS, TIDAL],
  );
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT s.id, k.kind, x.ts + k.late, (random() * 200 - 100)::real, CASE WHEN x.n % 2 = 0 THEN 'high' ELSE 'low' END, 1
     FROM (SELECT g AS n, date_bin('6 hours', now(), timestamptz '2000-01-01 00:00:00+00') - g * interval '6 hours' AS ts
           FROM generate_series(0, $1 * 4) g) x
     CROSS JOIN (VALUES ('extreme_astro', interval '0'), ('extreme', interval '7 min')) k (kind, late)
     CROSS JOIN (SELECT id FROM series ORDER BY id LIMIT $2) s`,
    [DAYS, TIDAL],
  );
  // P18b: the astronomical curve and the astronomical high and low waters 48 h ahead (a prediction, so it exists), for the
  // future snapshot's tide read at now + 24 h. No forecast runs are seeded (the Q2 benchmark, bench-q2.ts, covers that
  // read), and no measured value lies ahead.
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT s.id, 'astro', ts, (random() * 200 - 100)::real, NULL, 1
     FROM generate_series(date_bin('10 min', now(), timestamptz '2000-01-01 00:00:00+00') + interval '10 min',
                          date_bin('10 min', now(), timestamptz '2000-01-01 00:00:00+00') + interval '48 hours',
                          interval '10 min') ts
     CROSS JOIN (SELECT id FROM series ORDER BY id LIMIT $1) s`,
    [TIDAL],
  );
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT s.id, 'extreme_astro', date_bin('6 hours', now(), timestamptz '2000-01-01 00:00:00+00') + g * interval '6 hours',
            (random() * 200 - 100)::real, CASE WHEN g % 2 = 0 THEN 'high' ELSE 'low' END, 1
     FROM generate_series(1, 8) g
     CROSS JOIN (SELECT id FROM series ORDER BY id LIMIT $1) s`,
    [TIDAL],
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
  if (!/Index Scan Backward using obs_(?:\d{4}_\d{2}|y\d{4})_pkey/.test(plan)) {
    console.error('bench-q1: FAIL: not a backward index scan on (series_id, ts)');
    failed = true;
  }
  // P18a: the tide rows at T (the snapshot's extra call): the same measurement as Q1, and the plan of a copy of
  // the function body, whose tide reads must all be index scans.
  const TIDE = `SELECT series_id, kind, hilo, ts, value FROM ${TIDE_AT.public}($1::timestamptz)`;
  const tideBody = (
    await t.admin.query<{ prosrc: string }>('SELECT prosrc FROM pg_proc WHERE proname = $1', [TIDE_AT.public])
  ).rows[0]?.prosrc.replace(/\bp_t\b/g, '$1::timestamptz');
  if (tideBody === undefined) throw new Error(`bench-q1: function ${TIDE_AT.public} not found`);
  const tidePlan = (
    await t.admin.query({ text: `EXPLAIN (ANALYZE, BUFFERS) ${tideBody}`, values: [at(3)], rowMode: 'array' })
  ).rows
    .map((r: unknown[]) => String(r[0]))
    .join('\n');
  console.log(tidePlan);
  if (/Seq Scan on tide\s/.test(tidePlan)) {
    console.error('bench-q1: FAIL: the tide function scans the tide table');
    failed = true;
  }
  const tideTimes: number[] = [];
  let tideRows = 0;
  for (let i = 0; i < RUNS + 3; i++) {
    const t0 = process.hrtime.bigint();
    const result = await api.query(TIDE, [at(i)]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    tideRows = result.rowCount ?? 0;
    if (i >= 3) tideTimes.push(ms);
  }
  tideTimes.sort((a, b) => a - b);
  const tideMedian = tideTimes[Math.floor(tideTimes.length / 2)] as number;
  console.log(
    `${TIDE_AT.public} "tide rows at T": ${tideRows} rows over ${TIDAL} tidal series; median ${tideMedian.toFixed(1)} ms, p95 ${(tideTimes[Math.ceil(tideTimes.length * 0.95) - 1] as number).toFixed(1)} ms, max ${(tideTimes.at(-1) as number).toFixed(1)} ms over ${RUNS} runs (limit ${TIDE_MS} ms)`,
  );
  if (tideMedian >= TIDE_MS) {
    console.error(`bench-q1: FAIL: tide median ${tideMedian.toFixed(1)} ms is not under ${TIDE_MS} ms`);
    failed = true;
  }
  // P18b: the same function at a future instant (now + 24 h), the extra read of the future snapshot (readFutureSnapshot).
  const ahead = (i: number) => new Date(Date.now() + 24 * 3_600_000 + i * 61_000);
  const aheadTimes: number[] = [];
  let aheadRows = 0;
  for (let i = 0; i < RUNS + 3; i++) {
    const t0 = process.hrtime.bigint();
    const result = await api.query(TIDE, [ahead(i)]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    aheadRows = result.rowCount ?? 0;
    if (i >= 3) aheadTimes.push(ms);
  }
  aheadTimes.sort((a, b) => a - b);
  const aheadMedian = aheadTimes[Math.floor(aheadTimes.length / 2)] as number;
  console.log(
    `${TIDE_AT.public} "tide rows at now + 24 h": ${aheadRows} rows over ${TIDAL} tidal series; median ${aheadMedian.toFixed(1)} ms, p95 ${(aheadTimes[Math.ceil(aheadTimes.length * 0.95) - 1] as number).toFixed(1)} ms, max ${(aheadTimes.at(-1) as number).toFixed(1)} ms over ${RUNS} runs (limit ${TIDE_MS} ms)`,
  );
  if (aheadRows < TIDAL) {
    console.error(`bench-q1: FAIL: ${aheadRows} tide rows ahead for ${TIDAL} tidal series`);
    failed = true;
  }
  if (aheadMedian >= TIDE_MS) {
    console.error(`bench-q1: FAIL: future tide median ${aheadMedian.toFixed(1)} ms is not under ${TIDE_MS} ms`);
    failed = true;
  }
  // P14f: the day read of a cold /snapshot (readDoy): one UTC day key through the reference view, as rws_api. The
  // literal kind list is what lets the partial index of 20261116000001 apply through the view.
  const doyPlan = (
    await api.query({
      text: `EXPLAIN (ANALYZE, BUFFERS) SELECT series_id, source_id, kind, value, unit, season_from_md, valid
             FROM ${VIEWS.public.reference} WHERE kind IN ('P10_DOY', 'P90_DOY') AND season_from_md = ANY($1::int[])`,
      values: [[1026]],
      rowMode: 'array',
    })
  ).rows
    .map((r: unknown[]) => String(r[0]))
    .join('\n');
  console.log(doyPlan);
  console.log(
    /reference_value_doy/.test(doyPlan)
      ? 'DOY day read: uses the partial index reference_value_doy'
      : 'DOY day read: does NOT use the partial index reference_value_doy',
  );
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

    // P18a: one raw /series call over 14 days of a tidal series (its tide block included), and the size of one
    // /snapshot answer with and without tide rows (same t, a fresh app: the LRU is per app), for the file growth.
    const tidalCall = (await ask([seriesPath(ids[0] as number, lo - 2 * BUCKET_MS)])).answers[0] as {
      ms: number;
      body: string;
    };
    console.log(
      `API /series ${SPAN_DAYS} d raw, tidal series: ${tidalCall.ms.toFixed(1)} ms, ${tidalCall.body.length} bytes (limit ${SERIES_MS} ms)`,
    );
    if (tidalCall.ms >= SERIES_MS) {
      console.error(`bench-q1: FAIL: tidal /series ${tidalCall.ms.toFixed(1)} ms is not under ${SERIES_MS} ms`);
      failed = true;
    }
    const sizeAt = async () => {
      const fresh = createApp({ db: db.db, window: displayWindow });
      return (await (await fresh.request(snapshotPath(instants[5] as number))).text()).length;
    };
    const withTide = await sizeAt();

    // P20a (A§9.1): the publisher, on this seed and before the tide rows go, so that the tidal series have theirs.
    if (!(await publisherPhase())) failed = true;

    await t.admin.query('DELETE FROM tide');
    const without = await sizeAt();
    console.log(
      `/snapshot body: ${withTide} bytes with tide, ${without} bytes without (${TIDAL} tidal series, +${withTide - without} bytes)`,
    );
  } finally {
    await db.close();
  }
} finally {
  await t.drop();
}
process.exitCode = failed ? 1 : 0;
if (!failed) console.log('bench-q1: OK');
