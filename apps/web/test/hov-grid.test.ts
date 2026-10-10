import type { ApiStation } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { buildGrid, buildStateGrid, hoursOf, hovFetch, hovRows } from '../src/features/flow/hovmoller/grid.ts';
import type { Column } from '../src/features/flow/hovmoller/path.ts';
import { playRange } from '../src/features/flow/playback/engine.ts';
import { buildFrameStore, type FrameStore, type FramesChunk } from '../src/lib/data/frames.ts';
import { amsterdam, ceilHour } from '../src/lib/time/time.ts';

// P11c Hovmöller grid (pure): the 7-day pages, the frames window and the cells (the map's own 24-h change, D-2).

const H = 3_600_000;
const D = 24 * H;
const at = (iso: string) => Date.parse(iso);
const END = at('2026-10-26T12:00:00Z');
const RANGE = { start: END - 14 * D, end: END };

describe('hovRows', () => {
  it('page 0 is the 168 hours up to the end, for no t, a t on it, and a t outside the range', () => {
    const page0 = { from: END - 167 * H, to: END };
    expect(hovRows(undefined, RANGE)).toEqual(page0);
    expect(hovRows(END - 5 * H + 1234, RANGE)).toEqual(page0);
    expect(hovRows(END - 167 * H, RANGE)).toEqual(page0);
    expect(hovRows(END + 6 * H, RANGE)).toEqual(page0);
    expect(hovRows(RANGE.start - H, RANGE)).toEqual(page0);
  });

  it('page 1 is the 7 days before page 0, from the hour of 168 h before the end', () => {
    const page1 = { from: END - 335 * H, to: END - 168 * H };
    expect(hovRows(END - 168 * H, RANGE)).toEqual(page1);
    expect(hovRows(END - 8 * D, RANGE)).toEqual(page1);
    expect(hovRows(END - 335 * H + 600_000, RANGE)).toEqual(page1);
    // Never a third page: the range's first hour (exactly 14 days back) is on neither, and a t there shows page 1.
    expect(hovRows(RANGE.start, RANGE)).toEqual(page1);
  });

  it('clamps to a range shorter than 7 days and keeps a single hour', () => {
    expect(hovRows(undefined, { start: END - 3 * D, end: END })).toEqual({ from: END - 3 * D, to: END });
    expect(hovRows(undefined, { start: END, end: END })).toEqual({ from: END, to: END });
  });

  it('is null when the range holds no hour', () => {
    expect(hovRows(undefined, { start: END, end: END - H })).toBeNull();
    expect(hovRows(END, { start: END + H, end: END })).toBeNull();
  });

  it('every page is at most 168 rows, inside the range, and the pages tile', () => {
    const range = playRange(at('2026-09-01T00:00:00Z'), END + 30 * 60_000);
    for (let t = range.start - 2 * H; t <= range.end + 2 * H; t += 5 * H) {
      const rows = hovRows(t, range);
      expect(rows).not.toBeNull();
      const r = rows as { from: number; to: number };
      expect(hoursOf(r).length).toBeLessThanOrEqual(168);
      expect(r.from).toBeGreaterThanOrEqual(range.start);
      expect(r.to).toBeLessThanOrEqual(range.end);
      expect(r.from).toBeLessThanOrEqual(r.to);
      if (t >= range.start && t <= range.end) {
        expect(r.from).toBeLessThanOrEqual(Math.floor(t / H) * H);
        expect(Math.floor(t / H) * H).toBeLessThanOrEqual(r.to);
      }
    }
    const p0 = hovRows(undefined, range) as { from: number; to: number };
    const p1 = hovRows(p0.from - H, range) as { from: number; to: number };
    expect(p1.to).toBe(p0.from - H);
    expect(p1.from).toBe(range.start);
  });
});

describe('hoursOf', () => {
  it('lists whole UTC hours ascending, both ends included', () => {
    const hours = hoursOf({ from: END - 3 * H, to: END });
    expect(hours).toEqual([END - 3 * H, END - 2 * H, END - H, END]);
    expect(hours.every((h) => h % H === 0)).toBe(true);
    expect(hoursOf({ from: END, to: END })).toEqual([END]);
  });
});

describe('hovFetch', () => {
  it('starts 25 h before the first row, ends at the last, under 193 h', () => {
    const rows = hovRows(undefined, RANGE) as { from: number; to: number };
    const f = hovFetch(rows, at('2026-09-01T00:00:00Z'));
    expect(f).toEqual({ from: rows.from - 25 * H, to: rows.to });
    expect((f.to - f.from) / H).toBe(192);
  });

  it('is clamped at the first whole hour of the display range', () => {
    const rows = { from: END - 10 * H, to: END };
    expect(hovFetch(rows, END - 12 * H - 1000)).toEqual({ from: ceilHour(END - 12 * H - 1000), to: END });
    expect(hovFetch(rows, END - 100 * H)).toEqual({ from: END - 35 * H, to: END });
  });
});

describe('the DST night', () => {
  it('has the 00:00Z and 01:00Z rows of 2026-10-25 as two 02:00 rows, CEST then CET', () => {
    const rows = hovRows(undefined, { start: at('2026-10-24T00:00:00Z'), end: END }) as { from: number; to: number };
    const hours = hoursOf(rows);
    const i = hours.indexOf(at('2026-10-25T00:00:00Z'));
    expect(i).toBeGreaterThan(0);
    expect(hours[i + 1]).toBe(at('2026-10-25T01:00:00Z'));
    const [a, b] = [amsterdam(hours[i] as number), amsterdam(hours[i + 1] as number)];
    expect([a.time, a.label]).toEqual(['02:00', 'CEST']);
    expect([b.time, b.label]).toEqual(['02:00', 'CET']);
  });
});

// --- buildGrid ----------------------------------------------------------------------------------------------------

const T0 = at('2026-10-20T00:00:00Z');
const LEN = 60;
/** The row hour used by most cells: bucket T0+29h now, T0+5h a day earlier. */
const ROW = T0 + 30 * H;

interface Def {
  id: string;
  series: { id: number; quantity: 'H' | 'Q'; limitH?: number; data: Record<number, number> }[];
}

const stationOf = (d: Def): ApiStation =>
  ({
    id: d.id,
    series: d.series.map((s) => ({ id: s.id, quantity: s.quantity, stalenessLimitSeconds: (s.limitH ?? 48) * 3600 })),
  }) as unknown as ApiStation;
const colOf = (id: string, x: number): Column => ({
  id,
  name: id,
  riverId: 'rhine',
  x,
  tier: 1,
  tidal: false,
  owner: false,
});
const chunkOf = (defs: Def[]): FramesChunk => {
  const all = defs.flatMap((d) => d.series);
  return {
    from: new Date(T0).toISOString(),
    to: new Date(T0 + LEN * H).toISOString(),
    series: all.map((s) => s.id),
    vlast: all.map((s) => Array.from({ length: LEN }, (_, i) => s.data[i] ?? null)),
    attribution: [],
  };
};
const storeOf = (defs: Def[]) =>
  buildFrameStore([chunkOf(defs)], [{ from: T0, to: T0 + LEN * H }], defs.map(stationOf));
/** A station with one H series that is `from` at bucket 5 and `to` at bucket 29. */
let nextSeries = 1;
const hStation = (id: string, from: number, to: number): Def => ({
  id,
  series: [{ id: nextSeries++, quantity: 'H', data: { 5: from, 29: to } }],
});
const cellsAt = (defs: Def[], cols: Column[], stations = defs.map(stationOf), hours = [ROW]) =>
  buildGrid(cols, stations, hours, storeOf(defs));

describe('buildGrid: H stations', () => {
  const cases: [string, number, number, number][] = [
    ['up10', 100, 110, 1],
    ['up11', 100, 111, 2],
    ['up50', 100, 150, 2],
    ['up51', 100, 151, 3],
    ['dn10', 100, 90, -1],
    ['dn11', 100, 89, -2],
    ['dn50', 100, 50, -2],
    ['dn51', 100, 49, -3],
    ['up2', 100, 102, 0],
    ['up3', 100, 103, 1],
    ['dn2', 100, 98, 0],
    ['dn3', 100, 97, -1],
  ];
  const defs = cases.map(([id, a, b]) => hStation(`nl.t.${id}`, a, b));
  const row = cellsAt(
    defs,
    defs.map((d, i) => colOf(d.id, i)),
  )[0];

  it.each(cases.map((c, i) => [c[0], c[1], c[2], c[3], i] as const))('%s: Δ in cm and its bin', (_id, a, b, bin, i) => {
    expect(row?.[i]).toEqual({ bin, change: b - a, quantity: 'H' });
  });
});

describe('buildGrid: quantity choice', () => {
  it('falls back to the Q trend when the H series has no change, with the change in m³/s', () => {
    const d: Def = {
      id: 'nl.t.hq',
      series: [
        { id: 101, quantity: 'H', data: { 29: 300 } }, // no value 24 h earlier: no H change
        { id: 102, quantity: 'Q', data: { 5: 100, 29: 130 } },
      ],
    };
    expect(cellsAt([d], [colOf(d.id, 0)])[0]?.[0]).toEqual({ bin: 1, change: 30, quantity: 'Q' });
  });

  it('prefers the H change when both series have one', () => {
    const d: Def = {
      id: 'nl.t.hq2',
      series: [
        { id: 111, quantity: 'Q', data: { 5: 100, 29: 400 } },
        { id: 112, quantity: 'H', data: { 5: 100, 29: 160 } },
      ],
    };
    expect(cellsAt([d], [colOf(d.id, 0)])[0]?.[0]).toEqual({ bin: 3, change: 60, quantity: 'H' });
  });

  it('gives a Q-only station ±1 by its trend, 0 inside the dead band', () => {
    const rise: Def = { id: 'nl.t.qr', series: [{ id: 121, quantity: 'Q', data: { 5: 200, 29: 1200 } }] };
    const fall: Def = { id: 'nl.t.qf', series: [{ id: 122, quantity: 'Q', data: { 5: 200, 29: 150 } }] };
    const flat: Def = { id: 'nl.t.qs', series: [{ id: 123, quantity: 'Q', data: { 5: 100, 29: 101.5 } }] };
    const row = cellsAt([rise, fall, flat], [colOf(rise.id, 0), colOf(fall.id, 1), colOf(flat.id, 2)])[0];
    expect(row).toEqual([
      { bin: 1, change: 1000, quantity: 'Q' },
      { bin: -1, change: -50, quantity: 'Q' },
      { bin: 0, change: 1.5, quantity: 'Q' },
    ]);
  });
});

describe('buildGrid: grey cells', () => {
  const grey = { bin: null, change: null, quantity: null };

  it('is grey without a value 24 h earlier, and without a value now', () => {
    const noBefore: Def = { id: 'nl.t.nb', series: [{ id: 131, quantity: 'H', data: { 29: 100 } }] };
    const noNow: Def = { id: 'nl.t.nn', series: [{ id: 132, quantity: 'H', data: { 5: 100 }, limitH: 6 }] };
    const row = cellsAt([noBefore, noNow], [colOf(noBefore.id, 0), colOf(noNow.id, 1)])[0];
    expect(row).toEqual([grey, grey]);
  });

  it('never carries a value past its staleness limit forward', () => {
    // Data at buckets 5 and 20; at ROW the newest is 9 h old and the limit is 3 h: grey, though bucket 20 exists.
    const stale: Def = { id: 'nl.t.st', series: [{ id: 141, quantity: 'H', limitH: 3, data: { 5: 100, 20: 130 } }] };
    // The same data within a 12 h limit: carried (age 3 h at bucket 26's end... bucket 26, age 3 h < 12 h).
    const fresh: Def = { id: 'nl.t.fr', series: [{ id: 142, quantity: 'H', limitH: 12, data: { 5: 100, 26: 130 } }] };
    const row = cellsAt([stale, fresh], [colOf(stale.id, 0), colOf(fresh.id, 1)])[0];
    expect(row?.[0]).toEqual(grey);
    expect(row?.[1]).toEqual({ bin: 2, change: 30, quantity: 'H' });
  });

  it('is grey for a column whose station is not in stations, and no series leaks into a column', () => {
    const own: Def = hStation('nl.t.own', 100, 120);
    const other: Def = hStation('nl.t.other', 100, 400);
    const gone: Def = hStation('nl.t.gone', 100, 400);
    // The store knows all three; buildGrid is given only `own` and `other`.
    const store = storeOf([own, other, gone]);
    const row = buildGrid([colOf(own.id, 0), colOf(gone.id, 1)], [stationOf(own), stationOf(other)], [ROW], store)[0];
    expect(row).toEqual([{ bin: 2, change: 20, quantity: 'H' }, grey]);
  });

  it('is grey for every hour before the data, and has one row per hour and one cell per column', () => {
    const d: Def = hStation('nl.t.rows', 100, 120);
    const cols = [colOf(d.id, 0), colOf('nl.t.none', 1)];
    const grid = cellsAt([d], cols, [stationOf(d)], [T0 + 6 * H, ROW, ROW + H]);
    expect(grid.map((r) => r.length)).toEqual([2, 2, 2]);
    expect(grid[0]?.[0]?.bin).toBeNull();
    expect(grid[1]?.[0]).toEqual({ bin: 2, change: 20, quantity: 'H' });
    // ROW + 1 h: bucket 30 is empty, bucket 29 (age 1 h) and, a day earlier, bucket 5 (age 2 h) still count.
    expect(grid[2]?.[0]).toEqual({ bin: 2, change: 20, quantity: 'H' });
  });
});

describe('buildGrid: valuesAt calls', () => {
  it('asks each distinct hour once per call', () => {
    const d: Def = hStation('nl.t.spy', 100, 120);
    const store = storeOf([d]);
    const asked: number[] = [];
    const spy: Pick<FrameStore, 'valuesAt'> = {
      valuesAt: (t) => {
        asked.push(t);
        return store.valuesAt(t);
      },
    };
    const hours = hoursOf({ from: T0 + 24 * H, to: T0 + 54 * H });
    buildGrid([colOf(d.id, 0)], [stationOf(d)], hours, spy);
    // Rows T0+24h..54h and their day-earlier hours T0..30h overlap on 7 hours: 31 + 31 - 7 = 55 distinct hours.
    expect(asked.length).toBe(55);
    expect(new Set(asked).size).toBe(55);
    expect(asked.length).toBeLessThan(2 * hours.length);
  });
});

// --- buildStateGrid (#112 D-3) -------------------------------------------------------------------------------------

/** A chunk whose series carry a state code per hour (`codes` beside `data`; v2), or none (`v1`: a pre-#112 file). */
const stateChunkOf = (
  series: { id: number; data: Record<number, number>; codes?: Record<number, number> }[],
  v1 = false,
): FramesChunk => ({
  ...chunkOf([{ id: 'x', series: series.map((s) => ({ id: s.id, quantity: 'H' as const, data: s.data })) }]),
  ...(v1
    ? {}
    : {
        state: series.map((s) =>
          Array.from({ length: LEN }, (_, i) => (s.data[i] === undefined ? null : (s.codes?.[i] ?? 0))),
        ),
      }),
});
const stateStation = (id: string, ids: number[]): ApiStation =>
  ({
    id,
    series: ids.map((sid) => ({ id: sid, quantity: 'H', stalenessLimitSeconds: 48 * 3600 })),
  }) as unknown as ApiStation;
const levelsOf = (chunks: FramesChunk[], stations: ApiStation[], hours: number[]) =>
  buildStateGrid(
    stations.map((st, i) => colOf(st.id, i)),
    stations,
    hours,
    buildFrameStore(chunks, [{ from: T0, to: T0 + LEN * H }], stations),
  );

describe('buildStateGrid', () => {
  it("gives the level of the played hour's bucket, and a carried value the level of its own hour", () => {
    const st = stateStation('nl.s.a', [901]);
    const chunk = stateChunkOf([{ id: 901, data: { 3: 100, 4: 120 }, codes: { 3: 2, 4: 4 } }]);
    // t = T0+5h shows bucket 4 (high); t = T0+8h carries bucket 4 (still its own state, high); t = T0+4h shows bucket 3.
    expect(levelsOf([chunk], [st], [T0 + 4 * H, T0 + 5 * H, T0 + 8 * H])).toEqual([[2], [4], [4]]);
  });

  it('keeps no_ref as level 0 (a state), and reads a section code by its level', () => {
    const st = stateStation('nl.s.b', [902]);
    const chunk = stateChunkOf([{ id: 902, data: { 3: 100, 4: 100 }, codes: { 3: 0, 4: 3 + 8 } }]);
    expect(levelsOf([chunk], [st], [T0 + 4 * H, T0 + 5 * H])).toEqual([[0], [3]]);
  });

  it("takes the station's highest series, whatever the series order", () => {
    for (const ids of [
      [903, 904],
      [904, 903],
    ]) {
      const st = stateStation('nl.s.c', ids);
      const chunk = stateChunkOf([
        { id: 903, data: { 4: 100 }, codes: { 4: 2 } },
        { id: 904, data: { 4: 100 }, codes: { 4: 5 } },
      ]);
      expect(levelsOf([chunk], [st], [T0 + 5 * H])).toEqual([[5]]);
    }
  });

  it('is null (no data) for a v1 chunk, an hour before the data and a column whose station is unknown', () => {
    const st = stateStation('nl.s.d', [905]);
    const v1 = stateChunkOf([{ id: 905, data: { 4: 100 } }], true);
    expect(levelsOf([v1], [st], [T0 + 5 * H])).toEqual([[null]]);
    const v2 = stateChunkOf([{ id: 905, data: { 4: 100 }, codes: { 4: 3 } }]);
    expect(levelsOf([v2], [st], [T0 + 2 * H])).toEqual([[null]]);
    const grid = buildStateGrid(
      [colOf('nl.s.unknown', 0)],
      [st],
      [T0 + 5 * H],
      buildFrameStore([v2], [{ from: T0, to: T0 + LEN * H }], [st]),
    );
    expect(grid).toEqual([[null]]);
  });

  it('ignores a series whose state is unknown beside one whose state is known', () => {
    const st = stateStation('nl.s.e', [906, 907]);
    const v1 = stateChunkOf([{ id: 906, data: { 4: 100 } }], true);
    const v2 = stateChunkOf([{ id: 907, data: { 4: 100 }, codes: { 4: 1 } }]);
    expect(levelsOf([v1, v2], [st], [T0 + 5 * H])).toEqual([[1]]);
  });
});
