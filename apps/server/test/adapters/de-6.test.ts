import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FUTURE_SLACK_MS, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LabelFile } from '../../../../packages/contracts/src/tables.ts';
import { type LhpTable, normaliseAlerts, normaliseStations, TIME } from '../../src/adapters/de-6/normalise.ts';
import {
  ALERTS_CAPS,
  type Alerts,
  parseAlerts,
  parseStations,
  STATIONS_CAPS,
  type Stations,
} from '../../src/adapters/de-6/parse.ts';
import { ADAPTER_TIME, DST_PROOF, gate, LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { lhpStations } from '../../src/load/tables.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// DE-6 LHP: parse + normalise of the real recorded payloads, of the hand-edited synthetic ones and of the DST
// nights equals the committed golden files (invariant 9). `UPDATE_GOLDEN=1` rewrites them; a golden change is
// reviewed like code. The station table is registry/classes/de-6.yaml (what the loader hands in), or a table the
// test builds when it needs a group or a station that no recording has.

const MINUTE = 60_000;
const table = lhpStations();
const fetchedAt = (name: string) => Date.parse(rawFixture('DE-6', name).meta.recorded_at);
const stationsDoc = (name: string) => parseStations(rawFixture('DE-6', name).body);
const alertsDoc = (name: string) => parseAlerts(rawFixture('DE-6', name).body);
const stationsOf = (name: string, t: LhpTable = table) => normaliseStations(stationsDoc(name), t, fetchedAt(name));
const alertsOf = (name: string) => normaliseAlerts(alertsDoc(name), fetchedAt(name));

/** Every feature its own station and its own operator: the classes of a whole payload, whatever the registry. */
const everyFeature = (doc: Stations): LhpTable => ({
  stations: doc.features.map((f) => ({
    lhp: f.id,
    station: `de.test.${f.id}`,
    state: f.id.slice(0, 2),
    operator: true,
  })),
});

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('DE-6', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}
/** What a golden holds of a station run, and of an alerts run. */
const classesOf = (out: Normalised) => ({ classes: out.classes, dropped: out.dropped });
const warningsOf = (out: Normalised) => ({ warnings: out.warnings, dropped: out.dropped });

const stationRow = (out: Normalised, station: string) => out.classes?.find((c) => c.station === station);
const WORMS = 'de.wsv.23900200';
const PERL = 'de.wsv.26100100';

/** Perl's table rows plus the invented second Saarland id of the synthetic fixture. */
const perlTable: LhpTable = {
  stations: [
    ...table.stations.filter((s) => s.station === PERL),
    { lhp: 'SL_26100101', station: PERL, state: 'SL', operator: false },
  ],
};
/** The three Perl features of the fixture with other classes (absent, null or a number). */
function perl(classes: Record<string, number | null | 'absent'>): Stations {
  const doc = stationsDoc('de-6-stations-perl.synthetic');
  doc.features = doc.features.filter((f) => f.id in classes);
  for (const f of doc.features) {
    const c = classes[f.id];
    if (c === 'absent') delete f.properties.lhpClass;
    else f.properties.lhpClass = c;
  }
  return doc;
}
const perlCode = (doc: Stations, t: LhpTable = perlTable) =>
  stationRow(normaliseStations(doc, t, fetchedAt('de-6-stations-perl.synthetic')), PERL)?.code;

describe('golden files (real payloads)', () => {
  it('the live stations payload (1,589 features): 157 table stations, the duplicate groups of catalogue §4.9', () => {
    const out = stationsOf('de-6-stations');
    expect(classesOf(out)).toEqual(golden('de-6-stations', classesOf(out)));
    expect(stationsDoc('de-6-stations').features).toHaveLength(1589);
    expect(out.classes).toHaveLength(157);
    // 163 table features, so the other 1,426 are not our stations.
    expect(out.dropped).toEqual({ not_registered: 1426 });
    expect(out.unknown).toBe(0);
    // Worms: RP 0 beside HE -1. Mainz, Kaub and Kalkofen-neu: RP and HE both 0. Perl: RP -1, SL 0 → SL:0.
    expect(stationRow(out, WORMS)).toMatchObject({
      code: 'RP:0',
      level: 2,
      label: 'Kein Hochwasser bzw. &#60; 2-jährliches Hochwasser',
    });
    expect(stationRow(out, 'de.wsv.25100100')?.code).toBe('RP:0');
    expect(stationRow(out, 'de.wsv.25700100')?.code).toBe('RP:0');
    expect(stationRow(out, PERL)).toMatchObject({ code: 'SL:0', level: 2 });
    // Obernau (BY operates; the HE copy has the same class) and Kleinheubach (only BY lies within 500 m).
    expect(stationRow(out, 'de.wsv.24700302')?.code).toBe('BY:0');
    expect(stationRow(out, 'de.wsv.24700200')?.code).toBe('BY:0');
    // Raw: HE_23900200 "timestamp": "2026-09-18 03:15:00" (class -1); RP_23900200 "2026-09-29 15:30:00" is
    // Berlin summer time, so 13:30Z.
    expect(stationRow(out, WORMS)?.ts).toBe('2026-09-29T13:30:00.000Z');
    // Station classes are 0 or -1 live: levels 2 (normal) or null (no_ref).
    for (const c of out.classes ?? []) expect([c.code, [2, null].includes(c.level as never)]).toEqual([c.code, true]);
  });

  it('the payload of 2026-10-02 with one BW gauge at class 3', () => {
    const out = stationsOf('de-6-stations-class3');
    expect(classesOf(out)).toEqual(golden('de-6-stations-class3', classesOf(out)));
    // The class 3 gauge is not one of our stations (a Baden-Württemberg gauge): the table does not list it. Perl RP_26100102 is not in this answer (162 table features).
    const f = stationsDoc('de-6-stations-class3').features.find((x) => x.properties.lhpClass === 3);
    expect(f?.id.startsWith('BW_')).toBe(true);
    expect(out.dropped.not_registered).toBe(1588 - 162);
    // The same gauge in a table of every feature: class 3 is level 5 (extreme), provider text raw.
    const all = normaliseStations(
      stationsDoc('de-6-stations-class3'),
      everyFeature(stationsDoc('de-6-stations-class3')),
      fetchedAt('de-6-stations-class3'),
    );
    const hit = all.classes?.find((c) => c.station === `de.test.${f?.id}`);
    expect(hit).toMatchObject({ code: `BW:3`, level: 5, label: '&#8805; 20-jährliches Hochwasser' });
  });

  it('the live alerts payload: no area is alerted, a snapshot of nothing at `updated`', () => {
    const out = alertsOf('de-6-alerts');
    expect(warningsOf(out)).toEqual(golden('de-6-alerts', warningsOf(out)));
    // Raw: "updated": "2026-09-29T14:42:46+01:00" (true UTC with a fixed +01:00 all year).
    expect(out.warnings).toEqual({ mode: 'snapshot', at: '2026-09-29T13:42:46.000Z', rows: [] });
    expect(out.dropped).toEqual({});
  });

  it('the test server stations (2024-01-25 flood): classes 1, 2, 3 are levels 3, 4, 5', () => {
    const doc = stationsDoc('de-6-stations-test');
    const out = stationsOf('de-6-stations-test');
    expect(classesOf(out)).toEqual(golden('de-6-stations-test', classesOf(out)));
    // Through a table of every feature the whole payload is seen: classes 0:1199, 1:32, 2:14, 3:1, -1:13.
    const all = normaliseStations(doc, everyFeature(doc), fetchedAt('de-6-stations-test'));
    expect(all.dropped).toEqual({});
    expect(all.classes).toHaveLength(1259);
    const tally = new Map<string, { n: number; level: unknown }>();
    for (const c of all.classes ?? []) {
      const cls = c.code.slice(3);
      tally.set(cls, { n: (tally.get(cls)?.n ?? 0) + 1, level: c.level });
    }
    expect(Object.fromEntries(tally)).toEqual({
      '0': { n: 1199, level: 2 },
      '1': { n: 32, level: 3 },
      '2': { n: 14, level: 4 },
      '3': { n: 1, level: 5 },
      '-1': { n: 13, level: null },
    });
    // 13 features have no stateClassName (BW_288, a gauge with -1 and no timestamp): the label is null, ts is `updated`.
    expect(all.classes?.filter((c) => c.label === null)).toHaveLength(13);
    expect(all.classes?.find((c) => c.station === 'de.test.BW_288')).toMatchObject({
      code: 'BW:-1',
      label: null,
      level: null,
      ts: '2026-10-03T08:42:47.000Z',
    });
    // Provider text stays raw text: the entity of "< 2-jährliches" is never decoded into markup.
    const entity = all.classes?.find((c) => c.label?.includes('&#60;'));
    expect(entity?.label).toBe('Kein Hochwasser bzw. &#60; 2-jährliches Hochwasser');
    expect(JSON.stringify(all.classes)).not.toContain('<');
  });

  it('the test server alerts (40 areas, Polygon and LineString): classes 1, 2, 4, 5 are levels 2, 3, 4, 5', () => {
    const doc = alertsDoc('de-6-alerts-test');
    const out = alertsOf('de-6-alerts-test');
    expect(warningsOf(out)).toEqual(golden('de-6-alerts-test', warningsOf(out)));
    expect(doc.features).toHaveLength(40);
    expect(out.dropped).toEqual({});
    const rows = out.warnings?.rows ?? [];
    const at = out.warnings?.mode === 'snapshot' ? out.warnings.at : undefined;
    expect(rows).toHaveLength(40);
    const levels = new Map(rows.map((r) => [r.level_raw, r.level]));
    expect(Object.fromEntries(levels)).toEqual({ '1': 2, '2': 3, '4': 4, '5': 5 });
    const first = rows[0];
    const raw = doc.features[0];
    expect(first).toEqual({
      area_key: raw?.id,
      name: raw?.properties.areaDesc,
      geometry: JSON.stringify(raw?.geometry),
      level: 4,
      level_raw: raw?.properties.lhpClass,
      label_raw: raw?.properties.lhpClassName,
      texts: { de: { headline: raw?.properties.alertHeadline } },
      valid_from: at,
      valid_to: null,
      issued_at: null,
    });
    // Both geometry kinds are stored as GeoJSON text.
    expect(new Set(rows.map((r) => JSON.parse(r.geometry ?? 'null').type))).toEqual(new Set(['Polygon', 'LineString']));
    // `updated` 09:42:47+01:00 on 2026-10-03: 08:42:47Z.
    expect(at).toBe('2026-10-03T08:42:47.000Z');
  });
});

describe('golden files (synthetic payloads)', () => {
  const NAMES = [
    'de-6-stations-class4.synthetic',
    'de-6-stations-classless.synthetic',
    'de-6-stations-worms.synthetic',
    'de-6-stations-dst-fall-back.synthetic',
    'de-6-stations-dst-fall-back-first.synthetic',
    'de-6-stations-dst-spring-forward.synthetic',
  ];
  for (const name of NAMES)
    it(`${name}`, () => {
      const out = stationsOf(name);
      expect(classesOf(out)).toEqual(golden(name, classesOf(out)));
    });

  it('de-6-stations-perl.synthetic (with the invented second Saarland id in the table)', () => {
    const out = stationsOf('de-6-stations-perl.synthetic', perlTable);
    expect(classesOf(out)).toEqual(golden('de-6-stations-perl.synthetic', classesOf(out)));
    expect(out.dropped).toEqual({});
    // Without the invented id in the table it is a feature that is not ours: counted, and the rule still gives SL:0.
    const plain = stationsOf('de-6-stations-perl.synthetic');
    expect(plain.dropped).toEqual({ not_registered: 1 });
    expect(stationRow(plain, PERL)?.code).toBe('SL:0');
  });

  for (const name of [
    'de-6-alerts-class6.synthetic',
    'de-6-alerts-class3.synthetic',
    'de-6-alerts-dst-fall-back.synthetic',
    'de-6-alerts-dst-spring-forward.synthetic',
  ])
    it(`${name}`, () => {
      const out = alertsOf(name);
      expect(warningsOf(out)).toEqual(golden(name, warningsOf(out)));
    });
});

describe('station classes', () => {
  it('class 4 is the extreme level; the operator wins over a lower class of another state', () => {
    const out = stationsOf('de-6-stations-class4.synthetic');
    // RP_25700100 4 and HE_25700100 0: RP operates Kaub. NW_2721330000100 0.
    expect(stationRow(out, 'de.wsv.25700100')).toMatchObject({
      code: 'RP:4',
      level: 5,
      label: 'Sehr großes Hochwasser',
    });
    expect(stationRow(out, 'de.lanuk.2721330000100')).toMatchObject({ code: 'NW:0', level: 2 });
  });

  it('a feature without the lhpClass key, with a null class and with -1 have no level, and each its own code', () => {
    const out = stationsOf('de-6-stations-classless.synthetic');
    // No key and no timestamp: ts is `updated` (14:42:46+01:00 = 13:42:46Z), code none, the provider's text.
    expect(stationRow(out, 'de.lanuk.2721330000100')).toEqual({
      station: 'de.lanuk.2721330000100',
      ts: '2026-09-29T13:42:46.000Z',
      code: 'NW:none',
      label: 'Ohne Hochwasser-Einstufung',
      level: null,
    });
    expect(stationRow(out, 'de.lanuk.2721390000100')).toMatchObject({ code: 'NW:none', level: null });
    expect(stationRow(out, 'de.lanuk.2721459000100')).toMatchObject({ code: 'NW:-1', level: null });
    expect(out.dropped).toEqual({});
  });

  it('the duplicate rule: the operating state, else the worst other class (provenance in the code), else its own -1 or none', () => {
    // Perl: RP operates; SL, SL2 and RP.
    expect(perlCode(perl({ SL_26100102: 0, RP_26100102: -1, SL_26100101: -1 }))).toBe('SL:0');
    expect(perlCode(perl({ SL_26100102: 0, RP_26100102: 1, SL_26100101: 3 }))).toBe('RP:1');
    // The operator has no class: the worst of the others, the first of equals.
    expect(perlCode(perl({ SL_26100102: 2, RP_26100102: -1, SL_26100101: 3 }))).toBe('SL:3');
    expect(perlCode(perl({ SL_26100102: 2, RP_26100102: null, SL_26100101: 2 }))).toBe('SL:2');
    expect(perlCode(perl({ SL_26100102: 1, RP_26100102: 'absent', SL_26100101: 4 }))).toBe('SL:4');
    // Nothing states a class: the operator's own -1 or none.
    expect(perlCode(perl({ SL_26100102: -1, RP_26100102: -1, SL_26100101: -1 }))).toBe('RP:-1');
    expect(perlCode(perl({ SL_26100102: -1, RP_26100102: null, SL_26100101: null }))).toBe('RP:none');
    expect(perlCode(perl({ SL_26100102: null, RP_26100102: 'absent', SL_26100101: -1 }))).toBe('RP:none');
    // The operating state's feature is not in the answer: the first feature present is the base.
    expect(perlCode(perl({ SL_26100102: -1, SL_26100101: 2 }))).toBe('SL:2');
    expect(perlCode(perl({ SL_26100102: -1, SL_26100101: null }))).toBe('SL:-1');
    // A lone feature is a station of its own.
    expect(perlCode(perl({ RP_26100102: 3 }))).toBe('RP:3');
  });

  it('the worst class is taken among 0…4 only: -1 and none never beat a class; a duplicate feature id withholds the station', () => {
    const doc = perl({ SL_26100102: 0, RP_26100102: -1, SL_26100101: null });
    expect(perlCode(doc)).toBe('SL:0');
    const twice = perl({ SL_26100102: 0, RP_26100102: -1 });
    const first = twice.features[0] as Stations['features'][number];
    twice.features.push(structuredClone({ ...first, properties: { ...first.properties, lhpClass: 4 } }));
    const out = normaliseStations(twice, perlTable, fetchedAt('de-6-stations-perl.synthetic'));
    // Which copy is meant is unknown: both are counted, and Perl takes no class from this payload (review CR-12).
    expect(out.dropped).toEqual({ conflict: 2 });
    expect(stationRow(out, PERL)).toBeUndefined();
  });

  it('a class the crosswalk does not know is dropped unmapped_class (retained); a station is only in the table', () => {
    const doc = perl({ SL_26100102: 5, RP_26100102: 5 });
    const out = normaliseStations(doc, perlTable, fetchedAt('de-6-stations-perl.synthetic'));
    expect(out.classes).toEqual([]);
    expect(out.dropped).toEqual({ unmapped_class: 1 });
  });

  it('a feature more than 15 minutes ahead of the fetch is dropped future; a time in the spring gap dst_gap', () => {
    const out = stationsOf('de-6-stations-dst-spring-forward.synthetic');
    expect(out.dropped).toEqual({ dst_gap: 2 });
    const back = stationsOf('de-6-stations-dst-fall-back.synthetic');
    expect(back.dropped).toEqual({ future: 1 });
    // The repeated hour: 02:15 is the later occurrence (01:15Z, not after updated 01:40Z), 02:45 would be after
    // updated, so the earlier one (00:45Z) is taken; a feature without timestamp is `updated`.
    expect(back.classes?.map((c) => [c.station.slice(-13), c.ts])).toEqual([
      ['2721330000100', '2026-10-24T23:45:00.000Z'],
      ['2721390000100', '2026-10-25T01:15:00.000Z'],
      ['2721459000100', '2026-10-25T00:45:00.000Z'],
      ['2725910000100', '2026-10-25T01:40:00.000Z'],
    ]);
    const first = stationsOf('de-6-stations-dst-fall-back-first.synthetic');
    expect(first.classes?.map((c) => c.ts)).toEqual([
      '2026-10-24T23:50:00.000Z',
      '2026-10-25T00:15:00.000Z',
      '2026-10-25T00:30:00.000Z',
    ]);
    expect(first.dropped).toEqual({ future: 2 });
  });

  it('a malformed timestamp or `updated` is drift of the payload, never a row', () => {
    const doc = stationsDoc('de-6-stations-worms.synthetic');
    const body = (f: (d: Stations) => void) => {
      const d = structuredClone(doc);
      f(d);
      return Buffer.from(JSON.stringify(d));
    };
    expect(() =>
      parseStations(
        body((d) => {
          (d.features[0] as { properties: { timestamp: string } }).properties.timestamp = '2026-09-29T15:30:00';
        }),
      ),
    ).toThrow(SchemaDrift);
    expect(() => normaliseStations({ ...doc, updated: '2026-09-29 14:42:46' }, table, 0)).toThrow(
      /time_bad_format at updated/,
    );
    expect(() => normaliseAlerts({ ...alertsDoc('de-6-alerts'), updated: 'x' }, 0)).toThrow(/time_bad_format/);
  });
});

describe('alerts', () => {
  it('the alert scale is its own: 1, 2, 4, 5, 6 are levels 2, 3, 4, 5, 5 (never the station scale)', () => {
    const six = alertsOf('de-6-alerts-class6.synthetic');
    expect(six.warnings?.rows.map((r) => [r.level_raw, r.level, r.label_raw])).toEqual([
      ['4', 4, 'Hochwasser'],
      ['6', 5, 'Sehr großes Hochwasser'],
      ['5', 5, 'Großes Hochwasser'],
    ]);
    const all = alertsOf('de-6-alerts-test');
    expect(new Map((all.warnings?.rows ?? []).map((r) => [r.level_raw, r.level]))).toEqual(
      new Map([
        ['4', 4],
        ['5', 5],
        ['1', 2],
        ['2', 3],
      ]),
    );
  });

  it('a class "3" is unmapped (no row), a feature id twice is a conflict (neither copy stands); both stay listed', () => {
    const out = alertsOf('de-6-alerts-class3.synthetic');
    expect(out.dropped).toEqual({ unmapped_class: 1, conflict: 2 });
    expect(out.warnings?.rows.map((r) => [r.area_key, r.level_raw, r.level])).toEqual([['RP_29', '2', 3]]);
    // The payload lists them: their stored ranges are not closed (review CR-5).
    expect(out.warnings?.mode === 'snapshot' && out.warnings.kept).toEqual(['HE_104', 'TH_04']);
  });

  it('an alerts payload ahead of the fetch states nothing', () => {
    const doc = alertsDoc('de-6-alerts-class6.synthetic');
    const at = Date.parse('2026-10-03T08:42:47Z');
    expect(normaliseAlerts(doc, at - 1).warnings).toBeDefined();
    expect(normaliseAlerts(doc, at - FUTURE_SLACK_MS).warnings).toBeDefined();
    const ahead = normaliseAlerts(doc, at - FUTURE_SLACK_MS - 1);
    expect(ahead.warnings).toBeUndefined();
    expect(ahead.dropped).toEqual({ future: 3 });
  });
});

describe('the loader wiring and the DST gate', () => {
  it('declares both specs, the time convention, and a proof for each spec whose fixtures run to their goldens', async () => {
    expect(Object.keys(LOAD_ADAPTERS['DE-6']?.specs ?? {})).toEqual(['de-6-stations', 'de-6-alerts']);
    expect(ADAPTER_TIME['DE-6']).toBe(TIME);
    expect(TIME).toEqual({ kind: 'naive-local', zone: 'Europe/Berlin', dst: { gap: 'reject', overlap: 'later' } });
    for (const id of ['de-6-stations', 'de-6-alerts']) {
      const proof = DST_PROOF[id];
      expect([id, proof?.fallBack.length, proof?.springForward.length]).toEqual([
        id,
        id === 'de-6-stations' ? 2 : 1,
        1,
      ]);
      for (const name of [...(proof?.fallBack ?? []), ...(proof?.springForward ?? [])]) {
        const { body, meta } = rawFixture('DE-6', name);
        // The proof runs with an empty registry and needs only the station table.
        const out = await LOAD_ADAPTERS['DE-6']?.specs[id]?.run(body, {
          registry: new Map(),
          fetchedAt: Date.parse(meta.recorded_at),
          variant: '',
          unitMismatch: new Set(),
        });
        const golden_ = golden(
          name,
          id === 'de-6-stations' ? classesOf(out as Normalised) : warningsOf(out as Normalised),
        );
        expect(id === 'de-6-stations' ? classesOf(out as Normalised) : warningsOf(out as Normalised)).toEqual(golden_);
      }
    }
    // Every DE-6 spec has its proof: the gate refuses none of them.
    expect(gate(LOAD_ADAPTERS).refused.filter((s) => s.startsWith('de-6'))).toEqual([]);
  });

  it('the specs run the P1a payloads through the wiring: the stations table is registry/classes/de-6.yaml', async () => {
    const run = (spec: string, name: string) => {
      const { body, meta } = rawFixture('DE-6', name);
      return LOAD_ADAPTERS['DE-6']?.specs[spec]?.run(body, {
        registry: new Map(),
        fetchedAt: Date.parse(meta.recorded_at),
        variant: '',
        unitMismatch: new Set(),
      });
    };
    expect((await run('de-6-stations', 'de-6-stations'))?.classes).toHaveLength(157);
    expect((await run('de-6-alerts', 'de-6-alerts-test'))?.warnings?.rows).toHaveLength(40);
    expect(LOAD_ADAPTERS['DE-6']?.specs['de-6-stations']?.maxBytes).toBe(8 * 1024 * 1024);
  });
});

describe('the registry table and the labels', () => {
  it('every emitted code has a label with a Dutch and an English text (no "warning" for a station class)', () => {
    const labels = LabelFile.parse(
      parseYaml(readFileSync(new URL('../../../../registry/labels/DE-6.yaml', import.meta.url), 'utf8')),
    );
    const has = (scale: string, code: string) => labels.labels.some((l) => l.scale === scale && l.code === code);
    const stations = [
      ...(stationsOf('de-6-stations').classes ?? []),
      ...(normaliseStations(
        stationsDoc('de-6-stations-test'),
        everyFeature(stationsDoc('de-6-stations-test')),
        fetchedAt('de-6-stations-test'),
      ).classes ?? []),
      ...(stationsOf('de-6-stations-classless.synthetic').classes ?? []),
      ...(stationsOf('de-6-stations-class4.synthetic').classes ?? []),
    ];
    const codes = new Set(stations.map((c) => c.code.slice(c.code.indexOf(':') + 1)));
    expect([...codes].sort()).toEqual(['-1', '0', '1', '2', '3', '4', 'none']);
    for (const code of codes) expect([code, has('station', code)]).toEqual([code, true]);
    const alerts = new Set(
      ['de-6-alerts-test', 'de-6-alerts-class6.synthetic'].flatMap(
        (n) => alertsOf(n).warnings?.rows.map((r) => r.level_raw) ?? [],
      ),
    );
    expect([...alerts].sort()).toEqual(['1', '2', '4', '5', '6']);
    for (const code of alerts) expect([code, has('alert', code ?? '')]).toEqual([code, true]);
    expect(labels.labels.filter((l) => l.scale === 'station' && /waarschuw|warn/i.test(`${l.nl} ${l.en}`))).toEqual([]);
  });
});

describe('strictness and caps', () => {
  const worms = () => JSON.parse(rawFixture('DE-6', 'de-6-stations-worms.synthetic').body.toString('utf8'));
  const alerts = () => JSON.parse(rawFixture('DE-6', 'de-6-alerts-class6.synthetic').body.toString('utf8'));
  const codeOf = (parse: (b: Buffer) => unknown, doc: unknown) => {
    try {
      parse(Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)));
    } catch (err) {
      if (err instanceof SchemaDrift) return err.message;
      throw err;
    }
    return 'parsed';
  };

  it('an unknown key, a wrong type and a wrong kind are drift', () => {
    expect(codeOf(parseStations, worms())).toBe('parsed');
    expect(codeOf(parseStations, { ...worms(), extra: 1 })).toMatch(/^unrecognized_keys/);
    const d = worms();
    d.features[0].properties.lhpClass = '0';
    expect(codeOf(parseStations, d)).toMatch(/^invalid_type at features\.0\.properties\.lhpClass/);
    const k = worms();
    k.features[0].kind = 'AlertArea';
    expect(codeOf(parseStations, k)).toMatch(/^invalid_value at features\.0\.kind/);
    const g = worms();
    g.features[0].geometry.coordinates = [8.3, 49.6, 90];
    expect(codeOf(parseStations, g)).toMatch(/^too_big/);
    const s = worms();
    s.features[0].properties.timestamp = '29.09.2026 15:30';
    expect(codeOf(parseStations, s)).toMatch(/^invalid_format at features\.0\.properties\.timestamp/);
    // An alert class is a string; a number is the station scale and not accepted here.
    expect(codeOf(parseAlerts, alerts())).toBe('parsed');
    const a = alerts();
    a.features[0].properties.lhpClass = 4;
    expect(codeOf(parseAlerts, a)).toMatch(/^invalid_type at features\.0\.properties\.lhpClass/);
    const t = alerts();
    t.features[0].geometry = { type: 'MultiPolygon', coordinates: [] };
    expect(codeOf(parseAlerts, t)).toMatch(/^invalid_union/);
  });

  it('a body that is not JSON, not a collection, or over a cap is drift with a fixed code', () => {
    expect(codeOf(parseStations, '')).toBe('not_json');
    expect(codeOf(parseStations, '<html>')).toBe('not_json');
    expect(codeOf(parseStations, '[]')).toMatch(/^invalid_type/);
    expect(codeOf(parseAlerts, 'null')).toMatch(/^invalid_type/);
    const deep = `${'['.repeat(STATIONS_CAPS.maxDepth + 1)}${']'.repeat(STATIONS_CAPS.maxDepth + 1)}`;
    expect(codeOf(parseStations, deep)).toBe('json_too_deep');
    expect(codeOf(parseAlerts, `[${'0,'.repeat(ALERTS_CAPS.maxNodes)}0]`)).toBe('json_too_many_nodes');
    const many = worms();
    many.features = Array.from({ length: STATIONS_CAPS.maxFeatures + 1 }, () => 0);
    expect(codeOf(parseStations, many)).toMatch(/^json_too_many_nodes|^too_big/);
    const ring = alerts();
    ring.features[0].geometry = { type: 'LineString', coordinates: Array.from({ length: 20_001 }, () => [1, 2]) };
    expect(codeOf(parseAlerts, ring)).toBe('too_big at features.0.geometry.coordinates');
  });

  it('truncating or reshaping any recorded body gives SchemaDrift or a parse, never another exception', () => {
    const bodies = [
      rawFixture('DE-6', 'de-6-stations-perl.synthetic').body.toString('utf8'),
      rawFixture('DE-6', 'de-6-alerts-class6.synthetic').body.toString('utf8'),
      rawFixture('DE-6', 'de-6-alerts').body.toString('utf8'),
    ];
    const run = (text: string) => {
      for (const parse of [parseStations, parseAlerts]) {
        try {
          const doc = parse(Buffer.from(text));
          if ('stateLinks' in doc) normaliseStations(doc as Stations, table, 0);
          else normaliseAlerts(doc as Alerts, 0);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }
    };
    fc.assert(
      fc.property(fc.constantFrom(...bodies), fc.nat(), (body, cut) => {
        run(body.slice(0, cut % body.length));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...bodies),
        fc.jsonValue(),
        fc.constantFrom('features', 'legend', 'bbox', 'updated', 'stateLinks'),
        (body, value, key) => {
          const doc = JSON.parse(body);
          run(JSON.stringify({ ...doc, [key]: value }));
          run(JSON.stringify({ ...doc, features: [value] }));
          run(JSON.stringify(value));
          if (doc.features[0]) run(JSON.stringify({ ...doc, features: [{ ...doc.features[0], properties: value }] }));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property: the time of a feature', () => {
  const Z = 'Europe/Berlin';
  const TRANSITIONS = [Date.UTC(2026, 9, 25), Date.UTC(2027, 2, 28), Date.UTC(2026, 2, 29), Date.UTC(2027, 9, 31)];
  const label = fc
    .oneof(
      fc.integer({ min: Date.UTC(2026, 0, 1) / MINUTE, max: Date.UTC(2028, 0, 1) / MINUTE - 1 }).map((m) => m * MINUTE),
      fc
        .tuple(fc.constantFrom(...TRANSITIONS), fc.integer({ min: 0, max: 24 * 60 - 1 }))
        .map(([day, m]) => day + m * MINUTE),
    )
    .map((ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' '));
  /** `updated` from 4 h before to 2 h after the label read as UTC, often at a candidate. */
  const around = (text: string) =>
    fc
      .oneof(fc.integer({ min: -4 * 3600, max: 2 * 3600 }), fc.constantFrom(-7200, -6300, -3600, -2700))
      .map((s) => Date.parse(`${text.replace(' ', 'T')}Z`) + s * 1000);
  /** Every UTC instant whose Berlin wall clock is the label (0, 1 or 2), without the code under test. */
  const candidates = (text: string): number[] => {
    const local = Temporal.PlainDateTime.from(text.replace(' ', 'T'));
    return ['+02:00', '+01:00']
      .map((offset) => Temporal.Instant.from(`${local.toString()}${offset}`))
      .filter((t) => t.toZonedDateTimeISO(Z).toPlainDateTime().equals(local))
      .map((t) => t.epochMilliseconds);
  };
  const base = stationsDoc('de-6-stations-worms.synthetic');
  const one: LhpTable = { stations: [{ lhp: 'RP_23900200', station: WORMS, state: 'RP', operator: true }] };

  it('a label resolves to the latest Berlin candidate not after `updated`, or is a counted drop', () => {
    fc.assert(
      fc.property(
        label.chain((l) => fc.tuple(fc.constant(l), around(l), fc.integer({ min: 0, max: 20 }))),
        ([text, updated, lateMin]) => {
          const feature = structuredClone(base.features[0]);
          if (feature === undefined) throw new Error('no feature');
          feature.properties.timestamp = text;
          const fetched = updated + lateMin * MINUTE;
          const doc: Stations = { ...base, updated: new Date(updated).toISOString(), features: [feature] };
          const out = normaliseStations(doc, one, fetched);
          const c = candidates(text);
          if (c.length === 0) {
            expect(out.dropped).toEqual({ dst_gap: 1 });
            return;
          }
          const pick = c.filter((t) => t <= updated).sort((a, b) => b - a)[0] ?? Math.min(...c);
          if (pick > fetched + FUTURE_SLACK_MS) expect(out.dropped).toEqual({ future: 1 });
          else expect(out.classes?.map((r) => r.ts)).toEqual([new Date(pick).toISOString()]);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
