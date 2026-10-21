import { SeriesTide, SnapshotTide } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { seriesTide, type TideRow, tideAt } from '../src/index.ts';

// P18a criterion 1 (invariant 9): the surge is measured − astro at the measured value's own instant, from the same
// series (hence the same datum), null when that instant has no astronomical value; nothing else moves it.

const STEP = 600_000;
const T0 = Date.UTC(2026, 10, 20, 10);
/** An instant on the 10-minute grid within ± 2 days of T0. */
const gridTs = fc.integer({ min: -288, max: 288 }).map((i) => T0 + i * STEP);
/** A value in cm with one decimal, as the loader stores it. */
const cm = fc.integer({ min: -5000, max: 5000 }).map((i) => i / 10);
const astroRows = fc
  .uniqueArray(fc.record({ ts: gridTs, value: cm }), { selector: (r) => r.ts, maxLength: 40 })
  .map((rs) => rs.map((r): TideRow => ({ kind: 'astro', hilo: null, ...r })));
const extremeRows = (max: number) =>
  fc.array(
    fc.record({
      kind: fc.constantFrom('extreme' as const, 'extreme_astro' as const),
      hilo: fc.constantFrom('high' as const, 'low' as const),
      ts: gridTs,
      value: cm,
    }),
    { maxLength: max },
  );
const measured = fc.record({ ts: gridTs, value: cm });

describe('tideAt properties', () => {
  it('surge = value − astro (to 0.1 cm) iff an astro row has exactly the measured ts; null astro ⇒ null surge', () => {
    fc.assert(
      fc.property(measured, astroRows, extremeRows(6), (m, astro, ext) => {
        const out = tideAt(m, [...ext, ...astro]);
        if (astro.length + ext.length === 0) {
          expect(out).toBeUndefined();
          return;
        }
        expect(SnapshotTide.parse(out)).toEqual(out);
        const same = astro.find((r) => r.ts === m.ts);
        if (same === undefined) {
          expect(out?.astro).toBeNull();
          expect(out?.surge).toBeNull();
        } else {
          expect(out?.astro).toBe(same.value);
          expect(Math.abs((out?.surge as number) - (m.value - same.value))).toBeLessThanOrEqual(0.05 + 1e-9);
        }
      }),
    );
  });

  it('astro at T ≠ ts, at ts ± one step, or a high/low water at ts never gives a surge', () => {
    fc.assert(
      fc.property(measured, cm, fc.integer({ min: 1, max: 6 }), (m, v, k) => {
        const rows: TideRow[] = [
          { kind: 'astro', hilo: null, ts: m.ts + STEP, value: v },
          { kind: 'astro', hilo: null, ts: m.ts - STEP, value: v },
          { kind: 'astro', hilo: null, ts: m.ts + k * 60_000, value: v }, // t inside the bucket after ts
          { kind: 'extreme', hilo: 'high', ts: m.ts, value: v },
          { kind: 'extreme_astro', hilo: 'low', ts: m.ts, value: v },
        ];
        const out = tideAt(m, rows);
        expect(out?.astro).toBeNull();
        expect(out?.surge).toBeNull();
      }),
    );
  });

  it("one series' result depends on its own rows only (several series, other datums)", () => {
    // The callers group the rows by series_id (states.ts); a series of another datum (another provider key) is
    // another series, here with its rows offset by a datum shift and an astro row at A's own ts.
    const series = fc.integer({ min: 2, max: 5 });
    fc.assert(
      fc.property(measured, astroRows, astroRows, series, cm, (m, rowsA, rowsB, b, shift) => {
        const tagged = [
          ...rowsA.map((r) => ({ series_id: 1, ...r })),
          ...rowsB.map((r) => ({ series_id: b, ...r, value: r.value + shift })),
          { series_id: b, kind: 'astro' as const, hilo: null, ts: m.ts, value: shift },
        ];
        const bySeries = new Map<number, TideRow[]>();
        for (const { series_id, ...r } of tagged) bySeries.set(series_id, [...(bySeries.get(series_id) ?? []), r]);
        expect(tideAt(m, bySeries.get(1) ?? [])).toEqual(tideAt(m, rowsA));
      }),
    );
  });

  it('keeps every high/low water once, by ts, its hilo, its kind mapped; every ts in UTC with Z', () => {
    fc.assert(
      fc.property(measured, extremeRows(6), astroRows, (m, ext, astro) => {
        fc.pre(ext.length > 0);
        const out = tideAt(m, [...astro, ...ext]);
        const want = [...ext]
          .sort((a, b) => a.ts - b.ts)
          .map((r) => [r.ts, r.value, r.hilo, r.kind === 'extreme' ? 'measured' : 'astro']);
        expect(out?.extremes.map((e) => [Date.parse(e.ts), e.value, e.hilo, e.kind])).toEqual(want);
        for (const e of out?.extremes ?? []) expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      }),
    );
  });
});

describe('seriesTide properties', () => {
  it('astro is every astro row by ts; surge exactly at the points with an astro row at their ts', () => {
    const points = fc.uniqueArray(fc.record({ ts: gridTs, value: cm }), { selector: (p) => p.ts, maxLength: 60 });
    fc.assert(
      fc.property(points, astroRows, extremeRows(20), (pts, astro, ext) => {
        const out = seriesTide(pts, [...ext, ...astro]);
        if (astro.length + ext.length === 0) {
          expect(out).toBeUndefined();
          return;
        }
        expect(SeriesTide.parse(out)).toEqual(out);
        const at = new Map(astro.map((r) => [r.ts, r.value]));
        expect(out?.astro.map((p) => [Date.parse(p.ts), p.value])).toEqual(
          [...astro].sort((a, b) => a.ts - b.ts).map((r) => [r.ts, r.value]),
        );
        const want = pts.filter((p) => at.has(p.ts));
        expect(out?.surge.map((p) => Date.parse(p.ts))).toEqual(want.map((p) => p.ts));
        out?.surge.forEach((s, i) => {
          const p = want[i] as { ts: number; value: number };
          expect(Math.abs(s.value - (p.value - (at.get(p.ts) as number)))).toBeLessThanOrEqual(0.05 + 1e-9);
        });
        expect(out?.extremes).toHaveLength(ext.length);
        for (const p of [...(out?.astro ?? []), ...(out?.surge ?? []), ...(out?.extremes ?? [])])
          expect(p.ts.endsWith('Z')).toBe(true);
      }),
    );
  });
});

describe('tide examples', () => {
  const at = (h: number, m: number) => Date.UTC(2026, 10, 20, h, m);

  it('T = 10:10, last measurement 10:00, astro at 10:00 and 10:10: the 10:00 row', () => {
    const rows: TideRow[] = [
      { kind: 'astro', hilo: null, ts: at(10, 0), value: 112.4 },
      { kind: 'astro', hilo: null, ts: at(10, 10), value: 118.9 },
    ];
    expect(tideAt({ ts: at(10, 0), value: 362.4 }, rows)).toEqual({
      astro: 112.4,
      surge: 250,
      derived: 'surge',
      extremes: [],
    });
  });

  it('no rows: no tide; rows without astro at ts: null astro and surge', () => {
    expect(tideAt({ ts: at(10, 0), value: 1 }, [])).toBeUndefined();
    expect(seriesTide([{ ts: at(10, 0), value: 1 }], [])).toBeUndefined();
    expect(tideAt({ ts: at(10, 0), value: 1 }, [{ kind: 'astro', hilo: null, ts: at(9, 50), value: 1 }])).toEqual({
      astro: null,
      surge: null,
      derived: 'surge',
      extremes: [],
    });
  });

  it('rounds the surge to 0.1 cm', () => {
    const rows: TideRow[] = [{ kind: 'astro', hilo: null, ts: at(10, 0), value: 0.1 }];
    expect(tideAt({ ts: at(10, 0), value: 0.3 }, rows)?.surge).toBe(0.2);
  });
});
