import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dataToJson, HTML_ATTR_MAX, SchemaDrift } from '../src/index.ts';

// The LU-4 `data-to-json` reader (catalogue §6.7): only the attribute of the one element outside comments and raw-text
// elements, linear in the page, fixed failure codes.

const REAL = '{&quot;id&quot;:&quot;real&quot;,&quot;n&quot;:[1,2]}';
const OUT = { id: 'real', n: [1, 2] };
const EVIL = '{&quot;id&quot;:&quot;evil&quot;}';
const el = (attrs = `data-to-json="${REAL}"`) => `<cmp-dashboard-station class="c" ${attrs}></cmp-dashboard-station>`;
const page = (before = '', after = '') => `<!DOCTYPE html><html><body>${before}${el()}${after}</body></html>`;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SchemaDrift) return err.code;
    throw err;
  }
  return 'no error';
}

describe('dataToJson', () => {
  it('reads the attribute and decodes the five entities and numeric references', () => {
    const json = '{&quot;n&quot;:&quot;a&amp;b &lt;c&gt; &apos;d&apos; &#39;e&#39; &#65;&#x42; &#x10ffff;&quot;}';
    expect(dataToJson(page('').replace(REAL, json))).toEqual({ n: "a&b <c> 'd' 'e' AB \u{10ffff}" });
    for (const ref of ['&#x110000;', '&#1114112;', '&#9999999;', '&#xffffff;', '&nbsp;']) {
      expect(dataToJson(page('').replace(REAL, `{&quot;n&quot;:&quot;${ref}&quot;}`))).toEqual({ n: ref });
    }
  });

  describe('decoys: the same JSON comes out', () => {
    const decoys: [string, string][] = [
      ['a script holding a fake element', `<script>var x = '<cmp-dashboard-station data-to-json="${EVIL}">';</script>`],
      [
        'an upper-case script holding one',
        `<SCRIPT type="x">'<cmp-dashboard-station data-to-json="${EVIL}">'</SCRIPT >`,
      ],
      [
        'a style, a template and a textarea holding one',
        `<style>/* <cmp-dashboard-station data-to-json="${EVIL}"> */</style><template><cmp-dashboard-station data-to-json="${EVIL}"></template><textarea><cmp-dashboard-station data-to-json="${EVIL}"></textarea>`,
      ],
      ['a comment holding a fake element', `<!-- <cmp-dashboard-station data-to-json="${EVIL}"> -->`],
      ['a div with a data-to-json attribute', `<div data-to-json="${EVIL}">x</div>`],
      ['an attribute value that holds `data-to-json=`', `<p title="data-to-json=&quot;${EVIL}&quot;">x</p>`],
    ];
    for (const [name, decoy] of decoys) {
      it(`${name} before the element`, () => {
        expect(dataToJson(page(decoy))).toEqual(OUT);
      });
      it(`${name} after the element`, () => {
        expect(dataToJson(page('', decoy))).toEqual(OUT);
      });
    }

    it('`title="data-to-json=…"` on the element itself, before the real attribute', () => {
      const attrs = `title="data-to-json=&quot;${EVIL}&quot;" data-to-json="${REAL}"`;
      expect(dataToJson(page('').replace(el(), el(attrs)))).toEqual(OUT);
    });

    it('`data-to-json-old` and `xdata-to-json` are other attributes', () => {
      const attrs = `data-to-json-old="${EVIL}" xdata-to-json="${EVIL}" data-to-json="${REAL}"`;
      expect(dataToJson(page('').replace(el(), el(attrs)))).toEqual(OUT);
      expect(code(() => dataToJson(el(`data-to-json-old="${REAL}"`)))).toBe('html_attr');
    });

    it('an upper-case tag and attribute name, a single-quoted value, an unquoted one, a self-closing slash', () => {
      expect(dataToJson(`<CMP-Dashboard-Station DATA-TO-JSON='${REAL}'></CMP-Dashboard-Station>`)).toEqual(OUT);
      expect(dataToJson(`<cmp-dashboard-station data-to-json = "${REAL}" />`)).toEqual(OUT);
      expect(dataToJson('<cmp-dashboard-station\n\tdata-to-json={&quot;a&quot;:1}\n>')).toEqual({ a: 1 });
    });

    it('a quote inside a quoted value, a `>` inside one, a `<!--` inside one', () => {
      const attrs = `title='a > b <!-- "c"' data-to-json="${REAL}"`;
      expect(dataToJson(page('').replace(el(), el(attrs)))).toEqual(OUT);
    });

    it('an element after an unrelated unclosed tag name that merely starts like a raw-text one', () => {
      expect(dataToJson(`<scripts>x</scripts><textareas>${el()}`)).toEqual(OUT);
    });

    it('`<!-->` is an empty comment and `<!--->` too', () => {
      expect(dataToJson(`<!-->${el()}`)).toEqual(OUT);
      expect(dataToJson(`<!--->${el()}`)).toEqual(OUT);
    });
  });

  describe('failures (fixed codes)', () => {
    it('no element: html_tag', () => {
      expect(code(() => dataToJson('<html><body>Service unavailable</body></html>'))).toBe('html_tag');
      expect(code(() => dataToJson(''))).toBe('html_tag');
      // Only inside a script, a comment, a template: no element at all.
      expect(code(() => dataToJson(`<script>${el()}</script>`))).toBe('html_tag');
      expect(code(() => dataToJson(`<!-- ${el()} -->`))).toBe('html_tag');
      // An unterminated comment or script hides what follows, as in a browser.
      expect(code(() => dataToJson(`<!-- ${el()}`))).toBe('html_tag');
      expect(code(() => dataToJson(`<script>${el()}`))).toBe('html_tag');
      expect(code(() => dataToJson('<cmp-dashboard-stationary data-to-json="{}">'))).toBe('html_tag');
    });

    it('two elements: html_tag_count', () => {
      expect(code(() => dataToJson(el() + el()))).toBe('html_tag_count');
      expect(code(() => dataToJson(`${el()}<cmp-dashboard-station>`))).toBe('html_tag_count');
    });

    it('an unterminated tag or quote, a value over 256 KiB, too many attributes: html_attr', () => {
      expect(code(() => dataToJson('<cmp-dashboard-station data-to-json="{}'))).toBe('html_attr');
      expect(code(() => dataToJson('<cmp-dashboard-station data-to-json=\'{}"></cmp-dashboard-station>'))).toBe(
        'html_attr',
      );
      expect(code(() => dataToJson('<cmp-dashboard-station data-to-json="{}"'))).toBe('html_attr');
      expect(code(() => dataToJson(el(`data-to-json="${'x'.repeat(HTML_ATTR_MAX + 1)}"`)))).toBe('html_attr');
      expect(code(() => dataToJson(el(`data-to-json=${'x'.repeat(HTML_ATTR_MAX + 1)}`)))).toBe('html_attr');
      expect(code(() => dataToJson(el(`title="${'x'.repeat(HTML_ATTR_MAX + 1)}" data-to-json="{}"`)))).toBe(
        'html_attr',
      );
      const many = Array.from({ length: 65 }, (_, k) => `a${k}="1"`).join(' ');
      expect(code(() => dataToJson(el(`${many} data-to-json="{}"`)))).toBe('html_attr');
      expect(code(() => dataToJson(el(`${'n'.repeat(300)}=1 data-to-json="{}"`)))).toBe('html_attr');
    });

    it('the largest allowed value passes the size rule', () => {
      const json = `[${'1,'.repeat(HTML_ATTR_MAX / 2 - 2)}1]`;
      expect(json.length).toBeLessThanOrEqual(HTML_ATTR_MAX);
      expect((dataToJson(el(`data-to-json="${json}"`)) as number[]).length).toBe(HTML_ATTR_MAX / 2 - 1);
    });

    it('the attribute missing or twice: html_attr', () => {
      expect(code(() => dataToJson('<cmp-dashboard-station class="x"></cmp-dashboard-station>'))).toBe('html_attr');
      expect(code(() => dataToJson(el(`data-to-json="${REAL}" DATA-TO-JSON="${REAL}"`)))).toBe('html_attr');
      expect(code(() => dataToJson(el('data-to-json')))).toBe('html_json');
    });

    it('invalid JSON: html_json', () => {
      expect(code(() => dataToJson(el('data-to-json="{&quot;id&quot;:"')))).toBe('html_json');
      expect(code(() => dataToJson(el('data-to-json="&amp;quot;"')))).toBe('html_json');
    });
  });

  describe('linear time', () => {
    const MB4 = 4 * 1024 * 1024;
    const time = (fn: () => unknown) => {
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    };

    it('a 4 MB body of `<` characters', () => {
      let ms = 0;
      expect(code(() => (ms = time(() => dataToJson('<'.repeat(MB4)))))).toBe('html_tag');
      expect(ms).toBeLessThan(1000);
    });

    it('`<cmp-dashboard-station a=` repeated', () => {
      const body = '<cmp-dashboard-station a='.repeat(Math.ceil(MB4 / 25));
      expect(body.length).toBeGreaterThanOrEqual(MB4);
      const t0 = performance.now();
      expect(code(() => dataToJson(body))).toBe('html_attr');
      expect(performance.now() - t0).toBeLessThan(1000);
    });

    it('`<script` and `<!--` repeated, and a long run of whitespace after a tag name', () => {
      for (const body of [
        '<script '.repeat(MB4 / 8),
        '<!--'.repeat(MB4 / 4),
        `<cmp-dashboard-station${' '.repeat(MB4)}`,
      ]) {
        const t0 = performance.now();
        expect(['html_tag', 'html_attr']).toContain(code(() => dataToJson(body)));
        expect(performance.now() - t0).toBeLessThan(1000);
      }
    });

    it('many raw-text elements and comments before the element', () => {
      const filler = '<script>x</script><!-- c --><style></style><textarea></textarea>'.repeat(40_000);
      let out: unknown;
      const ms = time(() => {
        out = dataToJson(filler + el());
      });
      expect(out).toEqual(OUT);
      expect(ms).toBeLessThan(1000);
    });
  });

  describe('property', () => {
    const piece = fc.constantFrom(
      '<',
      '>',
      '/',
      '=',
      '"',
      "'",
      ' ',
      '\n',
      '<!--',
      '-->',
      '<script',
      '</script>',
      '<style',
      '<template',
      '<textarea',
      '<cmp-dashboard-station',
      '<CMP-DASHBOARD-STATION',
      ' data-to-json=',
      'data-to-json',
      '&quot;',
      '&#x110000;',
      '&#65;',
      '{',
      '}',
      '{&quot;a&quot;:1}',
      'a',
    );
    const soup = fc.array(piece, { maxLength: 40 }).map((p) => p.join(''));

    it('arbitrary text throws only SchemaDrift', () => {
      fc.assert(
        fc.property(
          fc.oneof(soup, fc.string({ maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 200 })),
          (text) => {
            try {
              dataToJson(text);
            } catch (err) {
              expect(err).toBeInstanceOf(SchemaDrift);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('a JSON value in the one element comes out, whatever surrounds it', () => {
      const surround = fc.array(
        fc.constantFrom(
          '<script>x</script>',
          '<!-- <cmp-dashboard-station> -->',
          '<div data-to-json="1">',
          'text',
          '<p>',
        ),
        { maxLength: 5 },
      );
      fc.assert(
        fc.property(fc.jsonValue(), surround, surround, (value, before, after) => {
          const attr = JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
          const html = `${before.join('')}<cmp-dashboard-station data-to-json="${attr}">${after.join('')}`;
          expect(dataToJson(html)).toEqual(JSON.parse(JSON.stringify(value)));
        }),
        { numRuns: 300 },
      );
    });
  });
});
