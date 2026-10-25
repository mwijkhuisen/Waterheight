import { type ApiStation, type AttributionEntry, stateOf } from '@rws/contracts';
import { replaceEqualDeep } from '@tanstack/react-query';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildFrameStore,
  type FrameStore,
  type FramesChunk,
  type FramesMeta,
  type FramesRead,
  framesPlan,
  framesUrl,
  MAX_FRAMES_BYTES,
  type PlayedValue,
  readApiUnits,
  readFileUnits,
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

// #112 PR B: windows with the travel-time lead. The playback window itself lives in usePlayback (a hook, not covered by
// a unit test: 25 h + extraLeadHours is one multiplication there); what is pinned here is that every such window still
// costs at most one file per UTC day, and `recent.json` once.
describe('framesPlan for the shifted windows (#112)', () => {
  const key = (u: ReturnType<typeof framesPlan>[number]) => (u.kind === 'day' ? u.day : u.kind);
  const oneFilePerDay = (from: number, to: number) => {
    const plan = framesPlan(from, to, meta(), 'public');
    expect(plan.every((u) => u.kind !== 'api')).toBe(true);
    const keys = plan.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.filter((u) => u.kind === 'recent').length).toBeLessThanOrEqual(1);
    return plan;
  };

  it.each([
    ['a settled day', '2026-10-15T10:00:00Z', ['2026-10-14', '2026-10-15']],
    ['across a day boundary', '2026-10-15T03:00:00Z', ['2026-10-13', '2026-10-14', '2026-10-15']],
    ['unsettled days', '2026-10-25T10:00:00Z', ['recent']],
    ['the settled/unsettled boundary', '2026-10-24T05:00:00Z', ['2026-10-22', '2026-10-23', 'recent']],
  ])('the paused window [t - 30 h, t) at %s', (_n, iso, keys) => {
    const t = at(iso);
    expect(oneFilePerDay(t - 30 * H, t).map(key)).toEqual(keys);
  });

  it('every hour of a week: at most one file per UTC day for the paused window', () => {
    for (let t = at('2026-10-18T00:00:00Z'); t <= at('2026-10-26T12:00:00Z'); t += H) {
      const plan = oneFilePerDay(t - 30 * H, t);
      expect(plan.length).toBeLessThanOrEqual(3);
    }
  });

  it('a 7-day play window with the 30 h lead asks at most one file per UTC day', () => {
    const end = at('2026-10-26T12:00:00Z');
    for (const shiftH of [0, 5]) {
      const plan = oneFilePerDay(end - 7 * D - (25 + shiftH) * H, end);
      const days = Math.ceil((7 * D + (25 + shiftH) * H + 12 * H) / D) + 1;
      expect(plan.length).toBeLessThanOrEqual(days);
    }
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
  state?: (number | null)[][],
): FramesChunk => ({
  from: new Date(from).toISOString(),
  to: new Date(from + (vlast[0]?.length ?? 0) * H).toISOString(),
  series,
  vlast,
  ...(state === undefined ? {} : { state }),
  attribution,
});
const stations = [station('nl.rws.a', [{ id: 1, limit: 3 * 3600 }]), station('nl.rws.b', [{ id: 2, limit: 7200 }])];
const span = [{ from: T0, to: T0 + 6 * H }];

describe('the frame store', () => {
  it('a carried value shows the state of its own bucket', () => {
    const s = buildFrameStore(
      [chunk([1], [[10, 11, null, null, null, null]], T0, [credit('RWS')], [[1, 3, null, null, null, null]])],
      span,
      stations,
    );
    const v = s.valuesAt(T0 + 4 * H).get(1);
    expect([v?.value, v?.state]).toEqual([11, 'elevated']);
  });

  it('a v1 chunk (no state) gives stateUnknown with a no_ref placeholder', () => {
    const s = buildFrameStore([chunk([1], [[10, 11, 12, 13, 14, 15]])], span, stations);
    const v = s.valuesAt(T0 + 3 * H).get(1);
    expect([v?.value, v?.state, v?.section, v?.stateUnknown, v?.basis]).toEqual([12, 'no_ref', false, true, null]);
  });

  it('drops a chunk with a misaligned state whole and counts it', () => {
    const rows = [[1, 2, 3, 4, 5, 6]];
    const short = chunk([1], rows, T0, [], [[1, 2, 3]]);
    const count = chunk([1], rows, T0, [], [rows[0] as number[], rows[0] as number[]]);
    const s = buildFrameStore([short, count], span, stations);
    expect(s.valuesAt(T0 + 6 * H).size).toBe(0);
    expect(s.dropped).toBe(2);
  });

  it('a later chunk for the same hour without state drops the earlier code', () => {
    const a = chunk([1], [[1, 2, 3]], T0, [], [[4, 4, 4]]);
    const b = chunk([1], [[7, 8, 9]], T0, []);
    const v = buildFrameStore([a, b], span, stations)
      .valuesAt(T0 + 3 * H)
      .get(1);
    expect([v?.value, v?.stateUnknown]).toEqual([9, true]);
  });

  it('shows the bucket t - 1 h (R12), Snapshot-shaped, with ts at the bucket end and the hour state (v2)', () => {
    // code 4 = high; 12 = high + SECTION_BIT
    const state = [[0, 1, 4, 12, 2, 5]];
    const s = buildFrameStore([chunk([1], [[10, 11, 12, 13, 14, 15]], T0, [credit('RWS')], state)], span, stations);
    const sec = s.valuesAt(T0 + 4 * H).get(1);
    expect([sec?.state, sec?.section, sec?.stateUnknown]).toEqual(['high', true, undefined]);
    expect(s.valuesAt(T0 + 3 * H).get(1)).toEqual({
      series: 1,
      ts: new Date(T0 + 3 * H).toISOString(),
      value: 12,
      qc: 0,
      ageSeconds: 0,
      state: 'high',
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

// --- O3 (#219): the stage readers keep their identity, and the indexed store equals the old copying one -------------

describe('the stage readers under structural sharing', () => {
  const c0 = chunk([1], [[1, 2]], T0);
  const c1 = chunk([2], [[3, 4]], T0 + 2 * H);
  const files = [
    { kind: 'day', day: '2026-10-20', v: 1 },
    { kind: 'day', day: '2026-10-21', v: 1 },
  ] as const;
  const calls = [
    { kind: 'api', from: T0, to: T0 + 2 * H },
    { kind: 'api', from: T0 + 2 * H, to: T0 + 4 * H },
  ] as const;
  const ok = (data: FramesChunk | undefined) => ({ isError: false, isSuccess: data !== undefined, data });
  // useQueries runs a `combine` result through replaceEqualDeep against the previous one: same data, same object.
  it('a changed fetch status alone gives back the previous result (files and API)', () => {
    const nowMs = at('2026-10-26T12:00:00Z');
    const rf = readFileUnits(files, T0, T0 + 2 * D, nowMs);
    const a = rf([ok(c0), ok(c1)]);
    const b = rf([{ ...ok(c0), isFetching: true } as FramesRead, { ...ok(c1), status: 'success' } as FramesRead]);
    expect(replaceEqualDeep(a, b)).toBe(a);
    const ra = readApiUnits(calls);
    const x = ra([ok(c0), ok(c1)]);
    const y = ra([{ ...ok(c0), isFetching: true } as FramesRead, ok(c1)]);
    expect(replaceEqualDeep(x, y)).toBe(x);
  });

  it('a chunk arriving in an earlier slot keeps the other chunk object and takes the new one as it is', () => {
    const ra = readApiUnits(calls);
    const before = ra([ok(undefined), ok(c1)]);
    const after = ra([ok(c0), ok(c1)]);
    expect(before.chunks).toEqual([null, c1]);
    const shared = replaceEqualDeep(before, after);
    expect(shared).not.toBe(before);
    expect(shared.chunks[0]).toBe(c0);
    expect(shared.chunks[1]).toBe(c1);
    expect(shared.answered).toEqual([
      { from: T0, to: T0 + 2 * H },
      { from: T0 + 2 * H, to: T0 + 4 * H },
    ]);
  });

  it('failed is the sorted comma-joined day list, empty for none', () => {
    const nowMs = at('2026-10-26T12:00:00Z');
    const err = { isError: true, isSuccess: false, data: undefined };
    const days = [
      { kind: 'day', day: '2026-10-21', v: 1 },
      { kind: 'day', day: '2026-10-20', v: 1 },
    ] as const;
    const read = readFileUnits(days, at('2026-10-20T00:00:00Z'), at('2026-10-22T00:00:00Z'), nowMs);
    expect(read([ok(c0), ok(c1)]).failed).toBe('');
    expect(read([err, ok(c1)]).failed).toBe('2026-10-21');
    const both = read([err, err]);
    expect(both.failed).toBe('2026-10-20,2026-10-21');
    expect(both.chunks).toEqual([null, null]);
    expect(both.answered).toEqual([]);
    // recent.json failed: every unsettled day of the window is failed (24th, 25th and 26th are unsettled)
    const recent = readFileUnits([{ kind: 'recent' }], at('2026-10-22T00:00:00Z'), at('2026-10-27T00:00:00Z'), nowMs);
    expect(recent([err]).failed).toBe('2026-10-24,2026-10-25,2026-10-26');
  });
});

describe('the indexed frame store equals the copying one it replaced (O3)', { timeout: 20_000 }, () => {
  // The pre-O3 algorithm, verbatim from f4215e5 (buildFrameStore), as the oracle.
  function oldStore(
    chunks: readonly FramesChunk[],
    answered: readonly { from: number; to: number }[],
    stationList: readonly ApiStation[],
  ): FrameStore {
    const limit = new Map<number, number>();
    for (const st of stationList) for (const s of st.series) limit.set(s.id, s.stalenessLimitSeconds);
    const buckets = new Map<number, Map<number, number>>();
    const codes = new Map<number, Map<number, number>>();
    const first = new Map<number, number>();
    const credits = new Map<string, AttributionEntry>();
    let dropped = 0;
    for (const c of chunks) {
      const from = Date.parse(c.from);
      const hours = (Date.parse(c.to) - from) / H;
      if (
        !Number.isInteger(hours) ||
        hours < 0 ||
        from % H !== 0 ||
        c.vlast.length !== c.series.length ||
        c.vlast.some((r) => r.length !== hours) ||
        (c.state !== undefined && (c.state.length !== c.series.length || c.state.some((r) => r.length !== hours)))
      ) {
        dropped += c.series.length;
        continue;
      }
      c.series.forEach((id, i) => {
        if (!limit.has(id)) {
          dropped += 1;
          return;
        }
        const m = buckets.get(id) ?? new Map<number, number>();
        const k = codes.get(id) ?? new Map<number, number>();
        const states = c.state?.[i];
        (c.vlast[i] as readonly (number | null)[]).forEach((v, h) => {
          if (v === null || !Number.isFinite(v)) return;
          const hourMs = from + h * H;
          m.set(hourMs, v);
          const code = states?.[h];
          if (code == null) k.delete(hourMs);
          else k.set(hourMs, code);
          first.set(id, Math.min(first.get(id) ?? hourMs, hourMs));
        });
        buckets.set(id, m);
        codes.set(id, k);
      });
      for (const a of c.attribution) credits.set(JSON.stringify(a), a);
    }
    const ready = (t: number) => {
      const b = Math.floor(t / H) * H - H;
      return answered.some((r) => r.from <= b && b < r.to);
    };
    const valuesAt = (t: number, only?: ReadonlySet<number>) => {
      const out = new Map<number, PlayedValue>();
      const newest = Math.floor(t / H) * H - H;
      for (const [series, m] of buckets) {
        if (only !== undefined && !only.has(series)) continue;
        const limitMs = (limit.get(series) as number) * 1000;
        const oldest = first.get(series) as number;
        for (let b = newest; b >= oldest; b -= H) {
          const ageMs = t - (b + H);
          if (ageMs >= limitMs) break;
          const value = m.get(b);
          if (value === undefined) continue;
          const code = codes.get(series)?.get(b);
          const decoded = code === undefined ? undefined : stateOf(code);
          out.set(series, {
            series,
            ts: new Date(b + H).toISOString(),
            value,
            qc: 0,
            ageSeconds: Math.round(ageMs / 1000),
            state: decoded?.state ?? 'no_ref',
            basis: null,
            section: decoded?.section ?? false,
            ...(decoded === undefined ? { stateUnknown: true as const } : {}),
          });
          break;
        }
      }
      return out;
    };
    return { ready, valuesAt, attribution: () => [...credits.values()], dropped };
  }

  const base = at('2026-10-24T00:00:00Z');
  const sites = [station('s', [{ id: 1, limit: 6 * 3600 }]), station('t', [{ id: 2, limit: 2 * 3600 }])];
  const cell = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: -50, max: 50 }) },
    { weight: 2, arbitrary: fc.constant(null) },
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
  );
  const code = fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 15 }));
  const credit = fc.constantFrom('A', 'B', 'C').map((text) => ({
    source: 'NL-1',
    lang: 'nl' as const,
    text,
    url: null,
    required: true,
    dateKind: null,
    date: null,
    dateText: null,
  }));
  const aChunk = fc
    .record({
      start: fc.integer({ min: 0, max: 10 }),
      hours: fc.integer({ min: 0, max: 8 }),
      // 1 and 2 are known, 3 is not; ids repeat within a chunk
      series: fc.array(fc.constantFrom(1, 2, 3), { maxLength: 4 }),
      withState: fc.boolean(),
      // 0: aligned; 1: a row of the wrong length; 2: a missing row; 3: a start that is not a whole hour
      fault: fc.constantFrom(0, 0, 0, 0, 1, 2, 3),
      seed: fc.infiniteStream(cell),
      codes: fc.infiniteStream(code),
      credits: fc.array(credit, { maxLength: 2 }),
    })
    .map((r): FramesChunk | null => {
      const cells = r.seed[Symbol.iterator]();
      const cds = r.codes[Symbol.iterator]();
      const grid = <T>(pick: () => T) => r.series.map(() => Array.from({ length: r.hours }, pick));
      const vlast = grid(() => cells.next().value as number | null);
      const state = grid(() => cds.next().value as number | null);
      if (r.fault === 1 && vlast[0]) vlast[0] = [...vlast[0], 1];
      if (r.fault === 2) vlast.pop();
      const from = base + r.start * H + (r.fault === 3 ? 1000 : 0);
      return {
        from: new Date(from).toISOString(),
        to: new Date(from + r.hours * H).toISOString(),
        series: r.series,
        vlast,
        ...(r.withState ? { state } : {}),
        attribution: r.credits,
      };
    });
  // A null slot is a chunk not yet there: the new store skips it, the oracle gets the list without nulls.
  const slots = fc.array(fc.oneof({ weight: 6, arbitrary: aChunk }, { weight: 1, arbitrary: fc.constant(null) }), {
    maxLength: 5,
  });
  const entries = (m: Map<number, PlayedValue>) => [...m];

  it('gives the same values, order, readiness, drops and credits for any list of chunks', () => {
    fc.assert(
      fc.property(slots, (list) => {
        const answered = [{ from: base + 2 * H, to: base + 12 * H }];
        const fresh = buildFrameStore(list, answered, sites);
        const old = oldStore(
          list.filter((c): c is FramesChunk => c !== null),
          answered,
          sites,
        );
        expect(fresh.dropped).toBe(old.dropped);
        expect(fresh.attribution()).toEqual(old.attribution());
        for (const h of [0, 1, 2, 3, 5, 8, 11, 12, 14, 20, 30]) {
          for (const t of [base + h * H, base + h * H + 17 * 60_000]) {
            expect(entries(fresh.valuesAt(t))).toEqual(entries(old.valuesAt(t)));
            for (const only of [new Set([2]), new Set([1, 3]), new Set<number>()])
              expect(entries(fresh.valuesAt(t, only))).toEqual(entries(old.valuesAt(t, only)));
            expect(fresh.ready(t)).toBe(old.ready(t));
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('is not vacuous: the generator makes stores that hold values, states and drops', () => {
    let held = 0;
    let withState = 0;
    let drops = 0;
    fc.assert(
      fc.property(slots, (list) => {
        const store = buildFrameStore(list, [], sites);
        drops += store.dropped;
        for (const h of [4, 8, 12]) {
          const v = store.valuesAt(base + h * H);
          held += v.size;
          for (const x of v.values()) if (!x.stateUnknown) withState += 1;
        }
      }),
      { numRuns: 200 },
    );
    expect(held).toBeGreaterThan(0);
    expect(withState).toBeGreaterThan(0);
    expect(drops).toBeGreaterThan(0);
  });
});
