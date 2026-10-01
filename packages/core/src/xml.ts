// A provider's XML is bounded before a validator or a parser reads it (T-CAP-2,
// review S1 of P2b). fast-xml-parser's validator collects every attribute of a
// tag at once and keeps one stack entry per open tag; its parser builds a node
// per tag and attribute, also for a processing instruction: one tag with
// hundreds of thousands of attributes, a flood of them over many tags, or a
// million unclosed tags exhausts a small heap. A linear scan of the text
// measures all of it first.

export type XmlCaps = {
  /** At most this many characters in one tag, from its `<` to its `>` (a processing instruction: to its `?>`). */
  maxTag: number;
  /** At most this many tags plus attributes in the whole text. */
  maxItems: number;
  /** At most this many open elements at any point. */
  maxDepth: number;
};

export type XmlOverCap = 'xml_tag_too_long' | 'xml_too_many_items' | 'xml_too_deep';

const GT = 0x3e;
const QUOTE = 0x22;
const APOS = 0x27;
const EQUALS = 0x3d;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const BANG = 0x21;

/**
 * The cap of `caps` that `text` breaks, as a fixed code, or null. A tag runs
 * from `<` to the first `>` outside quotes (to the end of the text when there
 * is none); a processing instruction (`<?…?>`) runs to its `?>`, as both the
 * validator and the parser read it; every `=` outside quotes in a tag counts as
 * an attribute: never fewer than the tags and attributes a parser builds from a
 * text the validator accepts, which needs `=` and a quoted value for each. A
 * start tag that is not `<…/>` opens an element, `</…>` closes one: the depth
 * is never less than the validator's stack on text it accepts (a stray end tag
 * is refused there and only lowers the count here). Comments and CDATA
 * sections are skipped to their end: no parser reads a tag inside them.
 */
export function xmlOverCaps(text: string, caps: XmlCaps): XmlOverCap | null {
  let items = 0;
  let depth = 0;
  let i = text.indexOf('<');
  while (i >= 0) {
    if (text.startsWith('<!--', i) || text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(text[i + 2] === '-' ? '-->' : ']]>', i + 4);
      i = end < 0 ? -1 : text.indexOf('<', end + 3);
      continue;
    }
    items += 1;
    const first = text.charCodeAt(i + 1);
    const instruction = first === QUESTION;
    let quote = 0;
    let previous = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (j - i >= caps.maxTag) return 'xml_tag_too_long';
      const c = text.charCodeAt(j);
      if (instruction) {
        if (c === GT && previous === QUESTION && j > i + 1) break;
      } else if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === GT) break;
      else if (c === QUOTE || c === APOS) quote = c;
      if (c === EQUALS && quote === 0) items += 1;
      previous = c;
    }
    if (items > caps.maxItems) return 'xml_too_many_items';
    if (first === SLASH) depth = Math.max(0, depth - 1);
    else if (!instruction && first !== BANG && previous !== SLASH) {
      depth += 1;
      if (depth > caps.maxDepth) return 'xml_too_deep';
    }
    i = text.indexOf('<', j + 1);
  }
  return null;
}
