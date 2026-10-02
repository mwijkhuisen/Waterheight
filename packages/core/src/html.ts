import { SchemaDrift } from './errors.ts';

// The one thing read from an AGE station page (LU-4; catalogue §2.6, §6.7): the `data-to-json` attribute of the
// `<cmp-dashboard-station>` element. One left-to-right scan with `indexOf` and sticky matches of fixed literals, so
// it is linear in the page (no backtracking over the document). Comments and the raw-text elements `script`,
// `style`, `template` and `textarea` are skipped whole, so a copy of the element inside one of them is not an
// element; attributes are tokenised like a browser does (quoted or not), so `data-to-json=` inside another
// attribute's value is not an attribute. Nothing else is parsed and no script ever runs. Failures are a
// SchemaDrift with a fixed code, never provider text.

/** The largest attribute value (and the room for the rest of the tag is 16 KiB more). */
export const HTML_ATTR_MAX = 256 * 1024;
const TAG_MAX = HTML_ATTR_MAX + 16 * 1024;
const ATTRS_MAX = 64;
const NAME_MAX = 256;
const TARGET = 'cmp-dashboard-station';
const WS = new Set([' ', '\t', '\n', '\f', '\r']);
const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" };

/** An opening tag name this scan acts on, followed by whitespace, `/` or `>`. */
const OPEN = /<(script|style|template|textarea|cmp-dashboard-station)(?=[\t\n\f\r />])/iy;
const CLOSE: Record<string, RegExp> = {
  script: /<\/script(?=[\t\n\f\r />])/gi,
  style: /<\/style(?=[\t\n\f\r />])/gi,
  template: /<\/template(?=[\t\n\f\r />])/gi,
  textarea: /<\/textarea(?=[\t\n\f\r />])/gi,
};

const fail = (code: string): never => {
  throw new SchemaDrift(code);
};

/** The attributes of one start tag whose name ends at `from`; returns them and the index after its `>`. */
function attributes(html: string, from: number): { attrs: [string, string][]; end: number } {
  const limit = Math.min(html.length, from + TAG_MAX);
  const attrs: [string, string][] = [];
  let p = from;
  for (;;) {
    while (p < limit && (WS.has(html[p] as string) || html[p] === '/')) p++;
    if (p >= limit) return fail('html_attr');
    if (html[p] === '>') return { attrs, end: p + 1 };
    if (attrs.length >= ATTRS_MAX) return fail('html_attr');
    // A name runs to whitespace, `/`, `=` or `>`; a first `=` belongs to the name (as in a browser).
    const nameStart = p++;
    while (p < limit && !WS.has(html[p] as string) && !'/=>'.includes(html[p] as string)) p++;
    if (p - nameStart > NAME_MAX) return fail('html_attr');
    const name = html.slice(nameStart, p).toLowerCase();
    while (p < limit && WS.has(html[p] as string)) p++;
    let value = '';
    if (html[p] === '=') {
      p++;
      while (p < limit && WS.has(html[p] as string)) p++;
      const q = html[p];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, p + 1);
        if (end < 0 || end >= limit || end - p - 1 > HTML_ATTR_MAX) return fail('html_attr');
        value = html.slice(p + 1, end);
        p = end + 1;
      } else {
        const start = p;
        while (p < limit && !WS.has(html[p] as string) && html[p] !== '>') p++;
        if (p - start > HTML_ATTR_MAX) return fail('html_attr');
        value = html.slice(start, p);
      }
    }
    attrs.push([name, value]);
  }
}

/**
 * The parsed JSON of the `data-to-json` attribute of the one `<cmp-dashboard-station>` element of a page (decoys
 * in comments, scripts and other attributes aside). Codes: `html_tag` (no such element), `html_tag_count` (two or
 * more), `html_attr` (an unterminated tag or quote, a value over 256 KiB, more than 64 attributes, the attribute
 * missing or twice) and `html_json`. The five named entities and numeric references are decoded; a reference
 * beyond U+10FFFF stays as text.
 */
export function dataToJson(html: string): unknown {
  let found: [string, string][] | null = null;
  let i = 0;
  for (;;) {
    i = html.indexOf('<', i);
    if (i < 0) break;
    if (html.startsWith('<!--', i)) {
      // `<!-->` and `<!--->` close a comment too, as in a browser.
      const end = html.indexOf('-->', i + 2);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    OPEN.lastIndex = i;
    const m = OPEN.exec(html);
    if (m === null) {
      i++;
      continue;
    }
    const name = (m[1] as string).toLowerCase();
    if (name === TARGET) {
      if (found !== null) return fail('html_tag_count');
      const tag = attributes(html, i + m[0].length);
      found = tag.attrs;
      i = tag.end;
      continue;
    }
    const close = CLOSE[name] as RegExp;
    close.lastIndex = i + m[0].length;
    const c = close.exec(html);
    const gt = c === null ? -1 : html.indexOf('>', c.index);
    if (gt < 0) break;
    i = gt + 1;
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
