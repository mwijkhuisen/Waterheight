// The API of the web e2e (P4b): a long-running, TEST-ONLY process. It creates a
// throw-away PostgreSQL database (createTestDb: the real roles and migrations),
// syncs the real registry, seeds synthetic observations around the DST night of
// 2026-10-25 plus three test stations, and serves the real P4a app over HTTP as
// a real `rws_api` login on a FIXED clock (NOW, the test seam of createApp).
// It lives under test/ so no image ever holds it; production has no clock switch.
// Playwright (local) and the CI e2e job start it; SIGTERM or SIGINT drops the database.
//
// Usage: env DATABASE_URL=<superuser url> [HOST=127.0.0.1] [PORT=4480] node apps/server/test/e2e/api.ts
import { serve } from '@hono/node-server';
import { CANARIES, CANARY_RENDERINGS, SeriesForecast, Snapshot, Stations } from '@rws/contracts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { openApiDb, parseListen } from '../../src/main.ts';
import { createTestDb } from '../db/testdb.ts';

/** The fixed clock; the Playwright specs use the same instant. */
export const NOW = new Date('2026-10-26T12:00:00Z');
const FROM = '2026-10-24T00:00:00Z';
/** The last value of nl.e2e.gap: two hours before NOW, so the snapshot at NOW has none for it. */
const GAP_LAST = '2026-10-26T10:00:00Z';
/** nl.e2e.dst holds only these (ts, value): 02:30 CEST is 00:30Z and 02:30 CET is 01:30Z. */
const DST_VALUES: [string, number][] = [
  ['2026-10-24T12:00:00Z', 50],
  ['2026-10-25T00:30:00Z', 111],
  ['2026-10-25T01:30:00Z', 222],
  ['2026-10-25T12:00:00Z', 333],
  ['2026-10-26T11:50:00Z', 444],
];
/** The basis label of the xss series' NL-4 class: a known stem, then HTML that must stay text. */
const HOSTILE_BASIS_LABEL = 'Licht verhoogd (<img src=y onerror=alert(3)>)';
/** Test stations inside the Lobith map fixture (6.04,51.82 – 6.16,51.88): one H series each, a level in cm NAP. */
const STATIONS = [
  {
    id: 'nl.e2e.xss',
    name: '<img src=x onerror=alert(1)>',
    water: '<svg onload=alert(2)>',
    lon: 6.1,
    lat: 51.85,
    step: '10 min',
    stale: '90 min',
  },
  { id: 'nl.e2e.gap', name: 'E2E gap', water: 'E2E', lon: 6.07, lat: 51.84, step: '10 min', stale: '90 min' },
  { id: 'nl.e2e.dst', name: 'E2E DST', water: 'E2E', lon: 6.13, lat: 51.86, step: '15 min', stale: '45 min' },
];

const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
/**
 * Synthetic forecast runs (P8b), hourly from `first` to `last` (hours from NOW), the value base + per × hour index:
 * - nl.e2e.xss: an NL-1 run whose issue time is inferred (fetched at NOW - 2 h), with a 10-90 % band; the provider's
 *   own segment ends at NOW + 12 h, so later points are estimates; it reaches NOW + 30 h (shorter than 48 h).
 *   At NOW + 2 h the value is 340 (band 320-365), at NOW + 20 h an estimate (430, band 410-455). Its basis label is the
 *   hostile one of the NL-4 class above, as text.
 * - nl.e2e.dst: an NL-1 run with a stated issue time (NOW - 3 h), no band, reaching NOW + 20 h: 420 at NOW + 2 h.
 * - the registry station Lobith: a run on its H series only (NOW + 40 h), so its Q series reads "no forecast" in the
 *   same panel (a station with two series, one of them forecast).
 * - nl.e2e.gap: NO public run. It carries an owner-canary run (source CANARY-OWNER, the constant 777777.777) up to
 *   NOW + 36 h: the public views never show it, so the station reads "no forecast" and the canary appears nowhere.
 */
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
const FORECASTS = [
  {
    station: 'nl.e2e.xss',
    source: 'NL-1',
    issued: null,
    fetched: at(-2),
    first: -2,
    last: 30,
    base: 320,
    per: 5,
    band: true,
    segmentEnd: at(12),
  },
  {
    station: 'nl.e2e.dst',
    source: 'NL-1',
    issued: at(-3),
    fetched: at(-3 + 1 / 6),
    first: -3,
    last: 20,
    base: 410,
    per: 2,
    band: false,
    segmentEnd: null,
  },
  {
    station: LOBITH,
    source: 'NL-1',
    issued: null,
    fetched: at(-1),
    first: -1,
    last: 40,
    base: 100,
    per: 1,
    band: false,
    segmentEnd: null,
  },
  {
    station: 'nl.e2e.gap',
    source: 'CANARY-OWNER',
    issued: null,
    fetched: at(-1),
    first: -1,
    last: 36,
    base: CANARIES.owner.value,
    per: 0,
    band: false,
    segmentEnd: null,
  },
] as const;

if (!process.env.DATABASE_URL) {
  console.error(
    'usage: env DATABASE_URL=<superuser url> [HOST=127.0.0.1] [PORT=4480] node apps/server/test/e2e/api.ts',
  );
  process.exit(64);
}
const listen = parseListen({ ...process.env, PORT: process.env.PORT ?? '4480' });
if (typeof listen === 'string') {
  console.error(listen);
  process.exit(64);
}

const t = await createTestDb();
let api: Db | undefined;
let window: DisplayWindow | undefined;
let server: ReturnType<typeof serve> | undefined;
const cleanup = async () => {
  server?.close(); // also closes idle keep-alive connections; the exit and the forced DROP do the rest
  window?.stop();
  await api?.close();
  await t.drop();
};
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => void cleanup().finally(() => process.exit(0)));

try {
  // The registry sync runs as rws_migrator (one connection: the role allows three), as `migrate` does.
  const owner = openDb(dbConfig({ DATABASE_URL: t.urlFor('rws_migrator') }, 'rws_migrator') as DbConfig, { max: 1 });
  try {
    await syncRegistry(owner.db, readRegistry());
  } finally {
    await owner.close();
  }
  await t.admin.query(`SELECT ensure_partitions('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')`);

  for (const s of STATIONS) {
    await t.admin.query(
      `INSERT INTO station (id, name, water_name, country, lon, lat, tier) VALUES ($1, $2, $3, 'NL', $4, $5, 1)`,
      [s.id, s.name, s.water, s.lon, s.lat],
    );
    await t.admin.query(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role)
       VALUES ($1, 'NL-1', 'H', 'level', $1, 'cm', 1, 'NAP', $2::interval, $2::interval, $3::interval, 'primary')`,
      [s.id, s.step, s.stale],
    );
  }

  // A hostile NL-4 class on the xss series: its basis label is its own payload (alert(3)), a different one from the
  // station's name (alert(1)) and water (alert(2)). The stem "Licht verhoogd" is a known one, so it classifies.
  await t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, season_from_md, season_to_md,
                                  priority, basis_label, valid)
     SELECT s.id, 'NL-4', k.kind, k.value, 'cm', 'provider_class', 101, 1231, 0, $1, tstzrange('2020-01-01Z', NULL)
     FROM series s, (VALUES ('NL4_FROM', 100), ('NL4_TO', 1000)) AS k(kind, value) WHERE s.station_id = 'nl.e2e.xss'`,
    [HOSTILE_BASIS_LABEL],
  );

  // One value per expected step for every series the public views show (registry series and the two test
  // stations with a regular grid): batch_id has no foreign key, so 1 does.
  await t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT s.id, g,
            CASE s.quantity WHEN 'H' THEN 300 + 40 * sin(extract(epoch FROM g)::float8 / 20000)
                            ELSE 800 + 100 * sin(extract(epoch FROM g)::float8 / 30000) END + s.id % 50,
            1, 1
     FROM series s
     JOIN series_eff e ON e.series_id = s.id
     CROSS JOIN LATERAL generate_series($1::timestamptz,
                                        CASE WHEN s.station_id = 'nl.e2e.gap' THEN $3::timestamptz ELSE $2::timestamptz END,
                                        s.expected_step) g
     WHERE s.active AND e.role = 'primary' AND e.audience = 'public' AND e.lic_display
       AND s.station_id <> 'nl.e2e.dst'`,
    [FROM, NOW.toISOString(), GAP_LAST],
  );
  await t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT s.id, v.ts, v.value, 1, 1
     FROM series s, unnest($1::timestamptz[], $2::real[]) AS v(ts, value) WHERE s.station_id = 'nl.e2e.dst'`,
    [DST_VALUES.map(([ts]) => ts), DST_VALUES.map(([, value]) => value)],
  );
  for (const [table, unit] of [
    ['obs_1h', 'hour'],
    ['obs_1d', 'day'],
  ] as const)
    await t.admin.query(
      `INSERT INTO ${table} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
       SELECT series_id, date_trunc('${unit}', ts, 'UTC'), min(value), max(value), avg(value),
              (array_agg(value ORDER BY ts DESC))[1], count(*), bit_or(qc)
       FROM obs GROUP BY 1, 2`,
    );

  for (const f of FORECASTS) {
    await t.admin.query(
      `WITH run AS (
         INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                   content_hash, kind, step, provider_segment_end)
         SELECT s.id, $2, COALESCE($3::timestamptz, $4::timestamptz), $3::timestamptz IS NULL, $5::timestamptz,
                $6::timestamptz, $4::timestamptz, decode(md5($1 || $2 || $4::text), 'hex'),
                CASE WHEN $9::boolean THEN 'quantiles' ELSE 'deterministic' END, interval '1 hour', $10::timestamptz
         FROM series s WHERE s.station_id = $1 AND s.quantity = 'H' AND s.role = 'primary'
         RETURNING id)
       INSERT INTO forecast_value (run_id, valid_ts, value, p10, p90, flags)
       SELECT run.id, g, v, CASE WHEN $9::boolean THEN v - 20 END, CASE WHEN $9::boolean THEN v + 25 END, 0
       FROM run, generate_series($5::timestamptz, $6::timestamptz, interval '1 hour') g,
            LATERAL (SELECT ($7::float8 + $8::float8 * extract(epoch FROM g - $5::timestamptz) / 3600)::real AS v) x`,
      [f.station, f.source, f.issued, f.fetched, at(f.first), at(f.last), f.base, f.per, f.band, f.segmentEnd],
    );
  }

  const opened = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof opened === 'string') throw new Error(opened);
  api = opened;
  window = new DisplayWindow(api.db);
  if (!(await window.refresh())) throw new Error('the display window did not load');
  window.start();
  const app = createApp({ db: api.db, window, now: () => NOW, build: 'dev' });

  // The self-check: the answers the specs depend on, in process, before anything listens.
  const get = async (path: string) => {
    const res = await app.request(path);
    if (res.status !== 200) throw new Error(`self-check: GET ${path} answered ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  await get('/api/v1/meta');
  const { stations } = Stations.parse(await get('/api/v1/stations'));
  const snapshot = Snapshot.parse(await get('/api/v1/snapshot?t=2026-10-26T12:00Z'));
  const seriesOf = (id: string) => stations.find((st) => st.id === id)?.series[0]?.id;
  const [xss, gap] = [seriesOf('nl.e2e.xss'), seriesOf('nl.e2e.gap')];
  const holds = (source: string, test: (id: string) => boolean) =>
    stations.some((st) => test(st.id) && st.series.some((s) => s.source === source));
  if (STATIONS.some((s) => seriesOf(s.id) === undefined)) throw new Error('self-check: a test station is missing');
  if (!holds('DE-1', () => true) || !holds('NL-1', (id) => !id.startsWith('nl.e2e.')))
    throw new Error('self-check: no registry station of NL-1 or DE-1');
  if (!snapshot.values.some((v) => v.series === xss)) throw new Error('self-check: no value for nl.e2e.xss at NOW');
  const xssValue = snapshot.values.find((v) => v.series === xss);
  if (xssValue?.state !== 'elevated' || !xssValue.basis?.label.includes('onerror=alert(3)'))
    throw new Error('self-check: nl.e2e.xss has no classified value with the hostile basis label');
  if (snapshot.values.some((v) => v.series === gap)) throw new Error('self-check: a value for nl.e2e.gap at NOW');

  // P8b: at NOW + 2 h the public runs answer (the xss one with its band and its inferred issue time, the dst one
  // with a stated one), the gap station has none, and the owner canary run on it appears in no public answer.
  const dst = seriesOf('nl.e2e.dst');
  const plus2 = await get(`/api/v1/snapshot?t=${at(2).slice(0, 16)}Z`);
  const ahead = Snapshot.parse(plus2);
  const held = (id: number | undefined) => ahead.forecasts?.find((f) => f.series === id);
  if (
    ahead.values.length > 0 ||
    held(xss)?.value !== 340 ||
    held(xss)?.band?.hi !== 365 ||
    held(xss)?.issuedInferred !== true
  )
    throw new Error('self-check: the future snapshot has no forecast of nl.e2e.xss');
  if (held(dst)?.value !== 420 || held(dst)?.issuedInferred !== false)
    throw new Error('self-check: the future snapshot has no forecast of nl.e2e.dst');
  if (held(gap) !== undefined) throw new Error('self-check: a public forecast for nl.e2e.gap');
  const lobith = stations.find((st) => st.id === LOBITH);
  const [lobithH, lobithQ] = ['H', 'Q'].map((q) => lobith?.series.find((x) => x.quantity === q)?.id);
  if (held(lobithH)?.value !== 103 || lobithQ === undefined || held(lobithQ) !== undefined)
    throw new Error('self-check: Lobith has a forecast for H only');
  const gapForecast = SeriesForecast.parse(await get(`/api/v1/series/${gap}/forecast`));
  const xssForecast = SeriesForecast.parse(await get(`/api/v1/series/${xss}/forecast`));
  if (gapForecast.run !== null) throw new Error('self-check: a public run for nl.e2e.gap');
  if (xssForecast.run?.horizonEnd !== at(30)) throw new Error('self-check: nl.e2e.xss does not end at NOW + 30 h');
  const everything = JSON.stringify([plus2, gapForecast, xssForecast]);
  if (CANARY_RENDERINGS.some((c) => everything.includes(c))) throw new Error('self-check: a canary in a public answer');

  const listening = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, ...listen }, () => resolve(s));
    s.once('error', reject);
  });
  server = listening;
  console.log(`e2e api listening on http://${listen.hostname}:${listen.port}`);
} catch (err) {
  console.error(`e2e api: ${err instanceof Error ? err.message.split('\n')[0] : 'set-up failed'}`);
  await cleanup().catch(() => undefined);
  process.exit(1);
}
