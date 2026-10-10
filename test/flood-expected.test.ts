import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalise as normaliseCh4 } from '../apps/server/src/adapters/ch-4/normalise.ts';
import { parseForecast as parseCh4 } from '../apps/server/src/adapters/ch-4/parse.ts';
import { normalise as normaliseDe2 } from '../apps/server/src/adapters/de-2/normalise.ts';
import { parseForecast as parseDe2 } from '../apps/server/src/adapters/de-2/parse.ts';
import { normaliseAlerts, normaliseStations } from '../apps/server/src/adapters/de-6/normalise.ts';
import { parseAlerts, parseStations } from '../apps/server/src/adapters/de-6/parse.ts';
import { normaliseVigilance } from '../apps/server/src/adapters/fr-5/normalise.ts';
import { parseVigilance } from '../apps/server/src/adapters/fr-5/parse.ts';
import { normalise as normaliseCap } from '../apps/server/src/adapters/lu-5/normalise.ts';
import { parseCap } from '../apps/server/src/adapters/lu-5/parse.ts';
import { lhpStations, sectionMap, vigicruesSectionCodes } from '../apps/server/src/load/tables.ts';
import {
  type AreaIn,
  type ClassIn,
  checkRun,
  classify,
  FORECAST_SOURCES,
  LEVEL_NORM,
  levelOf,
  type SeriesIn,
} from '../packages/core/src/index.ts';
import { plan } from '../scripts/flood-drill.ts';

// deploy/tests/flood/expected.json (the levels the flood drill must reach, read by deploy/tests/e2e/flood-check.mjs)
// against what the code says: the crosswalk and classify() (the rules of docs/classification.md), the P7 goldens
// (flood.test.ts, golden-states.golden.json, the adapters' golden files) and the real adapters on the drill's shifted
// payloads (the loader's own parse and normalise functions, the registry tables it reads).

type Expected = {
  levels: Record<string, number>;
  scales: Record<string, Record<string, string>>;
  stations: {
    id: string;
    source: string;
    scale: string;
    raw: string;
    state: string;
    section: boolean;
    area?: string;
    fixture: string;
    closedBy?: string;
  }[];
  noGaugeClass: { id: string; raw: string; fixture: string }[];
  areas: { source: string; area: string; levelRaw: string; level: number; closedBy?: string }[];
  minimums: { sectionStations: Record<string, number>; de6GaugeClassStations: number };
  absent: { source: string; fixture: string; textPrefix: string };
  forecast: {
    station: string;
    series: string;
    source: string;
    agency: string;
    kind: string;
    stepSeconds: number;
    bandKind: string;
    medianPeak: number;
    vmaxPeak: number;
    firstThreshold: number;
    runStartBeforeFetchSeconds: number;
  };
  owner: {
    station: string;
    source: string;
    agency: string;
    points: number;
    valueMin: number;
    valueMax: number;
    canary: string[];
  };
};
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const expected = JSON.parse(read('../deploy/tests/flood/expected.json')) as Expected;
const ADAPTERS = '../apps/server/src/adapters/';
const golden = (source: string, name: string) =>
  JSON.parse(read(`${ADAPTERS}${source.toLowerCase()}/fixtures/${name}.golden.json`)) as Record<string, unknown>;

const NOW = Date.parse('2026-10-12T10:00:00Z');
const planned = plan(NOW);
const scene = (fixture: string) => {
  const p = planned.find((x) => x.scene.fixture === fixture);
  if (p === undefined) throw new Error(`no scene ${fixture}`);
  return p;
};
const STATE_OF = Object.fromEntries(Object.entries(expected.levels).map(([k, v]) => [v, k]));
const CROSSWALK_SCALE: Record<string, [string, string]> = {
  'DE-6 station': ['DE-6', 'station'],
  'DE-6 alert': ['DE-6', 'alert'],
  'FR-5 section': ['FR-5', 'section'],
  'LU-5 zone': ['LU-5', 'zone'],
};

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
const withClass = (c: ClassIn) => classify(series({ classes: [c] }), 'public');
const withArea = (a: AreaIn) => classify(series({ areas: [a] }), 'public');

describe('expected.json against the rules', () => {
  it('has the six levels of LEVEL_NORM and no other scale than the four of the drill', () => {
    expect(expected.levels).toEqual({ no_ref: 0, ...LEVEL_NORM });
    expect(Object.keys(expected.scales).sort()).toEqual(Object.keys(CROSSWALK_SCALE).sort());
  });

  it('each scale code is the level the crosswalk gives it (no_ref for a class without a level)', () => {
    for (const [scale, codes] of Object.entries(expected.scales)) {
      const [source, name] = CROSSWALK_SCALE[scale] as [string, string];
      for (const [code, state] of Object.entries(codes)) {
        const level = levelOf(source, name, code);
        expect([scale, code, level === null ? 'no_ref' : STATE_OF[level as number]]).toEqual([scale, code, state]);
      }
    }
  });

  it('each expected station gets that state from classify(): a DE-6 class decides at the gauge, an area class as a section', () => {
    for (const s of expected.stations) {
      if (s.source === 'DE-6') {
        const out = withClass({ source: 'DE-6', code: s.raw, fresh: true });
        expect([s.id, out.state, out.section]).toEqual([s.id, s.state, false]);
        expect(out.basis).toMatchObject({ source: 'DE-6', kind: 'operational', ref: s.raw });
      } else {
        const out = withArea({ source: s.source, key: s.area as string, name: null, levelRaw: s.raw, fresh: true });
        expect([s.id, out.state, out.section]).toEqual([s.id, s.state, true]);
        expect(out.basis).toMatchObject({ source: s.source, kind: 'area', measure: 'area', ref: s.area });
      }
    }
  });

  it('a class-less feature gives no gauge class: classify() has no basis and no state from it', () => {
    for (const e of expected.noGaugeClass) {
      const out = withClass({ source: 'DE-6', code: e.raw, fresh: true });
      expect([e.id, out.state, out.basis]).toEqual([e.id, 'no_ref', null]);
    }
  });

  it('the area levels are the crosswalk levels of their raw codes', () => {
    for (const a of expected.areas) {
      const scale = { 'DE-6': 'alert', 'FR-5': 'section', 'LU-5': 'zone' }[a.source] as string;
      expect([a.source, a.area, levelOf(a.source, scale, a.levelRaw)]).toEqual([a.source, a.area, a.level]);
    }
  });

  it('the drill raises what the P7 baseline holds: each FR-1 station of golden-states is "normal" there, higher here', () => {
    const base = JSON.parse(read('../apps/server/test/classification/golden-states.golden.json')) as Record<
      string,
      { state: string; section: boolean; basis: { source: string } | null }
    >;
    let raised = 0;
    for (const s of expected.stations.filter((x) => x.source === 'FR-5')) {
      const g = base[`${s.id}#H`];
      if (g === undefined) continue;
      expect(g).toMatchObject({ state: 'normal', section: true, basis: { source: 'FR-5' } });
      if ((expected.levels[s.state] ?? 0) > 2) raised += 1;
    }
    // The three stations of flood.test.ts, each in a section the drill raises or keeps at level 1.
    expect(raised).toBeGreaterThanOrEqual(1);
    expect(base['de.wsv.26500100#H']).toMatchObject({ state: 'normal', basis: { source: 'DE-6', ref: 'RP:0' } });
  });
});

describe('expected.json against the real adapters on the shifted payloads', () => {
  const table = lhpStations();
  const classesOf = (fixture: string) => {
    const out = normaliseStations(parseStations(scene(fixture).body), table, NOW);
    return { classes: out.classes ?? [], dropped: out.dropped };
  };

  it('DE-6 stations: the decisive ones and the class-less ones, with the classes stamped inside the drill window', () => {
    const test = classesOf('de-6-stations-test');
    const c4 = classesOf('de-6-stations-class4.synthetic');
    const none = classesOf('de-6-stations-classless.synthetic');
    const all = [...test.classes, ...c4.classes, ...none.classes];
    for (const s of expected.stations.filter((x) => x.source === 'DE-6')) {
      const rows = classesOf(s.fixture).classes.filter((c) => c.station === s.id);
      expect([s.id, rows.map((r) => [r.code, STATE_OF[r.level ?? 0]])]).toEqual([s.id, [[s.raw, s.state]]]);
    }
    for (const e of expected.noGaugeClass) {
      const row = none.classes.find((c) => c.station === e.id);
      expect([e.id, row?.code, row?.level]).toEqual([e.id, e.raw, null]);
    }
    expect(test.classes.filter((c) => c.code.endsWith(':0')).length).toBeGreaterThanOrEqual(
      expected.minimums.de6GaugeClassStations,
    );
    // Per station the newest class is the drilled one: Kaub's RP 4 and the class-less rows are newer than the test server's.
    const newest = (station: string) =>
      all.filter((c) => c.station === station).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
    expect(newest('de.wsv.25700100')?.code).toBe('RP:4');
    for (const e of expected.noGaugeClass) expect(newest(e.id)?.code).toBe(e.raw);
    // Nothing is stamped after the drill clock (the 15-minute future rule), and every drop is a feature we do not table.
    for (const c of all) expect(Date.parse(c.ts)).toBeLessThanOrEqual(NOW);
    for (const d of [test.dropped, c4.dropped, none.dropped])
      expect(Object.keys(d).every((k) => k === 'not_registered')).toBe(true);
  });

  it('DE-6 alerts: the 40 areas of the test server at their levels, equal to the golden', () => {
    const out = normaliseAlerts(parseAlerts(scene('de-6-alerts-test').body), NOW);
    expect(out.dropped).toEqual({});
    const rows = out.warnings?.mode === 'snapshot' ? out.warnings.rows : [];
    const want = expected.areas.filter((a) => a.source === 'DE-6');
    expect(rows.map((r) => [r.area_key, r.level_raw, r.level])).toEqual(want.map((a) => [a.area, a.levelRaw, a.level]));
    const g = golden('DE-6', 'de-6-alerts-test') as {
      warnings: { rows: { area_key: string; level_raw: string; level: number }[] };
    };
    expect(g.warnings.rows.map((r) => [r.area_key, r.level_raw, r.level])).toEqual(
      want.map((a) => [a.area, a.levelRaw, a.level]),
    );
    expect(out.warnings?.mode === 'snapshot' ? Date.parse(out.warnings.at) : 0).toBe(NOW - 15 * 60_000);
  });

  it('FR-5: all 56 sections at their levels (the map is accepted whole), and each expected station is in its section', () => {
    const out = normaliseVigilance(parseVigilance(scene('fr-5-vigilance-level4.synthetic').body), {
      fetchedAt: NOW,
      sections: vigicruesSectionCodes(),
    });
    expect(out.dropped).toEqual({});
    const rows = out.warnings?.mode === 'snapshot' ? out.warnings.rows : [];
    const want = expected.areas.filter((a) => a.source === 'FR-5');
    expect(want).toHaveLength(vigicruesSectionCodes().size);
    expect(new Map(rows.map((r) => [r.area_key, [r.level_raw, r.level]]))).toEqual(
      new Map(want.map((a) => [a.area, [a.levelRaw, a.level]])),
    );
    expect(out.warnings?.mode === 'snapshot' ? Date.parse(out.warnings.at) : 0).toBe(NOW);
    const map = sectionMap();
    for (const s of expected.stations.filter((x) => x.source === 'FR-5'))
      expect([s.id, map.get(s.id)]).toEqual([s.id, s.area]);
    // The levels the issue names: two sections at 2, two at 3 (the 2023 flood) and one at 4 (no recording has it).
    expect(new Set(want.map((a) => a.levelRaw))).toEqual(new Set(['1', '2', '3', '4']));
    expect(want.filter((a) => a.levelRaw === '4')).toHaveLength(1);
  });

  it('LU-5: the red alert on Sud, the orange one on Nord, the Cancel naming the Nord alert exactly, the TEST message dropped', () => {
    const cap = (fixture: string) => normaliseCap(parseCap(scene(fixture).body.toString('utf8')), { fetchedAt: NOW });
    const sud = cap('lu-5-cap-20250908-231502-alert-lvl1');
    const nord = cap('lu-5-cap-20250908-231507-alert-lvl2');
    for (const [out, area] of [
      [sud, 'Sud du Luxembourg'],
      [nord, 'Nord du Luxembourg'],
    ] as const) {
      const row = out.warnings?.mode === 'message' ? out.warnings.rows[0] : undefined;
      const want = expected.areas.find((a) => a.source === 'LU-5' && a.area === area);
      expect(out.dropped).toEqual({});
      expect([row?.area_key, row?.level_raw, row?.level]).toEqual([area, want?.levelRaw, want?.level]);
      // Valid from the (shifted) message to the (shifted) expiry, 9 hours of the alert behind the drill clock.
      expect(Date.parse(row?.valid_from ?? '')).toBeLessThanOrEqual(NOW - 9 * 3600_000 + 5000);
      expect(Date.parse(row?.valid_to ?? '')).toBeGreaterThan(NOW);
    }
    const cancel = cap('lu-5-cap-20250909-080450-cancel');
    const closes = cancel.warnings?.mode === 'message' ? cancel.warnings.cancels : [];
    const nordRef = nord.warnings?.mode === 'message' ? nord.warnings.rows[0]?.ref : undefined;
    expect(closes).toEqual([nordRef]);
    const sent = cancel.warnings?.mode === 'message' ? Date.parse(cancel.warnings.sent) : 0;
    expect(sent).toBeLessThan(NOW);
    expect(sent).toBeGreaterThan(
      Date.parse(nord.warnings?.mode === 'message' ? (nord.warnings.rows[0]?.valid_from as string) : ''),
    );
    // The identifiers are not the recorded ones (the real archive's own Cancel of them must not close the drill's alert).
    expect(nordRef).not.toBe('LU-Alert.1757366107.4026.0');
    const test = cap(expected.absent.fixture);
    expect(test.dropped).toEqual({ test: 1 });
    expect(test.warnings).toMatchObject({ mode: 'message', rows: [], cancels: [] });
  });

  it('CH-4: the storm run of station 2020 passes the core bounds (nothing dropped) and has the numbers expected', () => {
    const f = expected.forecast;
    const p = scene('ch-4-forecast-ciaran-it');
    const out = normaliseCh4(parseCh4(p.body), { variant: '2020' });
    expect(out.dropped).toEqual({});
    const run = out.forecasts?.[0];
    expect([run?.target, run?.series, run?.kind, run?.stepMs]).toEqual([
      'CH-1',
      `2020/${f.series}`,
      f.kind,
      f.stepSeconds * 1000,
    ]);
    const checked = checkRun(run as NonNullable<typeof run>, NOW, FORECAST_SOURCES['CH-4']);
    expect(checked.dropped).toEqual({});
    expect(checked.run?.points).toHaveLength(119);
    const pts = run?.points ?? [];
    expect(Math.max(...pts.map((x) => x.p50 as number))).toBeCloseTo(f.medianPeak, 1);
    expect(Math.max(...pts.map((x) => x.vmax as number))).toBeCloseTo(f.vmaxPeak, 1);
    expect(Date.parse(pts[0]?.ts ?? '')).toBe(NOW - f.runStartBeforeFetchSeconds * 1000);
    // The peak is 8 h 26 min 43 s after the fetch, inside the 48 hours forecast/latest.json carries.
    const peak = pts.find((x) => x.p50 === f.medianPeak);
    expect(Date.parse(peak?.ts ?? '') - NOW).toBe((8 * 3600 + 26 * 60 + 43) * 1000);
  });

  it('DE-2: the truncated run sits on Kaub, current at the drill clock, nothing dropped', () => {
    const o = expected.owner;
    const out = normaliseDe2(parseDe2(scene('de-2-wv-truncated.synthetic').body), {
      variant: '1d26e504-7f9e-480a-b52c-5932be6549ab',
    });
    expect(out.dropped).toEqual({});
    const run = out.forecasts?.[0];
    expect(run?.target).toBe('DE-1');
    expect(run?.points).toHaveLength(o.points);
    expect(Math.min(...(run?.points ?? []).map((x) => x.value as number))).toBe(o.valueMin);
    expect(Math.max(...(run?.points ?? []).map((x) => x.value as number))).toBe(o.valueMax);
    expect(Date.parse(run?.issuedAt ?? '')).toBe(NOW - 10 * 60_000);
    const checked = checkRun(run as NonNullable<typeof run>, NOW, FORECAST_SOURCES['DE-2']);
    expect(checked.dropped).toEqual({});
    // Kaub is the station of the LHP class 4 too: the same de.wsv.25700100.
    expect(o.station).toBe('de.wsv.25700100');
  });
});
