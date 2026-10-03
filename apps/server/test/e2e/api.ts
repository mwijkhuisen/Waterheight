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
import { Snapshot, Stations } from '@rws/contracts';
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
