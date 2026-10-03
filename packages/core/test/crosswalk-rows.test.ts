import { describe, expect, it } from 'vitest';
import {
  type ClassIn,
  CROSSWALK,
  classify,
  type Family,
  LEVEL_NORM,
  LEVELS,
  type Level,
  levelOf,
  REFERENCE_ROLES,
  type RefIn,
  type SeriesIn,
} from '../src/index.ts';

// Every row of the crosswalk and every reference role, proved through classify() at its exact boundary (not by
// reading the table back): plan §6, "every §4.9 row tested". A last test counts the rows visited, so a row added to
// either table without a case here (or a case skipped) fails.

const T = Date.UTC(2026, 5, 15, 12);
const EPS = 0.01;

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
const series = (o: Partial<SeriesIn> = {}): SeriesIn => ({
  quantity: 'H',
  valueKind: 'stage',
  value: 100,
  qc: 0,
  ageMs: 0,
  stalenessMs: 3_600_000,
  t: T,
  refs: [],
  classes: [],
  areas: [],
  tidal: false,
  impounded: false,
  ...o,
});
const familyOf = (r: { audience: 'public' | 'owner' }): Family => (r.audience === 'owner' ? 'owner' : 'public');
const stateOf = (level: Level | 'no_ref') => level;

let visited = 0;

describe('CROSSWALK: every class row', () => {
  for (const row of CROSSWALK) {
    const name = `${row.source} ${row.scale} ${row.code}${row.gated ? ' (gated)' : ''}${row.audience === 'owner' ? ' (owner)' : ''}`;
    const family = familyOf(row);

    if (row.group === 'area') {
      it(`${name}: an area class`, () => {
        visited++;
        const a = { source: row.source, key: 'k', name: 'N', levelRaw: row.code, fresh: true };
        const r = classify(series({ areas: [a] }), family);
        expect(r.state).toBe(stateOf(row.level));
        expect(r.section).toBe(row.level !== 'no_ref');
        if (row.level === 'no_ref') expect(r.basis).toBeNull();
        else expect(r.basis).toMatchObject({ source: row.source, kind: 'area', measure: 'area', ref: 'k' });
        // not fresh: nothing
        expect(classify(series({ areas: [{ ...a, fresh: false }] }), family).state).toBe('no_ref');
        // a gauge state wins over it, the area is returned beside it
        const withGauge = classify(series({ value: 9, refs: [ref('DE-1', 'MNW', 65)], areas: [a] }), family);
        expect(withGauge.state).toBe('low');
        expect(withGauge.section).toBe(false);
        expect(withGauge.area?.state ?? 'none').toBe(row.level === 'no_ref' ? 'none' : row.level);
      });
    } else if (row.source === 'NL-4') {
      it(`${name}: the band [100, 200)`, () => {
        visited++;
        const label = row.code === 'Geen klasse-indeling' ? row.code : `${row.code} (>100cm)`;
        const refs = [ref('NL-4', 'NL4_FROM', 100, { label }), ref('NL-4', 'NL4_TO', 200, { label })];
        const at = (v: number) => classify(series({ value: v, refs }), 'public');
        expect(at(99.99).state).toBe('no_ref');
        expect(at(200).state).toBe('no_ref');
        for (const v of [100, 150, 199.99]) {
          const r = at(v);
          expect(r.state, String(v)).toBe(stateOf(row.level));
          if (row.level === 'no_ref') expect(r.basis).toBeNull();
          else expect(r.basis).toMatchObject({ source: 'NL-4', kind: 'provider_class', ref: row.code });
        }
      });
    } else {
      it(`${name}: a gauge class`, () => {
        visited++;
        const codes =
          row.code === '*'
            ? ['T3/ALERT', 'whatever']
            : row.source === 'DE-6'
              ? [row.code, `RP:${row.code}`]
              : [row.code];
        for (const code of codes) {
          const c: ClassIn = { source: row.source, code, fresh: true };
          const r = classify(series({ classes: [c] }), family);
          if (row.level === 'no_ref') {
            expect(r.state, code).toBe('no_ref');
            expect(r.basis).toBeNull();
          } else if (row.noFlood) {
            // "not elevated": normal, never low or above
            expect(r.state, code).toBe('normal');
            expect(r.basis).toMatchObject({ source: row.source, kind: row.group, ref: code });
            // a statistical low is not overridden, a statistical elevated is
            const refs = [ref('DE-1', 'MNW', 65), ref('DE-1', 'MHW', 544), ref('DE-1', 'HSW', 640)];
            expect(classify(series({ value: 9, refs, classes: [c] }), family).state).toBe('low');
            expect(classify(series({ value: 600, refs, classes: [c] }), family).state).toBe('normal');
          } else {
            expect(r.state, code).toBe(stateOf(row.level));
            expect(r.basis).toMatchObject({ source: row.source, kind: row.group, measure: 'stage', ref: code });
          }
          // not fresh: ignored
          expect(classify(series({ classes: [{ ...c, fresh: false }] }), family).state).toBe('no_ref');
          if (row.audience === 'owner') expect(classify(series({ classes: [c] }), 'public').state).toBe('no_ref');
        }
      });
    }
  }
});

describe('REFERENCE_ROLES: every reference kind', () => {
  for (const role of REFERENCE_ROLES) {
    const name = `${role.source} ${role.kind} (${role.op ?? 'shown'})${role.gated ? ' (gated)' : ''}${role.audience === 'owner' ? ' (owner)' : ''}`;
    const family = familyOf(role);
    const quantity = role.basis === 'discharge' ? 'Q' : 'H';
    const unit = quantity === 'Q' ? 'm³/s' : 'cm';
    const at = (v: number, bound: number, f: Family = family) =>
      classify(
        series({
          quantity,
          valueKind: quantity === 'Q' ? null : 'stage',
          value: v,
          refs: [ref(role.source, role.kind, bound, { unit, convention: role.convention ?? null })],
        }),
        f,
      );

    it(name, () => {
      visited++;
      const BOUND = 100;
      if (role.op === null) {
        // stored and shown, never classifies
        for (const v of [-1e6, 0, BOUND - EPS, BOUND, BOUND + EPS, 1e6])
          expect(at(v, BOUND).state, String(v)).toBe('no_ref');
        expect(role.level).toBeNull();
        expect(role.group).toBeNull();
        return;
      }
      const level = role.level as Level;
      if (role.op === '>=') {
        const hit = at(BOUND, BOUND);
        expect(hit.state).toBe(level);
        expect(hit.basis).toMatchObject({
          source: role.source,
          kind: role.group,
          measure: quantity === 'Q' ? 'discharge' : 'stage',
          ref: role.kind,
        });
        expect(at(BOUND + EPS, BOUND).state).toBe(level);
        expect(at(1e6, BOUND).state).toBe(level);
        // just below: the level is not reached (a scale says normal below its lowest level, statistics nothing)
        const below = at(BOUND - EPS, BOUND);
        expect(below.state).toBe(role.form === 'scale' ? 'normal' : 'no_ref');
      } else {
        // `<=` is low at the bound, `<` is not
        const lowAtBound = role.op === '<=';
        expect(at(BOUND, BOUND).state).toBe(lowAtBound ? 'low' : role.form === 'percentile' ? 'normal' : 'no_ref');
        expect(at(BOUND - EPS, BOUND).state).toBe('low');
        expect(at(-1e6, BOUND).state).toBe('low');
        const above = at(BOUND + EPS, BOUND);
        expect(above.state).toBe(role.form === 'percentile' ? 'normal' : 'no_ref');
        expect(at(BOUND - EPS, BOUND).basis).toMatchObject({ source: role.source, kind: role.group, ref: role.kind });
        expect(level).toBe('low');
      }
      // an owner row is inert in the public family
      if (role.audience === 'owner') {
        for (const v of [-1e6, BOUND - EPS, BOUND, BOUND + EPS, 1e6])
          expect(at(v, BOUND, 'public').state).toBe('no_ref');
      }
    });
  }
});

describe('LU-4 (owner family)', () => {
  const lu4 = (value: number, ...kv: [string, number][]) =>
    classify(series({ value, refs: kv.map(([k, v]) => ref('LU-4', k, v)) }), 'owner');
  const lu4pub = (value: number, ...kv: [string, number][]) =>
    classify(series({ value, refs: kv.map(([k, v]) => ref('LU-4', k, v)) }), 'public');
  const VIG: [string, number][] = [
    ['LU4_YELLOW', 100],
    ['LU4_ORANGE', 150],
    ['LU4_RED', 250],
  ];

  it('yellow, orange, red: each level at its bound, normal below yellow', () => {
    expect(lu4(99.99, ...VIG).state).toBe('normal');
    expect(lu4(100, ...VIG).state).toBe('elevated');
    expect(lu4(149.99, ...VIG).state).toBe('elevated');
    expect(lu4(150, ...VIG).state).toBe('high');
    expect(lu4(249.99, ...VIG).state).toBe('high');
    expect(lu4(250, ...VIG).state).toBe('extreme');
    expect(lu4(250, ...VIG).basis).toMatchObject({ source: 'LU-4', kind: 'operational', label: 'AGE red' });
  });

  it('none of it reaches the public family', () => {
    for (const v of [99, 100, 150, 250, 1e6]) expect(lu4pub(v, ...VIG).state).toBe('no_ref');
  });

  it('0 is undefined, so yellow is absent: below orange is normal, and HQ2 may raise it to elevated', () => {
    const noYellow: [string, number][] = [VIG[1] as [string, number], VIG[2] as [string, number]];
    expect(lu4(100, ...noYellow).state).toBe('normal');
    expect(lu4(149.99, ...noYellow).state).toBe('normal');
    expect(lu4(150, ...noYellow).state).toBe('high');
    // HQ2 passed below orange: elevated, from the status class
    const raised = lu4(120, ...noYellow, ['HQ2', 110]);
    expect(raised.state).toBe('elevated');
    expect(raised.basis).toMatchObject({ source: 'LU-4', kind: 'statistical', ref: 'HQ2', label: 'AGE HQ2' });
    // HQ2 not yet passed: normal
    expect(lu4(100, ...noYellow, ['HQ2', 110]).state).toBe('normal');
    // orange passed, an HQ2 below it does not lower it
    expect(lu4(160, ...noYellow, ['HQ2', 110]).state).toBe('high');
  });

  it('the HQ status classes: HQ2 elevated, HQ10 high, HQ50 extreme, HQ5 never (HQ20 and HQ100 alone below)', () => {
    const HQ: [string, number][] = [
      ['HQ2', 100],
      ['HQ5', 150],
      ['HQ10', 200],
      ['HQ50', 400],
    ];
    expect(lu4(99.99, ...HQ).state).toBe('normal');
    expect(lu4(100, ...HQ).state).toBe('elevated');
    expect(lu4(150, ...HQ).state).toBe('elevated'); // HQ5 has no status class
    expect(lu4(199.99, ...HQ).state).toBe('elevated');
    expect(lu4(200, ...HQ).state).toBe('high');
    expect(lu4(399.99, ...HQ).state).toBe('high');
    expect(lu4(400, ...HQ).state).toBe('extreme');
    expect(lu4(1e6, ...HQ).state).toBe('extreme');
    expect(lu4(300, ['HQ2', 100], ['HQ20', 300]).state).toBe('high');
    expect(lu4(500, ['HQ2', 100], ['HQ100', 500]).state).toBe('extreme');
    for (const v of [99, 100, 200, 400, 1e6]) expect(lu4pub(v, ...HQ).state).toBe('no_ref');
  });

  it('between two thresholds of the same level the level holds (HQ10 .. HQ20, HQ50 .. HQ100)', () => {
    const HQ: [string, number][] = [
      ['HQ2', 100],
      ['HQ10', 200],
      ['HQ20', 300],
      ['HQ50', 400],
      ['HQ100', 500],
    ];
    expect(lu4(250, ...HQ).state).toBe('high');
    expect(lu4(450, ...HQ).state).toBe('extreme');
  });

  it('MNQ is inert today (P7a stores none) but tested: below it is low, never higher', () => {
    const v = (value: number, ...more: [string, number][]) => lu4(value, ['MNQ', 20], ...more);
    expect(v(19.99).state).toBe('low');
    expect(v(20).state).toBe('no_ref'); // `<`: at the bound is not low
    expect(v(10, ...VIG).state).toBe('low');
    expect(v(50, ...VIG).state).toBe('normal');
    expect(lu4pub(10, ['MNQ', 20]).state).toBe('no_ref');
  });

  it('MQ and the reference flood are shown, never classify', () => {
    for (const k of ['MQ', 'LU4_CRUE_REF', 'HQ5']) {
      for (const val of [0, 100, 1e6]) expect(lu4(val, [k, 100]).state, `${k} ${val}`).toBe('no_ref');
    }
  });
});

describe('BE-3 percentiles (owner family, D18 addendum)', () => {
  const P = (kind: string, value: number) => ref('BE-3', kind, value, { convention: 'non_exceedance' });
  const SET = [
    P('P05', 10),
    P('P10', 20),
    P('P25', 30),
    P('P50', 40),
    P('P75', 50),
    P('P90', 60),
    P('P95', 70),
    P('MEDIAN', 45),
    P('MOYEN', 48),
  ];
  const be3 = (value: number, f: Family = 'owner') => classify(series({ value, refs: SET }), f);

  it('≤ P05 is low, above is normal, never higher from percentiles alone', () => {
    expect(be3(-5).state).toBe('low');
    expect(be3(10).state).toBe('low');
    expect(be3(10.01).state).toBe('normal');
    expect(be3(65).state).toBe('normal');
    expect(be3(70).state).toBe('normal');
    expect(be3(1e9).state).toBe('normal');
    expect(be3(10).basis).toMatchObject({ source: 'BE-3', kind: 'statistical', ref: 'P05', label: 'SPW P05' });
  });

  it('inert in the public family', () => {
    for (const v of [-5, 10, 10.01, 1e9]) expect(be3(v, 'public').state).toBe('no_ref');
  });
});

describe('the tables are fully visited', () => {
  it('every CROSSWALK row and every REFERENCE_ROLES row ran exactly once', () => {
    expect(visited).toBe(CROSSWALK.length + REFERENCE_ROLES.length);
  });

  it('owner rows and gated rows exist in both tables (so the cases above are not vacuous)', () => {
    expect(CROSSWALK.some((r) => r.audience === 'owner')).toBe(true);
    expect(
      REFERENCE_ROLES.filter((r) => r.audience === 'owner')
        .map((r) => r.source)
        .sort(),
    ).toContain('LU-4');
    expect(REFERENCE_ROLES.some((r) => r.gated)).toBe(true);
    expect(CROSSWALK.some((r) => r.gated)).toBe(true);
    expect(LEVELS).toHaveLength(5);
  });
});

describe('levelOf (the level the loader stores)', () => {
  it('is 1 to 5 for a class, null for no_ref, undefined for a code the table lacks', () => {
    for (const r of CROSSWALK) {
      expect(levelOf(r.source, r.scale, r.code), `${r.source} ${r.scale} ${r.code}`).toBe(
        r.level === 'no_ref' ? null : LEVEL_NORM[r.level],
      );
    }
    expect(levelOf('DE-6', 'station', '9')).toBeUndefined();
    expect(levelOf('XX-1', 'station', '1')).toBeUndefined();
    expect(levelOf('BE-3', 'nivcru', 'anything')).toBeNull();
  });
});
