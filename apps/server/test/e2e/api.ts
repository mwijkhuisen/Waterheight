// The API of the web e2e (P4b): a long-running, TEST-ONLY process. It creates a
// throw-away PostgreSQL database (createTestDb: the real roles and migrations),
// syncs the real registry, seeds synthetic observations around the DST night of
// 2026-10-25 plus three test stations, and serves the real P4a app over HTTP as
// a real `rws_api` login on a FIXED clock (NOW, the test seam of createApp).
// It lives under test/ so no image ever holds it; production has no clock switch.
// Playwright (local) and the CI e2e job start it; SIGTERM or SIGINT drops the database.
//
// Usage: env DATABASE_URL=<superuser url> [HOST=127.0.0.1] [PORT=4480] [E2E_PUBLISH_DIR=<dir>]
//        [E2E_OWNER_PUBLISH_DIR=<dir> [E2E_OWNER_API_HOST=127.0.0.1] [E2E_OWNER_API_PORT=8080]] node apps/server/test/e2e/api.ts
// With E2E_OWNER_PUBLISH_DIR (P10a) it also seeds synthetic owner rows (owner-seed.ts), writes the owner tree with the
// owner publisher and serves the owner family (createApp family 'owner', as rws_owner_api) on the second address.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { serve } from '@hono/node-server';
import {
  CANARIES,
  CANARY_RENDERINGS,
  RiversManifest,
  SeriesForecastAnswer,
  SnapshotAnswer,
  StationsAnswer,
} from '@rws/contracts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { openApiDb, parseListen } from '../../src/main.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { createTestDb } from '../db/testdb.ts';
import { seedOwner } from './owner-seed.ts';
import { ENDED_DAY, FR_STATION, seedPublic, XSS } from './public-seed.ts';
import { obsInsertSql, rollupInsertSql } from './seed.ts';

/**
 * The publisher's root (P9a): `v1/` under it is /data/v1/. The stand-in for Caddy (apps/web/e2e/server.ts) serves it;
 * the CI e2e job mounts `<dir>/v1` into the real Caddy. Both read E2E_PUBLISH_DIR (same default).
 */
export const E2E_PUBLISH_DIR = process.env.E2E_PUBLISH_DIR ?? join(tmpdir(), 'rws-e2e-publish');
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
type TestStation = {
  id: string;
  name: string;
  water: string;
  lon: number;
  lat: number;
  step: string;
  stale: string;
  /** The primary H series' datum (default NAP). */
  datum?: 'NAP' | 'MSL';
  /** `station.flags` (default none). */
  flags?: Record<string, boolean>;
};

/**
 * P19a (lakes, coast and sea layers): synthetic water-body stations, listed in the e2e reaches file by
 * apps/web/e2e/prepare-tiles.ts (e2eReaches). Positions were checked against the polygons of the committed
 * rivers-fixture.pmtiles (layer `waterbodies`, z7-z12): lake-ref (Enkhuizen shore) and lake-gauge (Lemmer shore) lie
 * in the IJsselmeer, lake-noref in the Veluwemeer; the coast point lies in the Wadden Sea, the platform north of 54 N.
 *   coast: tidal, with astro rows (below) giving a surge of 80 cm at NOW, -60 at P19A_SETTLED_HOUR, 20 elsewhere,
 *          and 150 at NOW + 6 h (forecast).
 *   platform: tidal, datum MSL, no astro, so no surge.
 *   lake-ref: NL-4 class "Licht verhoogd" (elevated), the D27 reference of the IJsselmeer, with a forecast.
 *   lake-gauge: NL-4 class "Hoogwater" (high), the same lake: the lake must still read elevated.
 *   lake-noref: no class (the Veluwemeer has no reference gauge).
 */
const P19A_STATIONS: TestStation[] = [
  {
    id: 'nl.e2e.coast',
    name: 'E2E coast',
    water: 'E2E',
    lon: 5.25,
    lat: 53.4,
    step: '10 min',
    stale: '90 min',
    flags: { tidal: true },
  },
  {
    id: 'nl.e2e.platform',
    name: 'E2E platform',
    water: 'E2E',
    lon: 4.73,
    lat: 54.85,
    step: '10 min',
    stale: '90 min',
    datum: 'MSL',
    flags: { tidal: true },
  },
  { id: 'nl.e2e.lake-ref', name: 'E2E lake ref', water: 'E2E', lon: 5.31, lat: 52.72, step: '10 min', stale: '90 min' },
  {
    id: 'nl.e2e.lake-gauge',
    name: 'E2E lake gauge',
    water: 'E2E',
    lon: 5.62,
    lat: 52.83,
    step: '10 min',
    stale: '90 min',
  },
  {
    id: 'nl.e2e.lake-noref',
    name: 'E2E lake noref',
    water: 'E2E',
    lon: 5.71,
    lat: 52.4,
    step: '10 min',
    stale: '90 min',
  },
];

/** Test stations inside the Lobith map fixture (6.04,51.82 – 6.16,51.88): one H series each, a level in cm NAP. */
const STATIONS: TestStation[] = [
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
  ...P19A_STATIONS,
];

const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
/**
 * P19a: the past hour of the surge check, NOW - 2 d at a fixed HH:00 (-60 cm there). Not a settled day: the seeded
 * observations start on 2026-10-24, and a day settles 48 h after its end, so the static file is recent/2026-10-24/1200.json.
 */
const P19A_SETTLED_HOUR = at(-48);
/** P19a: the NL-4 class of the lake stations ("Licht verhoogd" is elevated, "Hoogwater" high), 0 to 1000 cm. */
const P19A_LAKE_CLASSES = [
  ['nl.e2e.lake-ref', 'Licht verhoogd (>0cm)'],
  ['nl.e2e.lake-gauge', 'Hoogwater (>0cm)'],
] as const;
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
  // P19a: nl.e2e.coast (336 at NOW + 6 h, its astro below gives a forecast surge of 150) and nl.e2e.lake-ref (346 at
  // NOW + 6 h, class elevated), each an NL-1 run from NOW to NOW + 24 h.
  {
    station: 'nl.e2e.coast',
    source: 'NL-1',
    issued: null,
    fetched: at(-1),
    first: 0,
    last: 24,
    base: 330,
    per: 1,
    band: false,
    segmentEnd: null,
  },
  {
    station: 'nl.e2e.lake-ref',
    source: 'NL-1',
    issued: null,
    fetched: at(-1),
    first: 0,
    last: 24,
    base: 340,
    per: 1,
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
const OWNER_DIR = process.env.E2E_OWNER_PUBLISH_DIR;
/**
 * P11a: the river release the owner publisher splits at the BE-3 gauges (the owner reaches variant): the committed
 * fixture release (test/fixtures/reaches-fixture.json and its tiles) under a manifest, as rws-rivers-refresh leaves it.
 */
const RIVERS_DIR = OWNER_DIR ? join(tmpdir(), 'rws-e2e-rivers') : undefined;
const RIVERS_VERSION = '20261003';
async function installRivers(dir: string): Promise<void> {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const entry = async (file: string, bytes: Buffer) => {
    await writeFile(join(dir, file), bytes);
    return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const v = RIVERS_VERSION;
  const release = {
    version: v,
    tag: 'geo-2026-10-03',
    installed_at: '2026-10-05T05:40:00Z',
    tiles: await entry(`rivers-${v}.pmtiles`, await readFile(join(root, 'tools/geo/fixtures/rivers-fixture.pmtiles'))),
    reaches: await entry(`reaches-${v}.json`, await readFile(join(root, 'test/fixtures/reaches-fixture.json'))),
    download: await entry(`rivers-${v}.geojson.gz`, gzipSync('{"type":"FeatureCollection","features":[]}\n')),
  };
  const manifest = RiversManifest.parse({ schema_version: 1, current: release, previous: null });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const ownerListen = parseListen({
  HOST: process.env.E2E_OWNER_API_HOST ?? '127.0.0.1',
  PORT: process.env.E2E_OWNER_API_PORT ?? '8080',
});
if (typeof ownerListen === 'string') {
  console.error(ownerListen);
  process.exit(64);
}

const t = await createTestDb();
let api: Db | undefined;
let window: DisplayWindow | undefined;
let server: ReturnType<typeof serve> | undefined;
let ownerApi: Db | undefined;
let ownerWindow: DisplayWindow | undefined;
let ownerServer: ReturnType<typeof serve> | undefined;
const cleanup = async () => {
  await rm(E2E_PUBLISH_DIR, { recursive: true, force: true }).catch(() => undefined);
  if (OWNER_DIR) await rm(OWNER_DIR, { recursive: true, force: true }).catch(() => undefined);
  if (RIVERS_DIR) await rm(RIVERS_DIR, { recursive: true, force: true }).catch(() => undefined);
  server?.close(); // also closes idle keep-alive connections; the exit and the forced DROP do the rest
  ownerServer?.close();
  window?.stop();
  ownerWindow?.stop();
  await api?.close();
  await ownerApi?.close();
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
      `INSERT INTO station (id, name, water_name, country, lon, lat, tier, flags)
       VALUES ($1, $2, $3, 'NL', $4, $5, 1, $6::jsonb)`,
      [s.id, s.name, s.water, s.lon, s.lat, JSON.stringify(s.flags ?? {})],
    );
    await t.admin.query(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role)
       VALUES ($1, 'NL-1', 'H', 'level', $1, 'cm', 1, $4, $2::interval, $2::interval, $3::interval, 'primary')`,
      [s.id, s.step, s.stale, s.datum ?? 'NAP'],
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
    obsInsertSql({
      from: FROM,
      to: NOW.toISOString(),
      gap: { station: 'nl.e2e.gap', last: GAP_LAST },
      skipStation: 'nl.e2e.dst',
    }),
  );
  await t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT s.id, v.ts, v.value, 1, 1
     FROM series s, unnest($1::timestamptz[], $2::real[]) AS v(ts, value) WHERE s.station_id = 'nl.e2e.dst'`,
    [DST_VALUES.map(([ts]) => ts), DST_VALUES.map(([, value]) => value)],
  );
  for (const table of ['obs_1h', 'obs_1d'] as const) await t.admin.query(rollupInsertSql(table));

  // P19a: the NL-4 classes of the two lake stations (0 to 1000 cm, the xss pattern above): lake-ref elevated, lake-gauge
  // high, so the lake must read the reference's class (D27).
  await t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, season_from_md, season_to_md,
                                  priority, basis_label, valid)
     SELECT s.id, 'NL-4', k.kind, k.value, 'cm', 'provider_class', 101, 1231, 0, c.label, tstzrange('2020-01-01Z', NULL)
     FROM series s
     JOIN unnest($1::text[], $2::text[]) AS c(station, label) ON c.station = s.station_id,
          (VALUES ('NL4_FROM', 0), ('NL4_TO', 1000)) AS k(kind, value)`,
    [P19A_LAKE_CLASSES.map(([station]) => station), P19A_LAKE_CLASSES.map(([, label]) => label)],
  );
  // P19a: the astronomical tide of nl.e2e.coast, computed from its observations (the shared sine) so that the surge
  // (obs - astro) is exact at the observed instant: 80 at NOW, -60 at the past hour, 20 at every other point.
  // nl.e2e.platform gets none (no tide, no surge).
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT o.series_id, 'astro', o.ts,
            o.value - CASE o.ts WHEN $1::timestamptz THEN 80 WHEN $2::timestamptz THEN -60 ELSE 20 END, NULL, 1
     FROM obs o JOIN series s ON s.id = o.series_id WHERE s.station_id = 'nl.e2e.coast'`,
    [NOW.toISOString(), P19A_SETTLED_HOUR],
  );

  await seedPublic(t.admin, NOW.toISOString());
  if (OWNER_DIR) await seedOwner(t.admin, FROM, NOW.toISOString());

  for (const f of FORECASTS) {
    // Every seeded run must exist, the owner canary's included: its absence test proves nothing otherwise (SEC-4).
    const seeded = await t.admin.query(
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
    if ((seeded.rowCount ?? 0) === 0) throw new Error(`seed: no ${f.source} run on ${f.station}`);
  }
  // P19a: the astronomical tide at each forecast point of nl.e2e.coast (forecast - astro = the forecast surge): 150 at
  // NOW + 6 h, 20 elsewhere. The point at NOW keeps the observation's astro row above.
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT r.series_id, 'astro', v.valid_ts, v.value - CASE v.valid_ts WHEN $1::timestamptz THEN 150 ELSE 20 END, NULL, 1
     FROM forecast_run r
     JOIN forecast_value v ON v.run_id = r.id
     JOIN series s ON s.id = r.series_id
     WHERE s.station_id = 'nl.e2e.coast'
     ON CONFLICT DO NOTHING`,
    [at(6)],
  );

  // P9a: the static files, from the same seeded data and the same fixed clock, as the real `publish` role writes them
  // (one full strict cycle). The web reads them first; it finds the API behind them.
  await rm(E2E_PUBLISH_DIR, { recursive: true, force: true });
  await mkdir(E2E_PUBLISH_DIR, { recursive: true });
  const publisher = openDb(dbConfig({ DATABASE_URL: t.urlFor('rws_publish') }, 'rws_publish') as DbConfig, { max: 3 });
  try {
    // The nine newest settled days (P11b R10: a 7-day playback with its 24 h Δh lead reads six day files of frames); the
    // display window reaches back to 2026-08-24 (about 60 empty settled days, two minutes of rendering), and the older
    // ones stay 0 in meta.dayVersions and are read from the API, as in production while the publisher catches up.
    await publishOnce(publisher.db, 'public', E2E_PUBLISH_DIR, { now: NOW.getTime(), settledDays: 9 });
  } finally {
    await publisher.close();
  }

  // The owner tree (C19): the owner publisher is the rws_owner_api login (limit 4); its pool of 2 closes before the
  // owner API's opens.
  if (OWNER_DIR) {
    await rm(OWNER_DIR, { recursive: true, force: true });
    await mkdir(OWNER_DIR, { recursive: true });
    if (RIVERS_DIR) {
      await rm(RIVERS_DIR, { recursive: true, force: true });
      await mkdir(RIVERS_DIR, { recursive: true });
      await installRivers(RIVERS_DIR);
    }
    const ownerPub = openDb(dbConfig({ DATABASE_URL: t.urlFor('rws_owner_api') }, 'rws_owner_api') as DbConfig, {
      max: 2,
    });
    try {
      await publishOnce(ownerPub.db, 'owner', OWNER_DIR, {
        now: NOW.getTime(),
        settledDays: 1,
        ...(RIVERS_DIR ? { riversDir: RIVERS_DIR } : {}),
      });
    } finally {
      await ownerPub.close();
    }
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
  const { stations } = StationsAnswer.parse(await get('/api/v1/stations'));
  const snapshot = SnapshotAnswer.parse(await get('/api/v1/snapshot?t=2026-10-26T12:00Z'));
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
  const ahead = SnapshotAnswer.parse(plus2);
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
  const gapForecast = SeriesForecastAnswer.parse(await get(`/api/v1/series/${gap}/forecast`));
  const xssForecast = SeriesForecastAnswer.parse(await get(`/api/v1/series/${xss}/forecast`));
  if (gapForecast.run !== null) throw new Error('self-check: a public run for nl.e2e.gap');
  if (xssForecast.run?.horizonEnd !== at(30)) throw new Error('self-check: nl.e2e.xss does not end at NOW + 30 h');
  const everything = JSON.stringify([plus2, gapForecast, xssForecast]);
  if (CANARY_RENDERINGS.some((c) => everything.includes(c))) throw new Error('self-check: a canary in a public answer');

  // P19a: the coast's surge now (80), at the past hour (-60) and at NOW + 6 h (150, forecast), no tide on the MSL
  // platform, and the lake classes (reference elevated, the other gauge high), in the answers and in latest.json.
  const [coast, platform, lakeRef, lakeGauge] = ['coast', 'platform', 'lake-ref', 'lake-gauge'].map((n) =>
    seriesOf(`nl.e2e.${n}`),
  );
  const seriesValue = (answer: ReturnType<typeof SnapshotAnswer.parse>, id: number | undefined) =>
    answer.values.find((v) => v.series === id);
  const pastHour = SnapshotAnswer.parse(await get(`/api/v1/snapshot?t=${P19A_SETTLED_HOUR.slice(0, 16)}Z`));
  const sixHours = SnapshotAnswer.parse(await get(`/api/v1/snapshot?t=${at(6).slice(0, 16)}Z`));
  if (
    seriesValue(snapshot, coast)?.tide?.surge !== 80 ||
    seriesValue(snapshot, coast)?.tide?.derived !== 'surge' ||
    seriesValue(pastHour, coast)?.tide?.surge !== -60
  )
    throw new Error('self-check: nl.e2e.coast has no surge of 80 at NOW and -60 at the past hour');
  if (seriesValue(snapshot, platform) === undefined || seriesValue(snapshot, platform)?.tide !== undefined)
    throw new Error('self-check: nl.e2e.platform has no value, or a tide');
  const heldAt6 = (id: number | undefined) => sixHours.forecasts?.find((f) => f.series === id);
  if (heldAt6(coast)?.tide?.surge !== 150 || heldAt6(lakeRef)?.state !== 'elevated')
    throw new Error('self-check: the snapshot at NOW + 6 h has no coast surge of 150 or no elevated lake-ref forecast');
  if (seriesValue(snapshot, lakeRef)?.state !== 'elevated' || seriesValue(snapshot, lakeGauge)?.state !== 'high')
    throw new Error('self-check: nl.e2e.lake-ref is not elevated or nl.e2e.lake-gauge not high at NOW');

  // P10a: the seeded zero, classes and warnings, in the snapshot and in the published files (the XSS text as data).
  const fr = seriesOf(FR_STATION);
  const frValue = snapshot.values.find((v) => v.series === fr);
  if (frValue?.zero?.datum !== 'IGN69' || frValue.nap)
    throw new Error('self-check: the FR-1 value has no IGN69 zero (or a nap)');
  const file = async (path: string) => readFile(join(E2E_PUBLISH_DIR, 'v1', path), 'utf8');
  const latest = await file('warnings/latest.geojson');
  const ended = await file(`warnings/${ENDED_DAY}.json`);
  // P19a: the static latest.json carries the tide column too (coast 80, the platform none).
  const latestFile = JSON.parse(await file('latest.json')) as { series: number[]; tide?: ({ surge: number } | null)[] };
  const tideOf = (id: number | undefined) => latestFile.tide?.[latestFile.series.indexOf(id ?? -1)];
  if (tideOf(coast)?.surge !== 80 || (tideOf(platform) ?? null) !== null)
    throw new Error('self-check: latest.json has no coast surge of 80, or a tide for the platform');
  if (
    !latest.includes(XSS) ||
    !latest.includes('e2e-river') ||
    !latest.includes('e2e-2') ||
    latest.includes('e2e-ended')
  )
    throw new Error('self-check: warnings/latest.geojson lacks the seeded areas');
  if (!ended.includes('e2e-ended')) throw new Error(`self-check: warnings/${ENDED_DAY}.json lacks the ended area`);
  const today = await file('warnings/today.json');
  if (!today.includes('"day":"2026-10-26"') || !today.includes('e2e-today') || latest.includes('e2e-today'))
    throw new Error('self-check: warnings/today.json lacks the area that ended earlier today');
  if (!snapshot.values.some((v) => v.basis?.label.includes('LHP')))
    throw new Error('self-check: no DE-6 class state in the snapshot');
  if (CANARY_RENDERINGS.some((c) => latest.includes(c))) throw new Error('self-check: a canary in a public file');

  let ownerApp: ReturnType<typeof createApp> | undefined;
  if (OWNER_DIR) {
    const ownerOpened = openApiDb({ DATABASE_URL: t.urlFor('rws_owner_api') }, undefined, 'owner');
    if (typeof ownerOpened === 'string') throw new Error(ownerOpened);
    ownerApi = ownerOpened;
    ownerWindow = new DisplayWindow(ownerApi.db, undefined, 'owner');
    if (!(await ownerWindow.refresh())) throw new Error('the owner display window did not load');
    ownerWindow.start();
    ownerApp = createApp({ family: 'owner', db: ownerApi.db, window: ownerWindow, now: () => NOW, build: 'dev' });
    const res = await ownerApp.request('/api/v1/meta');
    const meta = (await res.json()) as { audience?: string };
    if (res.status !== 200 || meta.audience !== 'owner')
      throw new Error('self-check: the owner api is not the owner family');
    const sources = await readFile(join(OWNER_DIR, 'v1', 'sources.json'), 'utf8');
    if (!sources.includes(XSS)) throw new Error('self-check: the owner sources.json lacks the XSS clause');
    // P11a: the owner publisher split the fixture release at the SPW gauges.
    const variant = await readFile(join(OWNER_DIR, 'v1', 'rivers', `reaches-${RIVERS_VERSION}.json`), 'utf8').catch(
      () => '',
    );
    if (!variant.includes('"be.spw.5447"') || !variant.includes('"be.spw.5451"'))
      throw new Error('self-check: the owner reaches variant lacks the SPW gauges of Eijsden');
    // #86: the owner family writes today's and the ended days' warnings files too.
    const ownerToday = await readFile(join(OWNER_DIR, 'v1', 'warnings', 'today.json'), 'utf8');
    const ownerEnded = await readFile(join(OWNER_DIR, 'v1', 'warnings', `${ENDED_DAY}.json`), 'utf8');
    if (!ownerToday.includes('e2e-today') || !ownerEnded.includes('e2e-ended'))
      throw new Error("self-check: the owner warnings files lack today's or the ended day's area");
  }

  const listening = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, ...listen }, () => resolve(s));
    s.once('error', reject);
  });
  server = listening;
  if (ownerApp) {
    const o = ownerApp;
    ownerServer = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: o.fetch, ...ownerListen }, () => resolve(s));
      s.once('error', reject);
    });
    console.log(`e2e owner api listening on http://${ownerListen.hostname}:${ownerListen.port}`);
  }
  console.log(`e2e api listening on http://${listen.hostname}:${listen.port}`);
} catch (err) {
  console.error(`e2e api: ${err instanceof Error ? err.message.split('\n')[0] : 'set-up failed'}`);
  await cleanup().catch(() => undefined);
  process.exit(1);
}
