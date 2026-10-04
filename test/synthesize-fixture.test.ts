import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractDataToJson } from '../apps/server/src/http/guards.ts';
import {
  HEADER_CELL,
  Refusal,
  synthesize,
  synthesizeFromExport,
  synthesizeSmoke,
  VALUE_WITH_UNIT,
  VERBATIM,
} from '../scripts/synthesize-fixture.ts';

// The export form of scripts/synthesize-fixture.ts (P5c): a fake export in a temp directory, an injectable output
// root, so nothing is ever written under apps/. Every value below is invented.

const tmp = mkdtempSync(join(tmpdir(), 'synth-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let counter = 0;

/** A fresh export directory holding the given payloads of one spec (and a fresh output root). */
function exportOf(
  source: string,
  spec: string,
  payloads: { body: string; start?: string; variant?: string; sha?: string }[],
) {
  counter += 1;
  const from = join(tmp, `export-${counter}`);
  const outRoot = join(tmp, `out-${counter}`);
  mkdirSync(from, { recursive: true });
  payloads.forEach((p, i) => {
    const body = Buffer.from(p.body);
    writeFileSync(join(from, `${spec}-${i + 1}.raw`), body);
    writeFileSync(
      join(from, `${spec}-${i + 1}.line.json`),
      JSON.stringify({
        source,
        spec,
        variant: p.variant ?? 'default',
        sha256: p.sha ?? sha256(body),
        key: `raw/${source}/${spec}/${i + 1}.zst`,
        status: 200,
        fetched_at: { start: p.start ?? `2026-10-0${i + 1}T10:00:00Z`, end: `2026-10-0${i + 1}T10:00:01Z` },
      }),
    );
  });
  return { from, outRoot };
}

const run = (e: { from: string; outRoot: string }, spec: string, source: string, extra = {}) => {
  const written = synthesizeFromExport({ from: e.from, outRoot: e.outRoot, spec, name: 'test', ...extra });
  const dir = join(e.outRoot, source.toLowerCase(), 'fixtures');
  const file = (suffix: string) => readFileSync(join(dir, `${spec}-test.synthetic.${suffix}`), 'utf8');
  return { written, raw: file('raw'), meta: JSON.parse(file('meta.json')) as Record<string, unknown>, dir };
};

/** The exit code of the Refusal that `f` throws, or null when it throws none. */
function refusalOf(f: () => unknown): number | null {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Refusal);
    return (e as Refusal).code;
  }
  return null;
}

const DAY = 86_400_000;
/** The whole number of days by which `after` lies after `before`, with the same time of day and offset suffix. */
function shiftDays(before: string, after: string): number {
  expect(after.slice(10)).toBe(before.slice(10));
  const days = (Date.parse(after) - Date.parse(before)) / DAY;
  expect(Number.isInteger(days)).toBe(true);
  return days;
}

// Each run loads the capture registry (a few hundred ms): the whole suite runs these under load.
describe('the export form of synthesize-fixture', { timeout: 30_000 }, () => {
  it('a BE-3 layer: identifiers kept, values, names and coordinates generated, timestamps shifted by one constant', () => {
    const layer = [
      {
        ts_id: 905579408,
        timestamp: '2026-09-29T10:20:00.000+02:00',
        req_timestamp: null,
        ts_value: 3.25,
        station_latitude: 50.4561,
        station_longitude: 5.1234,
        station_no: '5902',
        station_name: 'Mijn Station',
        stationparameter_no: 'H',
        ts_unitsymbol: 'm3/s',
      },
      {
        ts_id: 689409637,
        timestamp: '2026-09-29T08:30:00.000Z',
        req_timestamp: null,
        ts_value: 27.25,
        station_latitude: 49.9,
        station_longitude: 4.8,
        station_no: '5277',
        station_name: 'Ander Station',
        stationparameter_no: 'QADM',
        ts_unitsymbol: 'cm',
      },
    ];
    const body = JSON.stringify(layer);
    const { written, raw, meta } = run(exportOf('BE-3', 'be-3-values', [{ body }]), 'be-3-values', 'BE-3');
    const out = JSON.parse(raw) as typeof layer;
    expect(out).toHaveLength(2);
    out.forEach((o, i) => {
      const was = layer[i] as (typeof layer)[number];
      for (const k of ['ts_id', 'station_no', 'stationparameter_no', 'ts_unitsymbol'] as const)
        expect(o[k]).toBe(was[k]);
      for (const k of ['ts_value', 'station_name', 'station_latitude', 'station_longitude'] as const)
        expect(o[k]).not.toBe(was[k]);
      expect(o.station_name).toMatch(/^synthetic-\d+$/);
      expect(typeof o.ts_value).toBe('number');
      expect(o.req_timestamp).toBeNull();
    });
    const [d1, d2] = [
      shiftDays(layer[0]?.timestamp as string, out[0]?.timestamp as string),
      shiftDays(layer[1]?.timestamp as string, out[1]?.timestamp as string),
    ];
    expect(d1).toBe(d2);
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeLessThanOrEqual(2000);
    // The raw bytes differ from the source, and the meta says where it came from (never a `from`).
    expect(sha256(Buffer.from(raw))).not.toBe(sha256(Buffer.from(body)));
    expect(meta).toEqual({
      spec: 'be-3-values',
      source: 'BE-3',
      synthetic: true,
      derived_from: 'an archived payload (owner audience: not committed)',
      values: expect.any(String),
      status: 200,
      variant: 'default',
      archive_key: 'raw/BE-3/be-3-values/1.zst',
      source_sha256: sha256(Buffer.from(body)),
    });
    expect(meta).not.toHaveProperty('from');
    expect(written.map((w) => w.path.split('/').pop())).toEqual([
      'be-3-values-test.synthetic.raw',
      'be-3-values-test.synthetic.meta.json',
    ]);
    expect(written.map((w) => w.bytes)).toEqual([raw.length, Buffer.byteLength(`${JSON.stringify(meta, null, 2)}\n`)]);
  });

  it('a BE-3 getTimeseriesValues item: quality codes, null and -1 kept; values and timestamps generated', () => {
    const item = {
      ts_id: '905579408',
      ts_path: '1/5902/Q/15m.Cmd.P',
      ts_unitsymbol: 'm³/s',
      columns: 'Timestamp,Value,Quality Code',
      rows: '4',
      data: [
        ['2026-09-29T10:00:00.000+02:00', 4.25, 200],
        ['2026-09-29T10:15:00.000+02:00', 4.5, 205],
        ['2026-09-29T10:30:00.000+02:00', 0, 40],
        ['2026-09-29T10:45:00.000+02:00', null, -1],
        ['2026-09-29T11:00:00.000+02:00', -1, 253],
      ],
    };
    const { raw } = run(exportOf('BE-3', 'be-3-values', [{ body: JSON.stringify([item]) }]), 'be-3-values', 'BE-3');
    const [out] = JSON.parse(raw) as (typeof item)[];
    expect(out?.ts_path).toBe(item.ts_path);
    expect(out?.columns).toBe(item.columns);
    expect(out?.data.map((r) => r[2])).toEqual(item.data.map((r) => r[2]));
    expect(out?.data[3]?.[1]).toBeNull();
    expect(out?.data[4]?.[1]).toBe(-1);
    expect(out?.data[2]?.[1]).toBe(0);
    for (const i of [0, 1]) expect(out?.data[i]?.[1]).not.toBe(item.data[i]?.[1]);
    const days = item.data.map((r, i) => shiftDays(r[0] as string, out?.data[i]?.[0] as string));
    expect(new Set(days).size).toBe(1);
  });

  it('a KiWIS table: header row and registry columns kept, keep rows only, other cells generated', () => {
    const header = ['station_no', 'station_name', 'station_carteasting', 'river_name', 'station_gauge_datum_unit'];
    const rows = [
      ['5902', 'Mijn Station', '999.99 m NN', 'Mijn Rivier', 'DNG'],
      ['5277', 'Ander Station', '99,99', 'Andere Rivier', '---'],
      ['5111', 'Derde Station', '09.099999', 'Derde Rivier', 'DNG'],
    ];
    const { raw } = run(
      exportOf('BE-3', 'be-3-meta', [{ body: JSON.stringify([header, ...rows]) }]),
      'be-3-meta',
      'BE-3',
      { keep: 2 },
    );
    const out = JSON.parse(raw) as string[][];
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(header);
    out.slice(1).forEach((r, i) => {
      const was = rows[i] as string[];
      expect([r[0], r[4]]).toEqual([was[0], was[4]]);
      expect(r[1]).toMatch(/^synthetic-\d+$/);
      expect(r[3]).toMatch(/^synthetic-\d+$/);
    });
    // A number with unit text keeps its shape and its letters; only the digits change.
    expect(out[1]?.[2]).toMatch(/^\d{3}\.\d{2} m NN$/);
    expect(out[1]?.[2]).not.toBe('999.99 m NN');
    expect(out[2]?.[2]).toMatch(/^\d{2},\d{2}$/);
  });

  it('an LU-2 file: its enumerations kept, its names and values generated', () => {
    const file = [
      {
        ts_path: 'Alzette/Hesperange/W/15m',
        ts_unitsymbol: 'cm',
        parametertype_name: 'W',
        station_name: 'Hesperange',
        columns: 'Timestamp,Value',
        rows: '3',
        data: [
          ['2026-09-29T10:00:00.000+02:00', 85.5],
          ['2026-09-29T10:15:00.000+02:00', 86.25],
        ],
      },
    ];
    const { raw } = run(exportOf('LU-2', 'lu-2-json', [{ body: JSON.stringify(file) }]), 'lu-2-json', 'LU-2');
    const [out] = JSON.parse(raw) as typeof file;
    for (const k of ['ts_path', 'ts_unitsymbol', 'parametertype_name', 'columns', 'rows'] as const)
      expect(out?.[k]).toBe(file[0]?.[k]);
    expect(out?.station_name).toBe('synthetic-1');
    expect(out?.data[0]?.[1]).not.toBe(85.5);
    expect(shiftDays('2026-09-29T10:00:00.000+02:00', out?.data[0]?.[0] as string)).toBeGreaterThanOrEqual(1000);
  });

  it('an LU-4 page: the attribute is re-emitted with &#34; and its enumerations kept', () => {
    const doc = {
      id: 'mondorf',
      jsonFile: 'mondorf.json',
      forecastsLimit: 'h24',
      label: 'Mondorf',
      stationName: 'Mondorf-les-Bains',
      operator: 'Mijn Beheerder',
      serviceStatus: 'En service',
      forecastsCalcul: 'Mijn Rekencentrum',
      vigilanceThreshold: 47,
      showImage: true,
      levelsMax: [
        { value: 0, label: 'Cote de vigilance jaune' },
        { value: 999.5, label: 'Cote de vigilance orange 999 cm' },
      ],
      newVigilanceList: [{ legend: 'HQ10', value: 9 }],
    };
    const attr = JSON.stringify(doc).replace(/"/g, '&#34;');
    const body = `<!DOCTYPE html><html><body><cmp-dashboard-station data-to-json="${attr}"></cmp-dashboard-station></body></html>`;
    const { raw } = run(exportOf('LU-4', 'lu-4-pages', [{ body }]), 'lu-4-pages', 'LU-4');
    expect(raw).toContain('<cmp-dashboard-station class="synthetic" data-to-json="{&#34;id&#34;:&#34;mondorf&#34;');
    expect(raw).not.toMatch(/data-to-json="[^"]*"[^"]*"/);
    const out = extractDataToJson(Buffer.from(raw)) as typeof doc;
    expect([out.id, out.jsonFile, out.forecastsLimit, out.showImage]).toEqual(['mondorf', 'mondorf.json', 'h24', true]);
    expect(out.newVigilanceList[0]?.legend).toBe('HQ10');
    expect(out.newVigilanceList[0]?.value).not.toBe(9);
    // Free text, which no parser needs as published (P5c review R2-SR-3): generated.
    for (const k of ['stationName', 'operator', 'serviceStatus', 'forecastsCalcul'] as const)
      expect(out[k]).toMatch(/^synthetic-\d+$/);
    expect(out.vigilanceThreshold).not.toBe(47);
    // A label is text that can carry the level itself ("… orange 999 cm"): generated, never kept (P5c review CR-1).
    expect(out.levelsMax.map((l) => l.label)).toEqual([
      expect.stringMatching(/^synthetic-/),
      expect.stringMatching(/^synthetic-/),
    ]);
    expect(raw).not.toContain('999 cm');
    expect(out.levelsMax[0]?.value).toBe(0);
    expect(out.levelsMax[1]?.value).not.toBe(999.5);
  });

  it('keeps verbatim only identifiers and codes: no kept key of any source is a free text (P5c review CR-1)', () => {
    const FREE_TEXT = /label|name|text|info|description|remark|diary|address|adresse|banner|comment/i;
    for (const [source, formats] of Object.entries(VERBATIM))
      for (const key of Object.keys(formats))
        expect([
          source,
          key,
          FREE_TEXT.test(key) && !/^(ts_name|ts_shortname|parametertype_name|forecastsFileName)$/.test(key),
        ]).toEqual([source, key, false]);
    for (const key of ['label', 'operator', 'serviceStatus', 'forecastsCalcul'])
      expect([key, Object.hasOwn(VERBATIM['LU-4'] ?? {}, key)]).toEqual([key, false]);
  });

  it('a kept key keeps a string or an integer only: an object, an array or a decimal under it is generated (P5c review SR-2)', () => {
    const doc = [
      {
        ts_id: 905579408,
        ts_path: '1/5902/Q/15m.Cmd.P',
        rows: '12',
        station_no: ['5902', 'Mijn Station'],
        site_no: 12.75,
        ts_name: { level: 'Mijn Rivier', value: 999.25 },
      },
    ];
    const [out] = JSON.parse(synthesize('BE-3', 'json', Buffer.from(JSON.stringify(doc))).toString()) as typeof doc;
    expect([out?.ts_id, out?.ts_path, out?.rows]).toEqual([905579408, '1/5902/Q/15m.Cmd.P', '12']);
    expect(out?.station_no[0]).toMatch(/^\d{4}$/);
    expect(out?.station_no[0]).not.toBe('5902');
    expect(out?.station_no[1]).toMatch(/^synthetic-\d+$/);
    expect(out?.site_no).not.toBe(12.75);
    expect(out?.ts_name.level).toMatch(/^synthetic-\d+$/);
    expect(out?.ts_name.value).not.toBe(999.25);
  });

  it('refuses a kept string that holds a value with a unit, and keeps codes that hold digits', () => {
    for (const text of ['Cote de vigilance orange 999 cm', '9,9 m³/s', 'at 99%', 'zero 9.9 m NN', '9 l/s', '99mm'])
      expect([text, VALUE_WITH_UNIT.test(text)]).toEqual([text, true]);
    for (const code of ['0/11/W_out/15m.Cmd.RelAbs.P', '15m.Cmd.P', 'PT15M', 'h24', 'EPSG:31370', 'UTC+01:00'])
      expect([code, VALUE_WITH_UNIT.test(code)]).toEqual([code, false]);
    const page = [{ ts_id: 1, ts_path: 'Cote de vigilance orange 999 cm' }];
    expect(() => synthesize('BE-3', 'json', Buffer.from(JSON.stringify(page)))).toThrow(Refusal);
  });

  it('a first row that is not a header of names is no KiWIS table: it is generated like the others (P5c review R2-SR-2)', () => {
    const probes = [
      {
        forecast: [
          ['2030-01-02T10:00:00Z', '999.45'],
          ['2030-01-02T10:10:00Z', '998.1'],
        ],
      },
      {
        levels: [
          ['999', '998', '997'],
          ['1', '2', '3'],
        ],
      },
      {
        t: [
          ['station_no', '99 cm'],
          ['1', '2'],
        ],
      },
    ];
    for (const doc of probes) {
      const [first] = Object.values(doc) as string[][][];
      const [out] = Object.values(
        JSON.parse(synthesize('DE-2', 'json', Buffer.from(JSON.stringify(doc))).toString()),
      ) as string[][][];
      expect(out).toHaveLength(2);
      for (const [i, cell] of (first?.[0] ?? []).entries()) expect(out?.[0]?.[i]).not.toBe(cell);
    }
    for (const cell of ['station_no', 'Quality Code', 'ts_id', 'HQ100'])
      expect([cell, HEADER_CELL.test(cell)]).toEqual([cell, true]);
    for (const cell of ['999', '2030-01-02T10:00:00Z', '99 cm', '-1', '', 'synthetic-1', '9.9'])
      expect([cell, HEADER_CELL.test(cell)]).toEqual([cell, false]);
  });

  it('a kept key keeps only its one format: any other string or integer under it is refused (P5c review R2-SR-3)', () => {
    const lu4 = (legend: unknown) => [{ newVigilanceList: [{ legend, value: 9 }] }];
    for (const legend of ['HQ2', 'HQ10', 'HQ100'])
      expect([legend, refusalOf(() => synthesize('LU-4', 'json', Buffer.from(JSON.stringify(lu4(legend)))))]).toEqual([
        legend,
        null,
      ]);
    const probes = [
      '9.999,5 cm',
      '999 centimetres',
      '9,9 mètres',
      '\uff19\uff19\uff19 cm',
      '\u0669\u0669\u0669 cm',
      '999\u200bcm',
      '999 \u339d',
      'cm 999',
      '9.99-m',
      'Cote 999',
      'seuil 999',
      '999',
      999,
      'HQ 10',
    ];
    for (const legend of probes)
      expect([legend, refusalOf(() => synthesize('LU-4', 'json', Buffer.from(JSON.stringify(lu4(legend)))))]).toEqual([
        legend,
        1,
      ]);
    // An integer only where the key is an id or a count: `ts_id` 905579408 stays, `ts_unitsymbol` 999 is refused.
    expect(refusalOf(() => synthesize('BE-3', 'json', Buffer.from('[{"ts_id":905579408,"x":1.5}]')))).toBeNull();
    expect(refusalOf(() => synthesize('BE-3', 'json', Buffer.from('[{"ts_unitsymbol":999}]')))).toBe(1);
    expect(refusalOf(() => synthesize('BE-3', 'json', Buffer.from('[{"ts_unitsymbol":"9 cm"}]')))).toBe(1);
    // Every kept key has its format (a typed table), and every format matches no bare value with a unit.
    for (const [source, formats] of Object.entries(VERBATIM))
      for (const [key, format] of Object.entries(formats))
        expect([source, key, format.test('999 cm'), format.test('999,5')]).toEqual([source, key, false, false]);
  });

  it("a KiWIS Quality Code cell keeps only a code of SPW's table (P5c review R2-SR-3)", () => {
    const item = (code: unknown) => [
      { ts_id: '1', columns: 'Timestamp,Value,Quality Code', data: [['2026-09-29T10:00:00Z', 1.5, code]] },
    ];
    const quality = (code: unknown) =>
      (
        JSON.parse(synthesize('BE-3', 'json', Buffer.from(JSON.stringify(item(code)))).toString()) as {
          data: unknown[][];
        }[]
      )[0]?.data[0]?.[2];
    for (const code of [-1, 0, 40, 160, 165, 200, 205, 210, 253]) expect([code, quality(code)]).toEqual([code, code]);
    expect(quality(null)).toBeNull();
    for (const code of [1, 100, 255, 999, '999 cm']) expect([code, refusalOf(() => quality(code))]).toEqual([code, 1]);
  });

  it('an object key is a name of letters, or refused (P5c review R2-SR-4)', () => {
    for (const key of ['ts_id', 'Quality Code', 'logos-header', ''])
      expect([key, refusalOf(() => synthesize('DE-2', 'json', Buffer.from(JSON.stringify([{ [key]: 1.5 }]))))]).toEqual(
        [key, null],
      );
    for (const key of ['999 cm', 'a1', ' a', 'a ', 'a  b', 'a.b', 'a\tb', 'mètres', 'x:y'])
      expect([key, refusalOf(() => synthesize('DE-2', 'json', Buffer.from(JSON.stringify([{ [key]: 1.5 }]))))]).toEqual(
        [key, 1],
      );
    // At any depth, under a kept key too.
    expect(refusalOf(() => synthesize('LU-4', 'json', Buffer.from('[{"legend":{"999 cm":1}}]')))).toBe(1);
  });

  it('a text file: comment and station lines generated whole, the Datum header kept, number cells generated (P5c review R2-SR-5)', () => {
    const cells = ['123,45', ' 456.7 ', '+78.9', '1.234,5', '1e3', '12.5 cm'];
    const text = [
      '# Bundesanstalt fuer Gewaesserkunde, Stand 2026-09-29\r',
      'Mijn Pegel\r',
      'Datum;W;Q;Hinweis',
      `29.09.2026 06:00;${cells[0]};${cells[1]};\r`,
      `30.09.2026 06:00;${cells[2]};${cells[3]};${cells[4]}\r`,
      `01.10.2026 06:00;${cells[5]};;\r`,
      '',
    ].join('\n');
    const out = synthesize('DE-3', 'text', Buffer.from(text, 'latin1')).toString('utf8').split('\n');
    expect(out[0]).toMatch(/^# synthetic-\d+\r$/);
    expect(out[1]).toMatch(/^synthetic-\d+\r$/);
    expect(out[2]).toBe('Datum;W;Q;Hinweis');
    const rows = out.slice(3, 6).map((l) => l.split(';'));
    expect(rows.map((r) => r[0])).toEqual(['02.01.2030 00:00', '03.01.2030 00:00', '04.01.2030 00:00']);
    const generated = [rows[0]?.[1], rows[0]?.[2], rows[1]?.[1], rows[1]?.[2], rows[1]?.[3]?.trimEnd(), rows[2]?.[1]];
    generated.forEach((cell, i) => {
      const was = cells[i] as string;
      expect(cell).not.toBe(was);
      // The shape stays (signs, separators, spaces, the exponent letter and an allowed unit); only the digits are new.
      expect(cell?.replace(/\d/g, '0')).toBe(was.replace(/\d/g, '0'));
    });
    expect([rows[0]?.[3], rows[2]?.[2], rows[2]?.[3]]).toEqual(['\r', '', '\r']);
    // A line ends in \r only where the source's did.
    const plain = synthesize('DE-3', 'text', Buffer.from('# x\nMijn Pegel\nDatum;W\n29.09.2026 06:00;12\n', 'latin1'));
    expect(plain.toString('latin1')).not.toContain('\r');
    // Refused: a text cell, a number followed by words that are no unit, a line of cells before the header or in its
    // place, and a second header among the data lines (invented data).
    const refused = [
      'Datum;W\n29.09.2026 06:00;Hochwasser\r\n',
      'Datum;W\n29.09.2026 06:00;-\r\n',
      'Datum;W\n29.09.2026 06:00;n.a.\r\n',
      'Datum;W\n29.09.2026 06:00;99 Hochwasser\r\n',
      'Datum;W\n29.09.2026 06:00;cm 99\r\n',
      '29.09.2026 06:00;99\r\nDatum;W\n',
      'Pegel;W\n29.09.2026 06:00;99\r\n',
      'Datum;W;99 cm\n29.09.2026 06:00;99\r\n',
      'Datum;W\n29.09.2026 06:00;99\r\nDatum;W\n',
    ];
    for (const file of refused)
      expect([file, refusalOf(() => synthesize('DE-3', 'text', Buffer.from(file, 'latin1')))]).toEqual([file, 1]);
  });

  it('a BfG file (P8b): the five fixed comment lines keep their words and get a new issue date and limit; `---` stays; any other comment is generated whole', () => {
    const head = [
      '# Probabilistische Wasserstandsvorhersage vom 2026-10-01 GMT+1',
      '# Quelle: Bundesanstalt fuer Gewaesserkunde <vorhersage@bafg.de>',
      '# Vorhersagetage 1 - 14 Tagesmittelwerte',
      "# Keine Veroeffentlichung von Werten > 777 cm (Wert '---')",
      '# !!!! Zeitstempel Beginn des Zeitschritts !!!!',
    ];
    const file = (rows: string[], first = head) =>
      Buffer.from([...first, 'Mijn Pegel ', 'Datum;5%;10%;95%', ...rows, ''].join('\r\n'), 'latin1');
    const out = synthesize('DE-3', 'text', file(['02.10.2026 00:00;-12;34;---', '03.10.2026 00:00;---;---;---']))
      .toString('latin1')
      .split('\r\n');
    // The words and the fixed digits (the forecast days, the offset) stay; the date and the limit are new digits.
    expect(out[0]).toMatch(/^# Probabilistische Wasserstandsvorhersage vom \d{4}-\d{2}-\d{2} GMT\+1$/);
    expect(out[0]).not.toContain('2026-10-01');
    expect([out[1], out[2], out[4]]).toEqual([head[1], head[2], head[4]]);
    expect(out[3]).toMatch(/^# Keine Veroeffentlichung von Werten > \d{3} cm \(Wert '---'\)$/);
    expect(out[3]).not.toContain('777');
    expect(out[5]).toMatch(/^synthetic-\d+$/);
    expect(out[6]).toBe('Datum;5%;10%;95%');
    // A number is generated, `---` (not published) stays and is no number.
    const [one, two] = out.slice(7, 9).map((l) => l.split(';'));
    expect([one?.[1], one?.[2]]).not.toContain('-12');
    expect(one?.[1]).toMatch(/^-\d{2}$/);
    expect(one?.[3]).toBe('---');
    expect(two?.slice(1)).toEqual(['---', '---', '---']);
    // The limit of a station is never given back, whatever the other values (the seed is the payload's).
    for (let i = 0; i < 25; i += 1) {
      const line = synthesize('DE-3', 'text', file([`02.10.2026 00:00;${i};${i + 7};---`]))
        .toString('latin1')
        .split('\r\n')[3];
      expect(line).not.toContain('777');
    }
    // Any other comment line is generated whole: another offset, an address with a space, an extra line, another source.
    const other = [
      '# Probabilistische Wasserstandsvorhersage vom 2026-10-01 GMT+2',
      '# Quelle: Bundesanstalt fuer Gewaesserkunde <a b>',
      '# Mijn opmerking 999',
      ...head.slice(2),
    ];
    const generated = synthesize('DE-3', 'text', file([], other)).toString('latin1').split('\r\n');
    expect(generated.slice(0, 3).every((l) => /^# synthetic-\d+$/.test(l))).toBe(true);
    expect(synthesize('LU-3', 'text', file([])).toString('latin1').split('\r\n')[1]).toMatch(/^# synthetic-\d+$/);
    // `---` is the only non-number cell that stays.
    for (const cell of ['--', '----', '-', '---x', 'x---'])
      expect([cell, refusalOf(() => synthesize('DE-3', 'text', file([`02.10.2026 00:00;${cell}`], head)))]).toEqual([
        cell,
        1,
      ]);
  });

  describe('the leak scan', () => {
    it('refuses a string of the source that appears in the output, wherever it appears', () => {
      // The first generated name is synthetic-1: a source that already says so would get its own text back.
      expect(() => synthesize('DE-2', 'json', Buffer.from('[{"a":"synthetic-1"}]'))).toThrow(/reappears in the output/);
      // A timestamp moved by the constant shift onto another timestamp of the same source.
      const [once] = JSON.parse(synthesize('DE-2', 'json', Buffer.from('[{"t":"2026-01-01T00:00:00Z"}]')).toString());
      const doc = [{ t: '2026-01-01T00:00:00Z' }, { other: once.t }];
      expect(() => synthesize('DE-2', 'json', Buffer.from(JSON.stringify(doc)))).toThrow(/reappears in the output/);
    });

    it('compares a number at its own place: a draw that lands on another value of the source is no leak', () => {
      const dense = Array.from({ length: 900 }, (_, i) => 100 + i);
      const out = JSON.parse(synthesize('DE-2', 'json', Buffer.from(JSON.stringify(dense)), { keep: 900 }).toString());
      expect(out).toHaveLength(900);
      expect((out as number[]).filter((v, i) => v === dense[i])).toEqual([]);
    });

    it('leaves kept keys and the numbers -1, 0 and 9999 out', () => {
      const doc = [{ ts_id: 905579408, station_no: '5902', a: -1, b: 0, c: 9999, d: '9999.0', e: 12.5 }];
      expect(() => synthesize('BE-3', 'json', Buffer.from(JSON.stringify(doc)))).not.toThrow();
    });
  });

  it('keeps 9999.0 (number and string), is deterministic, and shifts every timestamp by the same days', () => {
    const times = ['2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z', '2026-03-31T23:50:00.5+01:00'];
    const doc = [{ a: 9999.0, b: '9999.0', c: 7777.5, d: times, e: '2026-06-01T12:00' }];
    const body = Buffer.from(JSON.stringify(doc));
    const one = synthesize('DE-3', 'json', body);
    expect(one.equals(synthesize('DE-3', 'json', body))).toBe(true);
    const [out] = JSON.parse(one.toString()) as typeof doc;
    expect([out?.a, out?.b]).toEqual([9999, '9999.0']);
    expect(out?.c).not.toBe(7777.5);
    const days = times.map((t, i) => shiftDays(t, out?.d[i] as string));
    expect(new Set(days).size).toBe(1);
    // An offset-less time keeps its time of day, and moves by the same days.
    expect(out?.e.slice(10)).toBe('T12:00');
    expect(Date.parse(`${out?.e}Z`) - Date.parse('2026-06-01T12:00Z')).toBe((days[0] as number) * DAY);
  });

  it('picks by fetched_at.start (latest by default, oldest on request) and by variant', () => {
    const e = exportOf('BE-3', 'be-3-values', [
      { body: '[{"ts_value": 1.5}]', start: '2026-10-02T00:00:00Z', variant: 'a' },
      { body: '[{"ts_value": 2.5}]', start: '2026-10-05T00:00:00Z', variant: 'a' },
      { body: '[{"ts_value": 3.5}]', start: '2026-10-09T00:00:00Z', variant: 'b' },
    ]);
    const key = (extra: object) => run(e, 'be-3-values', 'BE-3', { force: true, ...extra }).meta.archive_key;
    expect(key({})).toBe('raw/BE-3/be-3-values/3.zst');
    expect(key({ pick: 'oldest' })).toBe('raw/BE-3/be-3-values/1.zst');
    expect(key({ variant: 'a' })).toBe('raw/BE-3/be-3-values/2.zst');
    expect(key({ variant: 'a', pick: 'oldest' })).toBe('raw/BE-3/be-3-values/1.zst');
    expect(() => key({ variant: 'zz' })).toThrow(Refusal);
  });

  describe('refuses', () => {
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(Refusal);
        return (e as Refusal).code;
      }
      return null;
    };
    const body = '[{"ts_value": 1.5}]';

    it('a spec of a source that is not owner audience, before it looks at the export (64)', () => {
      const e = exportOf('DE-1', 'de-1-basin', [{ body }]);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'de-1-basin', name: 'test' }))).toBe(64);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'no-such-spec', name: 'test' }))).toBe(64);
      expect(readdirSync(tmp)).not.toContain(`out-${counter}`);
    });

    it('a payload whose sha256 is not the one of its manifest line (1)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body, sha: sha256(Buffer.from('another body')) }]);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'be-3-values', name: 'test' }))).toBe(1);
      expect(readdirSync(tmp)).not.toContain(`out-${counter}`);
    });

    it('synthetic bytes that equal the source (1)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body: '[]' }]);
      expect(refusal(() => synthesizeFromExport({ ...e, spec: 'be-3-values', name: 'test' }))).toBe(1);
    });

    it('an existing output unless --force (1), and a name that is not lowercase words (64)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body }]);
      const o = { ...e, spec: 'be-3-values', name: 'test' };
      synthesizeFromExport(o);
      expect(refusal(() => synthesizeFromExport(o))).toBe(1);
      expect(refusal(() => synthesizeFromExport({ ...o, force: true }))).toBeNull();
      for (const name of ['Test', 'a_b', '-a', 'a--b', '', '../x']) {
        expect(refusal(() => synthesizeFromExport({ ...o, name }))).toBe(64);
      }
    });

    it('the smoke form: the same refusals, and no overwrite without --force (1)', () => {
      counter += 1;
      const smokeDir = join(tmp, `smoke-${counter}`);
      const outRoot = join(tmp, `out-${counter}`);
      mkdirSync(smokeDir, { recursive: true });
      const o = { spec: 'de-2-wv', smokeDir, outRoot };
      writeFileSync(join(smokeDir, 'de-2-wv.raw'), '[]');
      expect(refusal(() => synthesizeSmoke(o))).toBe(1);
      writeFileSync(join(smokeDir, 'de-2-wv.raw'), '[{"a":"synthetic-1"}]');
      expect(refusal(() => synthesizeSmoke(o))).toBe(1);
      expect(readdirSync(tmp)).not.toContain(`out-${counter}`);
      writeFileSync(join(smokeDir, 'de-2-wv.raw'), '[{"value": 1.5, "timestamp": "2026-09-29T10:00:00+02:00"}]');
      expect(refusal(() => synthesizeSmoke(o))).toBeNull();
      expect(refusal(() => synthesizeSmoke(o))).toBe(1);
      expect(refusal(() => synthesizeSmoke({ ...o, force: true }))).toBeNull();
      expect(readdirSync(join(outRoot, 'de-2', 'fixtures'))).toEqual([
        'de-2-wv.synthetic.meta.json',
        'de-2-wv.synthetic.raw',
      ]);
    });

    it('a body that is not JSON, without printing it (1)', () => {
      const e = exportOf('BE-3', 'be-3-values', [{ body: '{"ts_value": 777777.777' }]);
      try {
        synthesizeFromExport({ ...e, spec: 'be-3-values', name: 'test' });
        expect.unreachable();
      } catch (err) {
        expect((err as Refusal).code).toBe(1);
        expect((err as Refusal).message).not.toContain('777777');
      }
    });
  });
});
