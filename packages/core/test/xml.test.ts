import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { xmlOverCaps } from '../src/index.ts';

// Bounded XML (T-CAP-2, review S1 of P2b): the scan counts tags and attributes
// exactly on well-formed text and measures each tag, quotes respected, before
// any validator or parser reads it.

const WIDE = 1_000_000_000;

describe('xmlOverCaps', () => {
  /** A small well-formed document with the number of tags (start, end, empty) and attributes it holds. */
  type Doc = { text: string; items: number };
  const name = fc.constantFrom('a', 'row', 'c', 'x:y');
  // Attribute values and text may hold what a naive scan would take for markup: `>`, `=`, the other quote.
  const value = fc.string({ unit: fc.constantFrom('a', ' ', '>', '=', "'", '/', '&amp;', '&lt;'), maxLength: 6 });
  const text = fc.string({ unit: fc.constantFrom('b', ' ', '>', '=', '"', "'", '&lt;'), maxLength: 6 });
  // Comments and CDATA sections hold tag-like text the scan must not count.
  const hidden = fc.constantFrom('<!-- <a b="1" c=\'>\'> = -->', '<![CDATA[ <row r="1"/> = " ]]>', '');
  const doc: fc.Arbitrary<Doc> = fc.letrec<{ doc: Doc }>((tie) => ({
    doc: fc
      .record({
        tag: name,
        attrs: fc.uniqueArray(fc.constantFrom('p', 'q', 'r:s', 'xml:space'), { maxLength: 4 }),
        values: fc.array(value, { minLength: 4, maxLength: 4 }),
        quotes: fc.array(fc.constantFrom('"', "'"), { minLength: 4, maxLength: 4 }),
        // At the maximum depth oneof takes its first arbitrary: text, never another element.
        children: fc.array(fc.oneof({ maxDepth: 4, depthIdentifier: 'doc' }, text, hidden, tie('doc')), {
          maxLength: 3,
        }),
      })
      .map(({ tag, attrs, values, quotes, children }) => {
        const attrText = attrs
          .map((a, k) => {
            const q = quotes[k] as string;
            return ` ${a} = ${q}${(values[k] as string).replaceAll(q, '')}${q}`;
          })
          .join('');
        const inner = children.map((c) => (typeof c === 'string' ? c : c.text)).join('');
        const nested = children.reduce((n, c) => n + (typeof c === 'string' ? 0 : c.items), 0);
        return inner === ''
          ? { text: `<${tag}${attrText}/>`, items: 1 + attrs.length }
          : { text: `<${tag}${attrText}>${inner}</${tag}>`, items: 2 + attrs.length + nested };
      }),
  })).doc;

  it('counts the tags and attributes of well-formed text exactly, whatever quotes, comments and CDATA hold', () => {
    fc.assert(
      fc.property(doc, fc.boolean(), ({ text, items }, declared) => {
        const whole = declared ? `<?xml version="1.0" encoding="UTF-8"?>\n${text}` : text;
        const n = items + (declared ? 3 : 0);
        expect(xmlOverCaps(whole, { maxTag: WIDE, maxItems: n })).toBeNull();
        expect(xmlOverCaps(whole, { maxTag: WIDE, maxItems: n - 1 })).toBe('xml_too_many_items');
      }),
      { numRuns: 300 },
    );
  });

  it('measures a tag from its < to its > outside quotes', () => {
    const tag = (n: number) => `<a b="${'>'.repeat(n - 9)}"/>`;
    expect(tag(64)).toHaveLength(64);
    expect(xmlOverCaps(`<r>${tag(64)}</r>`, { maxTag: 64, maxItems: WIDE })).toBeNull();
    expect(xmlOverCaps(`<r>${tag(65)}</r>`, { maxTag: 64, maxItems: WIDE })).toBe('xml_tag_too_long');
    // An unclosed quote or tag runs to the end of the text.
    expect(xmlOverCaps(`<a b="${' '.repeat(100)}>`, { maxTag: 64, maxItems: WIDE })).toBe('xml_tag_too_long');
    expect(xmlOverCaps(`<a ${'b '.repeat(50)}`, { maxTag: 64, maxItems: WIDE })).toBe('xml_tag_too_long');
    expect(xmlOverCaps('<a b="1"', { maxTag: 64, maxItems: WIDE })).toBeNull();
    // A long comment, CDATA section or text is not a tag.
    const long = 'x'.repeat(1000);
    expect(xmlOverCaps(`<a><!--${long}-->${long}<![CDATA[${long}]]></a>`, { maxTag: 64, maxItems: 3 })).toBeNull();
    // An unterminated comment ends the scan (the validator refuses the text).
    expect(xmlOverCaps(`<a><!--${long}`, { maxTag: 64, maxItems: 1 })).toBeNull();
  });

  it('counts each = outside quotes, also where a validator would read no attribute', () => {
    expect(xmlOverCaps(`<row ${'a='.repeat(10)}/>`, { maxTag: WIDE, maxItems: 11 })).toBeNull();
    expect(xmlOverCaps(`<row ${'a='.repeat(10)}/>`, { maxTag: WIDE, maxItems: 10 })).toBe('xml_too_many_items');
    expect(xmlOverCaps(`<row ${"a='' ".repeat(10)}/>`, { maxTag: WIDE, maxItems: 10 })).toBe('xml_too_many_items');
    expect(xmlOverCaps('<row a="=" b=\'=\'/>', { maxTag: WIDE, maxItems: 3 })).toBeNull();
  });
});
