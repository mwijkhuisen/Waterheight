import { describe, expect, it } from 'vitest';
import { type MarkOptions, referenceMarks } from '../src/features/station/thresholds.ts';
import { basisLabel } from '../src/lib/labels/labels.ts';

// The threshold model (P10d, closes #88): lines for every reference, zones by the registry's role of the kind
// (METHOD_REFERENCES) and by NL-4 class, one legend row per zone and per zoneless line.

type Refs = Parameters<typeof referenceMarks>[0];
const ref = (source: string, kind: string, value: number, label: string | null = null, priority = 0, unit = 'cm') => ({
  source,
  kind,
  value,
  unit,
  priority,
  label,
});

const opts = (over: Partial<MarkOptions> = {}): MarkOptions => ({
  quantity: 'H',
  conv: (v) => v,
  ours: () => undefined,
  stem: (stem) => basisLabel({ source: 'NL-4', kind: 'provider_class', ref: stem }, over.locale ?? 'en'),
  owner: () => false,
  locale: 'en',
  unit: 'cm NAP',
  t: Date.UTC(2026, 9, 10, 12),
  ...over,
});
const marks = (refs: Refs, over: Partial<MarkOptions> = {}) => referenceMarks(refs, opts(over));
const bounds = (z: { from: number | null; to: number | null; level: string }) => [z.level, z.from, z.to];

describe('referenceMarks: roles', () => {
  it('DE-1: a low zone below MNW, MW a line only, elevated MHW up to HSW, high from HSW', () => {
    const k = marks([
      ref('DE-1', 'MNW', 100),
      ref('DE-1', 'MW', 300),
      ref('DE-1', 'MHW', 500),
      ref('DE-1', 'HSW', 700),
    ] as Refs);
    expect(k.lines).toHaveLength(4);
    expect(k.zones.map(bounds)).toEqual([
      ['low', null, 100],
      ['elevated', 500, 700],
      ['high', 700, null],
    ]);
    expect(k.items.map((i) => [i.kind, i.range])).toEqual([
      ['zone', '≤ 100 cm NAP'],
      ['zone', '500–700 cm NAP'],
      ['zone', '≥ 700 cm NAP'],
      ['line', '300 cm NAP'],
    ]);
  });

  it('shown-only DE-1 kinds are lines with a legend row and no zone', () => {
    const k = marks([ref('DE-1', 'HHW', 900), ref('DE-1', 'MARKE_I', 800), ref('DE-1', 'GLW', 20)] as Refs);
    expect(k.zones).toEqual([]);
    expect(k.items.map((i) => i.kind)).toEqual(['line', 'line', 'line']);
    expect(k.items.map((i) => i.range)).toEqual(['20 cm NAP', '800 cm NAP', '900 cm NAP']);
  });

  it('DE-7: Info 1 and MHW make one elevated zone; Info 2 high; Info 3 extreme; MNW low', () => {
    const k = marks([
      ref('DE-7', 'LANUV_INFO_1', 400),
      ref('DE-7', 'LANUV_INFO_2', 600),
      ref('DE-7', 'LANUV_INFO_3', 800),
      ref('DE-7', 'LANUV_MNW', 50),
      ref('DE-7', 'LANUV_MW', 200),
      ref('DE-7', 'LANUV_MHW', 450),
    ] as Refs);
    expect(k.zones.map(bounds)).toEqual([
      ['low', null, 50],
      ['elevated', 400, 600],
      ['high', 600, 800],
      ['extreme', 800, null],
    ]);
    expect(k.items.filter((i) => i.kind === 'line')).toHaveLength(1);
  });

  it('CH-2 WL2 to WL5 on a discharge: WL4 and WL5 are one extreme zone', () => {
    const q = (kind: string, value: number) => ref('CH-2', kind, value, null, 0, 'm3/s');
    const k = marks([q('WL2', 100), q('WL3', 200), q('WL4', 300), q('WL5', 400)] as Refs, {
      quantity: 'Q',
      unit: 'm³/s',
    });
    expect(k.zones.map(bounds)).toEqual([
      ['elevated', 100, 200],
      ['high', 200, 300],
      ['extreme', 300, null],
    ]);
    expect(k.items.map((i) => i.range)).toEqual(['100–200 m³/s', '200–300 m³/s', '≥ 300 m³/s']);
  });

  it('FR-5 CRUE_<hash> is a line with a legend row, never a zone', () => {
    const k = marks([ref('FR-5', 'CRUE_9f3a2c', 650, 'Crue de 1910')] as Refs);
    expect(k.zones).toEqual([]);
    expect(k.lines).toHaveLength(1);
    expect(k.items).toEqual([{ kind: 'line', name: 'Crue de 1910', range: '650 cm NAP' }]);
  });

  it('a reference with no role (an owner kind, an unknown kind) is a line plus a legend row', () => {
    const k = marks([ref('LU-4', 'VIGILANCE', 123, 'Niveau 2')] as Refs);
    expect(k.zones).toEqual([]);
    expect(k.items).toHaveLength(1);
    expect(k.items[0]?.kind).toBe('line');
  });

  it('keeps the raw label beside our text, and only when they differ', () => {
    const k = marks([ref('DE-1', 'MNW', 100, 'MNW'), ref('DE-1', 'HHW', 900, 'Höchster')] as Refs, {
      ours: (r) => (r.kind === 'MNW' ? 'MNW' : 'Highest'),
    });
    expect(k.items.map((i) => [i.name, i.raw])).toEqual([
      ['MNW', undefined],
      ['Highest', 'Höchster'],
    ]);
  });

  it('converts to the native unit and skips other units', () => {
    const k = marks([ref('DE-1', 'MNW', 1), ref('DE-1', 'MHW', 2, null, 0, 'm3/s')] as Refs, { conv: (v) => v * 100 });
    expect(k.lines.map((l) => l.value)).toEqual([100]);
  });

  it('keeps the owner badge in the line text', () => {
    const k = marks([ref('LU-4', 'X', 5, 'A')] as Refs, { owner: (s) => s === 'LU-4', ours: () => 'ours' });
    expect(k.lines[0]?.text).toContain('A');
    expect(k.lines[0]?.text).toContain('ours');
    expect(k.lines[0]?.text).toContain('owner only');
  });

  it('marks the legend rows of an owner source too, zones and lines, and no public row (review round 1)', () => {
    const owner = (s: string) => s === 'DE-1';
    const k = marks([ref('DE-1', 'MNW', 100), ref('DE-1', 'MW', 300), ref('DE-7', 'MHW', 500)] as Refs, { owner });
    expect(k.items.map((i) => [i.kind, i.range, i.owner])).toEqual([
      ['zone', '≤ 100 cm NAP', true],
      ['line', '300 cm NAP', true],
      ['line', '500 cm NAP', undefined],
    ]);
  });

  it('has no zone, no row and no NL-4 flag without references', () => {
    expect(marks([])).toEqual({ lines: [], zones: [], items: [], hasNl4: false });
  });
});

describe('referenceMarks: NL-4 classes', () => {
  const cls = (priority: number, label: string, from: number | null, to: number | null) =>
    [
      ...(from === null ? [] : [ref('NL-4', 'NL4_FROM', from, label, priority)]),
      ...(to === null ? [] : [ref('NL-4', 'NL4_TO', to, label, priority)]),
    ] as Refs;
  const whole = [
    ...cls(0, 'Laagwater (< 100cm)', null, 100),
    ...cls(1, 'Normaal (100 - 200cm)', 100, 200),
    ...cls(2, 'Licht verhoogd (200 - 300cm)', 200, 300),
    ...cls(3, 'Verhoogd (300 - 400cm)', 300, 400),
    ...cls(4, 'Hoogwater (400 - 500cm)', 400, 500),
    ...cls(5, 'Extreem (> 500cm)', 500, null),
  ];

  it('a whole-year set gives one zone per class, bounded by its From and To', () => {
    const k = marks(whole);
    expect(k.hasNl4).toBe(true);
    expect(k.zones.map(bounds)).toEqual([
      ['low', null, 100],
      ['normal', 100, 200],
      ['elevated', 200, 300],
      ['elevated', 300, 400],
      ['high', 400, 500],
      ['extreme', 500, null],
    ]);
    expect(k.items.every((i) => i.kind === 'zone')).toBe(true);
    expect(k.lines).toHaveLength(10);
  });

  it('without seasons (a file before #99), a class with several bounds at one priority is lines only', () => {
    const k = marks([
      ...cls(0, 'Laagwater (< 100cm)', null, 100),
      // Lobith-Q-like: "Normaal" has one From per season
      ...cls(1, 'Normaal (100 - 200cm)', 100, 200),
      ...cls(1, 'Normaal (120 - 200cm)', 120, 200),
      ...cls(2, 'Verhoogd (200 - 300cm)', 200, 300),
    ]);
    expect(k.zones.map(bounds)).toEqual([
      ['low', null, 100],
      ['elevated', 200, 300],
    ]);
    // the four Normaal rows (two From, two To) are line rows, named by the stem; the label stays raw
    const rows = k.items.filter((i) => i.kind === 'line');
    expect(rows).toHaveLength(4);
    expect(rows.map((i) => i.name)).toEqual(Array(4).fill('Normal (Waterinfo class)'));
    expect(rows.map((i) => i.raw)).toEqual([
      'Normaal (100 - 200cm)',
      'Normaal (120 - 200cm)',
      'Normaal (100 - 200cm)',
      'Normaal (120 - 200cm)',
    ]);
  });

  it('a seasonal class without our text is named by its stem, never by the whole label', () => {
    const long = `Zomerpeil (${'x'.repeat(600)})`;
    const k = marks([...cls(2, long, 0, 80), ...cls(2, long, 0, 90)]);
    expect(k.items.map((i) => i.name)).toEqual(Array(4).fill('Zomerpeil'));
    expect(k.items.every((i) => i.raw === long)).toBe(true);
  });

  it('the same stem twice with different bounds at one priority is seasonal (hellevoetsluis)', () => {
    const k = marks([...cls(3, 'Normaal (> 0cm)', 0, 80), ...cls(3, 'Normaal (> 0cm)', 0, 90)]);
    expect(k.zones).toEqual([]);
    expect(k.items.every((i) => i.kind === 'line')).toBe(true);
  });

  it('an unknown stem draws lines only, named by the stem; its label stays text', () => {
    const k = marks(cls(0, '<img src=x onerror=alert(1)> {x}', 100, 1000));
    expect(k.zones).toEqual([]);
    expect(k.items.map((i) => [i.name, i.raw])).toEqual([
      ['<img src=x onerror=alert', '<img src=x onerror=alert(1)> {x}'],
      ['<img src=x onerror=alert', '<img src=x onerror=alert(1)> {x}'],
    ]);
  });

  it('two overlapping classes are both drawn', () => {
    const k = marks([...cls(0, 'Normaal (100 - 300cm)', 100, 300), ...cls(1, 'Verhoogd (250 - 400cm)', 250, 400)]);
    expect(k.zones.map(bounds)).toEqual([
      ['normal', 100, 300],
      ['elevated', 250, 400],
    ]);
  });

  describe('seasons (#99)', () => {
    const season = (refs: Refs, from: number, to: number) => refs.map((r) => ({ ...r, season: { from, to } })) as Refs;
    // Lobith-H-like: one whole-year class above, and "Verlaagd" and "Normaal" per season.
    const lobith = [
      ...cls(3, 'Licht verhoogd (>1200cm)', 1200, 1300),
      ...season([...cls(4, 'Verlaagd (<810cm)', null, 810), ...cls(5, 'Normaal (810 - 1200cm)', 810, 1200)], 501, 531),
      ...season([...cls(4, 'Verlaagd (<770cm)', null, 770), ...cls(5, 'Normaal (770 - 1200cm)', 770, 1200)], 701, 731),
      ...season([...cls(4, 'Verlaagd (<745cm)', null, 745), ...cls(5, 'Normaal (745 - 1200cm)', 745, 1200)], 801, 831),
      ...season([...cls(4, 'Verlaagd (<720cm)', null, 720), ...cls(5, 'Normaal (720 - 1200cm)', 720, 1200)], 1001, 430),
    ];
    const at = (t: number) => marks(lobith, { t });
    const iso = (s: string) => Date.parse(s);

    it.each([
      ['May', '2026-05-15T12:00:00Z', 810],
      ['July', '2026-07-15T12:00:00Z', 770],
      ['August', '2026-08-15T12:00:00Z', 745],
      ['the winter, before the new year', '2026-12-15T12:00:00Z', 720],
      ['the winter, after the new year', '2027-02-15T12:00:00Z', 720],
    ])('in %s the seasonal classes are one zone each, with that season’s bounds', (_, t, edge) => {
      const k = at(iso(t));
      expect(k.zones.map(bounds)).toEqual([
        ['low', null, edge],
        ['normal', edge, 1200],
        ['elevated', 1200, 1300],
      ]);
      // the other seasons' rows are left out: no line, no legend row
      expect(k.lines.map((l) => l.value).sort((a, b) => a - b)).toEqual([edge, edge, 1200, 1200, 1300]);
      expect(k.items.every((i) => i.kind === 'zone')).toBe(true);
    });

    it('outside every season (June here) only the whole-year class is left', () => {
      const k = at(iso('2026-06-15T12:00:00Z'));
      expect(k.zones.map(bounds)).toEqual([['elevated', 1200, 1300]]);
      expect(k.lines).toHaveLength(2);
    });

    it.each([
      // summer time (CEST, UTC+2): the day turns at 22:00Z, while UTC still says the earlier date
      ['July → August', '2026-07-31T21:59:59.999Z', 770, '2026-07-31T22:00:00Z', 745],
      ['the winter → May', '2027-04-30T21:59:59.999Z', 720, '2027-04-30T22:00:00Z', 810],
      ['August → nothing', '2026-08-31T21:59:59.999Z', 745, '2026-08-31T22:00:00Z', null],
      ['nothing → the winter', '2026-09-30T21:59:59.999Z', null, '2026-09-30T22:00:00Z', 720],
    ])('the edge %s turns at midnight in Amsterdam', (_, before, a, after, b) => {
      const low = (t: string) => at(iso(t)).zones.find((z) => z.level === 'low')?.to ?? null;
      expect(low(before)).toBe(a);
      expect(low(after)).toBe(b);
    });

    it('across the October DST change the edge turns at midnight CET (23:00Z), not CEST', () => {
      // Clocks go back on 2026-10-25 at 01:00Z; a season edge on the 26th follows the winter offset.
      const refs = [
        ...season(cls(5, 'Normaal (700 - 1200cm)', 700, 1200), 401, 1025),
        ...season(cls(5, 'Normaal (720 - 1200cm)', 720, 1200), 1026, 331),
      ];
      const from = (t: string) => marks(refs, { t: iso(t) }).zones.map((z) => z.from);
      expect(from('2026-10-25T00:30:00Z')).toEqual([700]); // 02:30 CEST, before the change
      expect(from('2026-10-25T22:59:59.999Z')).toEqual([700]); // 23:59 CET on the 25th
      expect(from('2026-10-25T23:00:00Z')).toEqual([720]); // 00:00 CET on the 26th
      // and in spring, after clocks go forward on 2027-03-28, the edge on 1 April turns at 22:00Z (CEST)
      expect(from('2027-03-31T21:59:59.999Z')).toEqual([720]);
      expect(from('2027-03-31T22:00:00Z')).toEqual([700]);
    });

    it('two seasons that share an edge day (hellevoetsluis 315–715, 715–315) are lines on that day only', () => {
      const refs = [
        ...season(cls(3, 'Normaal (0 - 80cm)', 0, 80), 315, 715),
        ...season(cls(3, 'Normaal (0 - 90cm)', 0, 90), 715, 315),
      ];
      expect(marks(refs, { t: iso('2026-07-15T12:00:00Z') }).zones).toEqual([]);
      expect(marks(refs, { t: iso('2026-07-16T12:00:00Z') }).zones.map(bounds)).toEqual([['normal', 0, 90]]);
    });
  });

  it('writes the legend text in the page language, with the unit and its zero', () => {
    const refs = cls(0, 'Verlaagd (< 720cm)', null, 720);
    expect(marks(refs, { locale: 'nl' }).items).toEqual([
      expect.objectContaining({ kind: 'zone', name: expect.stringMatching(/^Verlaagd/), range: '< 720 cm NAP' }),
    ]);
    const en = marks(refs, { locale: 'en' }).items[0];
    expect(en?.range).toBe('< 720 cm NAP');
    expect(en?.raw).toBe('Verlaagd (< 720cm)');
  });
});
