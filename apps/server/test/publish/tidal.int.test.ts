import { floorBucket, LatestFile, SnapshotFile, StaticStations, toSnapshot } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSnapshot } from '../../src/api/data.ts';
import { StaticCache } from '../../src/api/states.ts';
import { attributionRows } from '../../src/attribution.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import type { RenderCtx } from '../../src/publish/cycle.ts';
import { classify } from '../../src/publish/plan.ts';
import { renderLatest } from '../../src/publish/render/latest.ts';
import { renderSnapshot } from '../../src/publish/render/snapshot.ts';
import { renderStations } from '../../src/publish/render/stations.ts';
import { type Harness, harness } from '../load/harness.ts';

// P18a criterion 4: no interpolation beyond the staleness limit, never in space, in the publisher's own output. Three
// tidal stations close together: A's newest value is older than its staleness limit at t, B has no data at all, C has
// a value 10 minutes before t. Every one has tide rows at t (written here, as the loader would store them), so a
// publisher that carried a value forward in time, or borrowed a neighbour's, would show a surge it must not. The
// renderers run against the real views as rws_publish: latest.json, the current bucket's recent file, a settled day's
// file (the same renderSnapshot, whose class `classify` names) and a bucket with no tide rows at all.

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-12-12T12:05:00Z');
const T = floorBucket(NOW); // 12:00, the current bucket: latest.json, and the current bucket's recent file
const T_SETTLED = Date.parse('2026-12-08T12:00:00Z');
const T_NO_TIDE = Date.parse('2026-12-07T12:00:00Z');
const WINDOW = { dataEpochMs: Date.parse('2026-11-30T00:00:00Z'), displayStartMs: Date.parse('2026-12-01T00:00:00Z') };
/** C's value 10 minutes before t, the astro at its own ts and at t (they differ), so the surge is 210 - 140, not 210 - 155. */
const VALUE = 210;
const ASTRO = { atTs: 140, atT: 155 };

let h: Harness;
let ids: { a: number; b: number; c: number };
let stations: { a: string; b: string; c: string };
const q = (text: string, args: unknown[] = []) => h.t.admin.query(text, args);
const at = (ms: number) => new Date(ms);

async function seed() {
  await q(`UPDATE app_meta SET value = '"2026-12-01T00:00:00Z"' WHERE key = 'display_start'`);
  await q(`SELECT ensure_partitions('2026-11-30'::timestamptz, '2026-12-14'::timestamptz)`);
  // The tidal NL-1 gauges nearest to Den Helder (Marsdiep): the first is A, the next two B and C.
  const { rows } = await q(
    `WITH tidal AS (
       SELECT s.id, s.station_id, st.lon, st.lat FROM series s
       JOIN series_eff e ON e.series_id = s.id JOIN station st ON st.id = s.station_id
       WHERE s.source_id = 'NL-1' AND s.active AND e.role = 'primary' AND e.audience = 'public' AND s.quantity = 'H'
         AND (st.flags->>'tidal')::boolean AND st.lon IS NOT NULL)
     SELECT n.id, n.station_id, (n.lon - a.lon)^2 + (n.lat - a.lat)^2 AS d2
     FROM tidal n, tidal a WHERE a.station_id = 'nl.rws.denhelder.marsdiep'
     ORDER BY d2, n.id LIMIT 3`,
  );
  expect(rows).toHaveLength(3);
  // Close together: within about 20 km of the anchor (0.2 degrees).
  for (const r of rows) expect(r.d2).toBeLessThan(0.04);
  ids = { a: rows[0].id, b: rows[1].id, c: rows[2].id };
  stations = { a: rows[0].station_id, b: rows[1].station_id, c: rows[2].station_id };
  await q(`UPDATE series SET staleness_limit = '1 hour' WHERE id = ANY($1)`, [[ids.a, ids.b, ids.c]]);

  const obs = (series: number, ts: number, value: number) =>
    q('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 0, 0)', [series, at(ts), value]);
  const tide = (series: number, kind: string, ts: number, value: number, hilo: string | null = null) =>
    q('INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id) VALUES ($1, $2, $3, $4, $5, 1)', [
      series,
      kind,
      at(ts),
      value,
      hilo,
    ]);
  // One pattern per bucket t. A: newest value 70 minutes old (past PT1H). B: none. C: 10 minutes old, within it.
  for (const t of [T, T_SETTLED]) {
    await obs(ids.a, t - 70 * MIN, 120);
    await obs(ids.c, t - 10 * MIN, VALUE);
    for (const series of [ids.a, ids.b, ids.c]) {
      await tide(series, 'astro', t - 70 * MIN, 130);
      await tide(series, 'astro', t - 10 * MIN, ASTRO.atTs);
      await tide(series, 'astro', t, ASTRO.atT);
    }
    // C's high and low waters: the astronomical ones either side of t, a measured one before and one after t.
    await tide(ids.c, 'extreme_astro', t - 3 * HOUR, 85, 'high');
    await tide(ids.c, 'extreme_astro', t + 3 * HOUR, -70, 'low');
    await tide(ids.c, 'extreme', t - 3.5 * HOUR, 90, 'high');
    await tide(ids.c, 'extreme', t + 2 * HOUR, -60, 'low');
  }
  // A bucket with a value and no tide row anywhere near it.
  await obs(ids.c, T_NO_TIDE - 10 * MIN, VALUE);
  // The loader keeps obs_latest; this seed writes obs directly, so it writes the newest points itself.
  await q(
    'INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 120, 0, 0), ($3, $4, $5, 0, 0)',
    [ids.a, at(T - 70 * MIN), ids.c, at(T - 10 * MIN), VALUE],
  );
}

async function ctx(): Promise<RenderCtx> {
  const db = h.dbAs('rws_publish');
  return {
    db: db.db,
    family: 'public',
    now: NOW,
    window: WINDOW,
    build: 'dev',
    sections: vigicruesSections(),
    cache: new StaticCache(60_000, () => NOW),
    inputs: undefined,
    attribution: await attributionRows(db.db, 'public'),
  };
}

let c: RenderCtx;
beforeAll(async () => {
  h = await harness();
  await seed();
  c = await ctx();
}, 120_000);
afterAll(() => h?.close());

describe('the publisher keeps tidal values in time and place', { timeout: 120_000 }, () => {
  it('the buckets are the classes the plan names: latest, a settled day', () => {
    expect(classify(T, NOW)).toBe('latest');
    expect(classify(T_SETTLED, NOW)).toBe('settled');
  });

  it('stations.json keeps tidal: true for A, B and C', async () => {
    const list = StaticStations.parse(await renderStations(c));
    for (const key of ['a', 'b', 'c'] as const) {
      const st = list.stations.find((s) => s.id === stations[key]);
      expect([key, st?.flags.tidal]).toEqual([key, true]);
      expect(st?.series.map((s) => s.id)).toContain(ids[key]);
    }
  });

  for (const [name, t] of [
    ['the current bucket (recent, and latest.json below)', T],
    ['a settled day', T_SETTLED],
  ] as const) {
    it(`${name}: C keeps its own ts and surges against the astro at it; A is not interpolated, B is not borrowed`, async () => {
      const file = SnapshotFile.parse(await renderSnapshot(c, t));
      expect(file.series).toEqual([ids.c]);
      const i = file.series.indexOf(ids.c);
      expect(file.value[i]).toBe(VALUE);
      expect(file.ageSeconds[i]).toBe(600);
      // The surge is value - astro at the value's own ts (210 - 140), not at t (210 - 155).
      expect(file.tide?.[i]).toEqual({
        astro: ASTRO.atTs,
        surge: VALUE - ASTRO.atTs,
        derived: 'surge',
        extremes: [
          { ts: at(t - 3.5 * HOUR).toISOString(), value: 90, hilo: 'high', kind: 'measured' },
          { ts: at(t - 3 * HOUR).toISOString(), value: 85, hilo: 'high', kind: 'astro' },
          { ts: at(t + 3 * HOUR).toISOString(), value: -70, hilo: 'low', kind: 'astro' },
        ],
      });
      expect(VALUE - ASTRO.atTs).not.toBe(VALUE - ASTRO.atT);
      // A (value past the staleness limit) and B (no data) have no value and so no tide, whatever rows they hold.
      expect(file.series).not.toContain(ids.a);
      expect(file.series).not.toContain(ids.b);
      expect(file.tide?.filter((x) => x !== null)).toHaveLength(1);
      // The file is the API's snapshot.
      const api = await readSnapshot(c.db, 'public', t, { now: NOW, sections: c.sections, cache: c.cache });
      expect(toSnapshot(file)).toEqual(api);
      expect(api.values.find((v) => v.series === ids.a)).toBeUndefined();
      expect(api.values.find((v) => v.series === ids.b)).toBeUndefined();
    });
  }

  it('latest.json: A is lapsed with the age of its newest value, B lapsed with none; C carries its own tide', async () => {
    const list = StaticStations.parse(await renderStations(c));
    const file = LatestFile.parse((await renderLatest(c, list)).body);
    expect(file.t).toBe(at(T).toISOString());
    expect(file.series).toContain(ids.c);
    expect(file.series).not.toContain(ids.a);
    expect(file.series).not.toContain(ids.b);
    expect(file.lapsed).toContain(ids.a);
    expect(file.lapsed).toContain(ids.b);
    expect(file.lapsedAge[file.lapsed.indexOf(ids.a)]).toBe(70 * 60);
    expect(file.lapsedAge[file.lapsed.indexOf(ids.b)]).toBeNull();
    const i = file.series.indexOf(ids.c);
    expect(file.ageSeconds[i]).toBe(600);
    expect(file.tide?.[i]).toMatchObject({ astro: ASTRO.atTs, surge: VALUE - ASTRO.atTs, derived: 'surge' });
    expect(file.tide?.filter((x) => x !== null)).toHaveLength(1);
  });

  it('a bucket with no tide rows at all has no tide key, and its snapshot items none', async () => {
    const file = SnapshotFile.parse(await renderSnapshot(c, T_NO_TIDE));
    expect(file.series).toEqual([ids.c]);
    expect(file).not.toHaveProperty('tide');
    expect(JSON.stringify(file)).not.toContain('"tide"');
    const api = await readSnapshot(c.db, 'public', T_NO_TIDE, { now: NOW, sections: c.sections, cache: c.cache });
    expect(toSnapshot(file)).toEqual(api);
    expect(api.values[0]).not.toHaveProperty('tide');
  });
});
