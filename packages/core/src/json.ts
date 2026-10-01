import { z } from 'zod';
import { SchemaDrift } from './errors.ts';

// A provider's JSON is bounded before it is parsed (T-LOAD-1). A scan of the
// text counts its values and its nesting depth, so JSON.parse never builds a
// larger tree than the caps allow; an array is length-checked before its
// elements are parsed, and the elements of a document's top-level array are
// parsed one at a time, so a document of the wrong shape stops at its first bad
// element instead of collecting one issue per value.

export type JsonCaps = {
  /** At most this many values (objects, arrays and scalars). */
  maxNodes: number;
  /** At most this many nested objects and arrays. */
  maxDepth: number;
};

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;

/**
 * JSON.parse of `text`, after a scan that refuses a document with more values
 * or deeper nesting than `caps`. The scan counts `{`, `[` and `,` outside
 * strings plus one: never fewer than the values JSON.parse would build, also for
 * a prefix of a broken document. Throws SchemaDrift with a fixed code.
 */
export function boundedJson(text: string, caps: JsonCaps): unknown {
  let nodes = 1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === BACKSLASH) i++;
      else if (c === QUOTE) inString = false;
    } else if (c === QUOTE) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      nodes++;
      if (++depth > caps.maxDepth) throw new SchemaDrift('json_too_deep');
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    } else if (c === COMMA) {
      nodes++;
    }
    if (nodes > caps.maxNodes) throw new SchemaDrift('json_too_many_nodes');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SchemaDrift('not_json');
  }
}

/** An array whose length is checked before any element is parsed: a long array of the wrong shape is one issue. */
export const cappedArray = <T extends z.ZodType>(item: T, max: number) =>
  z.array(z.unknown()).max(max).pipe(z.array(item));

/**
 * One value against its strict schema. Throws SchemaDrift with Zod's issue
 * code and the schema path below `at` (our keys and array indexes, never
 * provider text). A long array is parsed one element at a time through this,
 * so a document of the wrong shape stops at its first bad element.
 */
export function parseStrict<T>(schema: z.ZodType<T>, value: unknown, at: readonly (string | number)[] = []): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new SchemaDrift(issue?.code ?? 'invalid', [...at, ...(issue?.path ?? [])].map(String).join('.'));
}

/**
 * A JSON document that is an array of `item`s: bounded by `caps`, at most
 * `maxItems` elements, each parsed on its own (parseStrict).
 */
export function parseJsonArray<T>(text: string, item: z.ZodType<T>, caps: JsonCaps & { maxItems: number }): T[] {
  const doc = boundedJson(text, caps);
  if (!Array.isArray(doc)) throw new SchemaDrift('invalid_type');
  if (doc.length > caps.maxItems) throw new SchemaDrift('too_big');
  return doc.map((element: unknown, i) => parseStrict(item, element, [i]));
}
