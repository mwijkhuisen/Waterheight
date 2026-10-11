import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { maxShift, shiftAt, shiftHours, spanShift } from '../src/features/flow/reaches/shift.ts';
import { type FeatureSpan, spansOf } from '../src/features/flow/reaches/spans.ts';
import { ReachGraphFile, ReachTravel, type ReachTravelData } from '../src/lib/data/contracts.ts';

// The travel-time shift (#112 item 3, owner decision D-4): exact pairs only, whole hours, derived never.

const raw = JSON.parse(readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8'));
const graph = ReachGraphFile.parse(raw);
const travel = ReachTravel.parse(raw);

const tt = (from: string, to: string, v: Partial<ReachTravelData['travel_times'][number]>) =>
  ({ from_station_id: from, to_station_id: to, basis: 'x', source: 'x', source_url: 'x', ...v }) as never;
const data = (...t: ReachTravelData['travel_times']): ReachTravelData => ({ travel_times: t });
const span = (up: string[], down: string[]) => ({ up, down, lengthKm: 10, pos: 0.5, tidal: false });

describe('shiftHours', () => {
  it('is the midpoint of a range, rounded to whole hours', () => {
    expect(shiftHours({ h: [1, 9] })).toBe(5);
    expect(shiftHours({ h: [22, 41] })).toBe(32); // 31.5 rounds up
  });
  it('is a single value rounded, days times 24, and null for a derived figure', () => {
    expect(shiftHours({ h: 3.5, label: { nl: 'a', en: 'a' } } as never)).toBe(4);
    expect(shiftHours({ h: 23 })).toBe(23);
    expect(shiftHours({ d: [3, 4] })).toBe(84);
    // over MAX_SHIFT_H (96 h, review round 1): unshifted, so a garbled figure never widens the frames
    expect(shiftHours({ d: [4, 5] })).toBeNull();
    expect(shiftHours({ h: 96 })).toBe(96);
    expect(shiftHours({ h: 97 })).toBeNull();
    expect(shiftHours({ h: 1e6 })).toBeNull();
    expect(shiftHours({ d: 2, label: { nl: 'a', en: 'a' } } as never)).toBe(48);
    expect(shiftHours({ h: [4, 5], derived: true })).toBeNull();
    expect(shiftHours({ d: [4, 5], derived: true })).toBeNull();
  });
  it('is null when there is no value at all', () => {
    expect(shiftHours({})).toBeNull();
  });
});

describe('spanShift', () => {
  const t = data(tt('a', 'z', { h: [2, 4] }), tt('a', 'z', { h: [10, 20] }), tt('b', 'z', { h: 7 }));

  it('shifts only a span that holds the pair exactly, the first match winning', () => {
    expect(spanShift(span(['a'], ['z']), t)).toBe(3);
    expect(spanShift(span(['b', 'a'], ['y', 'z']), t)).toBe(3);
    expect(spanShift(span(['b'], ['z']), t)).toBe(7);
  });
  it('does not shift a span that names only one end, the wrong ends or swapped ends', () => {
    expect(spanShift(span(['a'], ['y']), t)).toBeNull();
    expect(spanShift(span(['c'], ['z']), t)).toBeNull();
    expect(spanShift(span(['z'], ['a']), t)).toBeNull();
    expect(spanShift(null, t)).toBeNull();
    expect(spanShift(span(['a'], ['z']), undefined)).toBeNull();
  });
  it('skips a derived entry and goes on to the next', () => {
    expect(spanShift(span(['a'], ['z']), data(tt('a', 'z', { h: [2, 4], derived: true })))).toBeNull();
    expect(
      spanShift(span(['a'], ['z']), data(tt('a', 'z', { h: [2, 4], derived: true }), tt('a', 'z', { h: 9 }))),
    ).toBe(9);
  });
  it('is null for a non-positive shift (a range that rounds to 0)', () => {
    expect(spanShift(span(['a'], ['z']), data(tt('a', 'z', { h: [0.2, 0.6] })))).toBeNull();
  });
});

describe('shiftAt', () => {
  it('is T times the position, rounded; an unknown position is the middle', () => {
    expect(shiftAt(5, 0)).toBe(0);
    expect(shiftAt(5, 0.3125)).toBe(2); // 1.5625
    expect(shiftAt(5, 0.5)).toBe(3); // 2.5 rounds up
    expect(shiftAt(5, 1)).toBe(5);
    expect(shiftAt(5, null)).toBe(3);
    expect(shiftAt(32, null)).toBe(16);
  });
});

describe('maxShift', () => {
  const fs = (s: ReturnType<typeof span> | null, bins: (ReturnType<typeof span> | null)[]): FeatureSpan => ({
    tidal: false,
    impounded: false,
    span: s,
    bins,
  });
  const t = data(tt('a', 'z', { h: 6 }), tt('b', 'y', { h: 30 }));

  it('is the largest shift of any span or bin, 0 when none is shifted', () => {
    expect(maxShift(new Map(), t)).toBe(0);
    expect(maxShift(new Map([['r', fs(span(['c'], ['z']), [null])]]), t)).toBe(0);
    expect(maxShift(new Map([['r', fs(span(['a'], ['z']), [span(['a'], ['z'])])]]), t)).toBe(6);
    // a bin alone (the owner variant's cut reach) counts too
    expect(maxShift(new Map([['r', fs(span(['c'], ['z']), [span(['c'], ['z']), span(['b'], ['y'])])]]), t)).toBe(30);
    expect(maxShift(new Map([['r', fs(span(['a'], ['z']), [])]]), undefined)).toBe(0);
  });
});

describe('on the fixture release', () => {
  const spans = spansOf(graph, new Set(graph.stations.map((s) => s.id)));
  const shifted = [...spans].filter(([, f]) => spanShift(f.span, travel) !== null);

  it('has 22 travel times and exactly one shifted span: Emmerich to Lobith, 5 h, on rhine.59', () => {
    expect(travel.travel_times).toHaveLength(22);
    expect(shifted.map(([id]) => id)).toEqual(['rhine.59']);
    const s = shifted[0]?.[1].span;
    expect(s?.up).toContain('de.wsv.2790020');
    expect(s?.down).toContain('nl.rws.lobith.bovenrijn.tolkamer');
    expect(spanShift(s ?? null, travel)).toBe(5);
    expect(shifted[0]?.[1].bins).toHaveLength(8);
  });
  it('has maxShift 5, and no derived travel time ever counts', () => {
    expect(maxShift(spans, travel)).toBe(5);
    const derived = travel.travel_times.filter((t) => t.derived === true);
    expect(derived.length).toBeGreaterThan(0);
    for (const d of derived) expect(spanShift(span([d.from_station_id], [d.to_station_id]), data(d))).toBeNull();
  });
});
