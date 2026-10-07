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

  it('a class with several bounds at one priority is seasonal: lines only, the others stay zones', () => {
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
    // the four Normaal rows (two From, two To) are line rows
    expect(k.items.filter((i) => i.kind === 'line')).toHaveLength(4);
  });

  it('the same stem twice with different bounds at one priority is seasonal (hellevoetsluis)', () => {
    const k = marks([...cls(3, 'Normaal (> 0cm)', 0, 80), ...cls(3, 'Normaal (> 0cm)', 0, 90)]);
    expect(k.zones).toEqual([]);
    expect(k.items.every((i) => i.kind === 'line')).toBe(true);
  });

  it('an unknown stem draws lines only, and its label stays text', () => {
    const k = marks(cls(0, '<img src=x onerror=alert(1)> {x}', 100, 1000));
    expect(k.zones).toEqual([]);
    expect(k.items.map((i) => i.name)).toEqual([
      '<img src=x onerror=alert(1)> {x}',
      '<img src=x onerror=alert(1)> {x}',
    ]);
  });

  it('two overlapping classes are both drawn', () => {
    const k = marks([...cls(0, 'Normaal (100 - 300cm)', 100, 300), ...cls(1, 'Verhoogd (250 - 400cm)', 250, 400)]);
    expect(k.zones.map(bounds)).toEqual([
      ['normal', 100, 300],
      ['elevated', 250, 400],
    ]);
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
