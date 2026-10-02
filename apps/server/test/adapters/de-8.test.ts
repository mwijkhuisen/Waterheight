import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { GaugeZeroRow, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { keyOf as de7KeyOf } from '../../src/adapters/de-7/normalise.ts';
import { type Drift, driftReport, keyOf, normaliseHydro } from '../../src/adapters/de-8/normalise.ts';
import {
  HYDRO_HEADER,
  HYDRO_MEMBER,
  type HydroRow,
  MAX_ROWS,
  parseHydro,
  parseStations,
  STATIONS_HEADER,
  type Station,
  ZERO_RANGE_M,
} from '../../src/adapters/de-8/parse.ts';
import { HYDRO_MAX, LOAD_ADAPTERS, type LoadContext } from '../../src/load/adapters.ts';
import type { SeriesRow } from '../../src/load/store.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// DE-8 opengeodata.nrw.de (DL-DE Zero): the OpenHygon station master (UTF-8) and the hydro stations with the
// gauge zero `Nullpunkt` (ISO-8859-1, in a ZIP). Parse + normalise of the real recordings equal the committed
// golden files (invariant 9); `UPDATE_GOLDEN=1` rewrites them. The station master stores nothing: it is registry
// input and, in the loader, drift against the DE-7 registry. The hydro payload becomes gauge zeros of DE-7 series.

const de7 = registryOf('DE-7');
const stationsSpec = LOAD_ADAPTERS['DE-8']?.specs['de-8-stations'];
const hydroSpec = LOAD_ADAPTERS['DE-8']?.specs['de-8-hydro'];

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('DE-8', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The registered DE-7 series with the positions registry/stations/de-7.yaml declares (what the loader's drift gets). */
const positions = (() => {
  const file = new URL('../../../../registry/stations/de-7.yaml', import.meta.url);
  const rows = StationsFile.parse(parse(readFileSync(file, 'utf8'))).stations;
  return new Map(rows.map((r) => [r.provider_key, { key: r.provider_key, lon: r.lon, lat: r.lat }]));
})();
const seriesRows = (): ReadonlyMap<string, SeriesRow> =>
  new Map(
    [...positions].map(([k, p]) => [
      k,
      {
        ...(de7.get(k) as NonNullable<ReturnType<typeof de7.get>>),
        id: 0,
        tier: 2,
        off: false,
        sameAudience: true,
        role: 'primary' as const,
        lon: p.lon,
        lat: p.lat,
      },
    ]),
  );

const body = (name: string) => rawFixture('DE-8', name).body;
/** The hydro recordings are ZIPs of one member; the parser takes the member's bytes. */
const member = (name: string) => unzipSync(body(name))[HYDRO_MEMBER] as Uint8Array;

const hydroCtx = (name: string, extra: Partial<LoadContext> = {}): LoadContext => ({
  registry: new Map(),
  fetchedAt: Date.parse(rawFixture('DE-8', name).meta.recorded_at),
  variant: '',
  unitMismatch: new Set(),
  zeroRegistry: de7,
  ...extra,
});
const runHydro = async (name: string, extra: Partial<LoadContext> = {}) =>
  (await hydroSpec?.run(body(name), hydroCtx(name, extra))) as Normalised;

const drift = (fn: () => unknown): [string, string] | 'parsed' => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return [(err as SchemaDrift).code, (err as SchemaDrift).path];
  }
  return 'parsed';
};
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return (err as SchemaDrift).code;
  }
  return 'parsed';
};

/** One station row (16 fields) and one hydro row (17), as the provider spells them. */
const stationRow = (o: Partial<Record<'lat' | 'lon' | 'name' | 'no', string>> = {}) =>
  [
    o.lat ?? '51.945408',
    o.lon ?? '6.900707',
    o.name ?? 'Südlohn',
    o.no ?? '9283215500100',
    '928',
    'IJssel',
    '160.0',
    '194.0',
    '224.0',
    '',
    '',
    '',
    '',
    '',
    '231.34 km²',
    '62.55 km',
  ].join(';');
const hydroRow = (o: Partial<Record<'name' | 'id' | 'operator' | 'zero', string>> = {}) =>
  [
    o.name ?? 'Stah',
    o.id ?? '2829100000100',
    'ja',
    'LANUV, Eschweiler',
    '78',
    'Grundmessnetz des Landes',
    o.operator ?? 'LANUV, NRW',
    '297270.8265',
    '5664699.114',
    '32U',
    '19050601',
    '22.91',
    '2135.15',
    o.zero ?? '29.938',
    'Wassenberg',
    'Heinsberg',
    'Rureinzugsgebiet_NRW',
  ].join(';');
const stationsText = (...rows: string[]) => `${[STATIONS_HEADER, ...rows].join('\r\n')}\r\n`;
const hydroText = (...rows: string[]) => `${[HYDRO_HEADER, ...rows].join('\n')}\n`;
const stations = (text: string) => parseStations(Buffer.from(text, 'utf8'));
const hydro = (text: string) => parseHydro(Buffer.from(text, 'latin1'));

describe('golden files (real payloads)', () => {
  it('the station master (254 stations, UTF-8, CRLF): numbers, names with their umlauts, WGS84 positions', () => {
    const got = parseStations(body('de-8-stations'));
    expect({ stations: got }).toEqual(golden('de-8-stations', { stations: got }));
    expect(got).toHaveLength(254);
    expect(new Set(got.map((s) => s.no)).size).toBe(254);
    // The placeholder Soestbach is in the master (the DE-7 normalise drops it by number).
    expect(got.find((s) => s.no === '1234512345')).toMatchObject({ name: 'Soestbach', lat: 51.5758988498307 });
    const names = got.map((s) => s.name);
    expect(names).toContain('Südlohn');
    expect(names.some((n) => n.includes('�'))).toBe(false);
    for (const s of got) {
      expect(s.lat).toBeGreaterThan(50);
      expect(s.lat).toBeLessThan(53);
      expect(s.lon).toBeGreaterThan(5);
      expect(s.lon).toBeLessThan(10);
    }
  });

  it('six stations of the master (trimmed)', () => {
    const got = parseStations(body('de-8-stations-subset'));
    expect({ stations: got }).toEqual(golden('de-8-stations-subset', { stations: got }));
    expect(got.map((s) => s.no).sort()).toEqual([
      '1234512345',
      '2768898001',
      '2829100000100',
      '2847500000100',
      '2869500000200',
      '9286455000200',
    ]);
  });

  it('the hydro stations (280 stations, ISO-8859-1): a gauge zero in m on DHHN2016 for each DE-7 series the file has', async () => {
    const out = await runHydro('de-8-hydro');
    expect(out).toEqual(golden('de-8-hydro', out));
    const rows = parseHydro(member('de-8-hydro'));
    // The catchment row without a station (all NA) is skipped; the file has no station twice.
    expect(rows).toHaveLength(280);
    expect(new Set(rows.map((r) => r.id)).size).toBe(280);
    // `Ahrhütte-Neuhof` read as ISO-8859-1 (the byte 0xFC), not as mojibake or U+FFFD.
    expect(rows[0]).toEqual({ id: '2718193000100', name: 'Ahrhütte-Neuhof', operator: 'LANUV, NRW', zero: 340.587 });
    // Lieme has `NA` as its Nullpunkt: no zero, and (not being a DE-7 series) not even counted.
    expect(rows.find((r) => r.name === 'Lieme')?.zero).toBeNull();
    // Stah (tier 1): 29.938 m NHN.
    expect(out.gaugeZeros).toContainEqual({
      series: '2829100000100/W',
      value_m: 29.938,
      datum: 'NHN',
      valid_from: null,
    });
    // The 4 third-party operators the registry notes are in the file (the operator is not LANUV, NRW).
    expect(rows.filter((r) => r.operator !== 'LANUV, NRW' && de7.has(keyOf(r.id))).map((r) => r.id)).toEqual(
      expect.arrayContaining(['2761150000100', '2766645000100', '2768529000200', '2768784000200']),
    );
    // Rows only for the gauges the DE-7 registry has; the rest of the file is `unknown`, counted once each.
    const registered = rows.filter((r) => de7.has(keyOf(r.id)));
    expect(out.gaugeZeros).toHaveLength(registered.length);
    expect(out.unknown).toBe(rows.length - registered.length);
    expect(out.dropped).toEqual({});
    expect(out.obs).toEqual([]);
    expect(out.gaugeZeros).toHaveLength(219);
    for (const z of out.gaugeZeros) GaugeZeroRow.parse(z);
    expect(new Set(out.gaugeZeros.map((z) => z.series)).size).toBe(out.gaugeZeros.length);
  });

  it('four stations of the hydro file plus the NA row (trimmed): the NA row is skipped, every station has its zero', async () => {
    const out = await runHydro('de-8-hydro-subset');
    expect(out).toEqual(golden('de-8-hydro-subset', out));
    expect(parseHydro(member('de-8-hydro-subset')).map((r) => r.id)).toEqual([
      '9286455000200',
      '2829100000100',
      '2869500000200',
      '2847500000100',
    ]);
    expect(out.gaugeZeros.map((z) => [z.series, z.value_m])).toEqual(
      expect.arrayContaining([['2829100000100/W', 29.938]]),
    );
    for (const z of out.gaugeZeros) expect([z.datum, z.valid_from]).toEqual(['NHN', null]);
  });
});

describe('the loader specs', () => {
  it('de-8-stations stores nothing (parse only) and reports drift against the DE-7 registry', async () => {
    const out = (await stationsSpec?.run(body('de-8-stations'), hydroCtx('de-8-stations'))) as Normalised;
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
    expect(stationsSpec?.driftSource).toBe('DE-7');
    expect(stationsSpec?.zeroTarget).toBeUndefined();
    const report = stationsSpec?.drift?.(body('de-8-stations'), seriesRows()) as Drift;
    // The master and the registry agree: every registered gauge is listed at its registered position; the station
    // file's two stations without readings in the recording are unregistered (the placeholder is left out).
    expect(report).toEqual({ unregistered: ['2766929300099', '2825320000100'], vanished: [], changed: [] });
    // A payload that is not the master is drift of the payload.
    expect(() => stationsSpec?.drift?.(Buffer.from('not the master'), seriesRows())).toThrow(SchemaDrift);
  });

  it('de-8-hydro puts its zeros on the DE-7 series (zeroTarget), and on nothing without that registry', async () => {
    expect(hydroSpec?.zeroTarget).toBe('DE-7');
    expect((await runHydro('de-8-hydro-subset')).gaugeZeros.length).toBeGreaterThan(0);
    const none = (await hydroSpec?.run(body('de-8-hydro-subset'), {
      registry: new Map(),
      fetchedAt: 0,
      variant: '',
      unitMismatch: new Set(),
    })) as Normalised;
    expect([none.gaugeZeros, none.unknown]).toEqual([[], 4]);
  });

  it('the key is the DE-7 key (<station_no>/W): the two adapters never import each other, this holds them together', () => {
    for (const no of ['2829100000100', '2768898001', '123456']) expect(keyOf(no)).toBe(de7KeyOf(no));
  });

  it('the ZIP is guarded: a member of another name, an extra member and a non-ZIP are refused with the guard reason', async () => {
    const run = (b: Uint8Array) => refusal(Promise.resolve(hydroSpec?.run(b, hydroCtx('de-8-hydro'))));
    expect(await run(zipSync({ 'other.csv': strToU8(hydroText(hydroRow())) }))).toBe('zip_name');
    expect(await run(zipSync({ [HYDRO_MEMBER]: strToU8(hydroText(hydroRow())), 'extra.txt': strToU8('x') }))).toBe(
      'zip_name',
    );
    expect(await run(Buffer.from(hydroText(hydroRow())))).toBe('zip_eocd');
    expect(await run(zipSync({ [HYDRO_MEMBER]: new Uint8Array(1024 * 1024) }))).toBe('zip_ratio');
    // A member that is not the hydro table is the parser's drift (header pinned).
    expect(await run(zipSync({ [HYDRO_MEMBER]: strToU8('a;b\n1;2\n') }))).toBe('csv_header');
  });

  it('the hydro member is read whole, so it has a byte cap of its own: 2 MiB, then zip_member_size (review L6)', async () => {
    expect(HYDRO_MAX).toBe(2 * 1024 * 1024);
    const run = (b: Uint8Array) => refusal(Promise.resolve(hydroSpec?.run(b, hydroCtx('de-8-hydro'))));
    // Stored (level 0): the guard's 50:1 ratio does not apply, the member cap does. One byte over is refused.
    const padded = (n: number) => {
      const text = strToU8(hydroText(hydroRow()));
      const out = new Uint8Array(n).fill(0x0a);
      out.set(text);
      return zipSync({ [HYDRO_MEMBER]: [out, { level: 0 }] });
    };
    expect(await run(padded(HYDRO_MAX + 1))).toBe('zip_member_size');
    // At the cap the member reaches the parser (whose row cap then refuses the padding lines).
    expect(await run(padded(HYDRO_MAX))).toBe('csv_rows');
    expect(member('de-8-hydro').length).toBeLessThan(HYDRO_MAX / 40);
  });

  it('a station listed twice in the real subset: neither row gives a zero, both are withheld as conflict (review CR-1)', async () => {
    const text = Buffer.from(member('de-8-hydro-subset')).toString('latin1');
    const stah = text.split('\n').find((l) => l.split(';')[1] === '2829100000100');
    if (stah === undefined) throw new Error('no Stah row in the subset');
    for (const extra of [stah, stah.replace(';29.938;', ';29.94;')]) {
      const zip = zipSync({ [HYDRO_MEMBER]: Buffer.from(`${text}${extra}\n`, 'latin1') });
      const out = (await hydroSpec?.run(zip, hydroCtx('de-8-hydro-subset'))) as Normalised;
      expect(out.gaugeZeros.map((z) => z.series)).not.toContain('2829100000100/W');
      expect(out.dropped).toEqual({ conflict: 2 });
      // The other stations of the subset keep their zeros.
      expect(out.gaugeZeros).toHaveLength((await runHydro('de-8-hydro-subset')).gaugeZeros.length - 1);
    }
  });
});

describe('parseStations (UTF-8, header pinned)', () => {
  it('reads umlauts as UTF-8 and a BOM is not part of the header', () => {
    expect(stations(stationsText(stationRow()))).toEqual([
      { no: '9283215500100', name: 'Südlohn', lat: 51.945408, lon: 6.900707 },
    ]);
    expect(stations(`﻿${stationsText(stationRow())}`)).toHaveLength(1);
    // LF line ends and a missing final line end parse too.
    expect(stations(stationsText(stationRow()).replaceAll('\r\n', '\n').trimEnd())).toHaveLength(1);
  });

  it('bytes that are not UTF-8 (a latin1 ü, a lone 0xFF) are encoding drift', () => {
    expect(drift(() => parseStations(Buffer.from(stationsText(stationRow()), 'latin1')))).toEqual(['encoding', '']);
    expect(drift(() => parseStations(Buffer.from([0x73, 0xff])))).toEqual(['encoding', '']);
  });

  it.each([
    ['another header', stationsText(stationRow()).replace('station_latitude', 'lat'), 'csv_header'],
    [
      'the header columns reordered',
      `${STATIONS_HEADER.replace('station_latitude;station_longitude', 'station_longitude;station_latitude')}\r\n${stationRow()}\r\n`,
      'csv_header',
    ],
    ['no header line', `${stationRow()}\r\n`, 'csv_header'],
    ['an empty body', '', 'csv_empty'],
    ['a row of 15 fields', `${STATIONS_HEADER}\r\n${stationRow().split(';').slice(1).join(';')}\r\n`, 'csv_width'],
    ['a row of 17 fields (no extra field is tolerated)', `${STATIONS_HEADER}\r\n${stationRow()};x\r\n`, 'csv_width'],
    ['a quote that never closes', `${STATIONS_HEADER}\r\n"${stationRow()}\r\n`, 'csv_quote'],
  ])('refuses %s as %s drift', (_, text, code) => {
    expect(drift(() => stations(text))).toEqual([code, '']);
  });

  it.each([
    ['a short station number', stationRow({ no: '12345' }), 'station_no'],
    ['a station number of 14 digits', stationRow({ no: '12345678901234' }), 'station_no'],
    ['a station number with a letter', stationRow({ no: '92832155001A0' }), 'station_no'],
    ['an empty station number', stationRow({ no: '' }), 'station_no'],
    ['a latitude with a decimal comma', stationRow({ lat: '51,945408' }), 'position'],
    ['a latitude without decimals', stationRow({ lat: '51' }), 'position'],
    ['a longitude with an exponent', stationRow({ lon: '6.9e0' }), 'position'],
    ['an empty longitude', stationRow({ lon: '' }), 'position'],
    ['a name of 201 characters', stationRow({ name: 'x'.repeat(201) }), 'text'],
  ])('refuses %s as %s drift at the row, here rows.1', (_, bad, code) => {
    expect(drift(() => stations(stationsText(stationRow(), bad)))).toEqual([code, 'rows.1']);
    // A name of 200 characters is fine.
    expect(stations(stationsText(stationRow({ name: 'x'.repeat(200) })))).toHaveLength(1);
  });

  it('more than MAX_ROWS rows is csv_rows drift (the master has 254)', () => {
    expect(MAX_ROWS).toBe(2000);
    const row = stationRow();
    expect(stations(stationsText(...Array(MAX_ROWS).fill(row)))).toHaveLength(MAX_ROWS);
    expect(drift(() => stations(stationsText(...Array(MAX_ROWS + 1).fill(row))))).toEqual(['csv_rows', '']);
  });
});

describe('parseHydro (ISO-8859-1, header pinned)', () => {
  it('decodes ISO-8859-1, so that ü, ä, ß and é come out right', () => {
    const [r] = hydro(hydroText(hydroRow({ name: 'Ahrhütte-Neuhof äßé' })));
    expect(r?.name).toBe('Ahrhütte-Neuhof äßé');
    // The bytes are really single-byte: a UTF-8 reading of the same member would be invalid.
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hydroText(hydroRow({ name: 'ü' })), 'latin1')),
    ).toThrow();
  });

  it('reads id, name, operator and zero; a zero of NA or empty is null, never 0', () => {
    expect(
      hydro(
        hydroText(
          hydroRow(),
          hydroRow({ id: '2829100000200', zero: 'NA' }),
          hydroRow({ id: '2829100000300', zero: '' }),
          hydroRow({ id: '2829100000400', zero: '-0.5' }),
          hydroRow({ id: '2829100000500', zero: '1000' }),
          hydroRow({ id: '2829100000600', zero: '-10' }),
          hydroRow({ id: '2829100000700', zero: '9999.9' }),
        ),
      ),
    ).toEqual([
      { id: '2829100000100', name: 'Stah', operator: 'LANUV, NRW', zero: 29.938 },
      { id: '2829100000200', name: 'Stah', operator: 'LANUV, NRW', zero: null },
      { id: '2829100000300', name: 'Stah', operator: 'LANUV, NRW', zero: null },
      { id: '2829100000400', name: 'Stah', operator: 'LANUV, NRW', zero: -0.5 },
      { id: '2829100000500', name: 'Stah', operator: 'LANUV, NRW', zero: 1000 },
      { id: '2829100000600', name: 'Stah', operator: 'LANUV, NRW', zero: -10 },
      // The file's missing marker (Rehringhausen in the file of 2024-06-12): no zero, never 9999.9 m.
      { id: '2829100000700', name: 'Stah', operator: 'LANUV, NRW', zero: null },
    ]);
  });

  it('a zero outside −10 … 1000 m NHN is bad_value drift (review L6: the first stored zero stands)', () => {
    expect(ZERO_RANGE_M).toEqual({ min: -10, max: 1000 });
    for (const zero of ['-10.001', '1000.001', '1234', '9999.8', '-999'])
      expect([zero, drift(() => hydro(hydroText(hydroRow(), hydroRow({ zero }))))]).toEqual([
        zero,
        ['bad_value', 'rows.1'],
      ]);
    // The real file reads: its zeros lie within the range (0 … 546.221 m) or are the missing marker.
    expect(parseHydro(member('de-8-hydro')).find((r) => r.id === '2766424000100')?.zero).toBeNull();
  });

  it('the catchment row of NA values (a catchment without a station) is skipped, wherever it stands', () => {
    const na = `${Array(16).fill('NA').join(';')};Emschereinzugsgebiet_NRW`;
    expect(hydro(hydroText(na, hydroRow(), na))).toHaveLength(1);
    // Only `NA` in the id column skips a row: a real id with NA elsewhere is a row.
    expect(hydro(hydroText(hydroRow({ zero: 'NA' })))).toHaveLength(1);
  });

  it.each([
    ['another header', hydroText(hydroRow()).replace('station_name', 'name'), 'csv_header'],
    ['no header line', `${hydroRow()}\n`, 'csv_header'],
    ['an empty body', '', 'csv_empty'],
    ['a row of 16 fields', `${HYDRO_HEADER}\n${hydroRow().split(';').slice(1).join(';')}\n`, 'csv_width'],
    ['a row of 18 fields', `${HYDRO_HEADER}\n${hydroRow()};x\n`, 'csv_width'],
  ])('refuses %s as %s drift', (_, text, code) => {
    expect(drift(() => hydro(text))).toEqual([code, '']);
  });

  it.each([
    ['a station id of 5 digits', hydroRow({ id: '12345' }), 'station_no'],
    ['an empty station id', hydroRow({ id: '' }), 'station_no'],
    ['a zero with a decimal comma', hydroRow({ zero: '29,938' }), 'bad_value'],
    ['a zero of 5 integer digits', hydroRow({ zero: '12345' }), 'bad_value'],
    ['a zero of 5 decimals', hydroRow({ zero: '29.93812' }), 'bad_value'],
    ['a zero that is text', hydroRow({ zero: 'abc' }), 'bad_value'],
    ['a zero with an exponent', hydroRow({ zero: '2e1' }), 'bad_value'],
    ['an operator of 201 characters', hydroRow({ operator: 'x'.repeat(201) }), 'text'],
    ['a name of 201 characters', hydroRow({ name: 'x'.repeat(201) }), 'text'],
  ])('refuses %s as %s drift at the row, here rows.1', (_, bad, code) => {
    expect(drift(() => hydro(hydroText(hydroRow(), bad)))).toEqual([code, 'rows.1']);
  });

  it('more than MAX_ROWS rows is csv_rows drift (the file has 281)', () => {
    expect(hydro(hydroText(...Array(MAX_ROWS).fill(hydroRow())))).toHaveLength(MAX_ROWS);
    expect(drift(() => hydro(hydroText(...Array(MAX_ROWS + 1).fill(hydroRow()))))).toEqual(['csv_rows', '']);
  });
});

describe('normaliseHydro', () => {
  const rows: HydroRow[] = [
    { id: '2829100000100', name: 'Stah', operator: 'LANUV, NRW', zero: 29.938 },
    { id: '2869500000200', name: 'Goch', operator: 'LANUV, NRW', zero: 12 },
    { id: '9999999999991', name: 'Elsewhere', operator: 'x', zero: 1 },
    { id: '9999999999991', name: 'Elsewhere again', operator: 'x', zero: 2 },
    { id: '9999999999992', name: 'Another', operator: 'x', zero: null },
    { id: '2847500000100', name: 'Pannenmühle', operator: 'LANUV, NRW', zero: null },
  ];

  it('a registered station listed twice gives no zero: both rows are conflict, whatever their values (review CR-1)', () => {
    const twice: HydroRow[] = [
      { id: '2829100000100', name: 'Stah', operator: 'LANUV, NRW', zero: 29.938 },
      { id: '2869500000200', name: 'Goch', operator: 'LANUV, NRW', zero: 12 },
      { id: '2829100000100', name: 'Stah', operator: 'LANUV, NRW', zero: 29.938 },
      { id: '2847500000100', name: 'Pannenmühle', operator: 'LANUV, NRW', zero: 30 },
      { id: '2847500000100', name: 'Pannenmühle', operator: 'LANUV, NRW', zero: null },
    ];
    const out = normaliseHydro(twice, { registry: de7 });
    expect(out.gaugeZeros).toEqual([{ series: '2869500000200/W', value_m: 12, datum: 'NHN', valid_from: null }]);
    expect(out.dropped).toEqual({ conflict: 4 });
    expect(out.unknown).toBe(0);
  });

  it('only a registered DE-7 series gets a zero: NHN, no validity date; unknown counts once per series; a missing zero is zero_missing', () => {
    const out = normaliseHydro(rows, { registry: de7 });
    expect(out.gaugeZeros).toEqual([
      { series: '2829100000100/W', value_m: 29.938, datum: 'NHN', valid_from: null },
      { series: '2869500000200/W', value_m: 12, datum: 'NHN', valid_from: null },
    ]);
    expect(out.unknown).toBe(2);
    expect(out.dropped).toEqual({ zero_missing: 1 });
    expect(out.obs).toEqual([]);
    for (const z of out.gaugeZeros) GaugeZeroRow.parse(z);
  });

  it('an empty registry (no zeroRegistry) makes every station unknown and loads nothing', () => {
    const out = normaliseHydro(rows, { registry: new Map() });
    expect([out.gaugeZeros, out.unknown, out.dropped]).toEqual([[], 5, {}]);
  });
});

describe('driftReport (the station master against the DE-7 registry)', () => {
  const master = parseStations(body('de-8-stations'));
  const at = (s: Station, dlon = 0, dlat = 0) => ({ key: keyOf(s.no), lon: s.lon + dlon, lat: s.lat + dlat });
  const registry = new Map([...positions].filter(([k]) => k !== '1234512345/W'));

  it('real: the registry (generated from this very file) and the master agree; two master stations have no readings', () => {
    expect(driftReport(registry, master)).toEqual({
      unregistered: ['2766929300099', '2825320000100'],
      vanished: [],
      changed: [],
    });
  });

  it('a station the master no longer lists is vanished; a placeholder is never unregistered', () => {
    const [first, ...rest] = master;
    const out = driftReport(registry, rest);
    expect(out.vanished).toEqual([keyOf((first as Station).no)]);
    expect(out.unregistered).not.toContain('1234512345');
    expect(driftReport(new Map(), [master.find((s) => s.no === '1234512345') as Station])).toEqual({
      unregistered: [],
      vanished: [],
      changed: [],
    });
  });

  it('a position that moved by more than 1e-4 degrees is changed (declared and published as lon,lat); less is not', () => {
    const s = master[0] as Station;
    const moved = driftReport(new Map([[keyOf(s.no), at(s, 0, 0.0002)]]), [s]);
    expect(moved.changed).toEqual([
      {
        key: keyOf(s.no),
        field: 'position',
        declared: `${s.lon.toFixed(6)},${(s.lat + 0.0002).toFixed(6)}`,
        published: `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`,
      },
    ]);
    expect(driftReport(new Map([[keyOf(s.no), at(s, 0.00009, -0.00009)]]), [s]).changed).toEqual([]);
    expect(driftReport(new Map([[keyOf(s.no), at(s, 0.00011)]]), [s]).changed).toHaveLength(1);
    // A registered series without a position is never changed.
    expect(driftReport(new Map([[keyOf(s.no), { key: keyOf(s.no), lon: null, lat: null }]]), [s])).toEqual({
      unregistered: [],
      vanished: [],
      changed: [],
    });
  });

  it('lists are sorted and capped at 200; a station twice is listed once', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      no: String(9_000_000_000_000 + 249 - i),
      name: 'x',
      lat: 51,
      lon: 7,
    }));
    const out = driftReport(new Map(), [...many, ...many]);
    expect(out.unregistered).toHaveLength(200);
    expect(out.unregistered).toEqual([...out.unregistered].sort());
    expect(out.unregistered[0]).toBe('9000000000000');
    const reg = new Map(many.map((s) => [keyOf(s.no), { key: keyOf(s.no), lon: 8, lat: 52 }]));
    expect(driftReport(reg, []).vanished).toHaveLength(200);
    expect(driftReport(reg, many).changed).toHaveLength(200);
    expect(driftReport(reg, many).changed.map((c) => c.key)).toEqual(
      driftReport(reg, many)
        .changed.map((c) => c.key)
        .sort(),
    );
  });
});

describe('property and fuzz tests', () => {
  const frag = fc.oneof(
    fc.constantFrom(
      '51.945408',
      '6.900707',
      'Südlohn',
      '9283215500100',
      '928',
      '',
      'NA',
      '29.938',
      '-1',
      '1234',
      ';',
      '"',
    ),
    fc.string({ maxLength: 10 }),
  );
  const shaped = (header: string, width: number) =>
    fc
      .array(
        fc.array(frag, { minLength: width - 1, maxLength: width + 1 }).map((c) => c.join(';')),
        { maxLength: 5 },
      )
      .map((rows) => [header, ...rows].join('\n'));

  it('parseStations and parseHydro throw nothing but SchemaDrift on arbitrary bytes or CSV-shaped text', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array().map((u) => Buffer.from(u)),
          shaped(STATIONS_HEADER, 16).map((t) => Buffer.from(t)),
          shaped(HYDRO_HEADER, 17).map((t) => Buffer.from(t, 'latin1')),
        ),
        (b) => {
          for (const fn of [parseStations, parseHydro]) {
            try {
              fn(b);
            } catch (err) {
              expect(err).toBeInstanceOf(SchemaDrift);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('well-formed rows always parse back to what was written', () => {
    const no = fc.stringMatching(/^\d{6,13}$/);
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            no,
            fc.integer({ min: 0, max: 99_999 }),
            fc.option(fc.integer({ min: -10_000, max: 1_000_000 }), { nil: null }),
          ),
          { maxLength: 20 },
        ),
        (items) => {
          const s = stations(
            stationsText(...items.map(([n, p]) => stationRow({ no: n, lat: `51.${p}`, lon: `6.${p}` }))),
          );
          expect(s.map((x) => [x.no, x.lat, x.lon])).toEqual(
            items.map(([n, p]) => [n, Number(`51.${p}`), Number(`6.${p}`)]),
          );
          const h = hydro(
            hydroText(...items.map(([n, , z]) => hydroRow({ id: n, zero: z === null ? 'NA' : (z / 1000).toFixed(3) }))),
          );
          expect(h.map((x) => [x.id, x.zero])).toEqual(
            items.map(([n, , z]) => [n, z === null ? null : Number((z / 1000).toFixed(3))]),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('normaliseHydro: valid zero rows for registered keys only, every row accounted for, deterministic', () => {
    const ids = ['2829100000100', '2869500000200', '2847500000100', '9999999999991', '9999999999992'];
    const row = fc.record({
      id: fc.constantFrom(...ids),
      name: fc.string({ maxLength: 5 }),
      operator: fc.string({ maxLength: 5 }),
      zero: fc.option(
        fc.integer({ min: -99_999, max: 99_999 }).map((n) => n / 1000),
        { nil: null },
      ),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 30 }), (list) => {
        const out = normaliseHydro(list, { registry: de7 });
        const registered = list.filter((r) => de7.has(keyOf(r.id)));
        for (const z of out.gaugeZeros) {
          GaugeZeroRow.parse(z);
          expect(de7.has(z.series)).toBe(true);
        }
        expect(out.gaugeZeros.length + (out.dropped.zero_missing ?? 0) + (out.dropped.conflict ?? 0)).toBe(
          registered.length,
        );
        // At most one zero per series (two would break the zero's range key).
        expect(new Set(out.gaugeZeros.map((z) => z.series)).size).toBe(out.gaugeZeros.length);
        expect(out.unknown).toBe(new Set(list.filter((r) => !de7.has(keyOf(r.id))).map((r) => r.id)).size);
        expect(normaliseHydro(list, { registry: de7 })).toEqual(out);
      }),
      { numRuns: 300 },
    );
  });

  it('driftReport: sorted, capped, disjoint from the registry, and the same for any order of the master', () => {
    const pool = Array.from({ length: 12 }, (_, i) => String(2_000_000_000_000 + i));
    const station = fc.record({
      no: fc.oneof(fc.constantFrom(...pool), fc.constantFrom('1234512345', '1234567', '123456')),
      name: fc.constant('x'),
      lat: fc.integer({ min: 0, max: 4 }).map((n) => 51 + n * 0.00005),
      lon: fc.integer({ min: 0, max: 4 }).map((n) => 7 + n * 0.00005),
    });
    const declared = fc.array(
      fc.record({
        i: fc.integer({ min: 0, max: 11 }),
        lat: fc.option(
          fc.integer({ min: 0, max: 4 }).map((n) => 51 + n * 0.00005),
          { nil: null },
        ),
        lon: fc.integer({ min: 0, max: 4 }).map((n) => 7 + n * 0.00005),
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(fc.array(station, { maxLength: 15 }), declared, fc.nat(), (list, decl, seed) => {
        const reg = new Map(
          decl.map((d) => [
            keyOf(pool[d.i] as string),
            { key: keyOf(pool[d.i] as string), lon: d.lat === null ? null : d.lon, lat: d.lat },
          ]),
        );
        const out = driftReport(reg, list);
        for (const l of [out.unregistered, out.vanished, out.changed.map((c) => c.key)]) {
          expect(l).toEqual([...l].sort());
          expect(l.length).toBeLessThanOrEqual(200);
        }
        expect(new Set(out.unregistered).size).toBe(out.unregistered.length);
        for (const n of out.unregistered) {
          expect(reg.has(keyOf(n))).toBe(false);
          expect(['1234512345', '1234567', '123456']).not.toContain(n);
        }
        for (const k of [...out.vanished, ...out.changed.map((c) => c.key)]) expect(reg.has(k)).toBe(true);
        const rotated = [...list.slice(seed % (list.length || 1)), ...list.slice(0, seed % (list.length || 1))];
        expect(driftReport(reg, rotated).unregistered).toEqual(out.unregistered);
        expect(driftReport(reg, rotated).vanished).toEqual(out.vanished);
      }),
      { numRuns: 300 },
    );
  });
});
