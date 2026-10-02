import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, writePayload } from '../../../../scripts/fixture-archive.ts';
import { FAMILY_ROLES, familyViews, OBS_AT, PUBLIC_ONLY_VIEWS, VIEWS } from '../../src/db/audience.ts';
import { computeHealth } from '../../src/load/health.ts';
import { PUBLIC_SCAN_BYTES } from '../../src/load/pipeline.ts';
import { replay } from '../../src/load/replay.ts';
import { checkTwins } from '../../src/load/twins.ts';
import type { LoginRole } from '../db/testdb.ts';
import { type Harness, harness } from './harness.ts';

// The owner sources BE-3 (SPW KiWIS) and LU-2 (AGE per-station JSON) through the real loader (P5c, invariants 8
// and 11), on synthetic payloads only (every value invented here): their rows reach the owner family and no public
// one (as rws_api and as rws_publish), twins reach neither, a gauge zero is stored and 9999.0 is not, a twin pair of
// an owner series with a public one is checked and shown to the owner family only, public health holds no number of
// an owner source (the loader's backlog included), and a replay of either source writes nothing.

let h: Harness;
const AFTER = new Date('2026-10-02T12:00:00Z');
/** When the payloads were fetched: 1 minute before the loader's clock. */
const FETCH = new Date('2026-10-02T11:59:00Z');
/** The at-T instant of the view sweeps: after the newest row (11:50Z), inside every staleness limit. */
const AT = '2026-10-02T11:55:00Z';
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// The twin window of checkTwins at AFTER is (2026-10-01T12:00Z, 2026-10-02T11:30Z]: 94 points on a 15-minute grid.
const GRID_FROM = Date.parse('2026-10-01T10:30:00Z');
const GRID_TO = Date.parse('2026-10-02T11:45:00Z');
const GRID = Array.from({ length: (GRID_TO - GRID_FROM) / (15 * MIN) + 1 }, (_, i) => GRID_FROM + i * 15 * MIN);
const WINDOW_POINTS = 94;
/** A signal that no shifted copy of itself matches (a slow wave plus a period-13 jitter), in cm to one decimal. */
const signal = (ts: number) => {
  const k = Math.round(ts / (15 * MIN));
  return Math.round((300 + 40 * Math.sin(k / 7) + ((k * 7919) % 13)) * 10) / 10;
};
/** An AGE stamp: the instant with its +02:00 offset (CEST on 2026-10-02). */
const local = (ts: number) => iso(ts + 2 * 3_600_000).replace('Z', '+02:00');

const LU91 = '0/91/W_out/15m.Cmd.RelAbs.P';
const LU92 = '0/92/W_out/15m.Cmd.RelAbs.P';
/** FR-1's Belgian point on the Chiers (a public primary stage series of the real registry). */
const FR1_BE = ['FR-1', 'B400101101/H'] as const;
const OFFSET_CM = 35;

type Spec = {
  key: string;
  source: 'BE-3' | 'LU-2';
  station: string;
  quantity: 'H' | 'Q';
  unit: string;
  factor: number;
  role: 'primary' | 'twin';
};
const SERIES: readonly Spec[] = [
  { key: '9101/H', source: 'BE-3', station: 'be.spw.t9101', quantity: 'H', unit: 'm', factor: 100, role: 'primary' },
  { key: '9101/Q', source: 'BE-3', station: 'be.spw.t9101', quantity: 'Q', unit: 'm³/s', factor: 1, role: 'primary' },
  { key: '9102/H', source: 'BE-3', station: 'be.spw.t9102', quantity: 'H', unit: 'm', factor: 100, role: 'twin' },
  { key: LU91, source: 'LU-2', station: 'lu.age-json.t91', quantity: 'H', unit: 'cm', factor: 1, role: 'twin' },
  { key: LU92, source: 'LU-2', station: 'lu.age-json.t92', quantity: 'H', unit: 'cm', factor: 1, role: 'primary' },
];
const PRIMARY = SERIES.filter((s) => s.role === 'primary').map((s) => `${s.source} ${s.key}`);
const TWIN = SERIES.filter((s) => s.role === 'twin').map((s) => `${s.source} ${s.key}`);

const ids = new Map<string, number>();
const sid = (source: string, key: string): number => {
  const id = ids.get(`${source} ${key}`);
  if (id === undefined) throw new Error(`no series ${source} ${key}`);
  return id;
};
const idsOf = (names: readonly string[]) => names.map((n) => ids.get(n) as number);

const deps = (x: Harness) => ({
  db: x.load.db,
  reader: x.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => x.alerts.push({ code, fields }),
  now: () => AFTER,
});

const send = (x: Harness, source: string, spec: string, variant: string, doc: unknown, at: Date = FETCH) =>
  writePayload(x.archive, {
    source,
    spec,
    variant,
    at,
    body: Buffer.from(JSON.stringify(doc)),
    url: 'https://example.org/synthetic',
  });

async function rows(x: Harness, source: string, key: string) {
  const { rows: r } = await x.t.admin.query<{ ts: Date; value: number; qc: number }>(
    `SELECT o.ts, o.value, o.qc FROM obs o JOIN series s ON s.id = o.series_id
     WHERE s.source_id = $1 AND s.provider_key = $2 ORDER BY o.ts`,
    [source, key],
  );
  return r;
}

const batches = async (x: Harness) =>
  (
    await x.t.admin.query(
      `SELECT id, source_id, spec_id, parse_status, n_rows, n_new, n_changed, n_skipped, error FROM ingest_batch ORDER BY id`,
    )
  ).rows;

type Reader = { role: LoginRole; family: typeof VIEWS.public | typeof VIEWS.owner; fn: string; client: pg.Client };
const readers: Reader[] = [];
const publicReaders = () => readers.filter((r) => r.family === VIEWS.public);
const ownerReader = () => readers.find((r) => r.family === VIEWS.owner) as Reader;

/** The series every view of a family shows (with its at-T function at `AT`), as `series_id` sets by view. */
async function seen(r: Reader): Promise<Map<string, Set<number>>> {
  const { family, fn, client } = r;
  const queries = {
    obs: `SELECT DISTINCT series_id FROM ${family.obs}`,
    latest: `SELECT DISTINCT series_id FROM ${family.obsLatest}`,
    h1: `SELECT DISTINCT series_id FROM ${family.obs1h}`,
    d1: `SELECT DISTINCT series_id FROM ${family.obs1d}`,
    apiObs: `SELECT DISTINCT series_id FROM ${family.api.obs}`,
    apiH1: `SELECT DISTINCT series_id FROM ${family.api.obs1h}`,
    apiD1: `SELECT DISTINCT series_id FROM ${family.api.obs1d}`,
    series: `SELECT id AS series_id FROM ${family.series}`,
    apiSeries: `SELECT id AS series_id FROM ${family.api.series}`,
    at: `SELECT series_id FROM ${fn}('${AT}'::timestamptz)`,
  };
  const out = new Map<string, Set<number>>();
  for (const [name, sql] of Object.entries(queries))
    out.set(name, new Set((await client.query<{ series_id: number }>(sql)).rows.map((x) => x.series_id)));
  return out;
}

/** Every row of every public view and of the at-T function, as text: what a public reader could ever see. */
async function sweep(client: pg.Client): Promise<string> {
  let text = '';
  for (const view of familyViews('public')) {
    const { rows: r } = await client.query<{ j: string }>(`SELECT row_to_json(v)::text AS j FROM ${view} v`);
    text += `${view}\n${r.map((x) => x.j).join('\n')}\n`;
  }
  const { rows: at } = await client.query<{ j: string }>(
    `SELECT row_to_json(v)::text AS j FROM ${OBS_AT.public}('${AT}'::timestamptz) v`,
  );
  return text + at.map((x) => x.j).join('\n');
}

beforeAll(async () => {
  h = await harness();
  const admin = h.t.admin;
  await admin.query(`SELECT ensure_partitions('2026-10-01'::timestamptz, '2026-10-03'::timestamptz)`);
  for (const [id, name, country] of [
    ['be.spw.t9101', 'synthetic 9101', 'BE'],
    ['be.spw.t9102', 'synthetic 9102', 'BE'],
    ['lu.age-json.t91', 'synthetic 91', 'LU'],
    ['lu.age-json.t92', 'synthetic 92', 'LU'],
  ])
    await admin.query('INSERT INTO station (id, name, country, tier) VALUES ($1, $2, $3, 2)', [id, name, country]);
  for (const s of SERIES) {
    const { rows: r } = await admin.query<{ id: number }>(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, audience)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '15 min', '15 min', '90 min', $9, NULL) RETURNING id`,
      [
        s.station,
        s.source,
        s.quantity,
        s.quantity === 'Q' ? null : 'stage',
        s.key,
        s.unit,
        s.factor,
        s.quantity === 'Q' ? null : 'LOCAL',
        s.role,
      ],
    );
    ids.set(`${s.source} ${s.key}`, (r[0] as { id: number }).id);
  }
  // The public LU-1 Diekirch series is the public twin partner of LU-2 Diekirch and the positive control of every
  // public view: its rows and rollups are written here, the same values as the LU-2 file states.
  const { rows: d } = await admin.query<{ id: number }>(
    `SELECT id FROM series WHERE source_id = 'LU-1' AND provider_key = 'Diekirch'`,
  );
  ids.set('LU-1 Diekirch', (d[0] as { id: number }).id);
  const dk = sid('LU-1', 'Diekirch');
  await admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1, u.ts, u.value, 1, 1 FROM unnest($2::timestamptz[], $3::real[]) AS u(ts, value)`,
    [dk, GRID.map(iso), GRID.map(signal)],
  );
  const last = GRID.at(-1) as number;
  await admin.query(`INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 1, 1)`, [
    dk,
    iso(last),
    signal(last),
  ]);
  for (const table of ['obs_1h', 'obs_1d'])
    await admin.query(
      `INSERT INTO ${table} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or) VALUES ($1, $2, 100, 100, 100, 100, 1, 1)`,
      [dk, '2026-10-02T00:00:00Z'],
    );
  const { rows: fr } = await admin.query<{ id: number }>(
    'SELECT id FROM series WHERE source_id = $1 AND provider_key = $2',
    [...FR1_BE],
  );
  ids.set(`${FR1_BE[0]} ${FR1_BE[1]}`, (fr[0] as { id: number }).id);

  for (const [family, fn] of [
    [VIEWS.public, OBS_AT.public],
    [VIEWS.owner, OBS_AT.owner],
  ] as const) {
    for (const role of family === VIEWS.public ? FAMILY_ROLES.public : FAMILY_ROLES.owner)
      readers.push({ role, family, fn, client: await h.t.connectAs(role) });
  }
});

afterAll(async () => {
  await Promise.allSettled(readers.map((r) => r.client.end()));
  await h.close();
});

describe('BE-3 and LU-2 through the loader', { timeout: 60_000 }, () => {
  it('load: a layer, a catch-up, the station list and two AGE files, every payload ok, no alert', async () => {
    // The layer: the latest value of three series (a level marker 654.321 cm and a discharge marker 87.6543 m³/s).
    const item = (tsId: number, no: string, parameter: string, unit: string, value: number) => ({
      ts_id: tsId,
      timestamp: '2026-10-02T11:50:00.000Z',
      req_timestamp: null,
      ts_value: value,
      station_no: no,
      station_name: 'synthetic',
      stationparameter_no: parameter,
      ts_unitsymbol: unit,
    });
    await send(h, 'BE-3', 'be-3-values', '', [
      item(900100010, '9101', 'H', 'm', 6.54321),
      item(900100020, '9101', 'Q', 'm³/s', 87.6543),
      item(900100030, '9102', 'H', 'm', 2.5),
    ]);
    // The catch-up's values: four quarter-hours of each primary series and a day of the twin (121 rows).
    const values = (tsId: number, no: string, parameter: string, unit: string, data: [number, number][]) => ({
      ts_id: String(tsId),
      ts_path: `DGH/${no}/${parameter}/Cmd.synthetic`,
      station_no: no,
      stationparameter_no: parameter,
      ts_unitsymbol: unit,
      rows: String(data.length),
      columns: 'Timestamp,Value,Quality Code',
      data: data.map(([ts, v]) => [iso(ts), v, 200]),
    });
    const recent = [1, 2, 3, 4].map((i) => GRID_TO - (4 - i) * 15 * MIN);
    await send(h, 'BE-3', 'be-3-catchup', '', [
      values(
        900100010,
        '9101',
        'H',
        'm',
        recent.map((ts, i) => [ts, 2.31 + i / 25]),
      ),
      values(
        900100020,
        '9101',
        'Q',
        'm³/s',
        recent.map((ts, i) => [ts, 18.2 + i / 5]),
      ),
      values(
        900100030,
        '9102',
        'H',
        'm',
        GRID.map((ts) => [ts, signal(ts) / 100]),
      ),
    ]);
    // The station list: 9101 has a zero of 109.9 m DNG from 2026-01-01, 9102 the unknown marker.
    await send(h, 'BE-3', 'be-3-meta', 'stations', [
      ['station_no', 'station_name', 'station_gauge_datum', 'station_gauge_datum_unit', 'station_gauge_datum_from'],
      ['9101', 'synthetic 9101', '109.9', 'DNG', '2026-01-01'],
      ['9102', 'synthetic 9102', '9999.0', 'DNG', null],
    ]);
    // The AGE files: one series each, stamps with their +02:00.
    const file = (path: string, data: [number, number][]) => [
      {
        ts_path: path,
        ts_unitsymbol: 'cm',
        station_name: 'synthetic',
        parametertype_name: 'W',
        rows: String(data.length),
        columns: 'Timestamp,Value',
        data: data.map(([ts, v]) => [local(ts), v]),
      },
    ];
    await send(
      h,
      'LU-2',
      'lu-2-json',
      '91',
      file(
        LU91,
        GRID.map((ts) => [ts, signal(ts)]),
      ),
    );
    await send(
      h,
      'LU-2',
      'lu-2-json',
      '92',
      file(
        LU92,
        recent.map((ts, i) => [ts, 140.5 + i]),
      ),
    );

    expect(await h.loader({ now: AFTER }).tick()).toEqual({ lines: 5, loaded: 5 });
    expect(h.alerts).toEqual([]);
    const all = await batches(h);
    expect(all.map((b) => [b.source_id, b.spec_id, b.parse_status, b.n_skipped, b.error])).toEqual([
      ['BE-3', 'be-3-values', 'ok', 0, null],
      ['BE-3', 'be-3-catchup', 'ok', 0, null],
      ['BE-3', 'be-3-meta', 'ok', 0, null],
      ['LU-2', 'lu-2-json', 'ok', 0, null],
      ['LU-2', 'lu-2-json', 'ok', 0, null],
    ]);
    // Every series shares its source's audience, so a batch counts what it stored (one gauge zero in the list).
    expect(all.map((b) => [b.n_rows, b.n_new, b.n_changed])).toEqual([
      [3, 3, 0],
      [4 + 4 + GRID.length, 4 + 4 + GRID.length, 0],
      [1, 1, 0],
      [GRID.length, GRID.length, 0],
      [4, 4, 0],
    ]);
    expect((await rows(h, 'BE-3', '9101/H')).length).toBe(5);
    expect((await rows(h, 'BE-3', '9101/Q')).length).toBe(5);
    expect((await rows(h, 'BE-3', '9102/H')).length).toBe(GRID.length + 1);
    expect((await rows(h, 'LU-2', LU91)).length).toBe(GRID.length);
    expect((await rows(h, 'LU-2', LU92)).length).toBe(4);
    // The +02:00 stamps are read with their offset: the first AGE row is the grid's first instant, in UTC.
    expect((await rows(h, 'LU-2', LU91))[0]?.ts.toISOString()).toBe(iso(GRID_FROM));
  });

  it('every row of a primary owner series is in the owner family; none is in a public one, for either public role', async () => {
    const primary = idsOf(PRIMARY);
    const twins = idsOf(TWIN);
    const diekirch = sid('LU-1', 'Diekirch');
    const stored = async (id: number) =>
      (await h.t.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM obs WHERE series_id = $1', [id])).rows[0]
        ?.n;

    const owner = ownerReader();
    for (const [view, set] of await seen(owner)) {
      for (const id of primary) expect(set.has(id), `owner ${view} lacks series ${id}`).toBe(true);
      for (const id of twins) expect(set.has(id), `owner ${view} shows twin ${id}`).toBe(false);
    }
    // Every stored row of a primary series is in the owner obs view, and the twins have none there.
    for (const id of primary) {
      const n = (
        await owner.client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${VIEWS.owner.obs} WHERE series_id = $1`,
          [id],
        )
      ).rows[0]?.n;
      expect(n, `owner obs rows of series ${id}`).toBe(await stored(id));
      expect(n).toBeGreaterThan(0);
    }
    for (const id of twins) {
      const { rows: n } = await owner.client.query(
        `SELECT count(*)::int AS n FROM ${VIEWS.owner.obs} WHERE series_id = $1`,
        [id],
      );
      expect(n).toEqual([{ n: 0 }]);
    }

    const terms = [
      'BE-3',
      'LU-2',
      'be.spw.',
      'lu.age-json.',
      '9101/',
      '9102/',
      '0/91/',
      '0/92/',
      'Wallonie',
      '654.321',
      '87.6543',
    ];
    expect(publicReaders().map((r) => r.role)).toEqual([...FAMILY_ROLES.public]);
    for (const r of publicReaders()) {
      for (const [view, set] of await seen(r)) {
        for (const id of [...primary, ...twins])
          expect(set.has(id), `${r.role} ${view} shows series ${id}`).toBe(false);
        // The positive control: the public LU-1 series is in every view.
        expect(set.has(diekirch), `${r.role} ${view} lacks the public control`).toBe(true);
      }
      const text = await sweep(r.client);
      expect(
        terms.filter((t) => text.includes(t)),
        `${r.role} sweep`,
      ).toEqual([]);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('be-3-meta stations: the stage series gets its gauge zero in m DNG, 9999.0 gives none', async () => {
    const { rows: zeros } = await h.t.admin.query(
      `SELECT s.provider_key, g.value_m, g.datum, lower(g.valid) AS valid_from, upper_inf(g.valid) AS open
       FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.source_id = 'BE-3' ORDER BY 1`,
    );
    // 2026-01-01 is local midnight of SPW's fixed UTC+01:00.
    expect(zeros).toEqual([
      {
        provider_key: '9101/H',
        value_m: 109.9,
        datum: 'DNG',
        valid_from: new Date('2025-12-31T23:00:00Z'),
        open: true,
      },
    ]);
  });
});

describe('twin pairs of owner series', { timeout: 60_000 }, () => {
  const LU_PAIR = 'owner-test-lu1-lu2';
  const FR_PAIR = 'owner-test-fr1-be3';
  const twinRows = async (r: Reader) =>
    (
      await r.client.query<{
        twin_id: string;
        n_aligned: number;
        median_delta: number | null;
        lag_min: number | null;
        ok: boolean;
      }>(
        `SELECT twin_id, n_aligned, median_delta, lag_min, ok FROM ${r.family.twinCheck} WHERE twin_id = ANY($1) ORDER BY 1`,
        [[LU_PAIR, FR_PAIR]],
      )
    ).rows;

  it('LU-1 against LU-2 (an offset of 0) and FR-1 against a BE-3 twin (a constant of 35 cm) are checked, ok, lag 0', async () => {
    const admin = h.t.admin;
    // FR-1 states what the BE-3 twin states plus 35 cm, on the same instants.
    const fr = sid(FR1_BE[0], FR1_BE[1]);
    await admin.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id)
       SELECT $1, ts, value + $3::real, 1, 1 FROM obs WHERE series_id = $2 AND ts <= $4::timestamptz`,
      [fr, sid('BE-3', '9102/H'), OFFSET_CM, iso(GRID_TO)],
    );
    await admin.query(`INSERT INTO twin (id, series_a, series_b, relation) VALUES ($1, $2, $3, $4::jsonb)`, [
      LU_PAIR,
      sid('LU-1', 'Diekirch'),
      sid('LU-2', LU91),
      JSON.stringify({ kind: 'offset', expected: 0, tolerance: 0.05, unit: 'cm', min_share: 0.98 }),
    ]);
    await admin.query(`INSERT INTO twin (id, series_a, series_b, relation) VALUES ($1, $2, $3, $4::jsonb)`, [
      FR_PAIR,
      fr,
      sid('BE-3', '9102/H'),
      JSON.stringify({ kind: 'constant', tolerance: 0.5, unit: 'cm' }),
    ]);

    expect(await checkTwins(h.load.db, AFTER)).toEqual([]);
    const { rows: checks } = await admin.query<{
      twin_id: string;
      window_end: Date;
      n_aligned: number;
      median_delta: number;
      max_delta: number;
      lag_min: number;
      ok: boolean;
    }>(
      `SELECT twin_id, window_end, n_aligned, median_delta, max_delta, lag_min, ok FROM twin_check
       WHERE twin_id = ANY($1) ORDER BY twin_id`,
      [[LU_PAIR, FR_PAIR]],
    );
    expect(checks.map((c) => c.twin_id)).toEqual([FR_PAIR, LU_PAIR]);
    for (const c of checks) {
      expect(c.window_end).toEqual(new Date('2026-10-02T12:00:00Z'));
      expect(c.n_aligned).toBe(WINDOW_POINTS);
      expect(c.lag_min).toBe(0);
      expect(c.ok).toBe(true);
    }
    const [fr1, lu] = checks as [(typeof checks)[number], (typeof checks)[number]];
    expect(lu.median_delta).toBe(0);
    expect(lu.max_delta).toBe(0);
    // The constant pair reports the offset it found: 35 cm (float32 arithmetic on values of a few hundred).
    expect(Math.abs(fr1.median_delta - OFFSET_CM) < 0.01).toBe(true);
    expect(Math.abs(fr1.max_delta - OFFSET_CM) < 0.01).toBe(true);
  });

  it('the owner family shows both checks; no public family does, for either public role', async () => {
    const own = await twinRows(ownerReader());
    expect(own.map((r) => [r.twin_id, r.n_aligned, r.lag_min, r.ok])).toEqual([
      [FR_PAIR, WINDOW_POINTS, 0, true],
      [LU_PAIR, WINDOW_POINTS, 0, true],
    ]);
    expect(own.find((r) => r.twin_id === FR_PAIR)?.median_delta !== null).toBe(true);
    for (const r of publicReaders()) expect(await twinRows(r), r.role).toEqual([]);
  });
});

describe('public health holds no number of an owner source', { timeout: 60_000 }, () => {
  const inputs = async () => ({
    cadenceS: new Map([
      ['BE-3', 600],
      ['LU-2', 3600],
    ]),
    lagP95Ms: new Map<string, number>(),
    backlog: (await h.loader({ now: AFTER }).backlog()).public,
    badLines: 0,
    now: AFTER,
  });

  it('the source health shows no BE-3 and no LU-2 row; the owner aggregate is two counts; the owner family has both', async () => {
    await computeHealth(h.load.db, await inputs());
    const admin = h.t.admin;
    const { rows: owners } = await admin.query<{ id: string }>(`SELECT id FROM source WHERE audience = 'owner'`);
    expect(owners.map((o) => o.id)).toEqual(expect.arrayContaining(['BE-3', 'LU-2']));
    const { rows: counts } = await admin.query<{ total: number; healthy: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE h.status = 'ok'))::int AS healthy
       FROM source s LEFT JOIN source_health h ON h.source_id = s.id
       WHERE s.audience = 'owner' AND s.capture_enabled AND NOT s.canary`,
    );
    for (const r of publicReaders()) {
      const listed = (await r.client.query<{ source_id: string }>(`SELECT source_id FROM ${r.family.sourceHealth}`))
        .rows;
      for (const o of owners)
        expect(
          listed.map((x) => x.source_id),
          `${r.role} lists ${o.id}`,
        ).not.toContain(o.id);
      const aggregate = (await r.client.query(`SELECT * FROM ${PUBLIC_ONLY_VIEWS.ownerHealth}`)).rows;
      // Two counts and nothing else: no id, no name.
      expect(aggregate).toEqual([{ healthy: counts[0]?.healthy, total: counts[0]?.total }]);
      expect(counts[0]?.total).toBeGreaterThanOrEqual(2);
      expect(Object.keys(aggregate[0] ?? {})).toEqual(['healthy', 'total']);
    }
    const own = (
      await ownerReader().client.query<{ source_id: string; last_fetch_ok: Date | null }>(
        `SELECT source_id, last_fetch_ok FROM ${VIEWS.owner.sourceHealth} WHERE source_id IN ('BE-3', 'LU-2') ORDER BY 1`,
      )
    ).rows;
    expect(own.map((r) => [r.source_id, r.last_fetch_ok])).toEqual([
      ['BE-3', FETCH],
      ['LU-2', FETCH],
    ]);
  });
});

describe('a replay of BE-3 and of LU-2', { timeout: 60_000 }, () => {
  it('twice writes nothing: the second pass reports no new row and no change', async () => {
    const state = async () => ({
      sums: await h.checksums(),
      revisions: await h.count('obs_revision'),
      batches: await batches(h),
      zeros: (await h.t.admin.query('SELECT series_id, value_m, datum, valid, batch_id FROM gauge_zero ORDER BY 1'))
        .rows,
    });
    const before = await state();
    const lines = { 'BE-3': 3, 'LU-2': 2 };
    for (let pass = 0; pass < 2; pass += 1) {
      for (const source of ['BE-3', 'LU-2'] as const) {
        const r = await replay(deps(h), { source, spec: null, from: '2026-09-01', to: '2026-12-31', dryRun: false });
        expect({ source, ...r }).toEqual({
          source,
          lines: lines[source],
          loaded: lines[source],
          quarantined: 0,
          skipped: 0,
          n_new: 0,
          n_changed: 0,
        });
      }
    }
    expect(h.alerts).toEqual([]);
    expect(await state()).toEqual(before);
    expect(before.revisions).toBe(0);
  });
});

describe('the loader backlog of public health', { timeout: 60_000 }, () => {
  it('counts no owner line: a backlog of owner lines only is no public file and no public age; one public line is seen alone', async () => {
    const x = await harness();
    try {
      // Three owner lines (a layer, an AGE file, a failed fetch), then one public line, all on 2026-10-02.
      await send(x, 'BE-3', 'be-3-values', '', [], new Date('2026-10-02T11:50:00Z'));
      await send(x, 'LU-2', 'lu-2-json', '91', [], new Date('2026-10-02T11:52:00Z'));
      await x.archive.append(
        bareLine('LU-4', 'lu-4-pages', new Date('2026-10-02T11:54:00Z'), { status: null, error: 'timeout' }),
      );
      const loader = x.loader({ now: AFTER });
      const all = await loader.backlog();
      expect(all.files).toBe(1);
      expect(all.bytes).toBeGreaterThan(0);
      expect(all.age_s).toBe(600);
      expect(all.public).toEqual({ files: 0, bytes: 0, age_s: null });

      // The health pass stores the public figures: the view a public reader sees is empty of the backlog.
      await computeHealth(x.load.db, {
        cadenceS: new Map(),
        lagP95Ms: new Map<string, number>(),
        backlog: all.public,
        badLines: 0,
        now: AFTER,
      });
      const api = await x.t.connectAs('rws_api');
      const publish = await x.t.connectAs('rws_publish');
      for (const client of [api, publish]) {
        const { rows } = await client.query(
          `SELECT backlog_files, backlog_bytes::int AS backlog_bytes, backlog_age_s FROM ${PUBLIC_ONLY_VIEWS.loader}`,
        );
        expect(rows).toEqual([{ backlog_files: 0, backlog_bytes: 0, backlog_age_s: null }]);
      }

      await x.archive.append(bareLine('DE-1', 'de-1-series', new Date('2026-10-02T11:58:00Z'), { status: 304 }));
      const next = await loader.backlog();
      expect(next.files).toBe(1);
      expect(next.age_s).toBe(600);
      // The public figures are that one line: its bytes are what the file grew by, its age its own.
      expect(next.public).toEqual({ files: 1, bytes: next.bytes - all.bytes, age_s: 120 });
      expect(next.public.bytes).toBeGreaterThan(0);

      await api.end();
      await publish.end();
    } finally {
      await x.close();
    }
  });

  it('reads at most PUBLIC_SCAN_BYTES of a file: the unscanned rest of a long owner backlog counts whole, as public (R2-CR-4)', async () => {
    const x = await harness();
    try {
      // Owner lines only, about 1.5 MiB more than the scan reads in its last 1 MiB chunk: written in one append.
      await x.archive.append(bareLine('LU-4', 'lu-4-pages', new Date('2026-10-02T11:50:00Z'), { status: 304 }));
      const one = `${JSON.stringify(bareLine('LU-4', 'lu-4-pages', new Date('2026-10-02T11:51:00Z'), { status: 304 }))}\n`;
      const lines = Math.ceil((PUBLIC_SCAN_BYTES + 2.5 * 1024 * 1024) / Buffer.byteLength(one));
      appendFileSync(join(x.raw, '_manifest', '2026-10-02.jsonl'), one.repeat(lines));
      const b = await x.loader({ now: AFTER }).backlog();
      expect(b.bytes).toBeGreaterThan(PUBLIC_SCAN_BYTES + 2 * 1024 * 1024);
      // Not 0, as a full scan of owner lines would give: the rest beyond the scan, aged from the file's day.
      expect(b.public.files).toBe(1);
      expect(b.public.bytes).toBeGreaterThan(0);
      expect(b.public.bytes).toBeLessThanOrEqual(b.bytes - PUBLIC_SCAN_BYTES);
      expect(b.public.age_s).toBe((AFTER.getTime() - Date.parse('2026-10-02T00:00:00Z')) / 1000);
    } finally {
      await x.close();
    }
  });
});
