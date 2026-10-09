import type { ApiStation, AttributionEntry } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildFrameStore,
  type FramesChunk,
  type FramesMeta,
  framesPlan,
  framesUrl,
  MAX_FRAMES_BYTES,
  readFramesBody,
} from '../src/lib/data/frames.ts';

// P11b frames loader (pure): the plan, the URLs, the R2 series check and the bucket rule of R12.

const H = 3_600_000;
const D = 24 * H;
const at = (iso: string) => Date.parse(iso);
const NOW = '2026-10-26T12:00:00Z';
// Settled: D + 1 day <= now - 48 h, so 2026-10-23 is the newest settled day; 24, 25, 26 are unsettled.
const meta = (dayVersions: Record<string, number> = {}): FramesMeta => ({
  now: NOW,
  displayStart: '2026-09-01T00:00:00Z',
  dayVersions,
});

describe('framesPlan', () => {
  it('reads an absent settled day as v1 and a listed one at its version', () => {
    expect(
      framesPlan(at('2026-10-20T00:00:00Z'), at('2026-10-22T00:00:00Z'), meta({ '2026-10-21': 3 }), 'public'),
    ).toEqual([
      { kind: 'day', day: '2026-10-20', v: 1 },
      { kind: 'day', day: '2026-10-21', v: 3 },
    ]);
  });

  it('puts every unsettled day into one recent unit, after the settled days', () => {
    expect(framesPlan(at('2026-10-23T00:00:00Z'), at('2026-10-26T12:00:00Z'), meta(), 'public')).toEqual([
      { kind: 'day', day: '2026-10-23', v: 1 },
      { kind: 'recent' },
    ]);
  });

  it('sends version 0 and failed days to the API, one call per contiguous range', () => {
    const m = meta({ '2026-10-10': 0, '2026-10-11': 0, '2026-10-13': 0 });
    const plan = framesPlan(
      at('2026-10-09T00:00:00Z'),
      at('2026-10-15T00:00:00Z'),
      m,
      'public',
      new Set(['2026-10-14']),
    );
    expect(plan.filter((u) => u.kind === 'api')).toEqual([
      { kind: 'api', from: at('2026-10-10T00:00:00Z'), to: at('2026-10-12T00:00:00Z') },
      { kind: 'api', from: at('2026-10-13T00:00:00Z'), to: at('2026-10-15T00:00:00Z') },
    ]);
    expect(plan.filter((u) => u.kind === 'day').map((u) => u.kind === 'day' && u.day)).toEqual([
      '2026-10-09',
      '2026-10-12',
    ]);
  });

  it('sends an unsettled day whose recent.json failed to the API', () => {
    const plan = framesPlan(
      at('2026-10-24T00:00:00Z'),
      at('2026-10-26T00:00:00Z'),
      meta(),
      'public',
      new Set(['2026-10-24', '2026-10-25']),
    );
    expect(plan).toEqual([{ kind: 'api', from: at('2026-10-24T00:00:00Z'), to: at('2026-10-26T00:00:00Z') }]);
  });

  it('asks the owner host for API ranges of at most 14 days, never per day or recent', () => {
    const from = at('2026-10-01T00:00:00Z');
    const plan = framesPlan(from, at('2026-10-26T12:00:00Z'), meta(), 'owner');
    expect(plan).toEqual([
      { kind: 'api', from, to: from + 14 * D },
      { kind: 'api', from: from + 14 * D, to: at('2026-10-26T12:00:00Z') },
    ]);
    for (const u of plan) if (u.kind === 'api') expect((u.to - u.from) / H).toBeLessThanOrEqual(336);
  });

  it('clamps API ranges to the window and ignores an empty or inverted one', () => {
    const m = meta({ '2026-10-10': 0 });
    expect(framesPlan(at('2026-10-10T05:00:00Z'), at('2026-10-10T09:00:00Z'), m, 'public')).toEqual([
      { kind: 'api', from: at('2026-10-10T05:00:00Z'), to: at('2026-10-10T09:00:00Z') },
    ]);
    expect(framesPlan(at('2026-10-10T05:00:00Z'), at('2026-10-10T05:00:00Z'), m, 'public')).toEqual([]);
    expect(framesPlan(at('2026-10-11T05:00:00Z'), at('2026-10-10T05:00:00Z'), m, 'public')).toEqual([]);
  });

  it('never reads a prototype key as a version', () => {
    expect(framesPlan(at('2026-10-10T00:00:00Z'), at('2026-10-11T00:00:00Z'), meta(), 'public')).toEqual([
      { kind: 'day', day: '2026-10-10', v: 1 },
    ]);
  });
});

describe('framesUrl', () => {
  it('builds relative URLs from the day, the version and whole UTC hours', () => {
    expect(framesUrl({ kind: 'day', day: '2026-10-21', v: 3 })).toBe('/data/v1/frames/2026-10-21/v3.json');
    expect(framesUrl({ kind: 'recent' })).toBe('/data/v1/frames/recent.json');
    expect(framesUrl({ kind: 'api', from: at('2026-10-10T00:00:00Z'), to: at('2026-10-12T03:00:00Z') })).toBe(
      '/api/v1/frames?from=2026-10-10T00%3A00%3A00Z&to=2026-10-12T03%3A00%3A00Z&step=1h',
    );
  });
});

describe('readFramesBody', () => {
  it('refuses a declared or an actual size over the cap', async () => {
    const big = new Response('x', { headers: { 'content-length': String(MAX_FRAMES_BYTES + 1) } });
    await expect(readFramesBody(big)).rejects.toThrow('too_big');
    await expect(readFramesBody(new Response('x'.repeat(MAX_FRAMES_BYTES + 1)))).rejects.toThrow('too_big');
    expect(await readFramesBody(new Response('{"a":1}'))).toBe('{"a":1}');
  });

  it('stops a body without a length at the cap while it streams (review round 1)', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(chunk);
      },
    });
    await expect(readFramesBody(new Response(endless))).rejects.toThrow('too_big');
    expect(pulled).toBeLessThanOrEqual(MAX_FRAMES_BYTES / chunk.byteLength + 2);
    expect(await readFramesBody(new Response('é'))).toBe('é');
  });
});

// --- the store ----------------------------------------------------------------------------------------------------

const station = (id: string, series: { id: number; limit: number }[]): ApiStation =>
  ({
    id,
    series: series.map((s) => ({ id: s.id, stalenessLimitSeconds: s.limit })),
  }) as unknown as ApiStation;

const credit = (text: string): AttributionEntry => ({
  source: 'NL-1',
  lang: 'nl',
  text,
  url: null,
  required: true,
  dateKind: null,
  date: null,
  dateText: null,
});

const T0 = at('2026-10-20T00:00:00Z');
const chunk = (
  series: number[],
  vlast: (number | null)[][],
  from = T0,
  attribution = [credit('RWS')],
): FramesChunk => ({
  from: new Date(from).toISOString(),
  to: new Date(from + (vlast[0]?.length ?? 0) * H).toISOString(),
  series,
  vlast,
  attribution,
});
const stations = [station('nl.rws.a', [{ id: 1, limit: 3 * 3600 }]), station('nl.rws.b', [{ id: 2, limit: 7200 }])];
const span = [{ from: T0, to: T0 + 6 * H }];

describe('the frame store', () => {
  it('shows the bucket t - 1 h (R12), Snapshot-shaped, with ts at the bucket end', () => {
    const s = buildFrameStore([chunk([1], [[10, 11, 12, 13, 14, 15]])], span, stations);
    expect(s.valuesAt(T0 + 3 * H).get(1)).toEqual({
      series: 1,
      ts: new Date(T0 + 3 * H).toISOString(),
      value: 12,
      qc: 0,
      ageSeconds: 0,
      state: 'no_ref',
      basis: null,
      section: false,
    });
    // t = bucket start of the first hour shows nothing: its bucket t - 1 h is before the data.
    expect(s.valuesAt(T0).size).toBe(0);
  });

  it('carries the last non-null bucket within the staleness limit and omits it at the limit', () => {
    const s = buildFrameStore([chunk([1], [[10, 11, null, null, null, null]])], span, stations);
    // t = T0+4h: bucket T0+3h is empty, the last value is bucket T0+1h, ends T0+2h: age 2 h < 3 h.
    const v = s.valuesAt(T0 + 4 * H).get(1);
    expect([v?.value, v?.ageSeconds, v?.ts]).toEqual([11, 7200, new Date(T0 + 2 * H).toISOString()]);
    // t = T0+5h: age 3 h = the limit: lapsed, like `lapses`.
    expect(s.valuesAt(T0 + 5 * H).has(1)).toBe(false);
    expect(s.valuesAt(T0 + 6 * H).has(1)).toBe(false);
  });

  it('applies each series own limit', () => {
    const s = buildFrameStore(
      [
        chunk(
          [1, 2],
          [
            [1, null, null, null, null, null],
            [2, null, null, null, null, null],
          ],
        ),
      ],
      span,
      stations,
    );
    const v = s.valuesAt(T0 + 3 * H);
    expect([v.has(1), v.has(2)]).toEqual([true, false]);
  });

  it('is ready when the bucket t - 1 h has answered, with or without data', () => {
    const s = buildFrameStore([], [{ from: T0, to: T0 + 2 * H }], stations);
    expect([T0, T0 + H, T0 + 2 * H, T0 + 3 * H].map((t) => s.ready(t))).toEqual([false, true, true, false]);
  });

  it('never maps an unknown series id: it is dropped and counted', () => {
    const s = buildFrameStore(
      [
        chunk(
          [1, 99],
          [
            [1, 2, 3, 4, 5, 6],
            [7, 8, 9, 10, 11, 12],
          ],
        ),
      ],
      span,
      stations,
    );
    const v = s.valuesAt(T0 + 6 * H);
    expect([...v.keys()]).toEqual([1]);
    expect(s.dropped).toBe(1);
  });

  it('drops a misaligned chunk whole: no values on any station', () => {
    const ragged = chunk(
      [1, 2],
      [
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3],
      ],
    );
    const rows = chunk([1, 2], [[1, 2, 3, 4, 5, 6]]);
    const half = { ...chunk([1], [[1, 2, 3]]), to: new Date(T0 + 2.5 * H).toISOString() };
    const off = { ...chunk([1], [[1, 2, 3]]), from: new Date(T0 + 1000).toISOString() };
    const s = buildFrameStore([ragged, rows, half, off], span, stations);
    expect(s.valuesAt(T0 + 6 * H).size).toBe(0);
    expect(s.dropped).toBe(2 + 2 + 1 + 1);
  });

  it('keeps the good chunks when another is dropped', () => {
    const s = buildFrameStore([chunk([1], [[5, 5, 5, 5, 5, 5]]), chunk([2], [[1, 2, 3]], T0, [])], span, stations);
    expect(s.valuesAt(T0 + 2 * H).get(1)?.value).toBe(5);
    expect(s.dropped).toBe(0);
  });

  it('does not map the canary series (not in the site stations)', () => {
    const CANARY_SERIES = 424242;
    const s = buildFrameStore(
      [chunk([CANARY_SERIES], [[777777.777, 777777.777, 777777.777, 777777.777, 777777.777, 777777.777]])],
      span,
      stations,
    );
    expect(s.valuesAt(T0 + 3 * H).size).toBe(0);
    expect(s.dropped).toBe(1);
  });

  it('spans two chunks and unions their attribution without duplicates', () => {
    const a = chunk([1], [[1, 2, 3]], T0, [credit('RWS'), credit('Hub')]);
    const b = chunk([1], [[4, 5, 6]], T0 + 3 * H, [credit('RWS')]);
    const s = buildFrameStore([a, b], span, stations);
    expect(s.valuesAt(T0 + 4 * H).get(1)?.value).toBe(4);
    expect(s.valuesAt(T0 + 6 * H).get(1)?.value).toBe(6);
    expect(s.attribution().map((x) => x.text)).toEqual(['RWS', 'Hub']);
  });
});

describe('buildFrameStore on crafted chunks (review round 1)', () => {
  const known = new Set([1, 2]);
  const hour = fc.integer({ min: 0, max: 48 }).map((h) => at('2026-10-24T00:00:00Z') + h * H);
  const cell = fc.oneof(fc.constant(null), fc.double(), fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY));
  const chunk = fc
    .record({
      from: fc.oneof(
        hour,
        hour.map((t) => t + 1234),
      ),
      hours: fc.integer({ min: -2, max: 30 }),
      series: fc.array(fc.oneof(fc.constantFrom(1, 2), fc.integer({ min: -5, max: 2_147_483_647 })), { maxLength: 6 }),
      rows: fc.array(fc.array(cell, { maxLength: 32 }), { maxLength: 8 }),
    })
    .map(
      (r): FramesChunk => ({
        from: new Date(r.from).toISOString(),
        to: new Date(r.from + r.hours * H).toISOString(),
        series: r.series,
        vlast: r.rows,
        attribution: [],
      }),
    );

  it('never throws, maps only known ids to finite values, and counts what it drops', () => {
    fc.assert(
      fc.property(fc.array(chunk, { maxLength: 4 }), hour, (chunks, t) => {
        const store = buildFrameStore(
          chunks,
          [{ from: at('2026-10-23T00:00:00Z'), to: at('2026-10-27T00:00:00Z') }],
          stations,
        );
        expect(store.dropped).toBeGreaterThanOrEqual(0);
        for (const [id, v] of store.valuesAt(t)) {
          expect(known.has(id)).toBe(true);
          expect(Number.isFinite(v.value)).toBe(true);
          expect(v.ageSeconds).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
