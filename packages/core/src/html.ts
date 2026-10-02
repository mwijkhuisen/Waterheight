import { SchemaDrift } from './errors.ts';

// The one thing read from an AGE station page (LU-4; catalogue §2.6, §6.7): the `data-to-json` attribute of the
// `<cmp-dashboard-station>` element. One left-to-right scan with `indexOf` and sticky or global matches of fixed
// literals, so it is linear in the page (no backtracking over the document). It follows the HTML tokenizer: every
// start and end tag has its attributes tokenised like a browser does (quoted or not), so a `<` inside a quoted value
// never starts a tag; comments (ended by `-->` or `--!>`) and bogus comments (`<!…>`, `<?…>`, `</…>`) are skipped;
// the text of the raw-text and RCDATA elements `script` (with its escaped states), `style`, `xmp`, `iframe`,
// `noembed`, `noframes`, `noscript`, `title` and `textarea` is skipped up to its end tag, and everything after
// `<plaintext>`; the contents of a `template` (nested ones counted) are not the page. So a copy of the element in
// any of them is not an element, and `data-to-json=` inside another attribute's value is not an attribute. Nothing
// else is parsed and no script ever runs. Failures are a SchemaDrift with a fixed code, never provider text.

/** The largest attribute value (and the room for the rest of the tag is 16 KiB more). */
export const HTML_ATTR_MAX = 256 * 1024;
const TAG_MAX = HTML_ATTR_MAX + 16 * 1024;
const ATTRS_MAX = 64;
const NAME_MAX = 256;
const TARGET = 'cmp-dashboard-station';
const WS = new Set([' ', '\t', '\n', '\f', '\r']);
const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" };

/** A start or end tag: `<` or `</`, an ASCII letter, then the name up to whitespace, `/` or `>`. */
const TAG = /<(\/?)([A-Za-z][^\t\n\f\r />]*)/y;
/** `-->` ends a comment, and `--!>` too (as in a browser). */
const COMMENT_END = /--!?>/g;
/** What changes the state inside a script: `<!--`, `-->`, `<script` and `</script`. */
const SCRIPT = /<!--|-->|<(\/?)script(?=[\t\n\f\r />])/gi;
const RAW = ['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'title', 'textarea'];
const CLOSE = new Map(RAW.map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi')]));

const fail = (code: string): never => {
  throw new SchemaDrift(code);
};

/**
 * The index after the `>` of a tag whose name ends at `from`, its attributes tokenised like a browser does; -1 when
 * the page ends first (a browser drops such a tag and everything after it). With `keep` (the target element) the
 * attributes are collected under the caps, and an unterminated tag is `html_attr`.
 */
function tagEnd(html: string, from: number, keep?: [string, string][]): number {
  const limit = keep === undefined ? html.length : Math.min(html.length, from + TAG_MAX);
  let p = from;
  for (;;) {
    while (p < limit && (WS.has(html[p] as string) || html[p] === '/')) p++;
    if (p >= limit) return keep === undefined ? -1 : fail('html_attr');
    if (html[p] === '>') return p + 1;
    if (keep !== undefined && keep.length >= ATTRS_MAX) return fail('html_attr');
    // A name runs to whitespace, `/`, `=` or `>`; a first `=` belongs to the name (as in a browser).
    const nameStart = p++;
    while (p < limit && !WS.has(html[p] as string) && !'/=>'.includes(html[p] as string)) p++;
    if (keep !== undefined && p - nameStart > NAME_MAX) return fail('html_attr');
    const name = html.slice(nameStart, p).toLowerCase();
    while (p < limit && WS.has(html[p] as string)) p++;
    let value = '';
    if (html[p] === '=') {
      p++;
      while (p < limit && WS.has(html[p] as string)) p++;
      const q = html[p];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, p + 1);
        if (end < 0) return keep === undefined ? -1 : fail('html_attr');
        if (keep !== undefined && (end >= limit || end - p - 1 > HTML_ATTR_MAX)) return fail('html_attr');
        if (keep !== undefined) value = html.slice(p + 1, end);
        p = end + 1;
      } else {
        const start = p;
        while (p < limit && !WS.has(html[p] as string) && html[p] !== '>') p++;
        if (keep !== undefined && p - start > HTML_ATTR_MAX) return fail('html_attr');
        if (keep !== undefined) value = html.slice(start, p);
      }
    }
    keep?.push([name, value]);
  }
}

/** The index after the comment that opens at `i`, or -1. `<!-->` and `<!--->` close at once; `<!--!>` does not. */
function commentEnd(html: string, i: number): number {
  COMMENT_END.lastIndex = i + 2;
  let m = COMMENT_END.exec(html);
  // The dashes of `--!>` cannot be the opening ones (at most twice).
  while (m !== null && m[0] === '--!>' && m.index < i + 4) {
    COMMENT_END.lastIndex = m.index + 1;
    m = COMMENT_END.exec(html);
  }
  return m === null ? -1 : m.index + m[0].length;
}

/**
 * The index of the `</script` that ends a script's text from `from`, or -1. As in a browser, `<!--` escapes and
 * `<!--<script` double-escapes the text, so a `</script>` after `<!--<script` does not end it; `-->` undoes both.
 */
function scriptEnd(html: string, from: number): number {
  let state = 0; // 0 data, 1 escaped, 2 double escaped
  SCRIPT.lastIndex = from;
  for (let m = SCRIPT.exec(html); m !== null; m = SCRIPT.exec(html)) {
    if (m[0] === '<!--') {
      if (state === 0) state = 1;
      // `<!-->` and `<!--->` share their dashes with the `-->`.
      SCRIPT.lastIndex = m.index + 2;
    } else if (m[0] === '-->') state = 0;
    else if (m[1] === '/') {
      if (state < 2) return m.index;
      state = 1;
    } else if (state === 1) state = 2;
  }
  return -1;
}

/**
 * The parsed JSON of the `data-to-json` attribute of the one `<cmp-dashboard-station>` element of a page (decoys
 * in comments, raw text, templates and attribute values aside). Codes: `html_tag` (no such element),
 * `html_tag_count` (two or more), `html_attr` (an unterminated element or quote, a value over 256 KiB, more than 64
 * attributes, the attribute missing or twice) and `html_json`. The five named entities and numeric references are
 * decoded; a reference beyond U+10FFFF stays as text.
 */
export function dataToJson(html: string): unknown {
  let found: [string, string][] | null = null;
  let templates = 0;
  let i = 0;
  for (;;) {
    i = html.indexOf('<', i);
    if (i < 0) break;
    if (html.startsWith('<!--', i)) {
      i = commentEnd(html, i);
      if (i < 0) break;
      continue;
    }
    TAG.lastIndex = i;
    const m = TAG.exec(html);
    if (m === null) {
      const next = html[i + 1];
      if (next !== '!' && next !== '?' && next !== '/') {
        i++;
        continue;
      }
      // A bogus comment (a doctype too) runs to the first `>`; `</>` is dropped.
      i = html.indexOf('>', i + 2);
      if (i < 0) break;
      i++;
      continue;
    }
    const end = m[1] === '/';
    const name = (m[2] as string).toLowerCase();
    const target = !end && templates === 0 && name === TARGET;
    if (target && found !== null) return fail('html_tag_count');
    const attrs: [string, string][] | undefined = target ? [] : undefined;
    i = tagEnd(html, i + m[0].length, attrs);
    if (i < 0) break;
    if (attrs !== undefined) found = attrs;
    if (name === 'template') templates = end ? Math.max(0, templates - 1) : templates + 1;
    if (end) continue;
    if (name === 'plaintext') break;
    let close = -1;
    if (name === 'script') close = scriptEnd(html, i);
    else if (CLOSE.has(name)) {
      const re = CLOSE.get(name) as RegExp;
      re.lastIndex = i;
      close = re.exec(html)?.index ?? -1;
    } else continue;
    if (close < 0) break;
    // The end tag's attributes are tokenised too.
    i = tagEnd(html, close + 2 + name.length);
    if (i < 0) break;
  }
  if (found === null) return fail('html_tag');
  const hits = found.filter(([n]) => n === 'data-to-json');
  if (hits.length !== 1) return fail('html_attr');
  const raw = (hits[0] as [string, string])[1].replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi,
    (ref, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith('#')) {
        const point = k.startsWith('#x') ? Number.parseInt(k.slice(2), 16) : Number(k.slice(1));
        // Beyond Unicode: not a character (String.fromCodePoint would throw). The text stays as it is.
        return point <= 0x10ffff ? String.fromCodePoint(point) : ref;
      }
      return ENTITIES[k] ?? ref;
    },
  );
  try {
    return JSON.parse(raw);
  } catch {
    return fail('html_json');
  }
}
