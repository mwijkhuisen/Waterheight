import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CanonRun,
  checkRun,
  encodeRun,
  FORECAST_COLUMNS,
  FORECAST_SOURCES,
  type ForecastPoint,
  type ForecastRunIn,
  firstValid,
  lastValid,
  mergeDecision,
  type StoredRun,
} from '../src/index.ts';

// Properties of the run identity (A§7.4 item 9): the encoding the content hash is taken over does not depend on
// how the instants are written or ordered, and changes with every value; and any order of loading the captures of a
// set of runs (a replay, twice, reversed, interleaved) leaves the same stored runs, each the earliest capture.

const STEP = 10 * 60_000;
const T0 = Date.parse('2026-10-24T00:00Z');
const NL1 = FORECAST_SOURCES['NL-1'];
const hex = (r: CanonRun) => Buffer.from(encodeRun(r)).toString('hex');

const value = fc.oneof(fc.constant(null), fc.double({ min: -1e6, max: 1e6, noNaN: true }));
const point = fc.record(Object.fromEntries(FORECAST_COLUMNS.map((c) => [c, value])) as Record<string, typeof value>);
const runIn = fc.tuple(fc.integer({ min: 0, max: 400 }), fc.array(point, { minLength: 1, maxLength: 40 })).map(
  ([start, pts]): ForecastRunIn => ({
    series: 's',
    kind: 'quantiles',
    stepMs: STEP,
    issuedAt: null,
    providerSegmentEnd: null,
    points: pts.map((p, i) => ({
      ...(p as Partial<Record<string, number | null>>),
      value: 1 + i, // never a gap
      ts: new Date(T0 + (start + i) * STEP).toISOString(),
      flags: 0,
    })),
  }),
);
/** The same instant with another offset (whole quarter hours, ±14 h). */
const reexpress = (ms: number, quarters: number) => {
  const off = quarters * 15;
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};
const canon = (r: ForecastRunIn) => checkRun(r, T0 + 1000 * STEP, NL1).run as CanonRun;

describe('the run encoding', () => {
  it('is invariant under offset re-expression and point order', () => {
    fc.assert(
      fc.property(runIn, fc.integer({ min: -56, max: 56 }), fc.integer(), (r, quarters, seed) => {
        const moved: ForecastPoint[] = r.points.map((p) => ({ ...p, ts: reexpress(Date.parse(p.ts), quarters) }));
        const shuffled = [...moved].sort(
          (a, b) => ((Date.parse(a.ts) * 2654435761) ^ seed) - ((Date.parse(b.ts) * 2654435761) ^ seed),
        );
        expect(hex(canon({ ...r, points: shuffled }))).toBe(hex(canon(r)));
      }),
    );
  });

  it('changes when any column of any point changes', () => {
    fc.assert(
      fc.property(
        runIn,
        fc.nat(),
        fc.constantFrom(...FORECAST_COLUMNS),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (r, at, column, v) => {
          const i = at % r.points.length;
          const before = r.points[i] as ForecastPoint;
          const was = before[column];
          // a float32 neighbour (or -0 for 0) is the same stored value
          fc.pre(was === undefined || was === null || Math.fround(was) !== Math.fround(v));
          const changed = r.points.map((p, j) => (j === i ? { ...p, [column]: v } : p));
          expect(hex(canon({ ...r, points: changed }))).not.toBe(hex(canon(r)));
        },
      ),
    );
  });
});

type Mem = StoredRun & { fetched: number };

/** An in-memory store that applies mergeDecision as the loader does. */
function load(store: Mem[], cap: { run: CanonRun; fetched: number }): void {
  const hash = hex(cap.run);
  const same = store.filter((s) => lastValid(s) === lastValid(cap.run));
  const d = mergeDecision(same, cap.run, hash, true);
  if (d.kind === 'insert') store.push({ ...cap.run, id: String(store.length), hash, fetched: cap.fetched });
  else if (d.kind === 'same' || d.kind === 'extend') {
    const s = store.find((x) => x.id === d.id) as Mem;
    s.fetched = Math.min(s.fetched, cap.fetched);
    if (d.kind === 'extend') {
      s.points = [...d.add, ...s.points];
      s.hash = hex(s);
    }
  }
}
const snapshot = (store: Mem[]) => store.map((s) => `${firstValid(s)}|${s.hash}|${s.fetched}`).sort();

describe('loading captures', () => {
  // A few runs (different values or ends); each captured hourly with its leading values dropped (six per hour).
  const runs = fc.array(
    fc.tuple(fc.integer({ min: 30, max: 60 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 5 })),
    { minLength: 1, maxLength: 3 },
  );
  it('gives the same stored runs, each the earliest capture, in any order and twice', () => {
    fc.assert(
      fc.property(runs, fc.integer(), (specs, seed) => {
        const caps: { run: CanonRun; fetched: number }[] = [];
        specs.forEach(([n, start, captures], k) => {
          const full = canon({
            series: 's',
            kind: 'deterministic',
            stepMs: STEP,
            issuedAt: null,
            providerSegmentEnd: null,
            points: Array.from({ length: n }, (_, i) => ({
              ts: new Date(T0 + (start * 6 + i) * STEP).toISOString(),
              value: 100 * k + i,
              flags: 0,
            })),
          });
          for (let h = 0; h < captures; h++) {
            caps.push({ run: { ...full, points: full.points.slice(h * 6) }, fetched: T0 + (start + h) * 6 * STEP + k });
          }
        });
        const inOrder: Mem[] = [];
        for (const c of caps) load(inOrder, c);
        const shuffled: Mem[] = [];
        const order = [...caps].sort((a, b) => ((a.fetched * 2654435761) ^ seed) - ((b.fetched * 2654435761) ^ seed));
        for (const c of [...order, ...order]) load(shuffled, c);
        expect(snapshot(shuffled)).toEqual(snapshot(inOrder));
        // each run is stored once, as its earliest (longest) capture, with the earliest fetch time
        expect(inOrder.length).toBe(new Set(specs.map((_, k) => k)).size);
      }),
    );
  });
});
