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
        expect(xmlOverCaps(whole, { maxTag: WIDE, maxItems: n, maxDepth: WIDE })).toBeNull();
        expect(xmlOverCaps(whole, { maxTag: WIDE, maxItems: n - 1, maxDepth: WIDE })).toBe('xml_too_many_items');
      }),
      { numRuns: 300 },
    );
  });

  it('measures a tag from its < to its > outside quotes', () => {
    const tag = (n: number) => `<a b="${'>'.repeat(n - 9)}"/>`;
    expect(tag(64)).toHaveLength(64);
    expect(xmlOverCaps(`<r>${tag(64)}</r>`, { maxTag: 64, maxItems: WIDE, maxDepth: WIDE })).toBeNull();
    expect(xmlOverCaps(`<r>${tag(65)}</r>`, { maxTag: 64, maxItems: WIDE, maxDepth: WIDE })).toBe('xml_tag_too_long');
    // An unclosed quote or tag runs to the end of the text.
    expect(xmlOverCaps(`<a b="${' '.repeat(100)}>`, { maxTag: 64, maxItems: WIDE, maxDepth: WIDE })).toBe(
      'xml_tag_too_long',
    );
    expect(xmlOverCaps(`<a ${'b '.repeat(50)}`, { maxTag: 64, maxItems: WIDE, maxDepth: WIDE })).toBe(
      'xml_tag_too_long',
    );
    expect(xmlOverCaps('<a b="1"', { maxTag: 64, maxItems: WIDE, maxDepth: WIDE })).toBeNull();
    // A long comment, CDATA section or text is not a tag.
    const long = 'x'.repeat(1000);
    expect(
      xmlOverCaps(`<a><!--${long}-->${long}<![CDATA[${long}]]></a>`, { maxTag: 64, maxItems: 3, maxDepth: WIDE }),
    ).toBeNull();
    // An unterminated comment ends the scan (the validator refuses the text).
    expect(xmlOverCaps(`<a><!--${long}`, { maxTag: 64, maxItems: 1, maxDepth: WIDE })).toBeNull();
  });

  it('measures a processing instruction to its ?>, and counts its = as attributes (the parser builds them)', () => {
    // A `>` inside an instruction does not end it: the instruction is one tag of 20 characters.
    const pi = '<?x a="1" > b="2" ?>';
    expect(pi).toHaveLength(20);
    expect(xmlOverCaps(`${pi}<r/>`, { maxTag: 20, maxItems: 4, maxDepth: WIDE })).toBeNull();
    expect(xmlOverCaps(`${pi}<r/>`, { maxTag: 19, maxItems: 4, maxDepth: WIDE })).toBe('xml_tag_too_long');
    expect(xmlOverCaps(`${pi}<r/>`, { maxTag: 20, maxItems: 3, maxDepth: WIDE })).toBe('xml_too_many_items');
    // The reviewer's shape (review R2 of P2b): one instruction carrying a million attributes.
    expect(xmlOverCaps(`<?x ${' a=""'.repeat(1_000_000)}?><r/>`, { maxTag: 16_384, maxItems: WIDE, maxDepth: 1 })).toBe(
      'xml_tag_too_long',
    );
    // An instruction never opens an element.
    expect(xmlOverCaps('<?xml version="1.0"?><?pi?><a/>', { maxTag: WIDE, maxItems: WIDE, maxDepth: 1 })).toBeNull();
  });

  it('bounds the nesting depth: open elements less closed ones, empty tags and instructions not counted', () => {
    const caps = { maxTag: WIDE, maxItems: WIDE, maxDepth: 3 };
    expect(xmlOverCaps('<a><b><c/></b></a>', caps)).toBeNull();
    // An empty-element tag is never on the validator's stack: three open elements, whatever it holds.
    expect(xmlOverCaps('<a><b><c><d/></c></b></a>', caps)).toBeNull();
    expect(xmlOverCaps('<a><b><c></c></b><b><c></c></b></a>', caps)).toBeNull();
    expect(xmlOverCaps('<a><b><c><d></d></c></b></a>', caps)).toBe('xml_too_deep');
    // A stray end tag only lowers the count (the validator refuses the text); a self-closing tag with a `/`
    // in a value, or with attributes, opens nothing.
    expect(xmlOverCaps('</z></z><a><b><c/></b></a>', caps)).toBeNull();
    expect(xmlOverCaps('<a><b><c d="/" e="1"/></b></a>', caps)).toBeNull();
    expect(xmlOverCaps('<a><b><c d="/"></b></a>', caps)).toBeNull();
    expect(xmlOverCaps('<a><b><c d="/"><e></e></b></a>', caps)).toBe('xml_too_deep');
    // The reviewer's shape (review R1 of P2b): a flood of unclosed tags, each under every other cap.
    expect(xmlOverCaps(`<r>${'<abc>'.repeat(1_500_000)}`, { maxTag: WIDE, maxItems: WIDE, maxDepth: 256 })).toBe(
      'xml_too_deep',
    );
  });

  it('counts each = outside quotes, also where a validator would read no attribute', () => {
    expect(xmlOverCaps(`<row ${'a='.repeat(10)}/>`, { maxTag: WIDE, maxItems: 11, maxDepth: WIDE })).toBeNull();
    expect(xmlOverCaps(`<row ${'a='.repeat(10)}/>`, { maxTag: WIDE, maxItems: 10, maxDepth: WIDE })).toBe(
      'xml_too_many_items',
    );
    expect(xmlOverCaps(`<row ${"a='' ".repeat(10)}/>`, { maxTag: WIDE, maxItems: 10, maxDepth: WIDE })).toBe(
      'xml_too_many_items',
    );
    expect(xmlOverCaps('<row a="=" b=\'=\'/>', { maxTag: WIDE, maxItems: 3, maxDepth: WIDE })).toBeNull();
  });
});
