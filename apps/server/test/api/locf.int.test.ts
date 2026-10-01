import { Snapshot } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db/pool.ts';
import { openApiDb } from '../../src/main.ts';
import { createTestDb, type TestDb } from '../db/testdb.ts';

// "The value of every series at T" (A§8 Q1) through GET /api/v1/snapshot, against
// a direct computation on the base tables. 300 public series with random steps,
// gaps and staleness limits come from a seeded generator (so every run reads the
// same data), plus the edge cases of the staleness window at the second, plus
// series that must never be in a snapshot although they hold a value at T.

const SEC = 1000;
const NOW = new Date('2026-10-26T12:00:00Z');
/** now - 1 day, already on the 10-minute grid. */
const T = Date.parse('2026-10-25T12:00:00Z');
const T_ISO = '2026-10-25T12:00:00.000Z';
const FIRST = Date.parse('2026-10-23T00:00:00Z');
const LAST = Date.parse('2026-10-26T12:00:00Z');
const HOUR = 3_600_000;
const SERIES = 300;

/** mulberry32: a tiny seeded generator, so the data of every run is the same. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rand = mulberry32(0x5eed_2026);
const pick = <X>(items: readonly X[]): X => items[Math.floor(rand() * items.length)] as X;

type Obs = [ms: number, value: number, qc: number];
type Spec = {
  key: string;
  source: string;
  limitMin: number;
  stepMin: number;
  obs: Obs[];
  role?: string;
  audience?: string;
  override?: string;
  active?: boolean;
};

/** An observation `s` seconds from T. */
const at = (s: number, value: number, qc: number): Obs => [T + s * SEC, value, qc];

// The edge cases of the staleness window, forced on specific series. A value counts when
// ts <= T and ts > T - limit: the limit itself is out, one second inside it is in.
const EDGES = {
  // A value exactly at T: age 0. Values after T are not read.
  age0: { limitMin: 45, obs: [at(-600, 10, 1), at(0, 11, 1), at(600, 12, 1)] },
  // The latest value at T - limit exactly, nothing later before T: omitted.
  atLimit: { limitMin: 45, obs: [at(-3600, 21, 1), at(-2700, 22, 1), at(600, 23, 1)] },
  // One second inside the limit: carried.
  justInside: { limitMin: 45, obs: [at(-3600, 31, 1), at(-2699, 33, 2)] },
  // Values after T only, and an old one outside the window: omitted.
  afterOnly: { limitMin: 45, obs: [at(-7200, 40, 1), at(300, 44, 1), at(3600, 45, 1)] },
  // No observation at all: omitted.
  noObs: { limitMin: 45, obs: [] as Obs[] },
  // One second before T wins over one second after.
  secondBefore: { limitMin: 45, obs: [at(-600, 6, 1), at(-1, 7, 5), at(1, 8, 1)] },
  // A slow gauge (25 h): one second inside the limit, and exactly at it.
  slowInside: { limitMin: 1500, obs: [at(-100_000, 70, 1), at(-89_999, 71, 1)] },
  slowAtLimit: { limitMin: 1500, obs: [at(-95_000, 80, 1), at(-90_000, 81, 1)] },
  // The latest value 10 minutes old, an older one and a newer one after T.
  tenMinutesBefore: { limitMin: 45, obs: [at(-1800, 4, 1), at(-600, 5, 2), at(60, 6, 1)] },
} as const;
type Edge = keyof typeof EDGES;
const EDGE_KEYS = Object.keys(EDGES) as Edge[];

/** What the snapshot must hold for the forced series, written by hand. */
const EXPECTED_EDGE: Record<Edge, { ts: number; value: number; qc: number } | null> = {
  age0: { ts: T, value: 11, qc: 1 },
  atLimit: null,
  justInside: { ts: T - 2699 * SEC, value: 33, qc: 2 },
  afterOnly: null,
  noObs: null,
  secondBefore: { ts: T - SEC, value: 7, qc: 5 },
  slowInside: { ts: T - 89_999 * SEC, value: 71, qc: 1 },
  slowAtLimit: null,
  tenMinutesBefore: { ts: T - 600 * SEC, value: 5, qc: 2 },
};

/** Random observations between FIRST and LAST: steps of 10, 15 or 60 minutes, jitter, skipped hours, long gaps. */
function observations(stepMin: number): Obs[] {
  const out: Obs[] = [];
  let gap = 0;
  for (let hour = FIRST; hour <= LAST; hour += HOUR) {
    if (gap > 0) {
      gap -= 1;
      continue;
    }
    const r = rand();
    if (r < 0.03) {
      gap = 2 + Math.floor(rand() * 30);
      continue;
    }
    if (r < 0.15) continue;
    for (let m = 0; m < 60; m += stepMin) {
      // Half of the values sit on the grid, the others up to a step late (whole seconds).
      const jitter = rand() < 0.5 ? 0 : Math.floor(rand() * stepMin * 60);
      const ms = hour + m * 60_000 + jitter * SEC;
      if (ms > LAST) break;
      if (rand() < 0.05) continue;
      out.push([ms, Math.round(rand() * 100_000) / 100, pick([1, 2, 5])]);
    }
  }
  return out;
}

let t: TestDb;
let api: Db;
let display: DisplayWindow;
let app: ReturnType<typeof createApp>;
/** Series id by key, for the 300 series of the snapshot and for the ones that must stay out of it. */
const ids = new Map<string, number>();
const extras: string[] = [];

async function addSeries(spec: Spec) {
  const country = { 'NL-1': 'NL', 'DE-1': 'DE', 'CH-2': 'CH', 'BE-3': 'BE' }[spec.source] as string;
  const station = `${country.toLowerCase()}.lc.${spec.key}`;
  await t.admin.query(`INSERT INTO station (id, name, country, tier) VALUES ($1, $1, $2, 2)`, [station, country]);
  const { rows } = await t.admin.query<{ id: number }>(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, audience, lic_override, active)
     VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', make_interval(mins => $4::int), make_interval(mins => $4::int),
             make_interval(mins => $5::int), $6, $7::audience, $8::jsonb, $9)
     RETURNING id`,
    [
      station,
      spec.source,
      spec.key,
      spec.stepMin,
      spec.limitMin,
      spec.role ?? 'primary',
      spec.audience ?? null,
      spec.override ?? null,
      spec.active ?? true,
    ],
  );
  const id = rows[0]?.id as number;
  ids.set(spec.key, id);
  return id;
}

async function insertObs(rows: { id: number; obs: Obs[] }[]) {
  const flat = rows.flatMap((r) => r.obs.map(([ms, value, qc]) => [r.id, ms / SEC, value, qc] as const));
  for (let i = 0; i < flat.length; i += 20_000) {
    const chunk = flat.slice(i, i + 20_000);
    await t.admin.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id)
       SELECT a, to_timestamp(b), c, d::int2, 1 FROM unnest($1::int[], $2::float8[], $3::float8[], $4::int[]) AS u(a, b, c, d)`,
      [chunk.map((r) => r[0]), chunk.map((r) => r[1]), chunk.map((r) => r[2]), chunk.map((r) => r[3])],
    );
  }
}

/** The reference: LOCF at T straight from the base tables, written differently from the at-T function. */
async function reference(seriesIds: number[], atMs = T) {
  const { rows } = await t.admin.query<{ series_id: number; ts: Date; value: number; qc: number }>(
    `SELECT DISTINCT ON (o.series_id) o.series_id, o.ts, o.value, o.qc
     FROM obs o JOIN series s ON s.id = o.series_id
     WHERE o.series_id = ANY($1::int[]) AND o.ts <= $2::timestamptz AND o.ts > $2::timestamptz - s.staleness_limit
     ORDER BY o.series_id, o.ts DESC`,
    [seriesIds, new Date(atMs).toISOString()],
  );
  return rows.map((r) => ({
    series: r.series_id,
    ts: r.ts.toISOString(),
    value: r.value,
    qc: r.qc,
    ageSeconds: (atMs - r.ts.getTime()) / SEC,
  }));
}

const id = (key: string): number => {
  const found = ids.get(key);
  if (found === undefined) throw new Error(`no series ${key}`);
  return found;
};
let all: number[];
let snapshot: Snapshot;

beforeAll(async () => {
  t = await createTestDb();
  const basis = `'{"clause": "c", "url": "https://example.org/terms", "retrieved": "2026-09-24"}'::jsonb`;
  await t.admin.query(`
    INSERT INTO provider (id, name, country) VALUES ('rws', 'RWS', 'NL'), ('wsv', 'WSV', 'DE'), ('bafu', 'BAFU', 'CH'),
      ('spw', 'SPW', 'BE');
    INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                        lic_history_export, history_window, capture_enabled) VALUES
      ('NL-1', 'rws', 'public obs', 'public', NULL, true, true, true, true, '0', true),
      ('DE-1', 'wsv', 'public obs', 'public', NULL, true, true, true, true, '0', true),
      ('CH-2', 'bafu', 'no display', 'public', NULL, false, false, false, false, '0', true),
      ('BE-3', 'spw', 'owner obs', 'owner', ${basis}, true, true, false, true, '0', true);`);
  await t.admin.query(`SELECT ensure_partitions('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')`);

  const specs: Spec[] = EDGE_KEYS.map((key) => ({
    key,
    source: 'NL-1',
    limitMin: EDGES[key].limitMin,
    stepMin: 15,
    obs: [...EDGES[key].obs],
  }));
  for (let i = EDGE_KEYS.length; i < SERIES; i += 1) {
    const stepMin = pick([10, 15, 60]);
    specs.push({
      key: `r${i}`,
      source: pick(['NL-1', 'DE-1']),
      limitMin: pick([45, 60, 90, 1500]),
      stepMin,
      obs: observations(stepMin),
    });
  }
  // Series with a value at T and just before it that must never be in the public snapshot.
  const held = (key: string, more: Partial<Spec>): Spec => ({
    key,
    source: 'NL-1',
    limitMin: 45,
    stepMin: 15,
    obs: [at(-600, 998, 1), at(0, 999, 1)],
    ...more,
  });
  const hidden = [
    held('x-inactive', { active: false }),
    held('x-mirror', { role: 'mirror' }),
    held('x-twin', { role: 'twin' }),
    held('x-off', { audience: 'off' }),
    held('x-owner-narrowed', { audience: 'owner' }),
    held('x-display-off', { override: '{"display": false}' }),
    held('x-source-display-off', { source: 'CH-2' }),
    held('x-owner-source', { source: 'BE-3' }),
  ];
  extras.push(...hidden.map((s) => s.key));

  const rows: { id: number; obs: Obs[] }[] = [];
  for (const spec of [...specs, ...hidden]) rows.push({ id: await addSeries(spec), obs: spec.obs });
  await insertObs(rows);
  await t.admin.query('ANALYZE');
  all = specs.map((s) => id(s.key));

  const opened = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof opened === 'string') throw new Error(opened);
  api = opened;
  display = new DisplayWindow(api.db);
  await t.admin.query(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [
    '2026-10-01T00:00:00Z',
  ]);
  expect(await display.refresh()).toBe(true);
  app = createApp({ db: api.db, window: display, now: () => NOW });
  // t = now - 1 day.
  const res = await app.request(`/api/v1/snapshot?t=${T_ISO}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=600');
  snapshot = Snapshot.parse(await res.json());
});

afterAll(async () => {
  await api.close();
  await t.drop();
});

describe('GET /api/v1/snapshot?t=<now - 1 day> against a direct LOCF computation on the base tables', () => {
  it('the quantised instant is the one asked for, and the data is the seeded mix', async () => {
    expect(snapshot.t).toBe(T_ISO);
    const { rows } = await t.admin.query<{ series: number; obs: number }>(
      `SELECT count(DISTINCT series_id)::int AS series, count(*)::int AS obs FROM obs WHERE series_id = ANY($1::int[])`,
      [all],
    );
    expect(rows[0]?.series).toBeGreaterThan(280);
    expect(rows[0]?.obs).toBeGreaterThan(20_000);
    const ref = await reference(all);
    // A real mix: most series have a value in their window, a good share have not (gaps, short limits, the forced ones).
    expect(ref.length).toBeGreaterThan(SERIES * 0.5);
    expect(ref.length).toBeLessThan(SERIES * 0.95);
    // Some values sit exactly at T, some are old, some belong to a slow gauge.
    expect(ref.some((r) => r.ageSeconds === 0)).toBe(true);
    expect(ref.filter((r) => r.ageSeconds > 3600).length).toBeGreaterThan(5);
    expect(ref.filter((r) => r.ageSeconds > 0 && r.ageSeconds < 900).length).toBeGreaterThan(10);
  });

  it('holds exactly the series the reference gives for all 300, each with the same ts, value, qc and age', async () => {
    const ref = await reference(all);
    const got = snapshot.values.filter((v) => all.includes(v.series));
    expect(got.map((v) => v.series)).toEqual(ref.map((r) => r.series));
    expect(got).toEqual(ref);
    // The omissions are as many as the reference says, and no series of the 300 is invented.
    expect(all.filter((s) => !got.some((v) => v.series === s))).toHaveLength(SERIES - ref.length);
  });

  it('holds nothing but those 300: no inactive, mirror, twin, off, owner, display-off or owner-source series', async () => {
    const { rows } = await t.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM obs WHERE series_id = ANY($1::int[]) AND ts = $2::timestamptz`,
      [extras.map(id), T_ISO],
    );
    // Every one of them has a value at T, so their absence is the views' doing.
    expect(rows[0]?.n).toBe(extras.length);
    expect(snapshot.values.map((v) => v.series).filter((s) => !all.includes(s))).toEqual([]);
    for (const key of extras)
      expect(
        snapshot.values.map((v) => v.series),
        key,
      ).not.toContain(id(key));
    expect(snapshot.values.map((v) => v.series)).toEqual(
      [...snapshot.values.map((v) => v.series)].sort((a, b) => a - b),
    );
  });

  it('equals the reference on 50 series picked by the generator, the edge cases among them', async () => {
    const others = all.filter((s) => !EDGE_KEYS.map(id).includes(s));
    // A seeded partial shuffle of the other 291.
    for (let i = others.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [others[i], others[j]] = [others[j] as number, others[i] as number];
    }
    const picked = [...EDGE_KEYS.map(id), ...others.slice(0, 50 - EDGE_KEYS.length)];
    expect(new Set(picked).size).toBe(50);
    const ref = await reference(picked);
    const got = snapshot.values.filter((v) => picked.includes(v.series));
    expect(got).toEqual(ref);
    // The sample is not trivial: some of the 50 have a value, some have none.
    expect(ref.length).toBeGreaterThan(15);
    expect(ref.length).toBeLessThan(46);
    // The same through a request of its own, so the answer is the one a visitor gets, not the shared fixture.
    const again = Snapshot.parse(
      await (
        await createApp({ db: api.db, window: display, now: () => NOW }).request(`/api/v1/snapshot?t=${T_ISO}`)
      ).json(),
    );
    expect(again.values.filter((v) => picked.includes(v.series))).toEqual(ref);
  });

  it('the staleness window at the second: age 0 is in, the limit itself is out, one second inside is in', () => {
    const byId = new Map(snapshot.values.map((v) => [v.series, v]));
    for (const key of EDGE_KEYS) {
      const want = EXPECTED_EDGE[key];
      const got = byId.get(id(key));
      if (want === null) {
        expect(got, key).toBeUndefined();
        continue;
      }
      expect(got, key).toEqual({
        series: id(key),
        ts: new Date(want.ts).toISOString(),
        value: want.value,
        qc: want.qc,
        ageSeconds: (T - want.ts) / SEC,
      });
    }
    // By number: the three ages the limits are about.
    expect(byId.get(id('age0'))?.ageSeconds).toBe(0);
    expect(byId.get(id('justInside'))?.ageSeconds).toBe(2699);
    expect(byId.get(id('slowInside'))?.ageSeconds).toBe(89_999);
    expect(byId.get(id('secondBefore'))?.ageSeconds).toBe(1);
    expect(byId.has(id('atLimit'))).toBe(false);
    expect(byId.has(id('slowAtLimit'))).toBe(false);
    expect(byId.has(id('afterOnly'))).toBe(false);
    expect(byId.has(id('noObs'))).toBe(false);
  });

  it('a second instant, T + 10 min, equals the reference too and moves the forced series on', async () => {
    // T + 10 min: the value 600 s after T is now the latest one for age0 and atLimit.
    const next = T + 600 * SEC;
    const res = await app.request(`/api/v1/snapshot?t=${new Date(next).toISOString()}`);
    const body = Snapshot.parse(await res.json());
    expect(body.t).toBe(new Date(next).toISOString());
    expect(body.values.filter((v) => all.includes(v.series))).toEqual(await reference(all, next));
    const byId = new Map(body.values.map((v) => [v.series, v]));
    expect(byId.get(id('age0'))).toEqual({
      series: id('age0'),
      ts: new Date(next).toISOString(),
      value: 12,
      qc: 1,
      ageSeconds: 0,
    });
    expect(byId.get(id('atLimit'))).toEqual({
      series: id('atLimit'),
      ts: new Date(next).toISOString(),
      value: 23,
      qc: 1,
      ageSeconds: 0,
    });
    // afterOnly: its first value is 300 s after T, so it is in at T + 10 min with age 300 s.
    expect(byId.get(id('afterOnly'))).toMatchObject({ value: 44, ageSeconds: 300 });
  });
});
