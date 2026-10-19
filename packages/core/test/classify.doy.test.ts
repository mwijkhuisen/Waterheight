import { describe, expect, it } from 'vitest';
import { type ClassIn, classify, type Family, type RefIn, type SeriesIn } from '../src/index.ts';

// Our day-of-year climatology in the classifier (P14f, plan §1a.2–3, §3.3; owner 2026-10-18): the "open upward"
// mapping, the day-key filter (UTC, 29 February on 0228), the order inside statistical (provider statistics first),
// the collapses against the candidates around it (operational above, NL-4 below), tidal, impounded and audience.

const T = Date.UTC(2026, 5, 15, 12); // day key 615
const PERIOD = ['1991-01-01', '2000-12-31'] as const;
const LABEL = 'DOY P10/P90 1991–2000';

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
/** A DOY pair as the climatology command stores it (non-exceedance, the period, one day key). */
const doy = (p10: number, p90: number, o: Partial<RefIn> & { md?: number; source?: string } = {}): RefIn[] => {
  const { md = 615, source = 'NL-1', ...rest } = o;
  const base = {
    convention: 'non_exceedance' as const,
    period: PERIOD,
    seasonFrom: md,
    seasonTo: md,
    label: 'DOY P10-P90, 1991-2000, 31 d/yr',
    ...rest,
  };
  return [ref(source, 'P10_DOY', p10, base), ref(source, 'P90_DOY', p90, base)];
};
const series = (value: number, refs: RefIn[], o: Partial<SeriesIn> = {}): SeriesIn => ({
  quantity: 'H',
  valueKind: 'level',
  value,
  qc: 0,
  ageMs: 0,
  stalenessMs: 3_600_000,
  t: T,
  refs,
  classes: [],
  areas: [],
  tidal: false,
  impounded: false,
  ...o,
});
const at = (value: number, refs: RefIn[], o: Partial<SeriesIn> = {}, family: Family = 'public') =>
  classify(series(value, refs, o), family);
/** An NL-4 display class [from, to) with its workbook label. */
const nl4 = (from: number, to: number, label: string) => [
  ref('NL-4', 'NL4_FROM', from, { label }),
  ref('NL-4', 'NL4_TO', to, { label }),
];

describe('the DOY set alone: open upward', () => {
  const SET = doy(100, 200);

  it('at or below P10 is low, between normal, at or above P90 elevated, never higher', () => {
    expect(at(-1e6, SET).state).toBe('low');
    expect(at(100, SET).state).toBe('low');
    expect(at(100.01, SET).state).toBe('normal');
    expect(at(150, SET).state).toBe('normal');
    expect(at(199.99, SET).state).toBe('normal');
    expect(at(200, SET).state).toBe('elevated');
    expect(at(1e9, SET).state).toBe('elevated');
  });

  it('the basis is the row source, statistical, the kinds that decided and a label without an agency', () => {
    const common = { source: 'NL-1', kind: 'statistical', measure: 'level', label: LABEL };
    expect(at(50, SET).basis).toEqual({ ...common, ref: 'P10_DOY' });
    expect(at(150, SET).basis).toEqual({ ...common, ref: 'P10_DOY/P90_DOY' });
    expect(at(250, SET).basis).toEqual({ ...common, ref: 'P90_DOY' });
    expect(at(250, SET).sources).toEqual(['NL-1']);
    // the measure follows the series: a discharge set on a Q series
    const q = doy(100, 200, { unit: 'm³/s', source: 'DE-1' });
    expect(at(250, q, { quantity: 'Q', valueKind: null }).basis).toEqual({
      source: 'DE-1',
      kind: 'statistical',
      measure: 'discharge',
      ref: 'P90_DOY',
      label: LABEL,
    });
  });

  it('a pair whose P10 is not below its P90, or half a pair, decides nothing', () => {
    expect(at(150, doy(150, 150)).state).toBe('no_ref');
    expect(at(1e6, doy(200, 100)).state).toBe('no_ref');
    expect(at(-1e6, [SET[0] as RefIn]).state).toBe('no_ref');
    expect(at(1e6, [SET[1] as RefIn]).state).toBe('no_ref');
    // two rows of one kind on the day (never stored: the key is unique) decide nothing either
    expect(at(150, [...SET, ...doy(90, 210)]).state).toBe('no_ref');
  });

  it('a row of another unit or of the other convention is not used', () => {
    expect(at(250, doy(100, 200, { unit: 'm³/s' })).state).toBe('no_ref');
    expect(at(250, doy(100, 200, { convention: 'exceedance' })).state).toBe('no_ref');
    expect(at(250, doy(100, 200, { convention: null })).state).toBe('no_ref');
  });
});

describe('the day key: UTC, 365 keys', () => {
  it("only the rows of t's own day key are used", () => {
    const rows = [...doy(100, 200, { md: 614 }), ...doy(300, 400, { md: 615 }), ...doy(100, 200, { md: 616 })];
    expect(at(250, rows).state).toBe('low'); // 615: P10 300
    expect(at(250, rows, { t: Date.UTC(2026, 5, 14, 12) }).state).toBe('elevated'); // 614
    expect(at(250, doy(100, 200, { md: 614 })).state).toBe('no_ref');
  });

  it('29 February uses the 0228 rows', () => {
    const rows = [...doy(100, 200, { md: 228 }), ...doy(300, 400, { md: 301 })];
    expect(at(250, rows, { t: Date.UTC(2028, 1, 29, 12) }).state).toBe('elevated');
    expect(at(250, rows, { t: Date.UTC(2028, 1, 28, 12) }).state).toBe('elevated');
    expect(at(250, rows, { t: Date.UTC(2028, 2, 1, 0) }).state).toBe('low');
    expect(at(250, doy(100, 200, { md: 229 }), { t: Date.UTC(2028, 1, 29, 12) }).state).toBe('no_ref');
  });

  it('the day is the UTC day, not the Amsterdam one', () => {
    const rows = [...doy(100, 200, { md: 1231 }), ...doy(300, 400, { md: 101 })];
    // 23:30Z on 31 December is already 1 January in Amsterdam
    expect(at(250, rows, { t: Date.UTC(2026, 11, 31, 23, 30) }).state).toBe('elevated');
    expect(at(250, rows, { t: Date.UTC(2027, 0, 1, 0, 30) }).state).toBe('low');
  });
});

describe('order inside statistical: provider statistics first, our DOY set last', () => {
  const MNW = ref('DE-1', 'MNW', 100, { label: 'MNW', period: ['2010-11-01', '2020-10-31'] });
  const MHW = ref('DE-1', 'MHW', 300, { label: 'MHW', period: ['2010-11-01', '2020-10-31'] });

  it('DE-1 MNW/MHW decides normal, and a DOY set that says elevated is outranked', () => {
    const r = at(250, [MNW, MHW, ...doy(150, 200, { source: 'DE-1' })], { valueKind: 'stage' });
    expect(r.state).toBe('normal');
    expect(r.basis).toMatchObject({ source: 'DE-1', ref: 'MNW/MHW', label: 'WSV MNW/MHW 2010–2020' });
  });

  it('DE-1 MNW/MHW decides low, normal or elevated; a DOY set never moves a decided level', () => {
    const rows = [MNW, MHW, ...doy(50, 400, { source: 'DE-1' })];
    expect(at(80, rows).state).toBe('low'); // the DOY set says normal
    expect(at(80, rows).basis?.ref).toBe('MNW');
    expect(at(350, rows).state).toBe('elevated'); // the DOY set says normal
    expect(at(350, rows).basis?.ref).toBe('MHW');
    expect(at(40, rows).basis?.ref).toBe('MNW'); // both say low: the provider is named
  });

  it('with MHW alone (no low bound) the DOY set refines: low, normal, and elevated collapses to normal', () => {
    const rows = [MHW, ...doy(100, 200, { source: 'DE-1' })];
    expect(at(80, rows).state).toBe('low');
    expect(at(80, rows).basis?.ref).toBe('P10_DOY');
    expect(at(150, rows).state).toBe('normal');
    expect(at(150, rows).basis?.ref).toBe('P10_DOY/P90_DOY');
    // DOY says elevated, MHW (not passed) caps at normal: the provider wins, the interval collapses to its edge
    const collapsed = at(250, rows);
    expect(collapsed.state).toBe('normal');
    expect(collapsed.basis).toEqual({
      source: 'DE-1',
      kind: 'statistical',
      measure: 'level',
      ref: 'MHW/P90_DOY',
      label: `WSV MHW 2010–2020 / ${LABEL}`,
    });
    expect(collapsed.basis?.ref.split('/').some((k) => k.endsWith('_DOY'))).toBe(true);
    // MHW passed: elevated from the provider
    expect(at(320, rows).basis?.ref).toBe('MHW');
  });

  it('a DOY set sorts after the provider sets whatever the source names (BE-3 < DE-1)', () => {
    // An owner DOY set of BE-3 (owner family) beside DE-1's MHW: taken first it would say elevated
    const rows = [MHW, ...doy(100, 200, { source: 'BE-3' })];
    const r = at(250, rows, {}, 'owner');
    expect(r.state).toBe('normal');
    expect(r.basis?.ref).toBe('MHW/P90_DOY');
    expect(r.basis?.source).toBe('DE-1');
    expect(r.sources).toEqual(['DE-1', 'BE-3']);
  });

  it('after an owner provider statistic too: BE-3 P05 then the BE-3 DOY set', () => {
    const p05 = ref('BE-3', 'P05', 100, { convention: 'non_exceedance' });
    const rows = [p05, ...doy(120, 200, { source: 'BE-3' })];
    expect(at(90, rows, {}, 'owner').basis?.ref).toBe('P05'); // both low: the provider is named
    // above P05 SPW says normal (normal..extreme); the DOY low under it collapses to its edge, normal, named by SPW
    expect(at(110, rows, {}, 'owner').state).toBe('normal');
    expect(at(110, rows, {}, 'owner').basis?.ref).toBe('P05');
    // above P90 the DOY set refines SPW's normal to elevated
    expect(at(250, rows, {}, 'owner').basis?.ref).toBe('P90_DOY');
  });
});

describe('around the DOY set: operational above, the NL-4 display class below', () => {
  const SET = doy(100, 200);

  it('an NL-4 high class still shows above the DOY set (it never caps a later candidate)', () => {
    const r = at(250, [...SET, ...nl4(240, 400, 'Hoogwater / Stormvloed (>240cm)')]);
    expect(r.state).toBe('high');
    expect(r.basis).toMatchObject({ source: 'NL-4', kind: 'provider_class' });
    expect(at(150, [...SET, ...nl4(140, 400, 'Hoogwater (>140cm)')]).state).toBe('high');
  });

  it('an NL-4 low class inside P10–P90 collapses to normal, named by the DOY set', () => {
    const r = at(150, [...SET, ...nl4(-100, 160, 'Laagwater (<160cm)')]);
    expect(r.state).toBe('normal');
    expect(r.basis?.ref).toBe('P10_DOY/P90_DOY');
    expect(r.sources).toEqual(['NL-1', 'NL-4']);
  });

  it('an NL-4 normal class above P90 gives elevated, and below P10 low (the DOY set ranks above NL-4)', () => {
    const normal = nl4(-100, 400, 'Normaal (<400cm)');
    expect(at(250, [...SET, ...normal]).state).toBe('elevated');
    expect(at(250, [...SET, ...normal]).basis?.ref).toBe('P90_DOY');
    expect(at(50, [...SET, ...normal]).state).toBe('low');
    expect(at(150, [...SET, ...normal]).basis?.ref).toBe('P10_DOY/P90_DOY');
    // an NL-4 elevated class above P90 agrees: elevated, named by the DOY set (it comes first)
    expect(at(250, [...SET, ...nl4(220, 300, 'Verhoogd (>220cm)')]).basis?.ref).toBe('P90_DOY');
    // without DOY rows nothing changes: NL-4 alone
    expect(at(250, normal).state).toBe('normal');
  });

  it('an operational gauge class outranks the DOY set both ways', () => {
    const lhp = (code: string): ClassIn[] => [{ source: 'DE-6', code: `RP:${code}`, fresh: true }];
    const rows = doy(100, 200, { source: 'DE-1' });
    expect(at(50, rows, { classes: lhp('2') }).state).toBe('high');
    expect(at(50, rows, { classes: lhp('2') }).basis?.source).toBe('DE-6');
    expect(at(250, rows, { classes: lhp('2') }).state).toBe('high');
    // LHP 0 (no flood: low..normal, point normal) with the DOY set above P90: collapses to normal
    expect(at(250, rows, { classes: lhp('0') }).state).toBe('normal');
    // with it below P10 the DOY set narrows to low
    expect(at(50, rows, { classes: lhp('0') }).state).toBe('low');
    expect(at(50, rows, { classes: lhp('0') }).basis?.ref).toBe('P10_DOY');
  });

  it('an agency scale (DE-7 Info) caps it: above P90 under Info 1 is normal "< Info 1"', () => {
    const rows = [ref('DE-7', 'LANUV_INFO_1', 300), ...doy(100, 200, { source: 'DE-7' })];
    const r = at(250, rows);
    expect(r.state).toBe('normal');
    expect(r.basis).toMatchObject({ source: 'DE-7', kind: 'operational', label: 'LANUK < Info 1' });
    expect(at(320, rows).state).toBe('elevated');
    expect(at(50, rows).state).toBe('low');
  });
});

describe('tidal, impounded and audience', () => {
  it('a tidal series takes no DOY set (operational only, D12)', () => {
    expect(at(250, doy(100, 200), { tidal: true }).state).toBe('no_ref');
    expect(at(50, doy(100, 200), { tidal: true }).state).toBe('no_ref');
  });

  it('an impounded stage has no statistical low: only at or above P90 decides', () => {
    const o = { impounded: true, valueKind: 'stage' as const };
    expect(at(50, doy(100, 200), o).state).toBe('no_ref');
    expect(at(150, doy(100, 200), o).state).toBe('no_ref');
    expect(at(250, doy(100, 200), o).state).toBe('elevated');
    // an impounded level series keeps the whole mapping
    expect(at(50, doy(100, 200), { impounded: true }).state).toBe('low');
  });

  it('an owner-only source (BE-3, LU-4) is never used in the public family, and is in the owner family', () => {
    for (const source of ['BE-3', 'LU-4']) {
      for (const v of [50, 150, 250]) expect(at(v, doy(100, 200, { source })).state).toBe('no_ref');
      const owner = at(250, doy(100, 200, { source }), {}, 'owner');
      expect(owner.state).toBe('elevated');
      expect(owner.basis?.source).toBe(source);
    }
  });

  it("the basis source is never the role's '*'", () => {
    for (const v of [50, 150, 250]) expect(at(v, doy(100, 200, { source: 'FR-1' })).basis?.source).toBe('FR-1');
  });
});
