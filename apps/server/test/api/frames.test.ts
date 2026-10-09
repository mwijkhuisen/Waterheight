import { FRAMES_MAX_HOURS } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { historyCapMs } from '../../src/api/answer.ts';
import { framesParams, Refused } from '../../src/api/params.ts';
import type { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { assembleFrames } from '../../src/publish/render/frames.ts';
import { fakeDb } from './fake-db.ts';

// P11b: the /frames parameters (pure, before any query) and the pure assembly of the rows into frames.

const BASE = 'http://api.test/api/v1/frames';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-20T12:34:56Z');
const NOW_H = Date.parse('2026-11-20T12:00:00Z');
const START = Date.parse('2026-01-01T00:10:00Z');

const call = (query: string, now = NOW, start = START) => framesParams(`${BASE}?${query}`, now, start);
function outcome(query: string, now = NOW, start = START): string {
  try {
    call(query, now, start);
    return 'ok';
  } catch (err) {
    if (err instanceof Refused) return err.code;
    throw err;
  }
}
const q = (from: number, to: number, extra = '&step=1h') => `from=${iso(from)}&to=${iso(to)}${extra}`;

describe('framesParams', () => {
  it('takes whole UTC hours, any offset, up to now, from ceilHour(displayStart)', () => {
    expect(call(q(NOW_H - 3 * HOUR, NOW_H))).toEqual({ from: NOW_H - 3 * HOUR, to: NOW_H });
    expect(call('from=2026-11-20T10:00%2B02:00&to=2026-11-20T12:00Z&step=1h')).toEqual({
      from: Date.parse('2026-11-20T08:00Z'),
      to: NOW_H,
    });
    expect(call(q(Date.parse('2026-01-01T01:00:00Z'), Date.parse('2026-01-01T03:00:00Z')))).toBeTruthy();
    expect(outcome(q(NOW_H - 336 * HOUR, NOW_H))).toBe('ok');
    expect(FRAMES_MAX_HOURS).toBe(336);
  });

  it('a span over 14 days is span_too_long, one hour more than the cap included', () => {
    expect(outcome(q(NOW_H - 336 * HOUR - HOUR, NOW_H))).toBe('span_too_long');
    expect(outcome(q(NOW_H - 60 * DAY, NOW_H))).toBe('span_too_long');
  });

  it('is out_of_range before ceilHour(displayStart) or after now', () => {
    expect(outcome(q(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T02:00:00Z')))).toBe('out_of_range');
    expect(outcome(q(NOW_H - HOUR, NOW_H + HOUR))).toBe('out_of_range');
    expect(outcome(q(NOW_H, NOW_H + HOUR), NOW_H + HOUR - 1)).toBe('out_of_range');
    expect(outcome(q(NOW_H, NOW_H + HOUR), NOW_H + HOUR)).toBe('ok');
  });

  it('refuses what is not whole hours, an empty or reversed range, and a missing or other step', () => {
    for (const bad of [
      q(NOW_H - 3 * HOUR + 60_000, NOW_H),
      q(NOW_H - 3 * HOUR, NOW_H - 30 * 60_000),
      q(NOW_H, NOW_H),
      q(NOW_H, NOW_H - HOUR),
      q(NOW_H - 3 * HOUR, NOW_H, ''),
      q(NOW_H - 3 * HOUR, NOW_H, '&step=2h'),
      q(NOW_H - 3 * HOUR, NOW_H, '&step=1H'),
      q(NOW_H - 3 * HOUR, NOW_H, '&step=3600'),
      `to=${iso(NOW_H)}&step=1h`,
      `from=${iso(NOW_H - HOUR)}&to=2026-11-20T12:00&step=1h`,
      q(NOW_H - 3 * HOUR, NOW_H, '&step=1h&v=0'),
      q(NOW_H - 3 * HOUR, NOW_H, '&step=1h&v=a'),
      q(NOW_H - 3 * HOUR, NOW_H, '&step=1h&v=1000000'),
    ])
      expect(outcome(bad), bad).toBe('bad_parameter');
  });

  it('refuses unknown, repeated and over-long parameters with the pipeline codes', () => {
    expect(outcome(q(NOW_H - HOUR, NOW_H, '&step=1h&zz=1'))).toBe('unknown_parameter');
    expect(outcome(q(NOW_H - HOUR, NOW_H, '&step=1h&step=1h'))).toBe('repeated_parameter');
    expect(outcome(q(NOW_H - HOUR, NOW_H, `&step=1h&v=${'1'.repeat(40)}`))).toBe('bad_parameter');
    expect(outcome(q(NOW_H - HOUR, NOW_H, '&step=1h&v=7'))).toBe('ok');
  });
});

describe('every refusal costs no database query', () => {
  const app = (queries: string[]) =>
    createApp({
      db: fakeDb(async (cq) => {
        queries.push(cq.sql);
        return { rows: [] };
      }),
      window: { current: { dataEpochMs: START, displayStartMs: START } } as unknown as DisplayWindow,
      now: () => new Date(NOW),
    });

  it('a bad request answers 400 and the database is never asked; a good one asks it', async () => {
    const queries: string[] = [];
    const a = app(queries);
    for (const query of [
      '',
      q(NOW_H - HOUR, NOW_H, '&step=1h&zz=1'),
      q(NOW_H - HOUR, NOW_H, '&step=1h&step=1h'),
      q(NOW_H - HOUR, NOW_H, ''),
      q(NOW_H - 60 * DAY, NOW_H),
      q(NOW_H - HOUR, NOW_H + HOUR),
      q(NOW_H - HOUR + 60_000, NOW_H),
      `${q(NOW_H - HOUR, NOW_H)}&x=${'a'.repeat(300)}`,
    ]) {
      const res = await a.request(`/api/v1/frames?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(queries).toEqual([]);
    await a.request(`/api/v1/frames?${q(NOW_H - HOUR, NOW_H)}`);
    expect(queries.length).toBeGreaterThan(0);
  });
});

describe('assembleFrames', () => {
  const FROM = Date.parse('2026-11-01T00:00:00Z');
  const hoursArb = fc.integer({ min: 0, max: 40 });
  it('one row per series with a value, one entry per hour, null where there is no bucket, never carried forward', () => {
    fc.assert(
      fc.property(
        hoursArb,
        fc.array(
          fc.record({
            series_id: fc.integer({ min: 1, max: 8 }),
            h: fc.integer({ min: -3, max: 45 }),
            vlast: fc.double({ noNaN: true, noDefaultInfinity: true }),
            qc_or: fc.integer({ min: 0, max: 1023 }),
          }),
          { maxLength: 60 },
        ),
        (hours, raw) => {
          const to = FROM + hours * HOUR;
          const rows = raw.map((r) => ({ ...r, bucket: new Date(FROM + r.h * HOUR) }));
          const { ids, vlast, qcOf } = assembleFrames(rows, FROM, to);
          expect(ids).toEqual([...ids].sort((a, b) => a - b));
          expect(new Set(ids).size).toBe(ids.length);
          expect(vlast).toHaveLength(ids.length);
          const inside = raw.filter((r) => r.h >= 0 && r.h < hours);
          expect(new Set(inside.map((r) => r.series_id))).toEqual(new Set(ids));
          ids.forEach((id, i) => {
            const row = vlast[i] as (number | null)[];
            expect(row).toHaveLength(hours);
            for (let h = 0; h < hours; h++) {
              const last = inside.filter((r) => r.series_id === id && r.h === h).at(-1);
              expect(row[h] ?? null).toBe(last === undefined ? null : last.vlast);
            }
            expect(qcOf.get(id)).toBe(inside.filter((r) => r.series_id === id).reduce((a, r) => a | r.qc_or, 0));
          });
        },
      ),
    );
  });

  it('is empty for an empty span or no rows', () => {
    expect(assembleFrames([], FROM, FROM + HOUR)).toEqual({ ids: [], vlast: [], qcOf: new Map() });
    expect(assembleFrames([{ series_id: 1, bucket: new Date(FROM), vlast: 1, qc_or: 0 }], FROM, FROM).ids).toEqual([]);
  });
});

describe('historyCapMs of frames', () => {
  it('is bounded by the oldest value of a series with a history window, and unbounded without one', () => {
    const body = {
      from: iso(NOW_H - 10 * HOUR),
      series: [1, 2],
      vlast: [
        [null, null, 5, 6, null, null, null, null, null, null],
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      ],
    };
    // Series 1's oldest value is hour 2: age at NOW = 8 h 34 m 56 s; window 72 h.
    const win = new Map([[1, 72 * HOUR]]);
    expect(historyCapMs('frames', body, win, NOW)).toBe(72 * HOUR - (NOW - (NOW_H - 8 * HOUR)));
    expect(historyCapMs('frames', body, new Map([[3, HOUR]]), NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(historyCapMs('frames', body, new Map(), NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});
