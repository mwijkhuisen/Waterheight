import {
  BUCKET_MS,
  CANARIES,
  CANARY_RENDERINGS,
  HealthSourcesAnswer,
  SnapshotAnswer,
  type Snapshot as SnapshotDoc,
} from '@rws/contracts';
import { attachArea, CLASS_WINDOW_MIN, classify, classSeries, pointIn, type RefIn, type SeriesIn } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildP7aFixtureArchive, P7A_FIXTURES } from '../../../../scripts/fixture-archive.ts';
import { classCoverage, readStates, snapshotValues } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { VIEWS } from '../../src/db/audience.ts';
import type { Db } from '../../src/db/pool.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import { type Harness, harness, KAUB_W } from '../load/harness.ts';

// The P7b classification through the real database roles: seeded rows (as the superuser, into the base tables) on real
// registry series are classified by /snapshot as `rws_api`, by readStates as `rws_api` (public family) and as
// `rws_owner_api` (owner family), and independently by this file's own reading of the base tables plus classify().
// The LU-5 flood path loads the recorded CAP files through the loader.

const NOW = new Date('2026-10-26T12:00:00Z');
const PAST = new Date('2026-10-20T12:00:00Z');
const T_NOW = NOW.getTime();
const T_PAST = PAST.getTime();
const MY_OBS = { cur: '2026-10-26T11:50:00Z', past: '2026-10-20T11:50:00Z' };
const LU4_VALUES = ['313.7', '417.9', '351.3'];
const FORBIDDEN = ['LU-4', 'BE-3', 'AGE ', 'SPW', ...LU4_VALUES, ...CANARY_RENDERINGS];

/**
 * P8a: the public forecast coverage names agencies, not sources: the one that would provide a reach's forecast after a
 * permission and the one that publishes none (catalogue §0.5: "SPW for the Walloon Meuse"; review C12). Those two lists
 * leave the sweep; everything else of the health document stays checked (apps/server/test/api/forecast.int.test.ts holds
 * the coverage block to no owner source id).
 */
const withoutAgencies = (text: string): string => {
  const doc = JSON.parse(text) as { forecast_coverage?: { reaches?: Record<string, unknown>[] } | null };
  for (const r of doc.forecast_coverage?.reaches ?? []) {
    delete r.after_permission;
    delete r.none_publishes;
  }
  return JSON.stringify(doc);
};

let h: Harness;
let app: ReturnType<typeof createApp>;
const id: Record<string, number> = {};
const station: Record<string, string> = {};
/** The FR-5 section seeded at vigilance 2 (a real code of registry/vigicrues-sections.yaml). */
let frSection = '';

type Row = Record<string, unknown>;
const q = async <R extends pg.QueryResultRow = Row>(text: string, args: unknown[] = []): Promise<R[]> =>
  (await h.t.admin.query<R>(text, args)).rows;

/** The first series of the query (`id`, `station_id`). */
async function pick(what: string, where: string): Promise<{ id: number; station: string }> {
  const rows = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     JOIN station st ON st.id = e.station_id WHERE ${where} ORDER BY e.series_id LIMIT 1`,
  );
  const r = rows[0];
  if (r === undefined) throw new Error(`no series for ${what}`);
  return { id: r.id, station: r.station_id };
}

type RefSpec = {
  period?: string;
  conv?: 'exceedance' | 'non_exceedance';
  priority?: number;
  label?: string;
};
const ref = (series: number, source: string, kind: string, value: number, semantics: string, o: RefSpec = {}) =>
  h.t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, percentile_convention, period,
                                  priority, basis_label, valid)
     VALUES ($1, $2, $3, $4, 'cm', $5, $6, $7::daterange, $8, $9, tstzrange('2020-01-01', NULL))`,
    [series, source, kind, value, semantics, o.conv ?? null, o.period ?? null, o.priority ?? 0, o.label ?? null],
  );
const obs = (series: number, ts: string, value: number) =>
  h.t.admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 1, 1)', [
    series,
    ts,
    value,
  ]);
const fetched = (source: string, at: Date) =>
  h.t.admin.query(
    `INSERT INTO source_health (source_id, status, last_fetch_ok) VALUES ($1, 'ok', $2)
     ON CONFLICT (source_id) DO UPDATE SET last_fetch_ok = EXCLUDED.last_fetch_ok`,
    [source, at],
  );

let apiDb: Db['db'];
let ownerDb: Db['db'];
const owner = () => ownerDb;
const apiRead = () => apiDb;
const opts = (_t: number, current: boolean) => ({ now: T_NOW, current, sections: vigicruesSections() });

/** The independent reading: base tables as the superuser, the pure classifier, no use of states.ts. */
async function oracle(family: 'public' | 'owner', t: number, current: boolean, ids: number[]) {
  const at = new Date(t).toISOString();
  const audiences = family === 'public' ? ['public'] : ['public', 'owner'];
  const series = await q<{
    id: number;
    station_id: string;
    source_id: string;
    quantity: 'H' | 'Q';
    value_kind: 'stage' | 'level' | null;
    stale_ms: string;
    flags: Record<string, unknown> | null;
  }>(
    `SELECT s.id, s.station_id, s.source_id, s.quantity, s.value_kind, EXTRACT(EPOCH FROM s.staleness_limit) * 1000 AS stale_ms,
            st.flags
     FROM series s JOIN station st ON st.id = s.station_id JOIN series_eff e ON e.series_id = s.id
     WHERE s.id = ANY($1) AND s.active AND e.role = 'primary' AND e.audience::text = ANY($2)`,
    [ids, audiences],
  );
  const stationIds = [...new Set(series.map((s) => s.station_id))];
  const siblings = await q<{ id: number; station_id: string; quantity: 'H' | 'Q' }>(
    `SELECT s.id, s.station_id, s.quantity FROM series s JOIN series_eff e ON e.series_id = s.id
     WHERE s.station_id = ANY($1) AND s.active AND e.role = 'primary' AND e.audience::text = ANY($2) ORDER BY s.id`,
    [stationIds, audiences],
  );
  const lastObs = await q<{ series_id: number; ts: Date; value: number; qc: number }>(
    `SELECT DISTINCT ON (series_id) series_id, ts, value, qc FROM obs WHERE series_id = ANY($1) AND ts <= $2
     ORDER BY series_id, ts DESC`,
    [ids, at],
  );
  const refs = await q<{
    series_id: number;
    source_id: string;
    kind: string;
    value: number;
    unit: string;
    percentile_convention: 'exceedance' | 'non_exceedance' | null;
    p_from: string | null;
    p_to: string | null;
    season_from_md: number;
    season_to_md: number;
    priority: number;
    basis_label: string | null;
  }>(
    `SELECT series_id, source_id, kind, value, unit, percentile_convention,
            to_char(lower(period), 'YYYY-MM-DD') AS p_from, to_char(upper(period) - 1, 'YYYY-MM-DD') AS p_to,
            season_from_md, season_to_md, priority, basis_label
     FROM reference_value WHERE series_id = ANY($1) AND valid @> $2::timestamptz`,
    [ids, at],
  );
  const classes = await q<{ subject_id: string; source_id: string; provider_code: string }>(
    `SELECT DISTINCT ON (subject_id, source_id) subject_id, source_id, provider_code FROM class_obs
     WHERE subject_type = 'station' AND subject_id = ANY($1) AND ts <= $2::timestamptz AND provider_code IS NOT NULL
     ORDER BY subject_id, source_id, ts DESC`,
    [stationIds, at],
  );
  const health = new Map(
    (
      await q<{ source_id: string; last_fetch_ok: Date | null }>('SELECT source_id, last_fetch_ok FROM source_health')
    ).map((r) => [r.source_id, r.last_fetch_ok?.getTime() ?? null]),
  );
  const fresh = (source: string) => {
    if (!current) return true;
    const ok = health.get(source) ?? null;
    return ok !== null && T_NOW - ok <= (CLASS_WINDOW_MIN[source] ?? 45) * 60_000;
  };
  const warnings = await q<{
    source_id: string;
    area_key: string;
    name: string | null;
    level_raw: string | null;
    g: string | null;
  }>(
    `SELECT source_id, area_key, name, level_raw, geometry_geojson AS g FROM warning_area WHERE valid @> $1::timestamptz`,
    [at],
  );
  const stations = await q<{ id: string; lon: number | null; lat: number | null }>('SELECT id, lon, lat FROM station');
  const sections = vigicruesSections();

  const out = new Map<number, ReturnType<typeof classify>>();
  for (const s of series) {
    const o = lastObs.find((x) => x.series_id === s.id);
    const mine: RefIn[] = refs
      .filter((r) => r.series_id === s.id)
      .map((r) => ({
        source: r.source_id,
        kind: r.kind,
        value: r.value,
        unit: r.unit,
        convention: r.percentile_convention,
        period: r.p_from === null ? null : [r.p_from, r.p_to],
        seasonFrom: r.season_from_md,
        seasonTo: r.season_to_md,
        priority: r.priority,
        label: r.basis_label,
      }));
    const cls = classes
      .filter((c) => c.subject_id === s.station_id)
      .filter(
        (c) =>
          classSeries(
            c.source_id,
            siblings.filter((x) => x.station_id === c.subject_id),
          )?.id === s.id,
      )
      .map((c) => ({ source: c.source_id, code: c.provider_code, fresh: fresh(c.source_id) }));
    const areas = warnings.flatMap((w) =>
      attachArea(
        { source: w.source_id, key: w.area_key, geometry: w.g === null ? null : JSON.parse(w.g) },
        stations,
        sections,
      ).includes(s.station_id)
        ? [{ source: w.source_id, key: w.area_key, name: w.name, levelRaw: w.level_raw, fresh: fresh(w.source_id) }]
        : [],
    );
    const input: SeriesIn = {
      quantity: s.quantity,
      valueKind: s.value_kind,
      value: o?.value ?? null,
      qc: o?.qc ?? 0,
      ageMs: o === undefined ? 0 : t - o.ts.getTime(),
      stalenessMs: Number(s.stale_ms),
      t,
      refs: mine,
      classes: cls,
      areas,
      tidal: s.flags?.tidal === true,
      impounded: s.flags?.impounded === true,
    };
    out.set(s.id, classify(input, family));
  }
  return out;
}

const get = async (path: string) => {
  const res = await app.request(path);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as unknown };
};
const snapshotAt = async (t: Date) => {
  const res = await get(`/api/v1/snapshot?t=${t.toISOString()}`);
  expect(res.status).toBe(200);
  const { attribution, ...snap } = SnapshotAnswer.parse(res.json);
  // P9b: the attribution names exactly the sources the body names: its series' sources and the sources of its bases.
  const owners = await q<{ id: number; source_id: string }>(
    `SELECT id, source_id FROM series WHERE id = ANY($1::int[])`,
    [snap.values.map((v) => v.series)],
  );
  const named = new Set(owners.map((r) => r.source_id));
  for (const v of snap.values) for (const b of [v.basis, v.area?.basis]) if (b) named.add(b.source);
  expect(new Set(attribution.map((a) => a.source))).toEqual(named);
  return { text: res.text, snap };
};
const valueIn = (snap: SnapshotDoc, series: number) => snap.values.find((v) => v.series === series);

beforeAll(async () => {
  h = await harness();
  const a = h.t.admin;
  await a.query(`SELECT ensure_partitions('2025-09-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  await a.query(`UPDATE app_meta SET value = to_jsonb('2026-10-01T00:00:00Z'::text) WHERE key = 'display_start'`);

  // Real registry series.
  const kaub = await pick('Kaub W', `s.provider_key = '${KAUB_W}'`);
  id.kaub = kaub.id;
  station.kaub = kaub.station;
  const chq = await pick(
    'CH-1 Q',
    `e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'Q' AND s.active`,
  );
  id.chq = chq.id;
  station.chq = chq.station;
  const area = await pick(
    'CH-1 H only',
    `e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.active
     AND e.station_id ~ '^ch\\.bafu\\.[0-9]+$' AND NOT EXISTS
       (SELECT 1 FROM series x WHERE x.station_id = e.station_id AND x.quantity = 'Q' AND x.active)`,
  );
  id.area = area.id;
  station.area = area.station;
  const nl = await pick(
    'NL-1 H',
    `e.source_id = 'NL-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.active
     AND COALESCE((st.flags->>'tidal')::boolean, false) = false
     AND NOT EXISTS (SELECT 1 FROM reference_value r WHERE r.series_id = e.series_id)`,
  );
  id.nl = nl.id;
  station.nl = nl.station;
  const fr = await pick(
    'FR-1 stage',
    `e.source_id = 'FR-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.value_kind = 'stage' AND s.active`,
  );
  id.fr = fr.id;
  const diekirch = await pick('Diekirch', `s.provider_key = 'Diekirch' AND e.source_id = 'LU-1'`);
  id.diekirch = diekirch.id;
  station.diekirch = diekirch.station;
  const be = await pick(
    'BE-3 stage',
    `e.source_id = 'BE-3' AND e.audience = 'owner' AND e.role = 'primary' AND s.quantity = 'H' AND s.value_kind = 'stage'
     AND s.active AND COALESCE((st.flags->>'impounded')::boolean, false) = false`,
  );
  id.be = be.id;
  station.be = be.station;

  // The two canaries on stations of their own.
  await a.query(`INSERT INTO station (id, name, country, tier) VALUES
    ('nl.canary.owner', 'owner canary', 'NL', 2), ('nl.canary.withheld', 'withheld canary', 'NL', 2)`);
  for (const [key, st, source, audience, provider] of [
    ['canaryOwner', 'nl.canary.owner', 'CANARY-OWNER', null, 'canary-owner'],
    ['canaryWithheld', 'nl.canary.withheld', 'NL-1', 'off', 'canary-withheld'],
  ] as const) {
    const r = await q<{ id: number }>(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, audience)
       VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary', $4::audience)
       RETURNING id`,
      [st, source, provider, audience],
    );
    id[key] = (r[0] as { id: number }).id;
  }

  // References, classes, an area and zeros.
  await ref(id.kaub as number, 'DE-1', 'MNW', 65, 'statistical', { period: '[2010-11-01,2020-11-01)' });
  await ref(id.kaub as number, 'DE-1', 'MHW', 544, 'statistical', { period: '[2010-11-01,2020-11-01)' });
  await ref(id.kaub as number, 'DE-1', 'HSW', 640, 'operational', { period: '[2010-11-01,2020-11-01)' });
  await a.query(
    `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, level_norm) VALUES
       ('station', $1, '2026-10-01T00:00:00Z', 'DE-6', 'RP:0', 2),
       ('station', $2, '2026-10-01T00:00:00Z', 'CH-1', '3', 4)`,
    [station.kaub, station.chq],
  );
  // An NL-4 band [200, 300) named "Hoogwater".
  await ref(id.nl as number, 'NL-4', 'NL4_FROM', 200, 'provider_class', { label: 'Hoogwater (>200cm)', priority: 1 });
  await ref(id.nl as number, 'NL-4', 'NL4_TO', 300, 'provider_class', { label: 'Hoogwater (>200cm)', priority: 1 });
  const riverNumber = String(station.area).slice('ch.bafu.'.length);
  await a.query(
    `INSERT INTO warning_area (source_id, area_key, name, level_norm, level_raw, valid)
     VALUES ('CH-5', $1, 'Test section', 3, '2', tstzrange('2026-10-01T00:00:00Z', NULL))`,
    [`river:${riverNumber}`],
  );
  // Review CR-7: an FR-5 vigilance (level 2) on a real section of registry/vigicrues-sections.yaml, no geometry; a
  // public FR-1 stage station of that section and one of another section, each with a value below.
  const sections = vigicruesSections();
  const frRows = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     WHERE e.source_id = 'FR-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H'
       AND s.value_kind = 'stage' AND s.active AND e.series_id <> $1 AND e.station_id = ANY($2)
     ORDER BY e.series_id`,
    [id.fr, [...sections.keys()]],
  );
  const frIn = frRows[0];
  if (frIn === undefined) throw new Error('no FR-1 stage station in a Vigicrues section');
  frSection = sections.get(frIn.station_id) as string;
  const frOther = frRows.find((r) => sections.get(r.station_id) !== frSection);
  if (frOther === undefined) throw new Error('no FR-1 stage station in a second Vigicrues section');
  id.frIn = frIn.id;
  id.frOther = frOther.id;
  await a.query(
    `INSERT INTO warning_area (source_id, area_key, name, level_norm, level_raw, valid)
     VALUES ('FR-5', $1, 'Test vigilance', 3, '2', tstzrange('2026-10-01T00:00:00Z', NULL))`,
    [frSection],
  );
  await a.query(
    `INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id) VALUES
       ($1, 78.0, 'NHN', tstzrange('2020-01-01', NULL), 1), ($2, 101.5, 'IGN69', tstzrange('2020-01-01', NULL), 1)`,
    [id.kaub, id.fr],
  );
  // Synthetic LU-4 references on Diekirch, a synthetic BE-3 P05 (both owner audience).
  await ref(id.diekirch as number, 'LU-4', 'LU4_ORANGE', 313.7, 'operational', { label: 'AGE' });
  await ref(id.diekirch as number, 'LU-4', 'LU4_RED', 417.9, 'operational', { label: 'AGE' });
  await ref(id.diekirch as number, 'LU-4', 'HQ2', 351.3, 'statistical', { label: 'AGE' });
  await ref(id.be as number, 'BE-3', 'P05', 30, 'statistical', { conv: 'non_exceedance' });

  // Observations at the current bucket and at a past one.
  const values: [string, number, number][] = [
    ['kaub', 9, 600],
    ['chq', 500, 500],
    ['area', 100, 100],
    ['nl', 100, 250],
    ['fr', 150, 150],
    ['frIn', 120, 120],
    ['frOther', 130, 130],
    ['diekirch', 200, 330],
    ['be', 20, 50],
    ['canaryOwner', CANARIES.owner.value, CANARIES.owner.value],
    ['canaryWithheld', CANARIES.withheld.value, CANARIES.withheld.value],
  ];
  for (const [key, past, cur] of values) {
    await obs(id[key] as number, MY_OBS.past, past);
    await obs(id[key] as number, MY_OBS.cur, cur);
  }
  const fresh5 = new Date(T_NOW - 5 * 60_000);
  for (const source of ['DE-1', 'DE-6', 'CH-1', 'CH-5', 'LU-5', 'LU-4', 'BE-3', 'NL-1', 'FR-1', 'FR-5', 'LU-1']) {
    await fetched(source, fresh5);
  }

  // The LU-5 CAP files only (the P7a fixtures of the other sources are skipped: their rows would be on the series
  // seeded above).
  const lines = await buildP7aFixtureArchive(h.raw, new Set(P7A_FIXTURES.map((f) => f.name)));
  expect(lines.length).toBeGreaterThan(20);
  expect((await h.loader({ now: new Date('2026-10-03T12:00:00Z') }).tick()).loaded).toBe(lines.length);

  const api = h.dbAs('rws_api', 4);
  apiDb = api.db;
  ownerDb = h.dbAs('rws_owner_api', 2).db;
  const window = new DisplayWindow(api.db);
  expect(await window.refresh()).toBe(true);
  app = createApp({ db: api.db, window, now: () => NOW });
}, 180_000);

afterAll(() => h.close());

const mine = () => ['kaub', 'chq', 'area', 'nl', 'fr', 'frIn', 'frOther', 'diekirch'].map((k) => id[k] as number);
const ownerOnly = () => ['be', 'canaryOwner', 'canaryWithheld'].map((k) => id[k] as number);

describe('snapshot against SQL and the classifier', { timeout: 60_000 }, () => {
  for (const [label, at, current] of [
    ['the current bucket', NOW, true],
    ['a past instant', PAST, false],
  ] as const) {
    it(`/snapshot at ${label} equals the independent reading, value by value`, async () => {
      const { snap } = await snapshotAt(at);
      const want = await oracle('public', at.getTime(), current, mine());
      expect(want.size).toBe(mine().length);
      for (const [series, c] of want) {
        const v = valueIn(snap, series);
        expect(v, `series ${series}`).toBeDefined();
        expect({ state: v?.state, basis: v?.basis, section: v?.section, area: v?.area ?? null }).toEqual({
          state: c.state,
          basis: c.basis,
          section: c.section,
          area: c.area,
        });
      }
      for (const series of ownerOnly()) expect(valueIn(snap, series)).toBeUndefined();
    });
  }

  it('states the expected levels: Kaub 9 cm is low on MNW; the others as seeded', async () => {
    const past = (await snapshotAt(PAST)).snap;
    const kaub = valueIn(past, id.kaub as number);
    expect(kaub).toMatchObject({ state: 'low', section: false });
    expect(kaub?.basis).toMatchObject({ source: 'DE-1', measure: 'stage', label: 'WSV MNW 2010–2020' });
    expect(valueIn(past, id.nl as number)).toMatchObject({ state: 'no_ref', basis: null });

    const cur = (await snapshotAt(NOW)).snap;
    const k = valueIn(cur, id.kaub as number);
    expect(k).toMatchObject({ state: 'normal' });
    expect(k?.basis).toMatchObject({ source: 'DE-6', label: 'LHP RP:0' });
    expect(valueIn(cur, id.chq as number)).toMatchObject({ state: 'high' });
    expect(valueIn(cur, id.chq as number)?.basis).toMatchObject({ source: 'CH-1', measure: 'discharge' });
    expect(valueIn(cur, id.nl as number)).toMatchObject({ state: 'high' });
    expect(valueIn(cur, id.nl as number)?.basis).toMatchObject({ source: 'NL-4', kind: 'provider_class' });
    const sec = valueIn(cur, id.area as number);
    expect(sec).toMatchObject({ state: 'elevated', section: true });
    expect(sec?.basis).toMatchObject({ source: 'CH-5', kind: 'area' });
    expect(valueIn(cur, id.diekirch as number)).toMatchObject({ state: 'no_ref', basis: null });
  });

  it('FR-5 through the section table: a station of the section takes its vigilance, one of another does not', async () => {
    for (const at of [NOW, PAST]) {
      const { snap } = await snapshotAt(at);
      const inside = valueIn(snap, id.frIn as number);
      expect(inside, at.toISOString()).toMatchObject({ state: 'elevated', section: true });
      expect(inside?.basis).toEqual({
        source: 'FR-5',
        kind: 'area',
        measure: 'area',
        ref: frSection,
        label: 'Vigicrues Test vigilance',
      });
      expect(inside?.area).toBeUndefined();
      const other = valueIn(snap, id.frOther as number);
      expect(other, at.toISOString()).toMatchObject({ state: 'no_ref', basis: null, section: false });
      expect(other?.area).toBeUndefined();
    }
  });

  it('gauge zeros: a DE-1 stage under NHN gets nap; an FR-1 stage under IGN69 gets zero and never nap', async () => {
    for (const at of [NOW, PAST]) {
      const { snap } = await snapshotAt(at);
      const kaub = valueIn(snap, id.kaub as number);
      expect(kaub?.zero).toBeUndefined();
      const value = kaub?.value ?? 0;
      expect(Math.abs((kaub?.nap?.m ?? 0) - (78 + value / 100))).toBeLessThan(0.1);
      const fr = valueIn(snap, id.fr as number);
      expect(fr?.nap).toBeUndefined();
      expect(fr?.zero).toEqual({ m: 101.5, datum: 'IGN69' });
    }
  });
});

describe('freshness of a class in the current bucket', { timeout: 60_000 }, () => {
  it('a class whose source was last fetched longer ago than its window is not used; at a past t it is', async () => {
    const api = apiRead();
    const kaub = async (current: boolean) =>
      (await readStates(api, 'public', T_NOW, opts(T_NOW, current))).series.find((s) => s.series === id.kaub)
        ?.classified;
    const fresh = await kaub(true);
    expect(fresh).toMatchObject({ state: 'normal', basis: { source: 'DE-6' } });
    try {
      await fetched('DE-6', new Date(T_NOW - (CLASS_WINDOW_MIN['DE-6'] as number) * 60_000 - 60_000));
      const stale = await kaub(true);
      expect(stale).toMatchObject({ state: 'elevated', basis: { source: 'DE-1', label: 'WSV MHW 2010–2020' } });
      // The same instant judged as a past one: the stored class is the record.
      expect(await kaub(false)).toMatchObject({ state: 'normal', basis: { source: 'DE-6' } });
      // And a past t through the route is unaffected by today's health.
      const past = valueIn((await snapshotAt(PAST)).snap, id.kaub as number);
      expect(past?.state).toBe('low');
    } finally {
      await fetched('DE-6', new Date(T_NOW - 5 * 60_000));
    }
    expect(await kaub(true)).toMatchObject({ state: 'normal' });
  });
});

describe('per audience (invariant 11)', { timeout: 60_000 }, () => {
  it('LU-4 classes Diekirch in the owner read only', async () => {
    const o = await readStates(owner(), 'owner', T_NOW, opts(T_NOW, true));
    const d = o.series.find((s) => s.series === id.diekirch)?.classified;
    expect(d?.state).toBe('high');
    expect(d?.basis).toMatchObject({ source: 'LU-4', kind: 'operational' });
    expect(d?.basis?.label.startsWith('AGE')).toBe(true);
    const want = await oracle('owner', T_NOW, true, [...mine(), ...ownerOnly()]);
    for (const s of o.series.filter((x) => want.has(x.series))) {
      expect(s.classified, `series ${s.series}`).toEqual(want.get(s.series));
    }

    const pub = await readStates(apiRead(), 'public', T_NOW, opts(T_NOW, true));
    const p = pub.series.find((s) => s.series === id.diekirch)?.classified;
    expect(p).toMatchObject({ state: 'no_ref', basis: null });
  });

  it('no public output holds LU-4, BE-3, AGE, SPW, the LU-4 values or a canary', async () => {
    const api = apiRead();
    const read = await readStates(api, 'public', T_NOW, opts(T_NOW, true));
    const body = JSON.stringify(read);
    const texts = [
      body,
      JSON.stringify(snapshotValues(read)),
      (await snapshotAt(NOW)).text,
      (await snapshotAt(PAST)).text,
      withoutAgencies((await get('/api/v1/health/sources')).text),
    ];
    for (const text of texts) for (const f of FORBIDDEN) expect(text.includes(f), f).toBe(false);
    for (const key of ownerOnly()) expect(read.series.find((s) => s.series === key)).toBeUndefined();
    expect(new Set(read.publicSeries).has(id.diekirch as number)).toBe(true);
    // The canary and the BE-3 series are in the owner read.
    const o = await readStates(owner(), 'owner', T_NOW, opts(T_NOW, true));
    expect(JSON.stringify(o)).toContain(CANARIES.owner.real);
    expect(o.series.find((s) => s.series === id.canaryWithheld)).toBeUndefined();
  });

  it('a BE-3 stage with a P05 exists only in the owner run: low at or below P05, normal above', async () => {
    const be = id.be as number;
    const cur = await readStates(owner(), 'owner', T_NOW, opts(T_NOW, true));
    const past = await readStates(owner(), 'owner', T_PAST, opts(T_PAST, false));
    expect(cur.series.find((s) => s.series === be)?.classified).toMatchObject({
      state: 'normal',
      basis: { source: 'BE-3' },
    });
    expect(past.series.find((s) => s.series === be)?.classified).toMatchObject({ state: 'low' });
    // At the bound: low.
    await obs(be, '2026-10-21T11:50:00Z', 30);
    const at = new Date('2026-10-21T12:00:00Z').getTime();
    const bound = await readStates(owner(), 'owner', at, opts(at, false));
    expect(bound.series.find((s) => s.series === be)?.classified.state).toBe('low');

    const pub = await readStates(apiRead(), 'public', T_NOW, opts(T_NOW, true));
    expect(pub.series.some((s) => s.series === be)).toBe(false);
    for (const at of [NOW, PAST]) expect(valueIn((await snapshotAt(at)).snap, be)).toBeUndefined();
  });

  it('the family and the role must match: no grant, no read', async () => {
    await expect(readStates(owner(), 'public', T_NOW, opts(T_NOW, true))).rejects.toMatchObject({ code: '42501' });
    await expect(readStates(apiRead(), 'owner', T_NOW, opts(T_NOW, true))).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('coverage per audience', { timeout: 60_000 }, () => {
  const tier1 = async (view: string) =>
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${view} WHERE tier = 1`))[0]?.n as number;

  it('the public report counts public tier-1 stations only; the owner report adds the owner ones', async () => {
    const pub = classCoverage(await readStates(apiRead(), 'public', T_NOW, opts(T_NOW, true)));
    const own = classCoverage(await readStates(owner(), 'owner', T_NOW, opts(T_NOW, true)));
    const publicTier1 = await tier1(VIEWS.public.station);
    const ownerTier1 = await tier1(VIEWS.owner.station);
    expect(pub.tier1.stations).toBe(publicTier1);
    expect(own.tier1.stations).toBe(ownerTier1);
    expect(ownerTier1).toBeGreaterThan(publicTier1);
    const extra = await q<{ id: string }>(
      `SELECT o.id FROM ${VIEWS.owner.station} o WHERE o.tier = 1 AND NOT EXISTS
         (SELECT 1 FROM ${VIEWS.public.station} p WHERE p.id = o.id)`,
    );
    expect(extra.length).toBe(ownerTier1 - publicTier1);
    for (const e of extra) expect(e.id.startsWith('be.spw.')).toBe(true);
    // Owner stations are never first release.
    expect(own.first_release.stations).toBe(publicTier1);
    expect(pub.first_release.stations).toBe(publicTier1);
    expect(pub.countries.reduce((n, c) => n + c.tier1.stations, 0)).toBe(publicTier1);
  });

  it('/health/sources carries the public report and no owner count', async () => {
    const res = await get('/api/v1/health/sources');
    expect(res.status).toBe(200);
    const { attribution, ...doc } = HealthSourcesAnswer.parse(res.json);
    expect(new Set(attribution.map((a) => a.source))).toEqual(
      new Set([...doc.sources.map((s) => s.id), ...doc.quarantined_batches.map((x) => x.source)]),
    );
    const t = Math.floor(T_NOW / BUCKET_MS) * BUCKET_MS;
    const want = classCoverage(await readStates(apiRead(), 'public', t, opts(t, true)));
    expect(doc.classification).toEqual(JSON.parse(JSON.stringify(want)));
    expect(doc.classification?.tier1.stations).toBe(await tier1(VIEWS.public.station));
    for (const c of doc.classification?.countries ?? [])
      expect(c.tier1.stations).toBeLessThanOrEqual(want.tier1.stations);
  });
});

describe('the LU-5 flood path of September 2025', { timeout: 120_000 }, () => {
  let station5: { id: string; series: number };
  let cancel: number;

  beforeAll(async () => {
    const sud = await q<{ g: string }>(
      `SELECT geometry_geojson AS g FROM warning_area
       WHERE source_id = 'LU-5' AND area_key = 'Sud du Luxembourg' AND level_raw = 'ALERT_LVL_1' AND geometry_geojson IS NOT NULL
       ORDER BY lower(valid) LIMIT 1`,
    );
    const geometry: unknown = JSON.parse((sud[0] as { g: string }).g);
    const stations = await q<{ id: string; lon: number; lat: number; series: number }>(
      `SELECT st.id, st.lon, st.lat, e.series_id AS series FROM station st JOIN series_eff e ON e.station_id = st.id
       WHERE st.id LIKE 'lu.age.%' AND st.id <> $1 AND e.source_id = 'LU-1' AND e.audience = 'public' AND e.role = 'primary'
         AND st.lon IS NOT NULL ORDER BY st.id`,
      [station.diekirch],
    );
    const inside = stations.find((s) => pointIn(s.lon, s.lat, geometry));
    expect(inside, 'an LU-1 station inside the Sud polygon').toBeDefined();
    station5 = { id: (inside as { id: string }).id, series: (inside as { series: number }).series };
    const last = await q<{ hi: Date }>(
      `SELECT max(upper(valid)) AS hi FROM warning_area WHERE source_id = 'LU-5' AND area_key = 'Sud du Luxembourg'
       AND lower(valid) < '2025-09-10'`,
    );
    cancel = (last[0] as { hi: Date }).hi.getTime();
    for (const [ts, v] of [
      ['2025-09-08T21:50:00Z', 80],
      ['2025-09-09T20:50:00Z', 80],
      [new Date(cancel + 30 * 60_000).toISOString(), 80],
      ['2026-02-02T11:50:00Z', 80],
    ] as const)
      await obs(station5.series, ts, v);
  });

  const stateAt = async (iso: string) => {
    const t = new Date(iso).getTime();
    const read = await readStates(apiRead(), 'public', t, opts(t, false));
    return read.series.find((s) => s.series === station5.series)?.classified;
  };

  it('a red alert on Sud classes a station inside it as extreme, a section state', async () => {
    const c = await stateAt('2025-09-08T22:00:00Z');
    expect(c).toMatchObject({ state: 'extreme', section: true });
    expect(c?.basis).toMatchObject({ source: 'LU-5', kind: 'area' });
  });

  it('the alert is gone after its Cancel; the 2026-02-02 TEST message left nothing', async () => {
    expect(cancel).toBeGreaterThan(new Date('2025-09-09T00:00:00Z').getTime());
    // Just before the end the zone still holds a level (normal: the last row is a lowered level), after it none.
    expect((await stateAt('2025-09-09T21:00:00Z'))?.section).toBe(true);
    const after = await stateAt(new Date(cancel + 3_600_000).toISOString());
    expect(after).toMatchObject({ state: 'no_ref', section: false, basis: null, area: null });
    expect(
      await q("SELECT 1 FROM warning_area WHERE source_id = 'LU-5' AND valid && tstzrange('2026-02-02', '2026-02-03')"),
    ).toEqual([]);
    expect(await stateAt('2026-02-02T12:00:00Z')).toMatchObject({ state: 'no_ref', section: false });
  });
});
