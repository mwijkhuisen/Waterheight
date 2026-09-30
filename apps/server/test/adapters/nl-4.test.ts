import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ALLOW, EDITION } from '../../../../scripts/convert-nl4.ts';
import {
  classOf,
  coverage,
  dedupe,
  fromCsvCells,
  H_DESCRIPTION,
  legendOn,
  Q_DESCRIPTION,
  type ThresholdRow,
  toCsv,
} from '../../src/adapters/nl-4/normalise.ts';
import { HEADER, MAX_ITEMS, MAX_ROWS, MAX_TAG, parse, READ } from '../../src/adapters/nl-4/parse.ts';
import { REGISTRY_DIR, readSeed } from '../../src/capture/specs.ts';
import { readXlsx, scanCsv } from '../../src/http/guards.ts';
import { readThresholds } from '../../src/load/thresholds.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// NL-4: the Rijkswaterstaat workbook of Waterinfo display classes (legend
// classes, catalogue §2.1). The real workbook (edition 15-4-2026) and a small
// synthetic one go through the XLSX guard, parse and normalise; the results
// equal the committed golden files (invariant 9). `UPDATE_GOLDEN=1` rewrites
// them and the synthetic workbook; a golden change is reviewed like code.

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('NL-4', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const real = rawFixture('NL-4', 'nl-4-xlsx').body;
const sheet = parse(await readXlsx(real, { allow: ALLOW, read: READ }));
const rows = dedupe(sheet);
const codes = (description: string) =>
  new Set(rows.filter((r) => r.description === description && r.code !== 'alle*').map((r) => r.code));
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('the real workbook (edition 15-4-2026)', () => {
  it('equals its golden summary', () => {
    const workbook = sha256(real);
    const summary = {
      workbook_sha256: workbook,
      sheet_rows: sheet.length,
      deduped_rows: rows.length,
      h_codes: codes(H_DESCRIPTION).size,
      q_codes: codes(Q_DESCRIPTION).size,
      csv_sha256: sha256(toCsv(rows, { sha256: workbook, edition: EDITION })),
    };
    expect(summary).toEqual(golden('nl-4-xlsx', summary));
    expect(summary).toMatchObject({ sheet_rows: 6245, deduped_rows: 1542, h_codes: 237, q_codes: 27 });
  });

  it("reads 'NULL' as a string: the month and day cells of the nvt* rows, and open bounds", () => {
    const nvt = sheet.filter((r) => r.FromMonth === 'NULL');
    // 58 rows, all area-wide (alle*) and all four cells 'NULL' (the brief said 59; the file has 58).
    expect(nvt).toHaveLength(58);
    for (const r of nvt)
      expect([r.Code, r.Period, r.FromDay, r.ToMonth, r.ToDay]).toEqual(['alle*', 'nvt*', 'NULL', 'NULL', 'NULL']);
    expect(sheet.filter((r) => r.Code === 'alle*')).toHaveLength(58);
    expect(sheet.filter((r) => r.From === 'NULL')).toHaveLength(1213);
    expect(sheet.filter((r) => r.To === 'NULL')).toHaveLength(1191);
    // Months and days are numbers everywhere else; From and To are always text.
    expect(sheet.filter((r) => typeof r.FromMonth === 'number')).toHaveLength(6187);
  });

  it('collapses the slug variants to one row per class, stored as the file states it', () => {
    // dedupe fails on variants that disagree on season, Order or Priority (see the drift cases): here none do.
    expect(new Set(sheet.map((r) => r.Slug)).size).toBeGreaterThan(new Set(sheet.map((r) => r.Code)).size);
    expect(rows.filter((r) => r.from !== null && r.to !== null && r.from >= r.to)).toHaveLength(46);
    expect(rows.filter((r) => r.from === null && r.to === null)).toHaveLength(18);
    // (Code, Description, season window, Priority) is one class for H and Q: the reference_value key.
    const hq = rows.filter((r) => r.description === H_DESCRIPTION || r.description === Q_DESCRIPTION);
    const keys = hq.map((r) => JSON.stringify([r.code, r.description, r.from_md, r.to_md, r.priority]));
    expect(new Set(keys).size).toBe(hq.length);
  });

  it('decodes entities by hand and keeps text verbatim (spaces, number-looking strings)', () => {
    const labels = new Set(rows.map((r) => r.label));
    expect([...labels].some((l) => /&(?:gt|lt|amp);/.test(l))).toBe(false);
    expect(rows.filter((r) => r.label.includes('>'))).not.toHaveLength(0);
    expect(labels).toContain(' Verlaagd (<1 m3/s)');
    expect(labels).toContain('≤ 5 Bft (≤ 10.8 m/s)');
    expect(labels).toContain('Extreme afvoer (>27,5 m3/s)');
  });

  it('maps every period to its season window', () => {
    const windows = new Map(rows.map((r) => [r.period, [r.from_md, r.to_md]]));
    expect(windows.get('Gehele jaar')).toEqual([101, 1231]);
    expect(windows.get('Mei')).toEqual([501, 531]);
    expect(windows.get('September')).toEqual([901, 930]);
    expect(windows.get('Winterstand')).toEqual([1001, 430]);
    expect(windows.get('nvt*')).toEqual([null, null]);
    // One window per period.
    for (const r of rows) expect([r.period, r.from_md, r.to_md]).toEqual([r.period, ...(windows.get(r.period) ?? [])]);
  });

  describe('Lobith (lobith.bovenrijn.tolkamer)', () => {
    const LOBITH = 'lobith.bovenrijn.tolkamer';
    const bands = (date: string, description = Q_DESCRIPTION) =>
      legendOn(rows, LOBITH, description, day(date)).map((r) => [r.from, r.to, r.priority]);

    it.each([
      ['2026-05-15', 1400],
      ['2026-06-15', 1300],
      ['2026-07-15', 1200],
      ['2026-08-15', 1100],
      ['2026-09-15', 1000],
      ['2026-01-15', 1000], // Winterstand wraps the year: 1 October – 30 April
      ['2026-04-30', 1000],
      ['2026-10-01', 1000],
      ['2026-12-31', 1000],
    ])('discharge on %s: the whole-year classes and Normaal/Verlaagd at %i', (date, low) => {
      expect(bands(date)).toEqual([
        [11800, null, 0],
        [8100, 11800, 1],
        [5400, 8100, 2],
        [4450, 5400, 3],
        [null, low, 4],
        [low, 4450, 5],
      ]);
    });

    it('classifies by band [from, to), the lower Priority number first', () => {
      const may = legendOn(rows, LOBITH, Q_DESCRIPTION, day('2026-05-15'));
      const label = (v: number) => classOf(may, v)?.label;
      expect(label(1399)).toBe('Verlaagde afvoer (<1400m3/s)');
      expect(label(1400)).toBe('Normale afvoer (>1400 m3/s)');
      expect(label(4449.9)).toBe('Normale afvoer (>1400 m3/s)');
      expect(label(4450)).toBe('Licht verhoogd (>4450 m3/s)');
      expect(label(11800)).toBe('Extreme afvoer (>11800 m3/s)');
      const september = legendOn(rows, LOBITH, Q_DESCRIPTION, day('2026-09-15'));
      expect(classOf(september, 1399)?.label).toBe('Normaal (1000 - 4450m3/s)');
    });

    it('keeps H (cm NAP) and Q (m³/s) apart', () => {
      const h = legendOn(rows, LOBITH, H_DESCRIPTION, day('2026-05-15'));
      const q = legendOn(rows, LOBITH, Q_DESCRIPTION, day('2026-05-15'));
      expect(h.map((r) => r.label).every((l) => /cm\)$/.test(l))).toBe(true);
      expect(q.map((r) => r.label).every((l) => /m3\/s\)$/.test(l))).toBe(true);
      expect(h.map((r) => r.from)).toEqual([1650, 1500, 1300, 1200, null, 810]);
      expect(h.every((r) => r.description === H_DESCRIPTION) && q.every((r) => r.description === Q_DESCRIPTION)).toBe(
        true,
      );
    });
  });

  it('counts area-wide defaults (alle*) as no station', () => {
    expect(codes(H_DESCRIPTION).has('alle*')).toBe(false);
    expect(new Set(rows.filter((r) => r.description === H_DESCRIPTION).map((r) => r.code)).size).toBe(238);
    expect(new Set(rows.filter((r) => r.code === 'alle*').map((r) => r.description)).size).toBe(11);
  });

  it('covers 61 of 69 H and 15 of 18 Q series of the curated NL-1 list', () => {
    // Tiers key and other (the twin is the same gauge in another datum). The catalogue's 49/54 and 14/18 counted an
    // older, shorter list; these are the numbers of registry/seed/nl-1.csv today.
    const seed = readSeed(REGISTRY_DIR, 'nl-1')
      .filter((r) => r.tier === 'key' || r.tier === 'other')
      .map((r) => ({ code: r.code ?? '', quantity: r.quantity ?? '' }));
    const cover = coverage(rows, seed);
    expect([cover.h.covered, cover.h.total, cover.q.covered, cover.q.total]).toEqual([61, 69, 15, 18]);
    expect(cover.h.missing.toSorted()).toEqual(
      [
        'antwerpen',
        'hedel',
        'herenlaak',
        'holtheme.vecht',
        'lith.beneden',
        'lixhebiefaval',
        'millingenaanderijn.pannerdensekop',
        'rhenen.grebbeberg',
      ].sort(),
    );
    expect(cover.q.missing.toSorted()).toEqual(['hagestein.boven', 'kanne', 'millingenaanderijn']);
    // The catalogue's series without classes (§2.1) have none, whether or not they are on today's list.
    for (const code of [
      'millingenaanderijn.pannerdensekop',
      'holtheme.vecht',
      'lith.beneden',
      'lixhebiefaval',
      'antwerpen',
    ])
      expect([code, rows.filter((r) => r.code === code && r.description === H_DESCRIPTION)]).toEqual([code, []]);
    for (const code of ['millingenaanderijn', 'hagestein.boven', 'maastricht.sintpieter.zuid', 'roermond.hambeek'])
      expect([code, rows.filter((r) => r.code === code && r.description === Q_DESCRIPTION)]).toEqual([code, []]);
  });
});

// ---------------------------------------------------------------- the synthetic workbook

type Cell = string | number | null | { xml: string } | { runs: string[] };
const H = H_DESCRIPTION;
const Q = Q_DESCRIPTION;
const WHOLE = ['Gehele jaar', 1, 1, 12, 31];
const WINTER = ['Winterstand', 10, 1, 4, 30];
const COLOURS = ['Groen', '#39870C', '#C3DBB6'];
const row = (
  code: string,
  slug: Cell,
  description: string,
  period: Cell[],
  label: Cell,
  from: string,
  to: string,
  order: number,
  priority: number,
  name: Cell = 'Synth',
): Cell[] => [code, name, slug, description, ...period, label, from, to, order, priority, ...COLOURS];

/** Two overlapping bands on one date with different Priority numbers, a wrapping season, and awkward text. */
const OVERLAP: Cell[][] = [
  row('synth.a', 'SynthA(SYNA)', H, WHOLE, 'Normale waterstand (100 - 200cm)', '100', '200', 5, 5),
  row('synth.a', 'SynthA(SYNA)', H, WHOLE, { xml: 'Verhoogd (&gt;150cm)' }, '150', '300', 3, 2),
  // A slug variant of the first row.
  row('synth.a', 'SynthA(SYNA)-1', H, WHOLE, 'Normale waterstand (100 - 200cm)', '100', '200', 5, 5),
  row('synth.a', 'SynthA(SYNA)', H, WINTER, 'Laag, "winter" (<-12,5cm)', 'NULL', '-12.5', 6, 4),
  row('synth.a', 'SynthA(SYNA)', H, WHOLE, ' Streefpeil (-40cm) ', '-40', '-40', 0, 10),
  row('synth.a', 'SynthA(SYNA)', Q, WHOLE, { runs: ['Hoge ', 'afvoer (>8100 m3/s)'] }, '8100', 'NULL', 1, 1),
  // Name and Slug are empty cells (absent from the XML): the other cells still land in their columns.
  row('synth.a', null, Q, WHOLE, '=HYPERLINK("x")', 'NULL', '8100', 2, 3, null),
  [
    'alle*',
    'NULL',
    'NULL',
    H,
    'nvt*',
    'NULL',
    'NULL',
    'NULL',
    'NULL',
    { xml: '&#8805; 12 Bft &amp; &#x4d;eer' },
    'NULL',
    'NULL',
    1,
    0,
    ...COLOURS,
  ],
  row('synth.b', 'SynthB(SYNB)', H, ['Mei', 5, 1, 5, 31], '-laag', '-5', '10.25', 2, 4),
];

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escapeXml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * A workbook as member texts: ParameterLimits is xl/worksheets/sheet1.xml here (the real file has it in
 * sheet2.xml), and the other sheet is a decoy with the same header, so only the relationships lead to the rows.
 */
function workbook(data: Cell[][]): Map<string, string> {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const si = (xml: string) => {
    if (!index.has(xml)) index.set(xml, strings.push(xml) - 1);
    return index.get(xml) as number;
  };
  const cell = (v: Cell, ref: string) => {
    if (v === null) return '';
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    const xml =
      typeof v === 'string'
        ? `<t${/^\s|\s$/.test(v) ? ' xml:space="preserve"' : ''}>${escapeXml(v)}</t>`
        : 'xml' in v
          ? `<t>${v.xml}</t>`
          : v.runs
              .map((r, i) => `<r>${i > 0 ? '<rPr><b/></rPr>' : ''}<t xml:space="preserve">${escapeXml(r)}</t></r>`)
              .join('');
    return `<c r="${ref}" s="3" t="s"><v>${si(xml)}</v></c>`;
  };
  const sheetXml = (table: Cell[][]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><dimension ref="A1:Q9"/><sheetData>${[
      [...HEADER],
      ...table,
    ]
      .map(
        (cells, i) =>
          `<row r="${i + 1}" spans="1:17">${cells.map((v, c) => cell(v, `${String.fromCharCode(65 + c)}${i + 1}`)).join('')}</row>`,
      )
      .join('')}</sheetData></worksheet>`;
  const parameterLimits = sheetXml(data);
  const decoy = sheetXml([row('decoy', 'Decoy', H, WHOLE, 'Decoy', '1', '2', 1, 1)]);
  return new Map([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS} xmlns:r="${REL}">\n  <sheets>\n    <sheet name="Uitleg" sheetId="2" r:id="rId3"/>\n    <sheet name="ParameterLimits" sheetId="1" r:id="rId1"/>\n  </sheets>\n</workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\r\n<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>\r\n<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>\r\n<Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/>\r\n</Relationships>`,
    ],
    [
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst ${NS} uniqueCount="${strings.length}">${strings.map((x) => `<si>${x}</si>`).join('')}</sst>`,
    ],
    ['xl/worksheets/sheet1.xml', parameterLimits],
    ['xl/worksheets/sheet2.xml', decoy],
  ]);
}

/** The ZIP of member texts. The mtime is built from local fields, so the bytes are the same in every time zone. */
const zip = (members: Map<string, string>) =>
  Buffer.from(
    zipSync(Object.fromEntries([...members].map(([n, t]) => [n, strToU8(t)])), { mtime: new Date(2026, 3, 15, 12) }),
  );

describe('the synthetic overlap workbook [U]', () => {
  const file = new URL('../../src/adapters/nl-4/fixtures/nl-4-overlap.synthetic.raw', import.meta.url);
  const built = zip(workbook(OVERLAP));
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, built);
  const fixture = rawFixture('NL-4', 'nl-4-overlap.synthetic');

  it('is reproducible from the builder, and its meta says so', () => {
    expect(fixture.body.equals(built)).toBe(true);
    expect(fixture.meta).toMatchObject({ synthetic: true, spec: 'nl-4-xlsx', bytes: built.length });
  });

  it('parses and normalises to its golden file, through the guard and the relationships', async () => {
    const parsed = parse(await readXlsx(fixture.body, { allow: ALLOW, read: READ }));
    const classes = dedupe(parsed);
    const out = {
      sheet: parsed,
      rows: classes,
      csv: toCsv(classes, { sha256: sha256(fixture.body), edition: EDITION }),
    };
    expect(out).toEqual(golden('nl-4-overlap.synthetic', out));
    expect(parsed).toHaveLength(9);
    expect(classes).toHaveLength(8);
    expect(classes.some((r) => r.code === 'decoy')).toBe(false);
    expect(parsed[6]).toMatchObject({ Name: '', Slug: '', Label: '=HYPERLINK("x")', To: '8100' });
    expect(classes.map((r) => r.label)).toEqual(
      expect.arrayContaining([
        'Verhoogd (>150cm)',
        'Laag, "winter" (<-12,5cm)',
        ' Streefpeil (-40cm) ',
        'Hoge afvoer (>8100 m3/s)',
        '≥ 12 Bft & Meer',
      ]),
    );
  });

  const classes = dedupe(parse(workbook(OVERLAP)));
  const legend = (date: string, code = 'synth.a', description = H) => legendOn(classes, code, description, day(date));

  it('resolves overlapping bands to the row with the lower Priority number', () => {
    const winter = legend('2026-01-15');
    expect(winter.map((r) => r.priority)).toEqual([2, 4, 5, 10]);
    expect(classOf(winter, 175)?.label).toBe('Verhoogd (>150cm)');
    expect(classOf(winter, 150)?.label).toBe('Verhoogd (>150cm)');
    expect(classOf(winter, 149.9)?.label).toBe('Normale waterstand (100 - 200cm)');
    expect(classOf(winter, 300)).toBeNull();
    expect(classOf(winter, -40)?.label).toBe('Laag, "winter" (<-12,5cm)');
    // In summer no band holds -40: Streefpeil's band [-40, -40) is empty, as the file states it.
    expect(classOf(legend('2026-07-15'), -40)).toBeNull();
  });

  it('applies a wrapping season on its first and last day and not beyond, and a month on its days', () => {
    const winter = (date: string) => legend(date).some((r) => r.period === 'Winterstand');
    expect(['2026-10-01', '2026-12-31', '2027-01-01', '2026-04-30'].map(winter)).toEqual([true, true, true, true]);
    expect(['2026-09-30', '2026-05-01', '2026-07-15'].map(winter)).toEqual([false, false, false]);
    const may = (date: string) => legend(date, 'synth.b').length;
    expect(['2026-04-30', '2026-05-01', '2026-05-31', '2026-06-01'].map(may)).toEqual([0, 1, 1, 0]);
    // The nvt* period has no window: it applies on every date.
    expect(legend('2026-02-28', 'alle*')).toHaveLength(1);
    expect(() => legend('not a date')).toThrow(RangeError);
  });

  it('keeps H and Q classes of one code apart', () => {
    expect(legend('2026-01-15', 'synth.a', Q).map((r) => r.label)).toEqual([
      'Hoge afvoer (>8100 m3/s)',
      '=HYPERLINK("x")',
    ]);
    expect(legend('2026-01-15').every((r) => r.description === H)).toBe(true);
  });

  it('writes a CSV the reader takes back exactly, formula starts guarded', () => {
    const text = toCsv(classes, { sha256: 'a'.repeat(64), edition: EDITION });
    expect(text).toContain(`,"'=HYPERLINK(""x"")",`);
    expect(text).toContain(`,'-laag,-5,10.25,`);
    expect(text).toContain(`," Streefpeil (-40cm) ",-40,-40,`);
    expect(text.endsWith('\n') && !text.includes('\r')).toBe(true);
    expect(readThresholds(text)).toEqual({ sha256: 'a'.repeat(64), edition: EDITION, rows: classes });
    expect(() => toCsv(classes, { sha256: 'x', edition: EDITION })).toThrow();
  });
});

// ---------------------------------------------------------------- drift

describe('drift: anything unknown is a SchemaDrift with a fixed code', () => {
  const at = (members: Map<string, string>, path: string, from: string | RegExp, to: string) => {
    const text = members.get(path) as string;
    const next = text.replace(from, to);
    if (next === text) throw new Error(`test edit did not apply: ${String(from)}`);
    return new Map(members).set(path, next);
  };
  const SHEET = 'xl/worksheets/sheet1.xml';
  const SST = 'xl/sharedStrings.xml';
  const RELS = 'xl/_rels/workbook.xml.rels';
  const base = workbook(OVERLAP);
  const withRow = (r: Cell[]) => workbook([...OVERLAP, r]);
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (err) {
      if (err instanceof SchemaDrift) return err.code;
      throw err;
    }
    return 'passed';
  };
  const both = (members: Map<string, string>) => () => dedupe(parse(members));

  it.each<[string, () => Map<string, string>, string]>([
    ['a wrong header', () => at(base, SST, '<t>Priority</t>', '<t>Prioriteit</t>'), 'header'],
    ['a missing header cell', () => at(base, SHEET, /<c r="Q1"[^/]*\/v><\/c>/, ''), 'header'],
    ['no rows at all', () => at(base, SHEET, /<sheetData>.*<\/sheetData>/, '<sheetData/>'), 'header'],
    [
      'no sheet ParameterLimits',
      () => at(base, 'xl/workbook.xml', 'name="ParameterLimits"', 'name="Limits"'),
      'sheet_missing',
    ],
    [
      'two sheets of that name',
      () => at(base, 'xl/workbook.xml', 'name="Uitleg"', 'name="ParameterLimits"'),
      'sheet_missing',
    ],
    [
      'an external sheet target',
      () =>
        at(
          base,
          RELS,
          'Target="/xl/worksheets/sheet1.xml"',
          'Target="/xl/worksheets/sheet1.xml" TargetMode="External"',
        ),
      'sheet_target',
    ],
    [
      'a sheet target outside xl/',
      () => at(base, RELS, 'Target="/xl/worksheets/sheet1.xml"', 'Target="../evil.xml"'),
      'sheet_target',
    ],
    ['no shared strings', () => at(base, RELS, /<Relationship Id="rId2"[^>]*>/, ''), 'strings_target'],
    [
      'a sheet member not given',
      () => {
        const m = new Map(base);
        m.delete(SHEET);
        return m;
      },
      'member_missing',
    ],
    ['a non-numeric bound', () => withRow(row('synth.c', 'C', H, WHOLE, 'X', '1,5', '2', 1, 1)), 'invalid_format'],
    [
      'a bound in a numeric cell',
      () => at(base, SHEET, /<c r="K2" s="3" t="s"><v>\d+<\/v><\/c>/, '<c r="K2"><v>100</v></c>'),
      'invalid_union',
    ],
    ['a padded bound', () => withRow(row('synth.c', 'C', H, WHOLE, 'X', '007', '8', 1, 1)), 'bound_form'],
    [
      'an invalid MMDD',
      () => withRow(row('synth.c', 'C', H, ['Feb', 2, 30, 3, 1], 'X', '1', '2', 1, 1)),
      'season_invalid',
    ],
    [
      'a month 13',
      () => withRow(row('synth.c', 'C', H, ['Dec', 13, 1, 12, 31], 'X', '1', '2', 1, 1)),
      'season_invalid',
    ],
    [
      "a season half 'NULL'",
      () => withRow(row('synth.c', 'C', H, ['Mei', 'NULL', 1, 5, 31], 'X', '1', '2', 1, 1)),
      'season_partial',
    ],
    [
      'a text month',
      () => withRow(row('synth.c', 'C', H, ['Mei', '5', 1, 5, 31], 'X', '1', '2', 1, 1)),
      'invalid_union',
    ],
    ['a missing Label', () => withRow(row('synth.c', 'C', H, WHOLE, null, '1', '2', 1, 1)), 'invalid_type'],
    [
      'variants that disagree on Priority',
      () => withRow(row('synth.a', 'SynthA(SYNA)-2', H, WHOLE, 'Normale waterstand (100 - 200cm)', '100', '200', 5, 6)),
      'variant_conflict',
    ],
    [
      'two H classes in one window with one Priority',
      () => withRow(row('synth.a', 'S', H, WHOLE, 'Other', '1', '2', 7, 5)),
      'priority_clash',
    ],
    [
      'too many rows',
      () =>
        at(
          base,
          SHEET,
          '</sheetData>',
          `${Array.from({ length: MAX_ROWS }, (_, i) => `<row r="${i + 11}"/>`).join('')}</sheetData>`,
        ),
      'too_many_rows',
    ],
    ['a row number gap', () => at(base, SHEET, /<row r="3"/, '<row r="4"'), 'row_ref'],
    ['a cell of another row', () => at(base, SHEET, '<c r="A3"', '<c r="A4"'), 'cell_ref'],
    ['a repeated column', () => at(base, SHEET, '<c r="B3"', '<c r="A3"'), 'cell_order'],
    ['a column right of Q', () => at(base, SHEET, '</row>', '<c r="R1"><v>1</v></c></row>'), 'extra_column'],
    ['a formula', () => at(base, SHEET, '<c r="M2"><v>5</v></c>', '<c r="M2"><f>2+3</f><v>5</v></c>'), 'cell'],
    [
      'an inline string',
      () => at(base, SHEET, '<c r="M2"><v>5</v></c>', '<c r="M2" t="inlineStr"><v>5</v></c>'),
      'cell_type',
    ],
    ['a cell attribute not known', () => at(base, SHEET, '<c r="M2">', '<c r="M2" vm="1">'), 'cell'],
    ['a fractional Order', () => at(base, SHEET, '<c r="M2"><v>5</v></c>', '<c r="M2"><v>5.5</v></c>'), 'cell_number'],
    [
      'a shared-string index out of range',
      () => at(base, SHEET, /<c r="A2" s="3" t="s"><v>\d+<\/v>/, '<c r="A2" t="s"><v>9999</v>'),
      'shared_string_index',
    ],
    [
      'merged cells',
      () => at(base, SHEET, '</worksheet>', '<mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells></worksheet>'),
      'merged_cells',
    ],
    [
      'a shared string with two texts',
      () => at(base, SST, '<si><t>Code</t></si>', '<si><t>Co</t><t>de</t></si>'),
      'shared_string',
    ],
    ['an OOXML _xHHHH_ escape', () => at(base, SST, '<t>Groen</t>', '<t>Gr_x000D_oen</t>'), 'xstring_escape'],
    ['a string over the text cap', () => at(base, SST, '<t>Groen</t>', `<t>${'g'.repeat(513)}</t>`), 'text_too_long'],
    ['a DOCTYPE', () => at(base, SST, '<sst', '<!DOCTYPE sst><sst'), 'xml_dtd'],
    ['CDATA', () => at(base, SST, '<t>Groen</t>', '<t><![CDATA[Groen]]></t>'), 'xml_cdata'],
    ['an unknown entity', () => at(base, SST, '<t>Groen</t>', '<t>Gr&eacute;en</t>'), 'xml_reference'],
    ['a NUL character reference', () => at(base, SST, '<t>Groen</t>', '<t>Gr&#0;en</t>'), 'xml_reference'],
    ['a reference beyond Unicode', () => at(base, SST, '<t>Groen</t>', '<t>Gr&#x110000;en</t>'), 'xml_reference'],
    ['a bare ampersand', () => at(base, SST, '<t>Groen</t>', '<t>Gr & en</t>'), 'xml_invalid'],
    ['malformed XML', () => at(base, SHEET, '</sheetData>', '<row></sheetData>'), 'xml_invalid'],
    [
      'a __proto__ element',
      () => at(base, SHEET, '</sheetData>', '<__proto__><row r="11"/></__proto__></sheetData>'),
      'xml_invalid',
    ],
    ['a text node inside sheetData', () => at(base, SHEET, '</sheetData>', 'text</sheetData>'), 'sheet_data'],
    [
      'too many tags',
      () => at(base, SHEET, '</sheetData>', `${'<a/>'.repeat(MAX_ITEMS)}</sheetData>`),
      'xml_too_many_items',
    ],
    [
      'too many attributes, spread over small tags (review S1)',
      () => at(base, SHEET, '</sheetData>', `${'<a b="" c="" d=""/>'.repeat(MAX_ITEMS / 4)}</sheetData>`),
      'xml_too_many_items',
    ],
    [
      'a tag over the length cap (review S1)',
      () => at(base, SHEET, '<sheetData>', `<sheetData x="${'x'.repeat(MAX_TAG)}">`),
      'xml_tag_too_long',
    ],
    [
      'a bidi control in an attribute (review S2)',
      () => at(base, SHEET, '<c r="M2">', '<c r="M2&#x202E;">'),
      'text_char',
    ],
  ])('%s', (_, members, expected) => {
    expect(code(both(members()))).toBe(expected);
  });

  // Review S2: each kind of character no text may hold, raw and as a numeric reference. A reference to a
  // character XML 1.0 does not allow is a bad reference; a raw CR is read as LF (XML 1.0 §2.11).
  it.each<[string, string | null, string, string]>([
    ['a C0 control', '\u0001', '&#1;', 'xml_reference'],
    ['a carriage return', null, '&#13;', 'text_char'],
    ['DEL', '\u007f', '&#127;', 'text_char'],
    ['a C1 control (NEL)', '\u0085', '&#x85;', 'text_char'],
    ['a directional mark (U+200E)', '\u200e', '&#x200E;', 'text_char'],
    ['a directional mark (U+200F)', '\u200f', '&#8207;', 'text_char'],
    ['a bidi embedding or override (U+202A)', '\u202a', '&#x202a;', 'text_char'],
    ['a bidi embedding or override (U+202E)', '\u202e', '&#x202E;', 'text_char'],
    ['a bidi isolate (U+2066)', '\u2066', '&#8294;', 'text_char'],
    ['a bidi isolate (U+2069)', '\u2069', '&#x2069;', 'text_char'],
    ['a byte order mark inside a text', '\ufeff', '&#xFEFF;', 'text_char'],
    ['a lone surrogate', '\ud800', '&#xD800;', 'xml_reference'],
    ['U+FFFE', '\ufffe', '&#xFFFE;', 'xml_reference'],
    ['U+FFFF', '\uffff', '&#65535;', 'xml_reference'],
  ])('%s in a text is drift, raw and as a reference', (_, raw, ref, refCode) => {
    const edit = (s: string) => both(at(base, SST, '<t>Groen</t>', `<t>Gr${s}oen</t>`));
    if (raw !== null) expect(code(edit(raw))).toBe('text_char');
    expect(code(edit(ref))).toBe(refCode);
  });

  it('keeps a tab and a line feed, raw or as a reference', () => {
    for (const s of ['\t', '\n', '&#9;', '&#10;', '&#xA;']) {
      expect([s, code(both(at(base, SST, '<t>Groen</t>', `<t>Gr${s}oen</t>`)))]).toEqual([s, 'passed']);
    }
  });

  it('a mutated member is either still a workbook or a SchemaDrift, never another error', () => {
    const paths = [...READ];
    const junk = fc.constantFrom(
      '<',
      '>',
      '&',
      '"',
      '/>',
      '</c>',
      '<row r="2"/>',
      '<c r="B2" t="s"><v>0</v></c>',
      '&#0;',
      '&gt;',
      '<!DOCTYPE a>',
      '<![CDATA[x]]>',
      '<constructor/>',
      '<__proto__/>',
      't="n"',
      'NULL',
      '\r',
      ' ',
      '\u0000',
      'é',
    );
    const mutation = fc.record({
      path: fc.constantFrom(...paths),
      at: fc.nat(),
      cut: fc.nat({ max: 40 }),
      insert: fc.oneof(junk, fc.string({ maxLength: 8 })),
    });
    fc.assert(
      fc.property(mutation, ({ path, at: pos, cut, insert }) => {
        const text = base.get(path) as string;
        const i = pos % (text.length + 1);
        const members = new Map(base).set(path, text.slice(0, i) + insert + text.slice(i + cut));
        try {
          const out = dedupe(parse(members));
          // Whatever still parses is written and read back unchanged.
          expect(readThresholds(toCsv(out, { sha256: 'c'.repeat(64), edition: EDITION })).rows).toEqual(out);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------- CSV round trip

/**
 * What a text cell may hold (review S2), stated here on its own: no C0 control but tab and line feed, no DEL
 * or C1 control, no surrogate half, no U+FFFE or U+FFFF, and none of the bidi and format controls.
 */
const allowed = (s: string) =>
  [...s].every((c) => {
    const cp = c.codePointAt(0) as number;
    return (
      (cp >= 0x20 || cp === 0x9 || cp === 0xa) &&
      !(cp >= 0x7f && cp <= 0x9f) &&
      !(cp >= 0xd800 && cp <= 0xdfff) &&
      !(cp >= 0x202a && cp <= 0x202e) &&
      !(cp >= 0x2066 && cp <= 0x2069) &&
      ![0x200e, 0x200f, 0xfeff, 0xfffe, 0xffff].includes(cp)
    );
  });

describe('CSV round trip (property)', () => {
  const unit = fc.constantFrom(
    ',',
    '"',
    '\n',
    '\t',
    '=',
    '+',
    '-',
    '@',
    "'",
    ' ',
    'a',
    'Z',
    '0',
    '.',
    'é',
    '≥',
    '😀',
    ' ',
  );
  // Only text a row may hold: the refusal of everything else is its own property below.
  const text = fc.oneof(
    fc.string({ unit, minLength: 1, maxLength: 24 }),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }).filter(allowed),
  );
  const monthDay = fc
    .integer({ min: 1, max: 12 })
    .chain((m) =>
      fc
        .integer({ min: 1, max: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number })
        .map((d) => m * 100 + d),
    );
  const bound = fc.oneof(
    fc.constant(null),
    fc.integer({ min: -1_000_000, max: 1_000_000 }).filter((n) => !Object.is(n, -0)),
    fc
      .double({ min: -1e6, max: 1e6, noNaN: true })
      .filter((n) => !Object.is(n, -0) && /^-?\d+(?:\.\d+)?$/.test(String(n))),
  );
  const threshold: fc.Arbitrary<ThresholdRow> = fc
    .record({
      code: text,
      description: fc.oneof(fc.constant(H), fc.constant(Q), text),
      period: text,
      season: fc.oneof(fc.constant([null, null] as const), fc.tuple(monthDay, monthDay)),
      label: text,
      from: bound,
      to: bound,
      order: fc.integer({ min: 0, max: 32_767 }),
      priority: fc.integer({ min: 0, max: 32_767 }),
    })
    .map(({ season, ...r }) => ({
      code: r.code,
      description: r.description,
      period: r.period,
      from_md: season[0],
      to_md: season[1],
      label: r.label,
      from: r.from,
      to: r.to,
      order: r.order,
      priority: r.priority,
    }));
  const header = { sha256: 'b'.repeat(64), edition: '2026-04-15' };

  it('fromCsvCells(scanCsv(toCsv(rows))) gives the rows back, and readThresholds takes the text', () => {
    fc.assert(
      fc.property(fc.array(threshold, { maxLength: 20 }), (rows) => {
        const text = toCsv(rows, header);
        const scanned = scanCsv(Buffer.from(text), { delimiter: ',', commentPrefix: '#' });
        expect(scanned.rows.map(fromCsvCells)).toEqual(rows);
        expect(readThresholds(text)).toEqual({ ...header, rows });
      }),
      { numRuns: 300 },
    );
  });

  it('a text with a control, bidi or format character is refused, written or read back (review S2)', () => {
    const risky = fc.constantFrom(
      '\u0001',
      '\r',
      '\u001f',
      '\u007f',
      '\u0085',
      '\u009f',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202e',
      '\u2066',
      '\u2069',
      '\ufeff',
      '\ud800',
      '\udfff',
      '\ufffe',
      '\uffff',
      '\t',
      '\n',
      'a',
      '≥',
      '\u200b',
    );
    const cell = fc.string({
      unit: fc.oneof(risky, fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })),
      minLength: 1,
      maxLength: 8,
    });
    const row: ThresholdRow = { ...(rows[0] as ThresholdRow), label: 'L' };
    fc.assert(
      fc.property(cell, fc.constantFrom('code', 'description', 'period', 'label'), (s, field) => {
        let result = 'written';
        try {
          toCsv([{ ...row, [field]: s }], header);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
          result = (err as SchemaDrift).message;
        }
        expect([s, result]).toEqual([s, allowed(s) ? 'written' : `custom at ${field}`]);
      }),
      { numRuns: 500 },
    );
    // A hand-edited CSV: the character in the label cell of a written file.
    const good = toCsv([row], header);
    expect(readThresholds(good).rows).toEqual([row]);
    for (const c of ['\u0001', '\u007f', '\u0085', '\u200f', '\u202e', '\u2066', '\ufeff', '\ufffe']) {
      const edited = good.replace(/,L,/, `,L${c},`);
      expect(edited).not.toBe(good);
      expect(() => readThresholds(edited)).toThrow(SchemaDrift);
      expect(() => fromCsvCells(['c', H, 'Gehele jaar', '101', '1231', `L${c}`, '1', '2', '1', '0'])).toThrow(
        'custom at label',
      );
    }
  });

  it('fromCsvCells on arbitrary cells is a row or a SchemaDrift', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ unit, maxLength: 6 }), fc.integer().map(String)), { maxLength: 12 }),
        (cells) => {
          try {
            fromCsvCells(cells);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a cell toCsv never writes', () => {
    const ok = ['c', H, 'Gehele jaar', '101', '1231', 'L', '1', '2', '1', '0'];
    expect(fromCsvCells(ok)).toMatchObject({ code: 'c', from_md: 101, from: 1 });
    const bad = (i: number, v: string) => () => fromCsvCells(ok.map((c, j) => (j === i ? v : c)));
    expect(bad(5, '=1+1')).toThrow(SchemaDrift); // a formula start without the guard
    expect(bad(5, "'x")).toThrow(SchemaDrift); // a guard where none belongs
    expect(bad(6, '1.0')).toThrow(SchemaDrift);
    expect(bad(6, '-0')).toThrow(SchemaDrift);
    expect(bad(3, '230')).toThrow(SchemaDrift);
    expect(bad(3, '')).toThrow(SchemaDrift); // one end of the season only
    expect(bad(8, '')).toThrow(SchemaDrift);
    expect(() => fromCsvCells(ok.slice(1))).toThrow(SchemaDrift);
  });
});
