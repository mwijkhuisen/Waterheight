import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedJson, cappedArray, parseJsonArray, SchemaDrift } from '../src/index.ts';

// Bounded JSON (T-LOAD-1): the caps hold before JSON.parse runs, and a document
// of the wrong shape stops at its first bad element.

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SchemaDrift) return err.message;
    throw err;
  }
  return 'ok';
};

describe('boundedJson', () => {
  it('counts every value, never fewer than JSON.parse builds, whatever the strings hold', () => {
    const count = (doc: unknown): number =>
      1 +
      (Array.isArray(doc) || (typeof doc === 'object' && doc !== null)
        ? Object.values(doc)
            .map(count)
            .reduce((a, b) => a + b, 0)
        : 0);
    fc.assert(
      fc.property(fc.jsonValue(), (doc) => {
        const text = JSON.stringify(doc);
        const n = count(doc);
        expect(boundedJson(text, { maxNodes: n + 2 * text.length, maxDepth: 1000 })).toEqual(JSON.parse(text));
        // One cap below the real number of values always refuses it.
        expect(codeOf(() => boundedJson(text, { maxNodes: n - 1, maxDepth: 1000 }))).toBe('json_too_many_nodes');
      }),
      { numRuns: 300 },
    );
  });

  it('ignores brackets and commas inside strings, escaped quotes included', () => {
    const text = JSON.stringify({ a: '[{,,,}]\\"[[[', b: ['x"],[', 'y'] });
    expect(boundedJson(text, { maxNodes: 5, maxDepth: 2 })).toEqual(JSON.parse(text));
  });

  it('refuses too many values, too deep a nesting and a document that is not JSON, with fixed codes', () => {
    expect(codeOf(() => boundedJson(`[${'0,'.repeat(99)}0]`, { maxNodes: 100, maxDepth: 2 }))).toBe(
      'json_too_many_nodes',
    );
    expect(boundedJson(`[${'0,'.repeat(98)}0]`, { maxNodes: 100, maxDepth: 2 })).toHaveLength(99);
    expect(codeOf(() => boundedJson('[[[[1]]]]', { maxNodes: 100, maxDepth: 3 }))).toBe('json_too_deep');
    expect(codeOf(() => boundedJson('<html>', { maxNodes: 100, maxDepth: 3 }))).toBe('not_json');
    expect(codeOf(() => boundedJson('[1,', { maxNodes: 100, maxDepth: 3 }))).toBe('not_json');
  });
});

describe('parseJsonArray and cappedArray', () => {
  const Point = z.strictObject({ t: z.string(), v: z.number(), tags: cappedArray(z.string(), 3).optional() });
  const caps = { maxNodes: 1000, maxDepth: 4, maxItems: 10 };

  it('parses each element and names the first bad one by its index and schema path', () => {
    expect(parseJsonArray('[{"t":"a","v":1},{"t":"b","v":2}]', Point, caps)).toEqual([
      { t: 'a', v: 1 },
      { t: 'b', v: 2 },
    ]);
    expect(codeOf(() => parseJsonArray('[{"t":"a","v":1},{"t":"b","v":"2"},{}]', Point, caps))).toBe(
      'invalid_type at 1.v',
    );
    expect(codeOf(() => parseJsonArray('{"t":"a"}', Point, caps))).toBe('invalid_type');
    expect(codeOf(() => parseJsonArray(`[${'{"t":"a","v":1},'.repeat(10)}{"t":"a","v":1}]`, Point, caps))).toBe(
      'too_big',
    );
  });

  it('checks an array length before its elements: a long wrong-shaped array is one issue', () => {
    const result = z.object({ tags: cappedArray(z.string(), 3) }).safeParse({ tags: Array(10_000).fill(0) });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_big', path: ['tags'] });
    expect(z.object({ tags: cappedArray(z.string(), 3) }).parse({ tags: ['a', 'b', 'c'] })).toEqual({
      tags: ['a', 'b', 'c'],
    });
  });
});
