import { areaLevel, attachArea, type ClassRow, classify, LEVEL_NORM, pointIn, type SeriesIn } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { normaliseAlerts, normaliseStations } from '../../src/adapters/de-6/normalise.ts';
import { parseAlerts, parseStations } from '../../src/adapters/de-6/parse.ts';
import { normaliseVigilance } from '../../src/adapters/fr-5/normalise.ts';
import { parseVigilance } from '../../src/adapters/fr-5/parse.ts';
import { normalise as normaliseCap } from '../../src/adapters/lu-5/normalise.ts';
import { parseCap } from '../../src/adapters/lu-5/parse.ts';
import { rawFixture } from '../adapters/registry.ts';
import { areaOf, classified, fetchedAt, frCase, lu1, lu1Case, rowsOf, vigilance } from './inputs.ts';

// The catalogue §0.4 flood fixtures reach the §4.9 levels through the classifier (PHASES P7b): the LHP test server
// of the 2024-01-25 flood, the hand-edited and classless synthetic stations, the LHP alerts, the Wayback and the
// current spelling of the Vigicrues map, and the real AGE red alert of 2025-09-08. Classes and areas are what the
// real adapters normalise from the committed fixtures; the series they are put on carry no reference (a gauge class
// alone), and `fresh` is true (the test is about the mapping, not about capture health).

const NOW = Date.parse('2026-10-03T12:00:00Z');
const series = (over: Partial<SeriesIn> = {}): SeriesIn => ({
  quantity: 'H',
  valueKind: 'stage',
  value: 100,
  qc: 0,
  ageMs: 0,
  stalenessMs: 45 * 60_000,
  t: NOW,
  refs: [],
  classes: [],
  areas: [],
  tidal: false,
  impounded: false,
  ...over,
});
const withClass = (c: ClassRow) =>
  classify(series({ classes: [{ source: 'DE-6', code: c.code, fresh: true }] }), 'public');
const withArea = (source: string, levelRaw: string | null) =>
  classify(series({ areas: [{ source, key: 'k', name: 'n', levelRaw, fresh: true }] }), 'public');

/** Every feature its own station (the table of the DE-6 tests): the classes of a whole payload. */
function lhp(name: string): ClassRow[] {
  const doc = parseStations(rawFixture('DE-6', name).body);
  const table = {
    stations: doc.features.map((f) => ({
      lhp: f.id,
      station: `de.test.${f.id}`,
      state: f.id.slice(0, 2),
      operator: true,
    })),
  };
  return normaliseStations(doc, table, fetchedAt('DE-6', name)).classes ?? [];
}
const firstWith = (rows: ClassRow[], suffix: string) => {
  const r = rows.find((c) => c.code.endsWith(`:${suffix}`));
  if (r === undefined) throw new Error(`no class ${suffix}`);
  return r;
};
const alerts = (name: string) => normaliseAlerts(parseAlerts(rawFixture('DE-6', name).body), fetchedAt('DE-6', name));

describe('LHP station classes (gauge classes on an H series, no references)', () => {
  const test = lhp('de-6-stations-test');

  it.each([
    ['1', 'elevated'],
    ['2', 'high'],
    ['3', 'extreme'],
  ] as const)('the test server class %s is %s', (cls, state) => {
    const row = firstWith(test, cls);
    const out = withClass(row);
    expect(out).toMatchObject({
      state,
      section: false,
      basis: { source: 'DE-6', kind: 'operational', measure: 'stage' },
    });
    expect(out.basis?.ref).toBe(row.code);
    // the stored level and the classifier's state are the same level
    expect(row.level).toBe(LEVEL_NORM[state]);
  });

  it('the whole test payload: classes 1, 2, 3 are 3, 4, 5 and class 0 is "not elevated" (normal)', () => {
    const states = new Map<string, Set<string>>();
    for (const c of test) {
      const code = c.code.split(':')[1] as string;
      states.set(code, (states.get(code) ?? new Set()).add(withClass(c).state));
    }
    expect(Object.fromEntries([...states].map(([k, v]) => [k, [...v]]))).toEqual({
      '3': ['extreme'],
      '2': ['high'],
      '1': ['elevated'],
      '0': ['normal'],
      '-1': ['no_ref'],
    });
  });

  it('the hand-edited class 4 fixture is extreme', () => {
    const rows = lhp('de-6-stations-class4.synthetic');
    const four = rows.filter((c) => c.code.endsWith(':4'));
    expect(four.length).toBeGreaterThan(0);
    for (const c of four) expect(withClass(c)).toMatchObject({ state: 'extreme', basis: { ref: c.code } });
  });

  it('a feature without an lhpClass key (classless synthetic) is no_ref', () => {
    const rows = lhp('de-6-stations-classless.synthetic');
    const none = rows.filter((c) => c.code.endsWith(':none'));
    expect(none.length).toBeGreaterThan(0);
    for (const c of none) expect(withClass(c)).toMatchObject({ state: 'no_ref', basis: null });
  });
});

describe('LHP alerts (area classes, areaLevel)', () => {
  const byRaw = (name: string, raw: string) => {
    const r = alerts(name).warnings?.rows.find((x) => x.level_raw === raw);
    if (r === undefined) throw new Error(`no alert "${raw}" in ${name}`);
    return r;
  };

  it.each([
    ['de-6-alerts-test', '1', 'normal'],
    ['de-6-alerts-test', '4', 'high'],
    ['de-6-alerts-test', '5', 'extreme'],
    ['de-6-alerts-class6.synthetic', '6', 'extreme'],
  ] as const)('%s level_raw "%s" is %s', (name, raw, state) => {
    const row = byRaw(name, raw);
    expect(areaLevel({ source: 'DE-6', levelRaw: row.level_raw })).toBe(state);
    // no gauge state: the area colours the value, section: true
    expect(withArea('DE-6', row.level_raw)).toMatchObject({
      state,
      section: true,
      basis: { source: 'DE-6', kind: 'area', measure: 'area' },
    });
  });

  it('"2" is elevated (Vorwarnung) and the string "3" has no row at all', () => {
    expect(areaLevel({ source: 'DE-6', levelRaw: '2' })).toBe('elevated');
    expect(areaLevel({ source: 'DE-6', levelRaw: '3' })).toBeNull();
    expect(withArea('DE-6', '3')).toMatchObject({ state: 'no_ref', section: false });
    const three = alerts('de-6-alerts-class3.synthetic');
    expect(three.warnings?.rows.some((r) => r.level_raw === '3')).toBe(false);
    expect(three.dropped.unmapped_class).toBe(1);
  });

  it('a polygon alert attaches to a station inside it; a River (LineString) alert attaches to none', () => {
    const rows = alerts('de-6-alerts-test').warnings?.rows ?? [];
    const poly = rows.find(
      (r) => r.level_raw === '5' && r.geometry !== null && JSON.parse(r.geometry).type === 'Polygon',
    );
    const line = rows.find((r) => r.geometry !== null && JSON.parse(r.geometry).type === 'LineString');
    expect(poly).toBeDefined();
    expect(line).toBeDefined();
    const ring = JSON.parse(poly?.geometry as string).coordinates[0] as number[][];
    // the mean of the ring's vertices: inside for the small, compact flood areas of the payload
    const lon = ring.reduce((a, p) => a + (p[0] as number), 0) / ring.length;
    const lat = ring.reduce((a, p) => a + (p[1] as number), 0) / ring.length;
    expect(pointIn(lon, lat, JSON.parse(poly?.geometry as string))).toBe(true);
    const stations = [
      { id: 'inside', lon, lat },
      { id: 'far', lon: 2, lat: 40 },
    ];
    const key = (r: typeof poly) => ({
      source: 'DE-6',
      key: r?.area_key as string,
      geometry: JSON.parse(r?.geometry as string),
    });
    expect(attachArea(key(poly), stations, new Map())).toEqual(['inside']);
    const [x, y] = JSON.parse(line?.geometry as string).coordinates[0] as number[];
    expect(attachArea(key(line), [{ id: 'on-line', lon: x as number, lat: y as number }], new Map())).toEqual([]);
    const out = classify(
      series({ areas: [{ source: 'DE-6', key: 'x', name: null, levelRaw: poly?.level_raw ?? null, fresh: true }] }),
      'public',
    );
    expect(out).toMatchObject({ state: 'extreme', section: true });
  });
});

describe("Vigicrues: the Wayback capture (old casing) and the same features in today's casing", () => {
  const name = 'fr-5-vigilance-wayback';
  const wayback = JSON.parse(rawFixture('FR-5', name).body.toString('utf8')) as {
    features: { properties: Record<string, unknown> }[];
  };
  const keep = new Set(['CdEntCru', 'CdTCC', 'NivInfViCr']);
  const current = {
    ...wayback,
    // the instant the Wayback body falls back to (the fetch time)
    DtHrInfoVigiCru: new Date(fetchedAt('FR-5', name)).toISOString(),
    features: wayback.features.map((f) => ({
      ...f,
      properties: Object.fromEntries(
        Object.entries(f.properties).map(([k, v]) => [keep.has(k) ? k : k.toLowerCase(), v]),
      ),
    })),
  };
  const codes = new Set(parseVigilance(rawFixture('FR-5', name).body).sections.map((s) => s.code));
  const ctx = { fetchedAt: fetchedAt('FR-5', name), sections: codes };
  const old = normaliseVigilance(parseVigilance(rawFixture('FR-5', name).body), ctx);
  const recased = normaliseVigilance(parseVigilance(Buffer.from(JSON.stringify(current))), ctx);

  it('the re-cased features really use the lower-case property names', () => {
    expect(Object.keys(current.features[0]?.properties ?? {})).toContain('lbentcru');
    expect(Object.keys(wayback.features[0]?.properties ?? {})).toContain('LbEntCru');
  });

  it('give identical section rows with levels 1, 2 and 3', () => {
    expect(recased.warnings).toEqual(old.warnings);
    expect(new Set(old.warnings?.rows.map((r) => r.level_raw))).toEqual(new Set(['1', '2', '3']));
  });

  it('and identical classify() outputs for the stations of those sections', () => {
    const rows = (o: typeof old) => new Map((o.warnings?.rows ?? []).map((r) => [r.area_key, r]));
    const a = rows(old);
    const b = rows(recased);
    // three real FR-1 stations (no gauge reference: the section decides) put into one section of each level
    const bySection = (level: string) => [...a.values()].find((r) => r.level_raw === level)?.area_key as string;
    const map = new Map([
      ['fr.sandre.A302009050', bySection('1')],
      ['fr.sandre.A850061001', bySection('2')],
      ['fr.sandre.B422431101', bySection('3')],
    ]);
    const states: string[] = [];
    for (const station of map.keys()) {
      const x = classified(frCase(station, 'H', a, map));
      expect(classified(frCase(station, 'H', b, map))).toEqual(x);
      expect(x.section).toBe(true);
      states.push(x.state);
    }
    expect(states).toEqual(['normal', 'elevated', 'high']);
  });

  it('the real map of 2026-09-29 puts every section of the stations at level 1 (normal)', () => {
    const map = vigilance('fr-5-vigilance');
    const out = classified(frCase('fr.sandre.A302009050', 'H', map));
    expect(out).toMatchObject({ state: 'normal', section: true, basis: { source: 'FR-5', ref: 'SA16' } });
  });
});

describe('LU-Alert (AGE): the real red alert of 2025-09-08 on the zone Sud', () => {
  const SUD_RED = 'lu-5-cap-20250908-231502-alert-lvl1';
  const cap = (name: string) =>
    normaliseCap(parseCap(rawFixture('LU-5', name).body.toString('utf8')), { fetchedAt: fetchedAt('LU-5', name) });
  // the public primary stations that the recorded CSV has a value for (Esch-Sûre's is withheld, `row_width`)
  const stations = rowsOf('LU-1').filter(
    (s) => s.role === 'primary' && s.audience === 'public' && lu1().latest.has(s.provider_key),
  );
  const zone = cap(SUD_RED).warnings?.rows[0];

  it('ALERT_LVL_1 is extreme', () => {
    expect(zone).toMatchObject({ area_key: 'Sud du Luxembourg', level_raw: 'ALERT_LVL_1' });
    expect(areaLevel({ source: 'LU-5', levelRaw: 'ALERT_LVL_1' })).toBe('extreme');
  });

  it('a station inside the stored polygon gets section: true extreme, one outside gets nothing', () => {
    const attached = attachArea(
      { source: 'LU-5', key: zone?.area_key as string, geometry: JSON.parse(zone?.geometry as string) },
      stations.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat })),
      new Map(),
    );
    expect(attached).toContain('lu.age.bissen');
    expect(attached).not.toContain('lu.age.clervaux');
    expect(attached).not.toContain('lu.age.bollendorf');
    const inside = classified(lu1Case('lu.age.bissen', [areaOf('LU-5', zone as never)]));
    expect(inside).toMatchObject({
      state: 'extreme',
      section: true,
      basis: { source: 'LU-5', kind: 'area', measure: 'area', ref: 'Sud du Luxembourg' },
    });
    // every attached station gets it; the unattached public ones keep no_ref
    for (const s of stations) {
      const area = attached.includes(s.id) ? [areaOf('LU-5', zone as never)] : [];
      const got = classified(lu1Case(s.id, area));
      expect(got.state).toBe(attached.includes(s.id) ? 'extreme' : 'no_ref');
    }
    expect(attached.length).toBeLessThan(stations.length);
  });

  it('the 2026-02-02 TEST message states no warning row, so no state', () => {
    const out = cap('lu-5-cap-20260202-095833-alert-test');
    expect(out.dropped).toEqual({ test: 1 });
    expect(out.warnings).toMatchObject({ mode: 'message', rows: [], cancels: [] });
    expect(classified(lu1Case('lu.age.bissen'))).toMatchObject({ state: 'no_ref' });
  });

  it('a Cancel (no <info>) has no area row of its own: it closes the referenced alerts', () => {
    const out = cap('lu-5-cap-20250908-231529-cancel');
    expect(out.warnings).toMatchObject({ mode: 'message', rows: [] });
    expect(out.warnings?.mode === 'message' ? out.warnings.cancels : []).toEqual([
      'LU-Alert.1757346271.4018.0',
      'LU-Alert.1757348488.4018.1',
    ]);
  });
});
