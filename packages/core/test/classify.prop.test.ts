import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  CLASS_SCALE,
  type ClassIn,
  classify,
  crosswalkRow,
  type Family,
  LEVEL_NORM,
  OWNER_ONLY_SOURCES,
  type RefIn,
  referenceRole,
  type SeriesIn,
} from '../src/index.ts';

// Property tests of the classifier (plan §6, "monotone"): over generated well-formed threshold sets and classes, a
// higher value never gives a lower DEFINED level, and no_ref arises only where no candidate decides. Only MNW and
// W > MNW is no_ref while W <= MNW is low: honest, not a regression, so no_ref is left out of the order.

const T = Date.UTC(2026, 5, 15, 12);
const NUMRUNS = 400;

const ref = (
  source: string,
  kind: string,
  value: number,
  unit: string,
  convention: RefIn['convention'] = null,
): RefIn => ({
  source,
  kind,
  value,
  unit,
  convention,
  period: null,
  seasonFrom: 101,
  seasonTo: 1231,
  priority: 0,
  label: null,
});

/** Any subset of `kinds`, with strictly increasing values in the order given (a well-formed threshold set). */
const chain = (source: string, kinds: readonly string[]) =>
  fc
    .tuple(
      fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: kinds.length, maxLength: kinds.length }),
      fc.array(fc.boolean(), { minLength: kinds.length, maxLength: kinds.length }),
    )
    .map(([values, keep]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return kinds.flatMap((k, i) => (keep[i] ? [{ source, kind: k, value: sorted[i] as number }] : []));
    });

const DE6 = ['-1', 'none', '0', '1', '2', '3', '4'].map((c) => `RP:${c}`);
const CH1 = ['1', '2', '3', '4', '5', 'undefined'];
const classArb: fc.Arbitrary<ClassIn[]> = fc.array(
  fc.oneof(
    fc.record({ source: fc.constant('DE-6'), code: fc.constantFrom(...DE6), fresh: fc.boolean() }),
    fc.record({ source: fc.constant('CH-1'), code: fc.constantFrom(...CH1), fresh: fc.boolean() }),
    fc.record({ source: fc.constant('BE-3'), code: fc.constantFrom('t1/ok', 't3/alert'), fresh: fc.boolean() }),
  ),
  { maxLength: 3 },
);

type Setup = {
  quantity: 'H' | 'Q';
  valueKind: 'stage' | 'level';
  tidal: boolean;
  impounded: boolean;
  family: Family;
  /** The five generated sets: DE-1, DE-7, CH-2, LU-4 vigilance, LU-4 HQ. */
  sets: { source: string; kind: string; value: number }[][];
  rows: { source: string; kind: string; value: number }[];
  p05: number | null;
  classes: ClassIn[];
};

const setupArb: fc.Arbitrary<Setup> = fc
  .record({
    quantity: fc.constantFrom('H', 'Q'),
    valueKind: fc.constantFrom('stage', 'level'),
    tidal: fc.boolean(),
    impounded: fc.boolean(),
    family: fc.constantFrom('public', 'owner'),
    sets: fc
      .tuple(
        chain('DE-1', ['MNW', 'MHW', 'HSW']),
        chain('DE-7', ['LANUV_MNW', 'LANUV_INFO_1', 'LANUV_INFO_2', 'LANUV_INFO_3']),
        chain('CH-2', ['WL2', 'WL3', 'WL4', 'WL5']),
        chain('LU-4', ['LU4_YELLOW', 'LU4_ORANGE', 'LU4_RED']),
        chain('LU-4', ['HQ2', 'HQ5', 'HQ10', 'HQ20', 'HQ50', 'HQ100']),
      )
      .map((sets) => sets),
    p05: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
    classes: classArb,
  })
  .map((s) => ({ ...s, rows: s.sets.flat() }))
  .map((s) => s as Setup);

const valueArb = fc.integer({ min: -100, max: 2200 }).map((x) => x / 2);

function build(s: Setup, value: number): SeriesIn {
  const unit = s.quantity === 'H' ? 'cm' : 'm³/s';
  const refs = s.rows.map((r) => ref(r.source, r.kind, r.value, unit));
  if (s.p05 !== null) refs.push(ref('BE-3', 'P05', s.p05, unit, 'non_exceedance'));
  return {
    quantity: s.quantity,
    valueKind: s.quantity === 'H' ? s.valueKind : null,
    value,
    qc: 0,
    ageMs: 0,
    stalenessMs: 3_600_000,
    t: T,
    refs,
    classes: s.classes,
    areas: [],
    tidal: s.tidal,
    impounded: s.impounded,
  };
}

/** Independent of classify(): whether some visible candidate has a point at `value` (a passed threshold, a low bound, a class). */
function decided(s: Setup, series: SeriesIn): boolean {
  const v = series.value as number;
  const visible = (source: string) => s.family === 'owner' || !OWNER_ONLY_SOURCES.has(source);
  const skipLow = s.impounded && s.quantity === 'H' && s.valueKind === 'stage';
  for (const r of series.refs) {
    const role = referenceRole(r.source, r.kind);
    if (!visible(r.source) || role === undefined || role.op === null) continue;
    if (s.tidal && role.group !== 'operational') continue;
    if (role.op === '>=' && v >= r.value) return true;
    if (role.op === '<=' && !(skipLow && role.group === 'statistical') && v <= r.value) return true;
  }
  for (const c of series.classes) {
    const scale = CLASS_SCALE[c.source];
    const row = scale === undefined ? undefined : crosswalkRow(c.source, scale, c.code.replace(/^[A-Z]{2}:/, ''));
    if (c.fresh && visible(c.source) && row !== undefined && row.level !== 'no_ref') return true;
  }
  return false;
}

describe('classify properties', () => {
  // Monotone over ONE threshold set at a time (plus classes and the percentile): two sources on one series can
  // disagree (an operational "below orange" and a statistical "at HQ10"), and then the operational one wins by
  // design, so a higher value can fall back to the operational state. That is priority, not a defect of one set.
  it('a higher value never gives a lower defined level', () => {
    fc.assert(
      fc.property(setupArb, fc.integer({ min: 0, max: 4 }), valueArb, valueArb, (all, pick, a, b) => {
        const s = { ...all, rows: all.sets[pick] as Setup['rows'] };
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const low = classify(build(s, lo), s.family).state;
        const high = classify(build(s, hi), s.family).state;
        if (low === 'no_ref' || high === 'no_ref') return true;
        return LEVEL_NORM[high] >= LEVEL_NORM[low];
      }),
      { numRuns: NUMRUNS },
    );
  });

  // All sets on one series at once: a lower-priority set that disagrees is skipped but pulls the state to the
  // interval's nearest edge, so below AGE orange with HQ10 passed is elevated, never back to normal.
  it('a higher value never gives a lower defined level, with every set at once', () => {
    fc.assert(
      fc.property(setupArb, valueArb, valueArb, (s, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const low = classify(build(s, lo), s.family).state;
        const high = classify(build(s, hi), s.family).state;
        if (low === 'no_ref' || high === 'no_ref') return true;
        return LEVEL_NORM[high] >= LEVEL_NORM[low];
      }),
      { numRuns: NUMRUNS * 5 },
    );
  });

  it('no_ref only where no candidate decides', () => {
    fc.assert(
      fc.property(setupArb, fc.integer({ min: 0, max: 5 }), valueArb, (all, pick, v) => {
        // one source's references (or the percentile) at a time, as on a real station; with two sources of statistics
        // a passed threshold of one can be skipped for disagreeing with the other, which is priority at work
        const s = { ...all, rows: all.sets[pick] ?? [], p05: pick === 5 ? all.p05 : null };
        const series = build(s, v);
        const r = classify(series, s.family);
        if (decided(s, series)) return r.state !== 'no_ref';
        return true;
      }),
      { numRuns: NUMRUNS },
    );
  });

  it('a state has a basis exactly when it is not no_ref, and a section has none of its own gauge basis', () => {
    fc.assert(
      fc.property(setupArb, valueArb, (s, v) => {
        const r = classify(build(s, v), s.family);
        return (r.state === 'no_ref') === (r.basis === null) && !r.section;
      }),
      { numRuns: NUMRUNS },
    );
  });

  it('the public family never has a basis from LU-4 or BE-3', () => {
    fc.assert(
      fc.property(setupArb, valueArb, (s, v) => {
        const r = classify(build(s, v), 'public');
        return r.basis === null || (r.basis.source !== 'LU-4' && r.basis.source !== 'BE-3');
      }),
      { numRuns: NUMRUNS },
    );
  });

  it('the public result is the same whatever owner rows are added', () => {
    fc.assert(
      fc.property(setupArb, valueArb, (s, v) => {
        const publicOnly: Setup = { ...s, rows: s.rows.filter((r) => r.source !== 'LU-4'), p05: null };
        const base = build(publicOnly, v);
        const withOwner = build({ ...s, family: 'public' }, v);
        const a = classify({ ...base, classes: s.classes.filter((c) => c.source !== 'BE-3') }, 'public');
        const b = classify({ ...withOwner, classes: s.classes.filter((c) => c.source !== 'BE-3') }, 'public');
        return a.state === b.state && JSON.stringify(a.basis) === JSON.stringify(b.basis);
      }),
      { numRuns: NUMRUNS },
    );
  });
});
