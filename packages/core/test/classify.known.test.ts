import { describe, expect, it } from 'vitest';
import {
  type AreaIn,
  attachArea,
  type ClassIn,
  classify,
  classSeries,
  deltaH,
  inSeason,
  monthDay,
  nl4Stem,
  pointIn,
  QC,
  type RefIn,
  type SeriesIn,
} from '../src/index.ts';

// Known answers of the classifier (PHASES P7b; plan §1 and §2): the Kaub examples, partial sets, the priority of the
// groups, tidal and impounded series, areas, the NL-4 display classes, the owner audience and the flags.

const T = Date.UTC(2026, 5, 15, 12);
const MS_HOUR = 3_600_000;

const ref = (source: string, kind: string, value: number, o: Partial<RefIn> = {}): RefIn => ({
  source,
  kind,
  value,
  unit: 'cm',
  convention: null,
  period: null,
  seasonFrom: 101,
  seasonTo: 1231,
  priority: 0,
  label: null,
  ...o,
});
const cls = (source: string, code: string, fresh = true): ClassIn => ({ source, code, fresh });
const area = (source: string, levelRaw: string | null, o: Partial<AreaIn> = {}): AreaIn => ({
  source,
  key: `${source}-area`,
  name: null,
  levelRaw,
  fresh: true,
  ...o,
});
const series = (o: Partial<SeriesIn> = {}): SeriesIn => ({
  quantity: 'H',
  valueKind: 'stage',
  value: 100,
  qc: 0,
  ageMs: 0,
  stalenessMs: 3 * MS_HOUR,
  t: T,
  refs: [],
  classes: [],
  areas: [],
  tidal: false,
  impounded: false,
  ...o,
});

const PERIOD = ['2010-11-01', '2020-10-31'] as const;
const KAUB = [
  ref('DE-1', 'MNW', 65, { period: PERIOD }),
  ref('DE-1', 'MHW', 544, { period: PERIOD }),
  ref('DE-1', 'HSW', 640, { period: PERIOD }),
];
const kaub = (value: number, lhp: string | null) =>
  classify(series({ value, refs: KAUB, classes: lhp === null ? [] : [cls('DE-6', lhp)] }), 'public');

describe('Kaub (the examples of the plan)', () => {
  it('9 cm under MNW 65 is low, from the statistics, whatever the no-flood class says', () => {
    const r = kaub(9, 'RP:0');
    expect(r.state).toBe('low');
    expect(r.section).toBe(false);
    expect(r.basis).toEqual({
      source: 'DE-1',
      kind: 'statistical',
      measure: 'stage',
      ref: 'MNW',
      label: 'WSV MNW 2010–2020',
    });
  });

  it('the low bound is inclusive: 65 is low, 66 is normal with the LHP class as basis', () => {
    expect(kaub(65, 'RP:0').state).toBe('low');
    const r = kaub(66, 'RP:0');
    expect(r.state).toBe('normal');
    expect(r.basis).toMatchObject({ source: 'DE-6', kind: 'operational', ref: 'RP:0', label: 'LHP RP:0' });
  });

  it('600 cm: LHP 0 holds it at normal, LHP 1 makes it elevated', () => {
    expect(kaub(600, 'RP:0').state).toBe('normal');
    expect(kaub(600, 'RP:1').state).toBe('elevated');
  });

  it('700 cm: LHP 2 is high, LHP 3 extreme', () => {
    expect(kaub(700, 'RP:2').state).toBe('high');
    const r = kaub(700, 'RP:3');
    expect(r.state).toBe('extreme');
    expect(r.basis?.source).toBe('DE-6');
  });

  it('700 cm without a usable LHP class: HSW decides (high, no extreme from statistics)', () => {
    const r = kaub(700, 'RP:-1');
    expect(r.state).toBe('high');
    expect(r.basis).toMatchObject({ source: 'DE-1', kind: 'statistical', label: 'WSV HSW 2010–2020' });
  });

  it('544 cm = MHW without a class: elevated, a threshold is reached at its value', () => {
    const r = kaub(544, 'RP:none');
    expect(r.state).toBe('elevated');
    expect(r.basis?.label).toBe('WSV MHW 2010–2020');
    expect(kaub(543, 'RP:none').state).toBe('normal');
    expect(kaub(640, 'RP:none').state).toBe('high');
  });
});

describe('no reference is no_ref, never a guess', () => {
  it('a station without references, classes or areas', () => {
    expect(classify(series(), 'public')).toMatchObject({ state: 'no_ref', basis: null, section: false, area: null });
    expect(classify(series(), 'owner').state).toBe('no_ref');
  });

  it('references of another quantity or unit do not reach the series', () => {
    const q = [ref('DE-1', 'MHW', 50, { unit: 'm³/s' }), ref('DE-1', 'HSW', 60, { unit: 'm³/s' })];
    expect(classify(series({ value: 100, refs: q }), 'public').state).toBe('no_ref');
    const h = [ref('DE-1', 'MHW', 50), ref('DE-1', 'HSW', 60)];
    expect(classify(series({ quantity: 'Q', valueKind: null, value: 100, refs: h }), 'public').state).toBe('no_ref');
  });

  it('a reference kind or source the table does not have, and a class with no code, decide nothing', () => {
    const refs = [ref('DE-1', 'NOPE', 1), ref('XX-1', 'MHW', 1)];
    expect(classify(series({ refs, classes: [cls('XX-1', '3'), cls('DE-6', 'RP:99')] }), 'owner').state).toBe('no_ref');
  });

  it('only MNW: at or below is low, above is undetermined', () => {
    const refs = [ref('DE-1', 'MNW', 65)];
    expect(classify(series({ value: 65, refs }), 'public').state).toBe('low');
    expect(classify(series({ value: 66, refs }), 'public')).toMatchObject({ state: 'no_ref', basis: null });
  });

  it('only HSW: below is undetermined, at or above is high', () => {
    const refs = [ref('DE-1', 'HSW', 640)];
    expect(classify(series({ value: 639, refs }), 'public').state).toBe('no_ref');
    expect(classify(series({ value: 640, refs }), 'public').state).toBe('high');
  });

  it('a series without a value is classed from its classes only', () => {
    const r = classify(series({ value: null, refs: KAUB, classes: [cls('DE-6', 'RP:2')] }), 'public');
    expect(r.state).toBe('high');
    expect(classify(series({ value: null, refs: KAUB }), 'public').state).toBe('no_ref');
  });

  it('a low class value does not exist: LHP -1, none and BAFU undefined are no_ref', () => {
    for (const c of [cls('DE-6', 'RP:-1'), cls('DE-6', 'none'), cls('CH-1', 'undefined')]) {
      expect(classify(series({ classes: [c] }), 'public').state).toBe('no_ref');
    }
  });
});

describe('priority', () => {
  it('operational wins over statistical where they disagree', () => {
    const refs = [
      ref('DE-7', 'LANUV_INFO_1', 100),
      ref('DE-7', 'LANUV_INFO_2', 200),
      ref('DE-1', 'MNW', 10),
      ref('DE-1', 'MHW', 160),
    ];
    const r = classify(series({ value: 150, refs }), 'public');
    expect(r.state).toBe('elevated');
    expect(r.basis).toMatchObject({ source: 'DE-7', kind: 'operational', ref: 'LANUV_INFO_1' });
  });

  it('a class wins over statistics too (LHP 2 at a value statistics call normal)', () => {
    const r = classify(series({ value: 300, refs: KAUB, classes: [cls('DE-6', 'RP:2')] }), 'public');
    expect(r.state).toBe('high');
    expect(r.basis?.source).toBe('DE-6');
  });

  it('a no-flood class never overrides a statistical low (LHP 0 and BAFU 1)', () => {
    for (const c of [cls('DE-6', 'RP:0'), cls('CH-1', '1')]) {
      expect(classify(series({ value: 9, refs: KAUB, classes: [c] }), 'public').state).toBe('low');
    }
  });

  it('statistics beat an NL-4 display class', () => {
    const refs = [
      ref('DE-1', 'MHW', 100),
      ref('NL-4', 'NL4_FROM', 0, { label: 'Normaal (0 tot 500cm)' }),
      ref('NL-4', 'NL4_TO', 500, { label: 'Normaal (0 tot 500cm)' }),
    ];
    expect(classify(series({ value: 150, refs }), 'public').state).toBe('elevated');
  });
});

describe('tidal and impounded series', () => {
  it('tidal: statistics and NL-4 are ignored, an operational class is kept', () => {
    const nl4 = [
      ref('NL-4', 'NL4_FROM', 0, { label: 'Hoogwater (>0cm)' }),
      ref('NL-4', 'NL4_TO', 500, { label: 'Hoogwater (>0cm)' }),
    ];
    expect(classify(series({ value: 9, tidal: true, refs: [...KAUB, ...nl4] }), 'public').state).toBe('no_ref');
    expect(classify(series({ value: 9, refs: nl4 }), 'public').state).toBe('high');
    const r = classify(series({ value: 9, tidal: true, refs: KAUB, classes: [cls('DE-6', 'RP:2')] }), 'public');
    expect(r).toMatchObject({ state: 'high', flags: { tidal: true } });
  });

  it('tidal: an operational reference set still classifies', () => {
    const refs = [ref('DE-7', 'LANUV_INFO_1', 100)];
    expect(classify(series({ value: 150, tidal: true, refs }), 'public').state).toBe('elevated');
  });

  it('impounded stage: the low bound of a statistical set is ignored, the high side is kept', () => {
    const imp = (value: number) => classify(series({ value, impounded: true, refs: KAUB }), 'public');
    expect(imp(9).state).toBe('no_ref');
    expect(imp(100).state).toBe('no_ref');
    expect(imp(544).state).toBe('elevated');
    expect(imp(700).state).toBe('high');
    expect(imp(9).flags.impounded).toBe(true);
  });

  it('impounded level series are not affected', () => {
    const r = classify(series({ value: 9, valueKind: 'level', impounded: true, refs: KAUB }), 'public');
    expect(r.state).toBe('low');
  });
});

describe('freshness', () => {
  it('a class with fresh: false is ignored', () => {
    expect(classify(series({ classes: [cls('DE-6', 'RP:3', false)] }), 'public').state).toBe('no_ref');
    const r = classify(series({ value: 300, refs: KAUB, classes: [cls('DE-6', 'RP:3', false)] }), 'public');
    expect(r.state).toBe('normal'); // from the statistics alone
    expect(r.basis?.source).toBe('DE-1');
  });

  it('an area with fresh: false is ignored', () => {
    expect(classify(series({ areas: [area('FR-5', '4', { fresh: false })] }), 'public').state).toBe('no_ref');
    const fresh = [area('FR-5', '2', { key: 'a' }), area('FR-5', '4', { key: 'b', fresh: false })];
    expect(classify(series({ areas: fresh }), 'public')).toMatchObject({ state: 'elevated', section: true });
  });
});

describe('areas', () => {
  it('a gauge state wins and the area is returned alongside', () => {
    const r = classify(
      series({ value: 9, refs: KAUB, areas: [area('FR-5', '3', { key: 'tr-1', name: 'Seine' })] }),
      'public',
    );
    expect(r.state).toBe('low');
    expect(r.section).toBe(false);
    expect(r.area).toEqual({
      state: 'high',
      basis: { source: 'FR-5', kind: 'area', measure: 'area', ref: 'tr-1', label: 'Vigicrues Seine' },
    });
  });

  it('an area alone gives a section state', () => {
    const r = classify(series({ areas: [area('LU-5', 'ALERT_LVL_2', { key: 'zone-7', name: null })] }), 'public');
    expect(r).toMatchObject({ state: 'high', section: true, area: null });
    expect(r.basis).toEqual({
      source: 'LU-5',
      kind: 'area',
      measure: 'area',
      ref: 'zone-7',
      label: 'LU-Alert zone-7',
    });
  });

  it('several areas: the highest level, whatever the order', () => {
    const a = [
      area('FR-5', '2', { key: 'a' }),
      area('CH-5', '4', { key: 'b' }),
      area('LU-5', 'ALERT_LVL_3', { key: 'c' }),
    ];
    for (const areas of [a, [...a].reverse()]) {
      const r = classify(series({ areas }), 'public');
      expect(r.state).toBe('extreme');
      expect(r.basis?.ref).toBe('b');
    }
  });

  it('a no-flood or unmapped area is no_ref, a null level too', () => {
    expect(
      classify(series({ areas: [area('CH-5', '0'), area('FR-5', null), area('DE-6', '3')] }), 'public').state,
    ).toBe('no_ref');
    expect(classify(series({ areas: [area('XX-9', '1')] }), 'public').state).toBe('no_ref');
  });

  it('a gauge no_ref (a class that decides nothing) leaves the area as the state', () => {
    const r = classify(series({ classes: [cls('DE-6', 'RP:-1')], areas: [area('FR-5', '2')] }), 'public');
    expect(r).toMatchObject({ state: 'elevated', section: true });
  });
});

describe('classSeries', () => {
  const H = { quantity: 'H' as const, id: 'h' };
  const Q = { quantity: 'Q' as const, id: 'q' };
  it('DE-6 reaches the H series, CH-1 the Q series', () => {
    expect(classSeries('DE-6', [Q, H])).toBe(H);
    expect(classSeries('CH-1', [H, Q])).toBe(Q);
  });
  it('a CH-1 lake or H-only station: its H series', () => {
    expect(classSeries('CH-1', [H])).toBe(H);
  });
  it('a station without series has none', () => {
    expect(classSeries('DE-6', [])).toBeUndefined();
  });
});

describe('NL-4 display classes', () => {
  /** The FROM and TO rows of one band, as the registry sync stores them. */
  const band = (label: string, from: number | null, to: number | null, o: Partial<RefIn> = {}): RefIn[] => [
    ...(from === null ? [] : [ref('NL-4', 'NL4_FROM', from, { label, ...o })]),
    ...(to === null ? [] : [ref('NL-4', 'NL4_TO', to, { label, ...o })]),
  ];
  const nl4 = (value: number, refs: RefIn[], t = T) => classify(series({ value, refs, t }), 'public');

  const LEGEND = [
    ...band('Verlaagde waterstand (<100cm)', null, 100, { priority: 4 }),
    ...band('Normale waterstand (100 tot 200cm)', 100, 200, { priority: 3 }),
    ...band('Licht verhoogd (>200cm)', 200, 300, { priority: 2 }),
    ...band('Hoogwater (>300cm)', 300, 400, { priority: 1 }),
    ...band('Extreem hoogwater (>400cm)', 400, null, { priority: 0 }),
  ];

  it('bands are [from, to): the lower bound is in, the upper bound is in the next band', () => {
    const at = (v: number) => nl4(v, LEGEND).state;
    expect([at(99.99), at(100), at(199.99), at(200), at(299.99), at(300), at(399.99), at(400)]).toEqual([
      'low',
      'normal',
      'normal',
      'elevated',
      'elevated',
      'high',
      'high',
      'extreme',
    ]);
  });

  it('open-ended bands match far away', () => {
    expect(nl4(-9999, LEGEND).state).toBe('low');
    expect(nl4(99999, LEGEND).state).toBe('extreme');
  });

  it('basis: kind provider_class, ref the stem, label with the agency and the full workbook label', () => {
    expect(nl4(250, LEGEND).basis).toEqual({
      source: 'NL-4',
      kind: 'provider_class',
      measure: 'stage',
      ref: 'Licht verhoogd',
      label: 'RWS Waterinfo: Licht verhoogd (>200cm)',
    });
  });

  it('measure follows the series: discharge for a Q series', () => {
    const refs = LEGEND.map((r) => ({ ...r, unit: 'm³/s' }));
    const r = classify(series({ quantity: 'Q', valueKind: null, value: 250, refs }), 'public');
    expect(r.basis?.measure).toBe('discharge');
  });

  it('overlapping bands: the lowest priority number wins', () => {
    const refs = [
      ...band('Normaal (0 tot 100cm)', 0, 100, { priority: 5 }),
      ...band('Hoogwater (>50cm)', 50, 150, { priority: 1 }),
    ];
    expect(nl4(60, refs).state).toBe('high');
    expect(nl4(30, refs).state).toBe('normal');
    const swapped = [
      ...band('Normaal (0 tot 100cm)', 0, 100, { priority: 1 }),
      ...band('Hoogwater (>50cm)', 50, 150, { priority: 5 }),
    ];
    expect(nl4(60, swapped).state).toBe('normal');
  });

  it('FROM and TO rows pair by season and priority, not by label', () => {
    const refs = [
      ...band('Hoogwater (>100cm)', 100, 200, { priority: 1 }),
      ref('NL-4', 'NL4_TO', 120, { label: 'Normaal (<120cm)', priority: 2 }),
    ];
    expect(nl4(150, refs).state).toBe('high');
    expect(nl4(50, refs).state).toBe('normal');
  });

  it('a season that wraps the year, read in the Europe/Amsterdam calendar', () => {
    const winter = band('Hoogwater (>0cm)', 0, 1000, { seasonFrom: 1101, seasonTo: 331 });
    expect(nl4(5, winter, Date.UTC(2026, 0, 15, 12)).state).toBe('high');
    expect(nl4(5, winter, Date.UTC(2026, 10, 1, 12)).state).toBe('high');
    expect(nl4(5, winter, Date.UTC(2026, 5, 15, 12)).state).toBe('no_ref');
    expect(nl4(5, winter, Date.UTC(2026, 3, 1, 12)).state).toBe('no_ref');
  });

  it('2026-04-30T22:30Z is 1 May in Amsterdam: the May season matches, the April one does not', () => {
    const t = Date.UTC(2026, 3, 30, 22, 30);
    expect(monthDay(t)).toBe(501);
    expect(monthDay(Date.UTC(2026, 3, 30, 21, 30))).toBe(430);
    const may = band('Hoogwater (>0cm)', 0, 1000, { seasonFrom: 501, seasonTo: 531 });
    const april = band('Hoogwater (>0cm)', 0, 1000, { seasonFrom: 401, seasonTo: 430 });
    expect(nl4(5, may, t).state).toBe('high');
    expect(nl4(5, april, t).state).toBe('no_ref');
    // the winter clock: 23:30Z on 31 December is 1 January in Amsterdam
    expect(monthDay(Date.UTC(2026, 11, 31, 23, 30))).toBe(101);
  });

  it('inSeason is inclusive at both ends and wraps when from > to', () => {
    expect([
      inSeason(501, 501, 531),
      inSeason(531, 501, 531),
      inSeason(500, 501, 531),
      inSeason(601, 501, 531),
    ]).toEqual([true, true, false, false]);
    expect([
      inSeason(1231, 1101, 331),
      inSeason(101, 1101, 331),
      inSeason(331, 1101, 331),
      inSeason(401, 1101, 331),
    ]).toEqual([true, true, true, false]);
  });

  it('an unknown stem decides nothing; so does "Geen klasse-indeling"', () => {
    expect(nl4(5, band('Onbekende klasse (>0cm)', 0, 10)).state).toBe('no_ref');
    expect(nl4(5, band('Geen klasse-indeling', 0, 10)).state).toBe('no_ref');
  });

  it('a band row without a label is ignored', () => {
    expect(nl4(5, [ref('NL-4', 'NL4_FROM', 0), ref('NL-4', 'NL4_TO', 10)]).state).toBe('no_ref');
  });

  it('nl4Stem drops the bracketed bound only', () => {
    expect(nl4Stem('Licht verhoogd (>1015cm)')).toBe('Licht verhoogd');
    expect(nl4Stem('Hoogwater / Stormvloed (>300cm)')).toBe('Hoogwater / Stormvloed');
    expect(nl4Stem('Geen klasse-indeling')).toBe('Geen klasse-indeling');
  });
});

describe('owner rows in the public family', () => {
  const lu4 = [ref('LU-4', 'LU4_ORANGE', 100), ref('LU-4', 'LU4_RED', 200)];
  const be3 = [ref('BE-3', 'P05', 50, { convention: 'non_exceedance' })];

  it('LU-4 references are ignored in public and used in owner', () => {
    expect(classify(series({ value: 150, refs: lu4 }), 'public')).toMatchObject({ state: 'no_ref', basis: null });
    const r = classify(series({ value: 150, refs: lu4 }), 'owner');
    expect(r.state).toBe('high');
    expect(r.basis).toMatchObject({ source: 'LU-4', kind: 'operational', label: 'AGE orange' });
  });

  it('a BE-3 percentile is ignored in public and used in owner', () => {
    expect(classify(series({ value: 40, refs: be3 }), 'public').state).toBe('no_ref');
    const r = classify(series({ value: 40, refs: be3 }), 'owner');
    expect(r.state).toBe('low');
    expect(r.basis?.source).toBe('BE-3');
  });

  it('a BE-3 class never classifies, in either family', () => {
    const c = [cls('BE-3', 't3/alert')];
    expect(classify(series({ classes: c }), 'public').state).toBe('no_ref');
    expect(classify(series({ classes: c }), 'owner').state).toBe('no_ref');
  });

  it('owner rows do not disturb a public state', () => {
    const r = classify(series({ value: 9, refs: [...KAUB, ...lu4, ...be3] }), 'public');
    expect(r.state).toBe('low');
    expect(r.basis?.source).toBe('DE-1');
  });
});

describe('attachArea', () => {
  const square = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  };
  const stations = [
    { id: 'in', lon: 5, lat: 5 },
    { id: 'out', lon: 50, lat: 5 },
    { id: 'nocoord', lon: null, lat: null },
    { id: 'ch.bafu.2091', lon: 5, lat: 5 },
  ];

  it('FR-5: by the section map only', () => {
    const sections = new Map([
      ['in', 'T1'],
      ['out', 'T2'],
    ]);
    expect(attachArea({ source: 'FR-5', key: 'T1', geometry: null }, stations, sections)).toEqual(['in']);
    expect(attachArea({ source: 'FR-5', key: 'T9', geometry: square }, stations, sections)).toEqual([]);
  });

  it('CH-5 river:<n> and lake:<n>: ch.bafu.<n>, only if that station exists', () => {
    const none = new Map<string, string>();
    expect(attachArea({ source: 'CH-5', key: 'river:2091', geometry: null }, stations, none)).toEqual(['ch.bafu.2091']);
    expect(attachArea({ source: 'CH-5', key: 'lake:2091', geometry: null }, stations, none)).toEqual(['ch.bafu.2091']);
    expect(attachArea({ source: 'CH-5', key: 'river:9999', geometry: null }, stations, none)).toEqual([]);
    expect(attachArea({ source: 'CH-5', key: 'river:2091x', geometry: square }, stations, none)).toEqual([
      'in',
      'ch.bafu.2091',
    ]);
  });

  it('a hydro_region polygon (CH-5), LU-5 zones and DE-6 regions attach to the stations inside', () => {
    const none = new Map<string, string>();
    for (const [source, key] of [
      ['CH-5', 'hydro_region:3'],
      ['LU-5', 'zone-1'],
      ['DE-6', 'region-1'],
    ] as const) {
      expect(attachArea({ source, key, geometry: square }, stations, none)).toEqual(['in', 'ch.bafu.2091']);
    }
  });

  it('a LineString or MultiLineString attaches nothing', () => {
    const line = {
      type: 'LineString',
      coordinates: [
        [5, 5],
        [6, 6],
      ],
    };
    const lines = {
      type: 'MultiLineString',
      coordinates: [
        [
          [5, 5],
          [6, 6],
        ],
      ],
    };
    for (const geometry of [line, lines]) {
      expect(attachArea({ source: 'DE-6', key: 'river-1', geometry }, stations, new Map())).toEqual([]);
    }
  });
});

describe('pointIn', () => {
  const holed = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
  };
  it('a hole is outside', () => {
    expect(pointIn(2, 2, holed)).toBe(true);
    expect(pointIn(5, 5, holed)).toBe(false);
    expect(pointIn(20, 5, holed)).toBe(false);
  });
  it('a MultiPolygon holds any of its polygons, and a Feature unwraps', () => {
    const multi = {
      type: 'MultiPolygon',
      coordinates: [
        holed.coordinates,
        [
          [
            [20, 20],
            [30, 20],
            [30, 30],
            [20, 30],
            [20, 20],
          ],
        ],
      ],
    };
    expect(pointIn(25, 25, multi)).toBe(true);
    expect(pointIn(5, 5, multi)).toBe(false);
    expect(pointIn(2, 2, multi)).toBe(true);
    expect(pointIn(25, 25, { type: 'Feature', geometry: multi })).toBe(true);
  });
  it('anything that is not a polygon contains nothing', () => {
    for (const g of [
      null,
      undefined,
      'x',
      3,
      { type: 'Point', coordinates: [5, 5] },
      { type: 'Polygon', coordinates: 'x' },
      { type: 'MultiPolygon', coordinates: 'x' },
    ]) {
      expect(pointIn(5, 5, g)).toBe(false);
    }
  });
});

describe('flags', () => {
  const flags = (o: Partial<SeriesIn>) => classify(series(o), 'public').flags;

  it('suspect for QC bits 4, 16, 32 and 64, each alone', () => {
    for (const bit of [QC.PROVIDER_SUSPECT, QC.RANGE, QC.SPIKE, QC.FROZEN]) {
      expect(flags({ qc: bit }).suspect, String(bit)).toBe(true);
    }
  });

  it('not suspect for bits 1, 2, 8 and 512, nor for none', () => {
    for (const bit of [QC.RAW, QC.VALIDATED, QC.ESTIMATED, QC.BACKFILLED, 0, QC.RAW | QC.VALIDATED]) {
      expect(flags({ qc: bit }).suspect, String(bit)).toBe(false);
    }
  });

  it('stale only when the age is over the staleness limit', () => {
    expect(flags({ ageMs: MS_HOUR, stalenessMs: MS_HOUR }).stale).toBe(false);
    expect(flags({ ageMs: MS_HOUR + 1, stalenessMs: MS_HOUR }).stale).toBe(true);
    expect(flags({ value: null, ageMs: 10 * MS_HOUR }).stale).toBe(false);
  });

  it('tidal and impounded are the series flags', () => {
    expect(flags({ tidal: true, impounded: true })).toMatchObject({ tidal: true, impounded: true });
    expect(flags({})).toMatchObject({ tidal: false, impounded: false });
  });
});

describe('deltaH (known answers; the band is in nap.test.ts)', () => {
  it('rises, falls, steady', () => {
    expect(deltaH(110, 100, 'H')).toEqual({ dh: 10, trend: 'rising' });
    expect(deltaH(90, 100, 'H')).toEqual({ dh: -10, trend: 'falling' });
    expect(deltaH(101, 100, 'H')).toEqual({ dh: 1, trend: 'steady' });
  });
});
