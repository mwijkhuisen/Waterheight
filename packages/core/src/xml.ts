// A provider's XML is bounded before a validator or a parser reads it (T-CAP-2,
// review S1 of P2b). fast-xml-parser's validator collects every attribute of a
// tag at once, and its parser builds a node per tag and attribute: one tag with
// hundreds of thousands of attributes, or a flood of them over many tags,
// exhausts a small heap. A linear scan of the text measures both first.

export type XmlCaps = {
  /** At most this many characters in one tag, from its `<` to its `>`. */
  maxTag: number;
  /** At most this many tags plus attributes in the whole text. */
  maxItems: number;
};

const GT = 0x3e;
const QUOTE = 0x22;
const APOS = 0x27;
const EQUALS = 0x3d;

/**
 * The cap of `caps` that `text` breaks, as a fixed code, or null. A tag runs
 * from `<` to the first `>` outside quotes (to the end of the text when there
 * is none), and every `=` outside quotes in it counts as an attribute: never
 * fewer than the tags and attributes a parser builds from a text the validator
 * accepts, which needs `=` and a quoted value for each. Comments and CDATA
 * sections are skipped to their end: no parser reads a tag inside them.
 */
export function xmlOverCaps(text: string, caps: XmlCaps): 'xml_tag_too_long' | 'xml_too_many_items' | null {
  let items = 0;
  let i = text.indexOf('<');
  while (i >= 0) {
    if (text.startsWith('<!--', i) || text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(text[i + 2] === '-' ? '-->' : ']]>', i + 4);
      i = end < 0 ? -1 : text.indexOf('<', end + 3);
      continue;
    }
    items += 1;
    let quote = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (j - i >= caps.maxTag) return 'xml_tag_too_long';
      const c = text.charCodeAt(j);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === GT) break;
      else if (c === QUOTE || c === APOS) quote = c;
      else if (c === EQUALS) items += 1;
    }
    if (items > caps.maxItems) return 'xml_too_many_items';
    i = text.indexOf('<', j + 1);
  }
  return null;
}
