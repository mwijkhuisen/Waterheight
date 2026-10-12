import { SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCheck } from '../../src/adapters/nl-1/parse.ts';
import { nextChunk, planChunks, probeYears, requestBudget } from '../../src/backfill/plan.ts';

// Invariant 9: a property test per parser, and one for the chunk planner (plan §3.10).

const DAY = 86_400_000;

describe('planChunks', () => {
  const range = fc.record({
    start: fc.integer({ min: Date.UTC(1990, 0, 1) / DAY, max: Date.UTC(2026, 7, 1) / DAY - 1 }),
    days: fc.integer({ min: 1, max: 14_000 }),
    chunkDays: fc.integer({ min: 1, max: 400 }),
  });

  it('tiles [from, to) exactly, each chunk at most chunk long, all but the last exactly chunk', () => {
    fc.assert(
      fc.property(range, ({ start, days, chunkDays }) => {
        const from = new Date(start * DAY);
        const to = new Date((start + days) * DAY);
        const chunks = planChunks(from, to, chunkDays * DAY);
        expect(chunks).toHaveLength(Math.ceil(days / chunkDays));
        expect(chunks[0]?.from).toEqual(from);
        expect(chunks.at(-1)?.to).toEqual(to);
        chunks.forEach((c, i) => {
          expect(c.to.getTime() - c.from.getTime()).toBeGreaterThan(0);
          expect(c.to.getTime() - c.from.getTime()).toBeLessThanOrEqual(chunkDays * DAY);
          if (i < chunks.length - 1) {
            expect(c.to.getTime() - c.from.getTime()).toBe(chunkDays * DAY);
            expect(chunks[i + 1]?.from).toEqual(c.to);
          }
        });
      }),
    );
  });

  it('the runner walks the same chunks: nextChunk from each cursor is the planned one', () => {
    fc.assert(
      fc.property(range, ({ start, days, chunkDays }) => {
        const from = new Date(start * DAY);
        const to = new Date((start + days) * DAY);
        let cursor = from;
        for (const c of planChunks(from, to, chunkDays * DAY)) {
          expect(nextChunk(cursor, to, chunkDays * DAY)).toEqual(c);
          cursor = c.to;
        }
        expect(cursor).toEqual(to);
      }),
    );
  });

  it('the budget covers every chunk and probe with 20 % to spare', () => {
    fc.assert(
      fc.property(range, ({ start, days, chunkDays }) => {
        const from = new Date(start * DAY);
        const to = new Date((start + days) * DAY);
        const n = planChunks(from, to, chunkDays * DAY).length;
        const y = probeYears(from, to);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(requestBudget(n, y)).toBeGreaterThanOrEqual(1.2 * (n + y));
      }),
    );
  });
});

describe('parseCheck', () => {
  const body = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

  it('reads the string "true" and "false"', () => {
    expect(parseCheck(body({ Succesvol: true, WaarnemingenAanwezig: 'true' }))).toBe(true);
    expect(parseCheck(body({ Succesvol: true, WaarnemingenAanwezig: 'false' }))).toBe(false);
  });

  it('any other JSON is a SchemaDrift, never a guess', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const ok =
          typeof v === 'object' &&
          v !== null &&
          !Array.isArray(v) &&
          Object.keys(v).sort().join() === 'Succesvol,WaarnemingenAanwezig' &&
          (v as Record<string, unknown>).Succesvol === true &&
          ['true', 'false'].includes((v as Record<string, unknown>).WaarnemingenAanwezig as string);
        if (ok) expect(parseCheck(body(v))).toBe((v as Record<string, unknown>).WaarnemingenAanwezig === 'true');
        else expect(() => parseCheck(body(v))).toThrow(SchemaDrift);
      }),
    );
  });

  it('the boolean spelling and arbitrary text are drift', () => {
    expect(() => parseCheck(body({ Succesvol: true, WaarnemingenAanwezig: true }))).toThrow(SchemaDrift);
    expect(() => parseCheck(body({ Succesvol: false, WaarnemingenAanwezig: 'true' }))).toThrow(SchemaDrift);
    expect(() => parseCheck(body({ Succesvol: true, WaarnemingenAanwezig: 'true', x: 1 }))).toThrow(SchemaDrift);
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          parseCheck(body(s));
        } catch (e) {
          expect(e).toBeInstanceOf(SchemaDrift);
          return;
        }
        throw new Error('a random string parsed');
      }),
    );
  });
});
