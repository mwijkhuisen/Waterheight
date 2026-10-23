import type { TideExtreme } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Pt } from '../src/features/station/chartModel.ts';
import { dayExtremes, daySpan, surgeBand } from '../src/features/station/tide.ts';
import { quantise, STEP_MS } from '../src/lib/time/time.ts';
import { bodyOf } from '../src/lib/water.ts';

// The pure part of the tide section (P19b T1): the day's high and low waters, the request span, the surge band, the
// water body of a station. Europe/Amsterdam days; Node 26 has Temporal natively.

const ex = (
  ts: string,
  hilo: 'high' | 'low' = 'high',
  kind: 'measured' | 'astro' = 'astro',
  value = 1,
): TideExtreme => ({
  ts,
  value,
  hilo,
  kind,
});
const ms = (iso: string) => Date.parse(iso);

describe('dayExtremes', () => {
  it('unions series and snapshot, dedupes by kind|hilo|ts, keeps the local day, sorts', () => {
    const a = [ex('2026-10-20T10:00:00Z'), ex('2026-10-20T04:00:00Z', 'low')];
    const b = [ex('2026-10-20T10:00:00Z', 'high', 'astro', 99), ex('2026-10-20T10:00:00Z', 'high', 'measured')];
    const got = dayExtremes(ms('2026-10-20T12:00:00Z'), a, b);
    expect(got.map((e) => `${e.kind}|${e.hilo}|${e.ts}`)).toEqual([
      'astro|low|2026-10-20T04:00:00Z',
      'astro|high|2026-10-20T10:00:00Z',
      'measured|high|2026-10-20T10:00:00Z',
    ]);
    expect(got[1]?.value).toBe(1); // the first one wins
  });

  it('empty and undefined inputs give nothing', () => {
    expect(dayExtremes(ms('2026-10-20T12:00:00Z'), undefined, undefined)).toEqual([]);
    expect(dayExtremes(ms('2026-10-20T12:00:00Z'), [], [])).toEqual([]);
  });

  it('CEST day: local midnight on both sides', () => {
    const t = ms('2026-10-20T12:00:00Z');
    const got = dayExtremes(
      t,
      [
        ex('2026-10-19T21:59:59Z'), // 23:59:59 local, the day before
        ex('2026-10-19T22:00:00Z', 'low'), // 00:00 local: in
        ex('2026-10-20T21:59:59Z'), // 23:59:59 local: in
        ex('2026-10-20T22:00:00Z', 'low'), // 00:00 next day: out
      ],
      undefined,
    );
    expect(got.map((e) => e.ts)).toEqual(['2026-10-19T22:00:00Z', '2026-10-20T21:59:59Z']);
  });

  it('25-hour DST-end day (2026-10-25) spans 2026-10-24T22:00Z up to 2026-10-25T23:00Z', () => {
    const t = ms('2026-10-25T12:00:00Z');
    const got = dayExtremes(
      t,
      [
        ex('2026-10-24T21:59:59Z'),
        ex('2026-10-24T22:00:00Z', 'low'),
        ex('2026-10-25T22:59:59Z'), // 23:59:59 local CET: in
        ex('2026-10-25T23:00:00Z', 'low'), // next midnight: out
      ],
      undefined,
    );
    expect(got.map((e) => e.ts)).toEqual(['2026-10-24T22:00:00Z', '2026-10-25T22:59:59Z']);
  });

  it('23-hour DST-start day (2026-03-29) spans 2026-03-28T23:00Z up to 2026-03-29T22:00Z', () => {
    const t = ms('2026-03-29T12:00:00Z');
    const got = dayExtremes(
      t,
      [
        ex('2026-03-28T22:59:59Z'),
        ex('2026-03-28T23:00:00Z', 'low'),
        ex('2026-03-29T21:59:59Z'),
        ex('2026-03-29T22:00:00Z', 'low'),
      ],
      undefined,
    );
    expect(got.map((e) => e.ts)).toEqual(['2026-03-28T23:00:00Z', '2026-03-29T21:59:59Z']);
  });
});

describe('daySpan', () => {
  const far = ms('2027-01-01T00:00:00Z');
  it('is the whole local day when the display start is earlier and the server is far ahead', () => {
    expect(daySpan(ms('2026-10-20T12:00:00Z'), 0, far)).toEqual({
      from: ms('2026-10-19T22:00:00Z'),
      to: ms('2026-10-20T22:00:00Z'),
    });
    expect(daySpan(ms('2026-10-25T12:00:00Z'), 0, far)).toEqual({
      from: ms('2026-10-24T22:00:00Z'),
      to: ms('2026-10-25T23:00:00Z'),
    });
    expect(daySpan(ms('2026-03-29T12:00:00Z'), 0, far)).toEqual({
      from: ms('2026-03-28T23:00:00Z'),
      to: ms('2026-03-29T22:00:00Z'),
    });
  });

  it('clamps the end to quantise(serverNow + 10 min) and the start to the display start', () => {
    const t = ms('2026-10-20T12:00:00Z');
    const now = ms('2026-10-20T12:03:00Z');
    expect(daySpan(t, 0, now)?.to).toBe(quantise(now + STEP_MS));
    const start = ms('2026-10-20T05:00:00Z');
    expect(daySpan(t, start, far)?.from).toBe(start);
  });

  it('gives no request when from >= to', () => {
    const t = ms('2026-10-20T12:00:00Z');
    expect(daySpan(t, ms('2026-10-20T22:00:00Z'), far)).toBeUndefined(); // display starts after the day
    expect(daySpan(t, 0, ms('2026-10-19T00:00:00Z'))).toBeUndefined(); // server before the day
  });
});

describe('surgeBand', () => {
  it('splits by sign and leaves breaks elsewhere', () => {
    const astro: Pt[] = [
      [1, 100],
      [2, 100],
      [3, 100],
    ];
    const surge: Pt[] = [
      [1, 20],
      [2, -30],
      [3, 0],
      [4, 50], // no astro at ts 4
    ];
    const b = surgeBand(astro, surge);
    expect(b.up.base).toEqual([
      [1, 100],
      [2, null],
      [3, 100],
      [4, null],
    ]);
    expect(b.up.spread).toEqual([
      [1, 20],
      [2, null],
      [3, 0],
      [4, null],
    ]);
    expect(b.down.base).toEqual([
      [1, null],
      [2, 70],
      [3, null],
      [4, null],
    ]);
    expect(b.down.spread).toEqual([
      [1, null],
      [2, 30],
      [3, null],
      [4, null],
    ]);
  });

  it('negative astro still bands between astro and astro + surge', () => {
    const b = surgeBand(
      [
        [1, -50],
        [2, -50],
      ],
      [
        [1, 10],
        [2, -10],
      ],
    );
    expect(b.up.base[0]).toEqual([1, -50]);
    expect(b.up.spread[0]).toEqual([1, 10]);
    expect(b.down.base[1]).toEqual([2, -60]);
    expect(b.down.spread[1]).toEqual([2, 10]);
  });

  it('empty inputs give empty bands', () => {
    expect(surgeBand([], [])).toEqual({ up: { base: [], spread: [] }, down: { base: [], spread: [] } });
  });

  it('property: height is |surge| and the band spans [min, max] of astro and astro + surge', () => {
    const val = fc.integer({ min: -1000, max: 1000 });
    fc.assert(
      fc.property(fc.array(fc.tuple(val, val), { maxLength: 30 }), (pairs) => {
        const astro: Pt[] = pairs.map(([a], i) => [i, a]);
        const surge: Pt[] = pairs.map(([, s], i) => [i, s]);
        const b = surgeBand(astro, surge);
        pairs.forEach(([a, s], i) => {
          const side = s >= 0 ? b.up : b.down;
          const other = s >= 0 ? b.down : b.up;
          const base = side.base[i]?.[1];
          const spread = side.spread[i]?.[1];
          expect(other.base[i]?.[1]).toBeNull();
          expect(other.spread[i]?.[1]).toBeNull();
          expect(spread).toBe(Math.abs(s));
          expect(base).toBe(Math.min(a, a + s));
          expect((base as number) + (spread as number)).toBe(Math.max(a, a + s));
        });
      }),
    );
  });
});

describe('bodyOf', () => {
  const b = (id: string, kind: string, stations: string[]) => ({ id, kind, stations });
  it('prefers lake, closed estuary, estuary, sea', () => {
    const bodies = [
      b('s', 'sea', ['x']),
      b('e', 'estuary', ['x']),
      b('c', 'closed_estuary', ['x']),
      b('l', 'lake', ['x']),
    ];
    expect(bodyOf('x', bodies)?.id).toBe('l');
    expect(bodyOf('x', bodies.slice(0, 3))?.id).toBe('c');
    expect(bodyOf('x', bodies.slice(0, 2))?.id).toBe('e');
    expect(bodyOf('x', bodies.slice(0, 1))?.id).toBe('s');
    expect(bodyOf('nope', bodies)).toBeUndefined();
    expect(bodyOf('x', [])).toBeUndefined();
  });
});
