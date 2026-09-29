import { randomBytes } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  checkXlsx,
  checkZip,
  extractDataToJson,
  flatNames,
  GuardFailure,
  lineSplitter,
  parseXml,
  scanCsv,
} from '../../src/http/guards.ts';

// Criterion "[CI] Per-format guards (§6.7)" (issue #16). Every bomb is generated here.

const reason = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof GuardFailure) return e.reason;
    throw e;
  }
  return 'passed';
};

/** Offset of the first central-directory entry of a comment-less ZIP. */
const cd = (zip: Uint8Array) => Buffer.from(zip).readUInt32LE(zip.length - 22 + 16);

describe('ZIP', () => {
  const pegel = flatNames([
    'pegel_messwerte.txt',
    'pegel_tagesmittelwerte.txt',
    'pegel_tagesmaxima.txt',
    'pegel_stationen.txt',
  ]);

  it('refuses a compression ratio above 50:1', async () => {
    const zip = zipSync({ 'pegel_messwerte.txt': new Uint8Array(1024 * 1024) });
    expect(await reason(checkZip(Buffer.from(zip), { names: pegel }))).toBe('zip_ratio');
  });

  it('refuses more than 200 MB declared uncompressed', async () => {
    const data = new Uint8Array(8 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24);
    const zip = Buffer.from(zipSync({ 'pegel_messwerte.txt': [data, { level: 0 }] }));
    zip.writeUInt32LE(201 * 1024 * 1024, cd(zip) + 24); // ratio stays under 50:1
    expect(await reason(checkZip(zip, { names: pegel }))).toBe('zip_total');
  });

  it('counts the real inflated bytes: a central directory that under-declares fails', async () => {
    const zip = Buffer.from(zipSync({ 'pegel_messwerte.txt': strToU8('abc;'.repeat(5000)) }));
    zip.writeUInt32LE(100, cd(zip) + 24);
    expect(await reason(checkZip(zip, { names: pegel }))).toBe('zip_size');
  });

  it('passes a synthetic 128 MB ZIP like the real pegeldaten.zip, streaming members', async () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    const lines = (bytes: number, header: string) => {
      const out = new Uint8Array(bytes);
      const enc = new TextEncoder();
      let at = enc.encodeInto(`${header}\r\n`, out).written;
      while (at < bytes - 80) {
        const line = `28${rnd() % 100000000}00100;2026-0${1 + (rnd() % 9)}-${10 + (rnd() % 18)}T${10 + (rnd() % 14)}:${10 + (rnd() % 50)}:00.000+01:00;${rnd() % 900}.${rnd() % 99}\r\n`;
        at += enc.encodeInto(line, out.subarray(at)).written;
      }
      return out.subarray(0, at);
    };
    const files = {
      'pegel_messwerte.txt': [lines(108 * 1024 * 1024, 'station_no;time;value(cm)'), { level: 1 }],
      'pegel_tagesmittelwerte.txt': [lines(10 * 1024 * 1024, 'station_no;time;mean(cm);coverage'), { level: 1 }],
      'pegel_tagesmaxima.txt': [lines(10 * 1024 * 1024, 'station_no;time;max(cm);coverage'), { level: 1 }],
      'pegel_stationen.txt': [strToU8('station_no;station_name\r\n2829100000100;Stah\r\n'), { level: 1 }],
    } as const;
    const zip = Buffer.from(zipSync(files as never));
    let lineCount = 0;
    const members = await checkZip(zip, {
      names: pegel,
      onMember: (name) => {
        if (name !== 'pegel_messwerte.txt') return undefined;
        const split = lineSplitter(() => {
          lineCount += 1;
        });
        return { data: split.push, end: split.end };
      },
    });
    const total = members.reduce((n, m) => n + m.size, 0);
    expect(total).toBeGreaterThan(127 * 1024 * 1024);
    expect(total).toBeLessThan(200 * 1024 * 1024);
    expect(lineCount).toBeGreaterThan(1_000_000);
  }, 120_000);

  it('refuses too many entries, unsafe or unexpected names, and duplicates', async () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`pegel_messwerte.txt${i}`, strToU8('x')]));
    expect(await reason(checkZip(Buffer.from(zipSync(many)), { names: () => true }))).toBe('zip_members');
    for (const bad of ['../pegel_messwerte.txt', '/etc/passwd', 'a\\..\\b.txt', 'C:x.txt', 'sub/pegel_messwerte.txt']) {
      expect(await reason(checkZip(Buffer.from(zipSync({ [bad]: strToU8('x') })), { names: pegel }))).toBe('zip_name');
    }
    expect(await reason(checkZip(Buffer.from(zipSync({ 'other.txt': strToU8('x') })), { names: pegel }))).toBe(
      'zip_name',
    );
  });

  it('refuses encryption, zip64 markers, a CRC mismatch, a mismatching local header and truncation', async () => {
    const make = () =>
      Buffer.from(zipSync({ 'pegel_stationen.txt': [strToU8('station_no;name\n1;a\n'), { level: 0 }] }));
    const enc = make();
    enc.writeUInt16LE(enc.readUInt16LE(cd(enc) + 8) | 1, cd(enc) + 8);
    expect(await reason(checkZip(enc, { names: pegel }))).toBe('zip_encrypted');
    const z64 = make();
    z64.writeUInt32LE(0xffffffff, cd(z64) + 20);
    expect(await reason(checkZip(z64, { names: pegel }))).toBe('zip64');
    const crc = make();
    crc.writeUInt8(crc.readUInt8(30 + 'pegel_stationen.txt'.length) ^ 0xff, 30 + 'pegel_stationen.txt'.length); // first data byte of the stored member
    expect(await reason(checkZip(crc, { names: pegel }))).toBe('zip_crc');
    const local = make();
    local[30] = 'Q'.charCodeAt(0);
    expect(await reason(checkZip(local, { names: pegel }))).toBe('zip_local');
    const whole = make();
    expect(await reason(checkZip(whole.subarray(0, whole.length - 10), { names: pegel }))).toBe('zip_eocd');
  });
});

describe('XML (CAP)', () => {
  const cap =
    '<?xml version="1.0" encoding="UTF-8"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>x</identifier><sender>[AGE]</sender></alert>';

  it('parses a plain CAP message', () => {
    expect(parseXml(strToU8(cap))).toMatchObject({ alert: { identifier: 'x', sender: '[AGE]' } });
  });

  it.each([
    ['a DOCTYPE', '<?xml version="1.0"?><!DOCTYPE alert><alert/>'],
    ['an external entity', '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'],
    [
      'entity expansion (billion laughs)',
      '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><l>&c;</l>',
    ],
    ['a lowercase doctype', '<!doctype html><html/>'],
    ['a bare ENTITY declaration', '<a><!ENTITY x "y"></a>'],
  ])('refuses %s', (_, xml) => {
    expect(() => parseXml(strToU8(xml))).toThrow(GuardFailure);
  });

  it('refuses more than 1 MB and malformed XML', async () => {
    expect(await reason(() => parseXml(strToU8(`<a>${'x'.repeat(1024 * 1024)}</a>`)))).toBe('xml_size');
    expect(await reason(() => parseXml(strToU8('<a><b></a>')))).toBe('xml_invalid');
  });
});

describe('XLSX', () => {
  const book = (sheet: string) =>
    Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
        '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships/>'),
        'xl/workbook.xml': strToU8(
          '<?xml version="1.0"?><workbook><sheets><sheet name="ParameterLimits"/></sheets></workbook>',
        ),
        'xl/worksheets/sheet1.xml': strToU8(sheet),
      }),
    );

  it('passes a clean workbook', async () => {
    expect(await checkXlsx(book('<?xml version="1.0"?><worksheet><sheetData/></worksheet>'), 20)).toContain(
      'xl/workbook.xml',
    );
  });

  it('refuses an XML bomb inside', async () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><worksheet>&b;</worksheet>';
    expect(await reason(checkXlsx(book(bomb), 20))).toBe('xml_dtd');
  });

  it('refuses a traversal member name', async () => {
    const z = Buffer.from(zipSync({ 'xl/../../evil.xml': strToU8('<a/>') }));
    expect(await reason(checkXlsx(z, 20))).toBe('zip_name');
  });

  /** Well-formed sheet XML of about `mb` MB that deflates at far less than 50:1 (random hex values). */
  const sheet = (mb: number) => {
    const hex = randomBytes(mb * 512 * 1024).toString('hex');
    const cells = hex.replace(/.{32}/g, (v) => `<c><v>${v}</v></c>`);
    return `<?xml version="1.0"?><worksheet><sheetData><row>${cells}</row></sheetData></worksheet>`;
  };

  it('refuses one large XML member (S3: ratio under 50:1, within the ZIP total)', async () => {
    const z = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8(sheet(12)) });
    const ratio = (12 * 1024 * 1024) / z.length;
    expect(ratio).toBeLessThan(50);
    expect(await reason(checkXlsx(Buffer.from(z), 20))).toBe('xlsx_xml_member');
  });

  it('refuses XML members whose sum exceeds the total cap', async () => {
    const part = strToU8(sheet(5)); // about 7 MB each
    const z = zipSync({ 'xl/a.xml': part, 'xl/b.xml': part, 'xl/c.xml': part });
    expect(await reason(checkXlsx(Buffer.from(z), 20))).toBe('xlsx_xml_total');
  });
});

describe('CSV', () => {
  const csv = (s: string) => strToU8(s);

  it('reads quoted fields, delimiters inside quotes and doubled quotes', () => {
    const r = scanCsv(csv('"Name","Number","Unit","18.09.2026 22:30",\n"a,b",,cm,"1""2",\n'), { delimiter: ',' });
    expect(r.header).toEqual(['Name', 'Number', 'Unit', '18.09.2026 22:30', '']);
    expect(r.rows).toEqual([['a,b', '', 'cm', '1"2', '']]);
  });

  it('passes a wide LU-1-like file (42 rows × 484 columns)', () => {
    const head = ['"Name"', '"Number"', '"Unit"', ...Array.from({ length: 480 }, (_, i) => `"t${i}"`), ''].join(',');
    const row = ['S', '', 'cm', ...Array.from({ length: 480 }, () => '123.0'), ''].join(',');
    expect(scanCsv(csv(`${head}\n${`${row}\n`.repeat(42)}`), { delimiter: ',' }).rows).toHaveLength(42);
  });

  it('skips comment lines before the header (BfG)', () => {
    expect(
      scanCsv(csv('# note\n# more\nDatum;5%\n23.09.2026 00:00;9\n'), { delimiter: ';', commentPrefix: '#' }).rows,
    ).toEqual([['23.09.2026 00:00', '9']]);
  });

  it.each([
    ['more than 1,000 columns', `${Array.from({ length: 1001 }, (_, i) => `c${i}`).join(',')}\n`, 'csv_columns'],
    ['a field over 1 KB', `a,b\n${'x'.repeat(1025)},1\n`, 'csv_field'],
    ['a quoted field over 1 KB', `a,b\n"${'x'.repeat(1025)}",1\n`, 'csv_field'],
    ['more than 100,000 rows', `a\n${'1\n'.repeat(100_001)}`, 'csv_rows'],
    ['a row narrower than the header (truncation)', 'a,b,c\n1,2,3\n4,5', 'csv_width'],
    ['an unterminated quote', 'a,b\n"1,2\n', 'csv_quote'],
  ])('refuses %s', async (_, text, code) => {
    expect(await reason(() => scanCsv(csv(text), { delimiter: ',' }))).toBe(code);
  });

  it('declares the encoding per source (Latin-1)', () => {
    const latin1 = Buffer.from('Name;Nullpunkt\nMünster;1\n', 'latin1');
    expect(scanCsv(latin1, { delimiter: ';', encoding: 'latin1' }).rows[0]?.[0]).toBe('Münster');
  });
});

describe('LU-4 data-to-json', () => {
  const page = (attr: string) =>
    strToU8(`<html><head><script>var x = "<b>";</script></head><body>
      <cmp-dashboard-station class="c" data-to-json="${attr}"></cmp-dashboard-station></body></html>`);

  it('reads only the attribute, unescaping entities', () => {
    const json =
      '{&quot;id&quot;:&quot;X&quot;,&quot;levelsMax&quot;:[0,1,2],&quot;n&quot;:&quot;a&amp;b &lt;c&gt; &#39;d&#39;&quot;}';
    expect(extractDataToJson(page(json))).toEqual({ id: 'X', levelsMax: [0, 1, 2], n: "a&b <c> 'd'" });
  });

  it('refuses a page without the element or attribute, an oversized attribute and invalid JSON', async () => {
    expect(await reason(() => extractDataToJson(strToU8('<html><body>Service unavailable</body></html>')))).toBe(
      'html_tag',
    );
    expect(
      await reason(() => extractDataToJson(strToU8('<cmp-dashboard-station class="x"></cmp-dashboard-station>'))),
    ).toBe('html_attr');
    expect(await reason(() => extractDataToJson(page('x'.repeat(300 * 1024))))).toBe('html_attr');
    expect(await reason(() => extractDataToJson(page('{&quot;id&quot;:')))).toBe('html_json');
  });
});
