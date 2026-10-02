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
      // Review CR-3 / SR-7: a whole element inside another tag's quoted value, a title or a noscript.
      ['a div title holding a fake element', `<div title="<cmp-dashboard-station data-to-json='${EVIL}'>">x</div>`],
      [
        'an unquoted and a single-quoted value holding one',
        `<a href=<cmp-dashboard-station b='<cmp-dashboard-station>'>`,
      ],
      ['a title holding one', `<title><cmp-dashboard-station data-to-json="${EVIL}"></title>`],
      ['a noscript holding one', `<noscript><cmp-dashboard-station data-to-json="${EVIL}"></noscript>`],
      [
        'an xmp, an iframe, a noembed and a noframes holding one',
        ['xmp', 'iframe', 'noembed', 'NOFRAMES']
          .map((t) => `<${t}><cmp-dashboard-station data-to-json="${EVIL}"></${t}>`)
          .join(''),
      ],
      [
        'a nested template holding one',
        `<template><template></template><cmp-dashboard-station data-to-json="${EVIL}"></template>`,
      ],
      [
        'a script whose `<!--<script>` hides a `</script>`',
        `<script><!--<script></script><cmp-dashboard-station data-to-json="${EVIL}"></script>`,
      ],
      [
        'bogus comments holding one',
        `<!x <cmp-dashboard-station data-to-json="${EVIL}"><?x <cmp-dashboard-station><//<cmp-dashboard-station>`,
      ],
      [
        '`--!>` ending a comment before a script that holds `-->`',
        `<!-- a --!><script>--><cmp-dashboard-station data-to-json="${EVIL}"></script>`,
      ],
      ['everything after a plaintext', `<plaintext><cmp-dashboard-station data-to-json="${EVIL}">`],
    ];
    for (const [name, decoy] of decoys) {
      // `<plaintext>` hides the rest of the page, so it goes only after the element.
      if (!name.includes('plaintext')) {
        it(`${name} before the element`, () => {
          expect(dataToJson(page(decoy))).toEqual(OUT);
        });
      }
      it(`${name} after the element`, () => {
        expect(dataToJson(page('', decoy))).toEqual(OUT);
      });
      it(`${name} without the element: no record`, () => {
        expect(code(() => dataToJson(`<!DOCTYPE html><html><body>${decoy}</body></html>`))).toBe('html_tag');
      });
    }

    it('a `<` or `<!--` inside a quoted value of another tag, or of an end tag, starts nothing', () => {
      expect(dataToJson(`<p title="<!--">${el()}<!-- -->`)).toEqual(OUT);
      expect(dataToJson(`<script></script title="><!--">${el()}<!-- -->`)).toEqual(OUT);
      expect(dataToJson(`<p></p title="<script>">${el()}</script>`)).toEqual(OUT);
      expect(dataToJson(`<?x title="<!--"?>${el()}<!-- -->`)).toEqual(OUT);
    });

    it('the escaped states of a script end as in a browser', () => {
      for (const script of ['<script><!--></script>', '<script><!--<script>--></script>', '<script><!-- </script>']) {
        expect(dataToJson(script + el())).toEqual(OUT);
      }
      // `<!--<script>` double-escapes: the first `</script>` only undoes it, the second ends the script.
      expect(code(() => dataToJson(`<script><!--<script></script>${el()}`))).toBe('html_tag');
    });

    it('`--!>` ends neither the escaped nor the double-escaped state of a script (it ends only a comment)', () => {
      // HTML tokenizer: in the "script data escaped dash dash state" (and the double-escaped one) only `>` returns to
      // the script data state; `!` goes back to the (double) escaped state. So in both pages the first `</script>`
      // only undoes the double escape and the decoy is script text. Reading `--!>` as an end would end the script at
      // the first `</script>` and take the decoy: as the page without the real element, `html_tag_count` with it.
      const decoy = `<cmp-dashboard-station data-to-json="${EVIL}"></cmp-dashboard-station>`;
      const escaped = `<script><!-- --!> <script> </script> ${decoy} </script>`;
      const doubleEscaped = `<script><!--<script> --!> </script> ${decoy} </script>`;
      for (const script of [escaped, doubleEscaped]) {
        expect(dataToJson(script + el())).toEqual(OUT);
        expect(code(() => dataToJson(script))).toBe('html_tag');
      }
    });

    it('a `<![CDATA[` outside comments and raw text refuses the page: in inline SVG a browser reads it as text', () => {
      const cdata = `<svg><![CDATA[ > <cmp-dashboard-station data-to-json="${EVIL}"> ]]></svg>`;
      expect(code(() => dataToJson(cdata))).toBe('html_cdata');
      expect(code(() => dataToJson(page(cdata)))).toBe('html_cdata');
      expect(code(() => dataToJson(page('', cdata)))).toBe('html_cdata');
      // Inside a comment or a script it is text like any other.
      expect(dataToJson(page('<!-- <![CDATA[ x ]]> --><script><![CDATA[ x ]]></script>'))).toEqual(OUT);
    });

    it('`<!--!>` and `<!---!>` do not close a comment, `<!----!>` does', () => {
      expect(code(() => dataToJson(`<!--!>${el()}`))).toBe('html_tag');
      expect(code(() => dataToJson(`<!---!>${el()}`))).toBe('html_tag');
      expect(dataToJson(`<!----!>${el()}`)).toEqual(OUT);
    });

    it('an element inside a template is not the page, one after it is', () => {
      expect(code(() => dataToJson(`<template>${el()}</template>`))).toBe('html_tag');
      expect(code(() => dataToJson(`<template><template></template>${el()}</template>`))).toBe('html_tag');
      expect(dataToJson(`</template><template><template></template></template>${el()}`)).toEqual(OUT);
    });

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
      // A start tag cut off at the end of the page: a browser drops it, the scan counts it and fails closed (R2-SR-7).
      expect(code(() => dataToJson(`${el()}<cmp-dashboard-station data-to-json="{}`))).toBe('html_tag_count');
      expect(code(() => dataToJson('<cmp-dashboard-station data-to-json="{}'))).toBe('html_attr');
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

    it('`<script`, comments, bogus comments, quotes and templates repeated, and a long run of whitespace after a tag name', () => {
      for (const body of [
        '<script '.repeat(MB4 / 8),
        '<!--'.repeat(MB4 / 4),
        '<!----!>'.repeat(MB4 / 8),
        `<script>${'<!--<script>'.repeat(MB4 / 12)}`,
        '<a title="'.repeat(MB4 / 10),
        '<!x'.repeat(MB4 / 3),
        '</'.repeat(MB4 / 2),
        '<template>'.repeat(MB4 / 10),
        `<p ${'a '.repeat(MB4 / 2)}`,
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
      '<title>',
      '</title>',
      '<noscript',
      '<template>',
      '</template>',
      '<!--<script>',
      '--!>',
      '<?',
      '<!x',
      '</',
      '<plaintext>',
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
