import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GaugeZeroRow, type Normalised, ObsRow, QC, type Registry, SchemaDrift, type SeriesDecl } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Context,
  normaliseLayer,
  normaliseStations,
  normaliseValues,
  SOURCE,
  TIME,
} from '../../src/adapters/be-3/normalise.ts';
import { parseCatchup, parseLayer, parseTable, parseValues } from '../../src/adapters/be-3/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// BE-3 SPW KiWIS (owner audience, catalogue §2.4): parse + normalise of the hand-made synthetic payloads equal their
// goldens (invariant 9: owner fixtures are synthetic, real structure, generated values), every rule of the adapter
// by name, and the property tests. `registry/stations/be-3.yaml` comes from the owner's export, so the registry here
// is built inline. `UPDATE_GOLDEN=1` rewrites goldens.

const series = (key: string, unit: 'm' | 'm³/s', kind: SeriesDecl['value_kind']): [string, SeriesDecl] => [
  key,
  {
    key,
    quantity: unit === 'm' ? 'H' : 'Q',
    native_unit: unit,
    to_canonical: unit === 'm' ? 100 : 1,
    value_kind: kind,
    native_step_ms: 300_000,
    expected_step_ms: 600_000,
  },
];
const stage = (key: string) => series(key, 'm', 'stage');
const level = (key: string) => series(key, 'm', 'level');
const discharge = (key: string) => series(key, 'm³/s', null);

const registry: Registry = new Map([
  // the level layer
  ...['8622/H', 'L9101/H', 'L8470/H', '8059/H', 'L9102/H_sonde', '9105/H', '9106/H', '9107/H', '9108/H'].map(stage),
  ...['9103/Habs', 'L9104/Habs_sonde'].map(level),
  // the discharge layer
  ...['5921/Q', '5451/QADM', 'L9201/Q', '5452/QADM', '9202/Q', '9203/Q', '9204/Q', '9205/Q', '9207/Q'].map(discharge),
  // the catch-up
  ...['5921/H', '9302/H', '9303/H', '9304/H', '9305/H', '9306/H'].map(stage),
  discharge('9301/Q'),
  // the stations table
  ...['8001/H', '8002/H_sonde', '8003/H', '8004/H', '8004/H_sonde', '8005/H', '8010/H', 'L8470/H'].map(stage),
  level('8007/Habs'),
]);

const LAYER_AT = '2030-01-01T10:12:00Z';
const CATCHUP_AT = '2030-01-01T02:30:00Z';
const ctx = (at: string, extra: Partial<Context> = {}): Context => ({ registry, fetchedAt: Date.parse(at), ...extra });

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('BE-3', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const body = (name: string) => rawFixture('BE-3', name).body;
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const layerOf = (name: string, extra: Partial<Context> = {}, at = LAYER_AT) =>
  normaliseLayer(parseLayer(body(name)), ctx(at, extra));
const valuesOf = (name: string, extra: Partial<Context> = {}) =>
  normaliseValues(parseValues(body(name)), ctx(CATCHUP_AT, extra));
const of = (out: Normalised, key: string) => out.obs.filter((r) => r.series === key);
const stationsOf = (rows: unknown[][], names = ['station_no', 'station_gauge_datum', 'station_gauge_datum_unit']) =>
  normaliseStations(parseTable(bytes([names, ...rows])), { registry });

/** A layer item with the md_returnfields of the spec. */
const layerItem = (over: Record<string, unknown> = {}) => ({
  ts_id: 900500010,
  timestamp: '2030-01-01T10:10:00.000Z',
  req_timestamp: null,
  ts_value: 1.276,
  station_latitude: 50.2,
  station_longitude: 4.8,
  station_no: '8622',
  station_name: 'HASTIERE',
  stationparameter_no: 'H',
  ts_unitsymbol: 'm',
  ...over,
});
/** A values item over the columns Timestamp,Value,Quality Code. */
const valuesItem = (data: unknown[][], over: Record<string, unknown> = {}) => ({
  ts_id: '900500020',
  station_no: '5921',
  stationparameter_no: 'H',
  ts_unitsymbol: 'm',
  rows: String(data.length),
  columns: 'Timestamp,Value,Quality Code',
  data,
  ...over,
});
const layer = (...items: Record<string, unknown>[]) => normaliseLayer(parseLayer(bytes(items)), ctx(LAYER_AT));
const values = (items: Record<string, unknown>[], extra: Partial<Context> = {}) =>
  normaliseValues(parseValues(bytes(items)), ctx(CATCHUP_AT, extra));
const drift = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    expect((err as SchemaDrift).code).toBe(code);
    return;
  }
  throw new Error(`no SchemaDrift ${code}`);
};

describe('golden files (synthetic: owner audience)', () => {
  it('the level layer: same-name stations told apart, four parameters, +02:00, nulls, range, unknown, unit', () => {
    const out = layerOf('be-3-level-layer.synthetic');
    expect(out).toEqual(golden('be-3-level-layer.synthetic', out));
    expect(out.obs).toHaveLength(8);
    expect(out.dropped).toEqual({ gap: 2, unit_mismatch: 1 });
    expect(out.unknown).toBe(1);
    expect(out.unitMismatch).toEqual(['9108/H']);
  });

  it('the discharge layer: Q and QADM, m3/s, the QADM at -1, the future, a unit, two ts_ids under one key', () => {
    const out = layerOf('be-3-discharge-layer.synthetic');
    expect(out).toEqual(golden('be-3-discharge-layer.synthetic', out));
    expect(out.dropped).toEqual({ sentinel: 1, future: 1, unit_mismatch: 1 });
    expect(out.unitMismatch).toEqual(['9203/Q']);
  });

  it('the catch-up values: every quality code, duplicates, the trailing null/-1, columns by name', () => {
    const out = valuesOf('be-3-catchup-quality.synthetic');
    expect(out).toEqual(golden('be-3-catchup-quality.synthetic', out));
    expect(out.unknown).toBe(1);
    expect(out.unitMismatch).toEqual(['9306/H']);
  });

  it('the stations table: the gauge zero of every registered stage series', () => {
    const out = normaliseStations(parseTable(body('be-3-stations.synthetic')), { registry });
    expect(out).toEqual(golden('be-3-stations.synthetic', out));
    expect(out.obs).toEqual([]);
  });

  it('an empty layer has no rows and no drops', () => {
    const out = layerOf('be-3-layer-empty.synthetic');
    expect(out).toEqual(golden('be-3-layer-empty.synthetic', out));
    expect(out).toMatchObject({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });

  it('a TooManyResults answer is drift in every values parser, never a partial result', () => {
    drift(() => parseValues(body('be-3-too-many-results.synthetic')), 'kiwis_too_many_results');
    drift(() => parseCatchup(body('be-3-too-many-results.synthetic')), 'kiwis_too_many_results');
    drift(() => parseLayer(body('be-3-too-many-results.synthetic')), 'kiwis_too_many_results');
    drift(() => parseTable(body('be-3-too-many-results.synthetic')), 'kiwis_too_many_results');
  });

  it('the capture fixtures parse: the metadata list, the catch-up list and its values', () => {
    expect(parseTable(body('be-3-meta.synthetic')).length).toBeGreaterThan(0);
    expect(parseCatchup(body('be-3-catchup.synthetic')).kind).toBe('list');
    expect(parseCatchup(body('be-3-catchup-values.synthetic')).kind).toBe('values');
    expect(parseCatchup(body('be-3-catchup-quality.synthetic')).kind).toBe('values');
  });
});

describe('rules (synthetic)', () => {
  it('declares its source and time convention', () => {
    expect([SOURCE, TIME]).toEqual(['BE-3', { kind: 'iso-offset' }]);
  });

  it('HASTIERE/Hastière and both Dinant resolve by station_no, never by name', () => {
    const out = layerOf('be-3-level-layer.synthetic');
    expect(out.obs.filter((r) => ['8622/H', 'L9101/H', 'L8470/H', '8059/H'].includes(r.series))).toEqual([
      { series: '8059/H', ts: '2030-01-01T10:05:00.000Z', value: 190.5, qc: QC.RAW },
      { series: '8622/H', ts: '2030-01-01T10:10:00.000Z', value: 127.6, qc: QC.RAW },
      { series: 'L8470/H', ts: '2030-01-01T10:10:00.000Z', value: 84.2, qc: QC.RAW },
      { series: 'L9101/H', ts: '2030-01-01T10:05:00.000Z', value: 210.4, qc: QC.RAW },
    ]);
    // The names swapped between the numbers change nothing; a registered name under an unregistered number is unknown.
    const swapped = layer(
      layerItem({ station_name: 'DINANT' }),
      layerItem({ ts_id: 900500011, station_no: 'L8470', station_name: 'HASTIERE', ts_value: 0.5 }),
      layerItem({ ts_id: 900500012, station_no: '7777', station_name: 'HASTIERE' }),
    );
    expect(swapped.obs.map((r) => r.series)).toEqual(['8622/H', 'L8470/H']);
    expect(swapped.unknown).toBe(1);
  });

  it('timezone=UTC stamps parse to UTC and a +02:00 stamp keeps its own offset', () => {
    const at = (stamp: string) => layer(layerItem({ timestamp: stamp })).obs[0]?.ts;
    expect(at('2030-01-01T10:05:00.000Z')).toBe('2030-01-01T10:05:00.000Z');
    expect(at('2030-01-01T10:05:00.000+00:00')).toBe('2030-01-01T10:05:00.000Z');
    expect(at('2030-01-01T12:05:00.000+02:00')).toBe('2030-01-01T10:05:00.000Z');
    expect(at('2030-01-01T05:05:00-05:00')).toBe('2030-01-01T10:05:00.000Z');
    // A stamp without an offset is never read as anything: the whole payload is drift.
    drift(() => at('2030-01-01T10:05:00'), 'time_bad_format');
    drift(() => at('2030-01-01'), 'time_bad_format');
    drift(() => values([valuesItem([[1893492300000, 1, 200]])]), 'time_bad_format');
  });

  it('H m → cm (stage), Habs m DNG → cm (level), Q m³/s unchanged', () => {
    const out = layerOf('be-3-level-layer.synthetic');
    expect(of(out, '8622/H')[0]?.value).toBe(127.6);
    expect(of(out, 'L9102/H_sonde')[0]?.value).toBe(31);
    expect(of(out, '9103/Habs')[0]?.value).toBe(7851.2);
    expect(of(out, 'L9104/Habs_sonde')[0]?.value).toBe(5998);
    const q = layerOf('be-3-discharge-layer.synthetic');
    expect(of(q, '5921/Q')[0]?.value).toBe(12.5);
    expect(of(q, '5451/QADM')[0]?.value).toBe(33.2);
    expect(of(q, '9205/Q')[0]?.value).toBe(0);
    expect(of(q, '9207/Q')[0]).toMatchObject({ value: -3.5, qc: QC.RAW });
  });

  it('a layer value is raw (live data is quality 200); an implausible stage keeps its value with the range bit', () => {
    const out = layerOf('be-3-level-layer.synthetic');
    expect(of(out, '8622/H')[0]?.qc).toBe(QC.RAW);
    expect(of(out, '9105/H')[0]).toMatchObject({ value: 6000, qc: QC.RAW | QC.RANGE });
  });

  it('ts_unitsymbol must equal the registry unit (m3/s and cumec mean m³/s), else the series is withheld and listed', () => {
    const out = layerOf('be-3-discharge-layer.synthetic');
    expect(of(out, 'L9201/Q')).toHaveLength(1); // `m3/s`
    expect(of(out, '9203/Q')).toEqual([]); // `l/s`
    const cumec = layer(layerItem({ station_no: '5921', stationparameter_no: 'Q', ts_unitsymbol: 'cumec' }));
    expect(cumec.obs).toHaveLength(1);
    // Level in cm where the registry says m: every value of the series is withheld, counted by value.
    const wrong = values([
      valuesItem(
        [
          ['2030-01-01T00:00:00.000Z', 55, 200],
          ['2030-01-01T01:00:00.000Z', 56, 200],
        ],
        { station_no: '9306', ts_unitsymbol: 'cm' },
      ),
    ]);
    expect(wrong.obs).toEqual([]);
    expect(wrong.dropped).toEqual({ unit_mismatch: 2 });
    // The list is sorted, whatever the payload's order.
    const two = layer(
      layerItem({ ts_id: 1, station_no: '9108', ts_unitsymbol: 'cm' }),
      layerItem({ ts_id: 2, station_no: '9106', ts_unitsymbol: 'ft' }),
      layerItem({ ts_id: 3, station_no: '8622' }),
    );
    expect(two.unitMismatch).toEqual(['9106/H', '9108/H']);
    expect(two.obs.map((r) => r.series)).toEqual(['8622/H']);
  });

  it('ctx.unitMismatch judges an item that states no unit; one that states its unit is judged by it alone', () => {
    const rows = [['2030-01-01T00:00:00.000Z', 1, 200]];
    const none = valuesItem(rows, { station_no: '9304', ts_unitsymbol: undefined });
    expect(values([none]).obs).toHaveLength(1);
    const listed = values([none], { unitMismatch: new Set(['9304/H']) });
    expect(listed.obs).toEqual([]);
    expect(listed.dropped).toEqual({ unit_mismatch: 1 });
    // The same list never withholds an item whose own unit is right (a stale list from the last unit change).
    const stated = values([valuesItem(rows, { station_no: '9304' })], { unitMismatch: new Set(['9304/H']) });
    expect(stated.obs).toHaveLength(1);
    expect(stated.unitMismatch).toEqual([]);
  });

  it('9999.0 datum → unknown, no conversion: no zero is stored and nothing is guessed', () => {
    const out = normaliseStations(parseTable(body('be-3-stations.synthetic')), { registry });
    expect(out.gaugeZeros.some((z) => z.series === 'L8470/H')).toBe(false);
    expect(out.dropped.zero_unknown).toBe(1);
    expect(out.gaugeZeros.some((z) => z.value_m === 9999)).toBe(false);
    for (const datum of ['9999', '9999.0', '9999,00']) {
      expect(stationsOf([['8001', datum, 'DNG']])).toMatchObject({ gaugeZeros: [], dropped: { zero_unknown: 1 } });
    }
    // Unknown wins whatever the unit says: there is no datum to put a unit on.
    expect(stationsOf([['8001', '9999.0', '']])).toMatchObject({ gaugeZeros: [], dropped: { zero_unknown: 1 } });
  });

  it('a gauge zero is 109.9 m DNG with its start of validity, for every registered stage series of the station', () => {
    const out = normaliseStations(parseTable(body('be-3-stations.synthetic')), { registry });
    expect(out.gaugeZeros.find((z) => z.series === '5921/H')).toEqual({
      series: '5921/H',
      value_m: 109.9,
      datum: 'DNG',
      valid_from: '2018-12-31T23:00:00.000Z', // 2019-01-01T00:00+01:00
    });
    // Both H and H_sonde of 8004 are stage series; a decimal comma is read; a date starts at local midnight (+01:00).
    expect(out.gaugeZeros.filter((z) => z.series.startsWith('8004/'))).toEqual([
      { series: '8004/H', value_m: 88.25, datum: 'DNG', valid_from: '2029-06-14T23:00:00.000Z' },
      { series: '8004/H_sonde', value_m: 88.25, datum: 'DNG', valid_from: '2029-06-14T23:00:00.000Z' },
    ]);
    // An unreadable start of validity is none, never a guess.
    expect(out.gaugeZeros.find((z) => z.series === '8010/H')).toEqual({
      series: '8010/H',
      value_m: -1.5,
      datum: 'DNG',
      valid_from: null,
    });
    for (const z of out.gaugeZeros) GaugeZeroRow.parse(z);
    // Habs is absolute (no zero), and a station of no registered series is ignored.
    expect(out.gaugeZeros.some((z) => z.series.startsWith('8007/') || z.series.startsWith('9998/'))).toBe(false);
    expect(out.unknown).toBe(0);
  });

  it('a gauge zero is withheld when its unit is not DNG, is empty, unreadable or out of −10…1000 m', () => {
    const out = normaliseStations(parseTable(body('be-3-stations.synthetic')), { registry });
    expect(out.dropped).toMatchObject({ zero_missing: 1, zero_unknown: 1, conflict: 1, bad_zero: 1 });
    for (const [datum, unit] of [
      ['12.3.4', 'DNG'],
      ['abc', 'DNG'],
      ['1e3', 'DNG'],
      ['12345.6', 'DNG'],
      ['1000.5', 'DNG'],
      ['-10.5', 'DNG'],
    ] as const)
      expect(stationsOf([['8001', datum, unit]])).toMatchObject({ gaugeZeros: [], dropped: { bad_zero: 1 } });
    expect(stationsOf([['8001', '27.5', 'mNGF']]).dropped).toEqual({ unknown_zero_unit: 1 });
    expect(stationsOf([['8001', '27.5', 'dng']]).dropped).toEqual({ unknown_zero_unit: 1 });
    // SPW's "no datum system" (measured 2026-10-02: 63 stations with `---`, 166 with nothing): counted, not withheld.
    expect(stationsOf([['8001', '27.5', null]]).dropped).toEqual({ zero_datum_unknown: 1 });
    expect(stationsOf([['8001', '27.5', '---']]).dropped).toEqual({ zero_datum_unknown: 1 });
    expect(stationsOf([['8001', '27.5', '']]).dropped).toEqual({ zero_datum_unknown: 1 });
    // A zero of exactly 0.0 or 9999.0 is SPW's "unknown" (no Walloon gauge lies at sea level).
    expect(stationsOf([['8001', '0.0', 'DNG']]).dropped).toEqual({ zero_unknown: 1 });
    expect(stationsOf([['8001', '9999.0', 'DNG']]).dropped).toEqual({ zero_unknown: 1 });
    expect(stationsOf([['8001', '', 'DNG']]).dropped).toEqual({ zero_missing: 1 });
    expect(stationsOf([['8001', null, 'DNG']]).dropped).toEqual({ zero_missing: 1 });
    // The limits themselves are valid; a number cell reads as its text.
    expect(stationsOf([['8001', '1000', 'DNG']]).gaugeZeros[0]?.value_m).toBe(1000);
    expect(stationsOf([['8001', '-10.0', 'DNG']]).gaugeZeros[0]?.value_m).toBe(-10);
    expect(stationsOf([['8001', 64.2, 'DNG']]).gaugeZeros[0]?.value_m).toBe(64.2);
  });

  it('a station listed twice gives no zero (conflict); a station without a registered stage series is not judged', () => {
    const twice = stationsOf([
      ['8001', '10.0', 'DNG'],
      ['8001', '10.0', 'DNG'],
      ['9998', '10.0', 'DNG'],
      ['9998', '11.0', 'DNG'],
      ['8007', '10.0', 'DNG'],
      ['8007', '11.0', 'DNG'],
    ]);
    expect(twice.gaugeZeros).toEqual([]);
    expect(twice.dropped).toEqual({ conflict: 1 });
  });

  it('a station table without its datum columns is drift; one with no rows is nothing', () => {
    drift(() => stationsOf([['8001', 'x']], ['station_no', 'station_gauge_datum']), 'kiwis_columns');
    drift(
      () => stationsOf([['8001', 'x', 'DNG']], ['station_name', 'station_gauge_datum', 'station_gauge_datum_unit']),
      'kiwis_columns',
    );
    expect(stationsOf([])).toMatchObject({ gaugeZeros: [], dropped: {}, unknown: 0 });
    // A row without a number names no station.
    expect(stationsOf([[null, '1.0', 'DNG']]).gaugeZeros).toEqual([]);
  });

  it('the trailing QADM null/-1 is dropped, and a QADM value one step ahead is the future', () => {
    const out = valuesOf('be-3-catchup-quality.synthetic');
    expect(of(out, '5451/QADM').map((r) => r.ts)).toEqual([
      '2030-01-01T00:00:00.000Z',
      '2030-01-01T01:00:00.000Z',
      '2030-01-01T02:00:00.000Z',
    ]);
    // Dropped by its -1 code (`sentinel`), before any time is read.
    const trailing = values([
      valuesItem(
        [
          ['2030-01-01T02:00:00.000Z', 2.1, 200],
          ['2030-01-01T03:00:00.000Z', null, -1],
        ],
        { station_no: '5451', stationparameter_no: 'QADM', ts_unitsymbol: 'm³/s' },
      ),
    ]);
    expect(trailing.obs).toHaveLength(1);
    expect(trailing.dropped).toEqual({ sentinel: 1 });
    // A value (not the placeholder) more than 15 minutes ahead is `future`; 15 minutes exactly is kept.
    const ahead = values([
      valuesItem(
        [
          ['2030-01-01T02:45:00.000Z', 1, 200],
          ['2030-01-01T02:45:00.001Z', 2, 200],
        ],
        { station_no: '5451', stationparameter_no: 'QADM', ts_unitsymbol: 'm³/s' },
      ),
    ]);
    expect(ahead.obs.map((r) => r.value)).toEqual([1]);
    expect(ahead.dropped).toEqual({ future: 1 });
  });

  it('quality 200 → raw, < 200 → validated, 205/210 → suspect, 253 dropped, -1 dropped, any other code withheld', () => {
    const out = valuesOf('be-3-catchup-quality.synthetic');
    expect(of(out, '5921/H').map((r) => [r.ts.slice(11, 16), r.value, r.qc])).toEqual([
      ['00:00', 18.8, QC.RAW],
      ['00:05', 19, QC.VALIDATED], // 40
      ['00:10', 19.2, QC.RAW | QC.PROVIDER_SUSPECT], // 205
      ['00:15', 19.5, QC.RAW | QC.PROVIDER_SUSPECT], // 210
      // 00:20 is 253 (phantom), 00:25 is -1 (sentinel), 00:30 is 999 (unknown_quality)
      ['00:35', 23, QC.RAW], // 02:35+02:00
      ['00:40', 24, QC.RAW], // twice, the same value
      // 00:45 states 0.25 and 0.26 (conflict), 00:50 is null (gap)
      ['00:55', 27, QC.VALIDATED], // 0
      ['01:00', 28, QC.VALIDATED], // 160
    ]);
    const dropped = (code: number) => values([valuesItem([['2030-01-01T00:00:00.000Z', 1, code]])]).dropped;
    expect(dropped(253)).toEqual({ phantom: 1 });
    expect(dropped(-1)).toEqual({ sentinel: 1 });
    for (const code of [201, 204, 206, 209, 211, 252, 254, 255, 999, -2, 40.5, 1e9])
      expect([code, dropped(code)]).toEqual([code, { unknown_quality: 1 }]);
    for (const code of [0, 40, 80, 120, 160, 165, 199])
      expect([code, values([valuesItem([['2030-01-01T00:00:00.000Z', 1, code]])]).obs[0]?.qc]).toEqual([
        code,
        QC.VALIDATED,
      ]);
    // A code that is not a number, or is missing from a row that has the column, says nothing: withheld.
    expect(dropped('200' as unknown as number)).toEqual({ unknown_quality: 1 });
    expect(dropped(null as unknown as number)).toEqual({ unknown_quality: 1 });
    // Unknown quality is retained for a replay, never counted as a gap: a null value with an unknown code is a gap.
    expect(values([valuesItem([['2030-01-01T00:00:00.000Z', null, 999]])]).dropped).toEqual({ gap: 1 });
  });

  it('columns are found by name: reordered columns and a missing Quality Code (raw) both load', () => {
    const out = valuesOf('be-3-catchup-quality.synthetic');
    expect(of(out, '9302/H').map((r) => [r.ts.slice(11, 16), r.value, r.qc])).toEqual([
      ['00:00', 150, QC.RAW],
      ['01:00', 160, QC.VALIDATED],
    ]);
    expect(of(out, '9303/H').map((r) => [r.value, r.qc])).toEqual([
      [70, QC.RAW],
      [80, QC.RAW],
    ]);
    // Absolute Value is never mistaken for Value.
    const abs = values([
      valuesItem([['2030-01-01T00:00:00.000Z', 109.1, 1.1, 200]], {
        columns: 'Timestamp,Absolute Value,Value,Quality Code',
      }),
    ]);
    expect(abs.obs.map((r) => r.value)).toEqual([110]);
    drift(
      () => values([valuesItem([['2030-01-01T00:00:00.000Z', 1]], { columns: 'Timestamp,Absolute Value' })]),
      'kiwis_columns',
    );
    drift(
      () => values([valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]], { columns: 'Timestamp,,Value' })]),
      'kiwis_columns',
    );
    drift(
      () => values([valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]], { columns: 'Timestamp,Value,Value' })]),
      'kiwis_columns',
    );
    // A row narrower or wider than its columns is drift, never read by position.
    drift(() => values([valuesItem([['2030-01-01T00:00:00.000Z', 1]])]), 'kiwis_row_width');
    drift(() => values([valuesItem([['2030-01-01T00:00:00.000Z', 1, 200, 5]])]), 'kiwis_row_width');
  });

  it('gaps, the -1 discharge placeholder, the future and a too old value are dropped by name', () => {
    const out = valuesOf('be-3-catchup-quality.synthetic');
    // 9301/Q: 2029-08-01 is 153 days before the fetch (too_old), -1 at 00:00 (sentinel), -0.5 kept, 03:30 > 02:45 (future).
    expect(of(out, '9301/Q')).toEqual([{ series: '9301/Q', ts: '2030-01-01T01:00:00.000Z', value: -0.5, qc: QC.RAW }]);
    expect(out.dropped).toMatchObject({ too_old: 1, future: 1, gap: 1, phantom: 1, unknown_quality: 1 });
    // A stage of exactly -1 m is a reading (negative stages are valid); only a discharge of -1 is the placeholder.
    const stage = values([valuesItem([['2030-01-01T00:00:00.000Z', -1, 200]])]);
    expect(stage.obs.map((r) => r.value)).toEqual([-100]);
    // 120 days before the fetch exactly is kept, one millisecond more is too old.
    const edge = values([
      valuesItem([
        ['2029-09-03T02:30:00.000Z', 1, 200],
        ['2029-09-03T02:29:59.999Z', 2, 200],
      ]),
    ]);
    expect(edge.obs.map((r) => r.value)).toEqual([100]);
    expect(edge.dropped).toEqual({ too_old: 1 });
    // A null timestamp is a gap too.
    expect(values([valuesItem([[null, 1, 200]])]).dropped).toEqual({ gap: 1 });
  });

  it('a (series, instant) stated twice: the same value once, different values both withheld', () => {
    const out = valuesOf('be-3-catchup-quality.synthetic');
    expect(out.dropped).toMatchObject({ duplicate: 1, conflict: 2 });
    expect(of(out, '5921/H').some((r) => r.ts === '2030-01-01T00:45:00.000Z')).toBe(false);
    const same = values([
      valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]]),
      valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]]),
    ]);
    expect([same.obs.length, same.dropped]).toEqual([1, { duplicate: 1 }]);
    // The same value with another quality is another statement.
    const quality = values([
      valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]]),
      valuesItem([['2030-01-01T00:00:00.000Z', 1, 40]]),
    ]);
    expect([quality.obs.length, quality.dropped]).toEqual([0, { conflict: 2 }]);
    // A third statement of a withheld instant is withheld too, and counted.
    const three = values([
      valuesItem([
        ['2030-01-01T00:00:00.000Z', 1, 200],
        ['2030-01-01T00:00:00.000Z', 2, 200],
        ['2030-01-01T00:00:00.000Z', 1, 200],
      ]),
    ]);
    expect([three.obs.length, three.dropped]).toEqual([0, { conflict: 3 }]);
  });

  it('two ts_ids under one key (L5860 Theux: Comp and Comp-Alarmes) meet per instant: the same value once, two withheld', () => {
    // The fixture's two 9204/Q series state different instants: both rows are the station's discharge.
    const out = layerOf('be-3-discharge-layer.synthetic');
    expect(of(out, '9204/Q').map((r) => r.ts)).toEqual(['2030-01-01T10:05:00.000Z', '2030-01-01T10:10:00.000Z']);
    expect(out.dropped.conflict).toBeUndefined();
    const rows = [
      ['2030-01-01T00:00:00.000Z', 1, 200],
      ['2030-01-01T01:00:00.000Z', 2, 200],
    ];
    // A copy that agrees is kept once.
    const agree = values([valuesItem(rows), valuesItem(rows.slice(0, 1), { ts_id: '900500021' })]);
    expect([agree.obs.length, agree.dropped]).toEqual([2, { duplicate: 1 }]);
    // A copy that disagrees at an instant withholds both values of that instant, and only those.
    const disagree = values([
      valuesItem(rows),
      valuesItem([['2030-01-01T00:00:00.000Z', 5, 200]], { ts_id: '900500021' }),
    ]);
    expect([disagree.obs.map((r) => r.ts), disagree.dropped]).toEqual([['2030-01-01T01:00:00.000Z'], { conflict: 2 }]);
    const same = values([valuesItem(rows), valuesItem(rows)]);
    expect([same.obs.length, same.dropped]).toEqual([2, { duplicate: 2 }]);
    // ts_id as a number (layer) and as a string (values) is the same series.
    const layerThenValues = [
      ...parseLayer(bytes([layerItem({ ts_id: 900500020, station_no: '5921' })])),
      ...parseValues(bytes([valuesItem([])])),
    ];
    expect(new Set(layerThenValues.map((i) => i.ts_id)).size).toBe(1);
  });

  it('a key the registry does not know counts once per key, with all its items', () => {
    const out = values([
      valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]], { station_no: '9999' }),
      valuesItem([['2030-01-01T01:00:00.000Z', 1, 200]], { station_no: '9999', ts_id: '900500099' }),
      valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]], { station_no: '9998' }),
    ]);
    expect(out).toMatchObject({ obs: [], unknown: 2, dropped: {} });
    // A key built from the name of a station is not the number's: 'HASTIERE/H' is nothing.
    expect(layer(layerItem({ station_no: 'HASTIERE' })).unknown).toBe(1);
  });

  it('an item with no rows is nothing, and a payload is the same however its items are ordered', () => {
    expect(values([valuesItem([])])).toMatchObject({ obs: [], dropped: {}, unknown: 0 });
    const a = layerItem({ ts_id: 1, station_no: '8622' });
    const b = layerItem({ ts_id: 2, station_no: 'L8470', timestamp: '2030-01-01T10:00:00.000Z' });
    expect(layer(a, b)).toEqual(layer(b, a));
  });

  it('values that are not numbers or not in range are drift: the payload is quarantined, never partly stored', () => {
    drift(() => values([valuesItem([['2030-01-01T00:00:00.000Z', '1.5', 200]])]), 'bad_value');
    drift(() => values([valuesItem([['2030-01-01T00:00:00.000Z', 1e300, 200]])]), 'value_out_of_range');
    drift(
      () => values([valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]], { station_no: undefined })]),
      'kiwis_no_metadata',
    );
    drift(
      () => values([valuesItem([['2030-01-01T00:00:00.000Z', 1, 200]], { stationparameter_no: undefined })]),
      'kiwis_no_metadata',
    );
  });

  it('parseCatchup tells the list from the values by shape', () => {
    expect(parseCatchup(Buffer.from(' \n[ ["ts_id","station_no"],["1","a"]]')).kind).toBe('list');
    expect(parseCatchup(Buffer.from('[["ts_id"]]'))).toEqual({ kind: 'list', rows: [] });
    expect(parseCatchup(Buffer.from('[]'))).toEqual({ kind: 'values', items: [] });
    expect(parseCatchup(bytes([valuesItem([])])).kind).toBe('values');
    drift(() => parseCatchup(Buffer.from('')), 'not_json');
    drift(() => parseCatchup(Buffer.from('{"code":"InvalidParameterValue"}')), 'kiwis_error');
    drift(() => parseCatchup(Buffer.from('{"a":1}')), 'invalid_type');
    drift(() => parseCatchup(Buffer.from('[1]')), 'invalid_type');
    drift(() => parseCatchup(Buffer.from('[["a","a"]]')), 'kiwis_header');
    drift(() => parseCatchup(Buffer.from('[["a"],["1","2"]]')), 'kiwis_row_width');
    drift(() => parseCatchup(Buffer.from('[{"ts_id":"x","columns":"a","data":[]}]')), 'invalid_format');
  });
});

describe('the archive-derived fixtures (fixtures:synth: real structure, generated values)', () => {
  // Real structure and the identifiers the registry publishes; every other value is generated and every timestamp is
  // shifted years ahead (one constant per document), so the fetch time is the payload's newest instant + 10 minutes.
  const real = registryOf('BE-3');
  const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
  const fetchedAt = (name: string) =>
    Math.max(...(body(name).toString('utf8').match(STAMP) ?? []).map((s) => Date.parse(s))) + 600_000;
  const realLayer = (name: string) =>
    normaliseLayer(parseLayer(body(name)), { registry: real, fetchedAt: fetchedAt(name) });

  // The generator (scripts/synthesize-fixture.ts) keeps a number's magnitude, so a 2-digit latitude came out as 14 to 97.7
  // and the strict `station_latitude` range (-90…90) of the shared KiWIS parser refuses the three layers as
  // `too_big at <i>.station_latitude`. Not an adapter gap: regenerate them with coordinates kept in range, then drop
  // this list (checked with the latitudes set to 50.5 in memory: 39 rows each, unknown 0).
  const LAYERS = [
    'be-3-values-levels.synthetic',
    'be-3-values-levels-first.synthetic',
    'be-3-values-discharge.synthetic',
  ];
  const BLOCKED = new Set<string>();

  for (const name of LAYERS) {
    if (BLOCKED.has(name)) {
      it.todo(`${name}: a layer of the real registry (blocked: generated station_latitude out of range)`);
      continue;
    }
    it(`${name}: a layer of the real registry has no unknown series and some rows`, () => {
      const items = parseLayer(body(name));
      expect(items.length).toBeGreaterThan(0);
      const out = realLayer(name);
      expect(out).toEqual(golden(name, out));
      expect(out.unknown).toBe(0);
      expect(out.obs.length).toBeGreaterThan(0);
      expect(out.gaugeZeros).toEqual([]);
      for (const r of out.obs) {
        ObsRow.parse(r);
        expect(real.has(r.series)).toBe(true);
      }
      // Every item is a row or a counted drop (a series of two ts_ids meets per instant, so only the sum is exact).
      const dropped = Object.values(out.dropped).reduce((a, b) => a + b, 0);
      expect(out.obs.length + dropped).toBeLessThanOrEqual(items.length);
    });
  }

  it('be-3-meta-stations.synthetic: a zero in DNG only for a registered stage series', () => {
    const name = 'be-3-meta-stations.synthetic';
    const out = normaliseStations(parseTable(body(name)), { registry: real });
    expect(out).toEqual(golden(name, out));
    expect(out.obs).toEqual([]);
    expect(out.gaugeZeros.length).toBeGreaterThan(0);
    for (const z of out.gaugeZeros) {
      GaugeZeroRow.parse(z);
      expect(z.datum).toBe('DNG');
      expect(real.get(z.series)?.value_kind).toBe('stage');
    }
    const keys = out.gaugeZeros.map((z) => z.series);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('be-3-meta-timeseries-discharge.synthetic: records with ts_id, station_no and stationparameter_no', () => {
    const name = 'be-3-meta-timeseries-discharge.synthetic';
    const records = parseTable(body(name));
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(String(r.ts_id)).toMatch(/^\d{1,12}$/);
      expect(String(r.station_no)).not.toBe('');
      expect(String(r.stationparameter_no)).not.toBe('');
    }
    const keys = records.map((r) => `${r.station_no}/${r.stationparameter_no}`);
    const listed = {
      records: records.length,
      distinct_keys: new Set(keys).size,
      registered: keys.filter((k) => real.has(k)).length,
      parameters: [...new Set(records.map((r) => String(r.stationparameter_no)))].sort(),
    };
    expect(listed).toEqual(golden(name, listed));
    expect(listed.registered).toBeGreaterThan(0);
  });
});

describe('property and fuzz', () => {
  const FETCHED = Date.parse(LAYER_AT);
  const keys = [...registry.keys(), '9999/H', '9998/Q'];
  const item = fc.record({
    id: fc.integer({ min: 1, max: 4 }),
    key: fc.constantFrom(...keys),
    // 5-minute steps from 130 days back to 15 minutes ahead; few distinct instants, so duplicates and conflicts occur.
    step: fc.oneof(fc.integer({ min: -6, max: 3 }), fc.integer({ min: -37_440, max: 3 })),
    value: fc.oneof(
      fc.constant(null),
      fc.constantFrom(-1, 0, 1.5, 60),
      fc.integer({ min: -5, max: 5 }),
      fc.double({ min: -300, max: 300, noNaN: true, noDefaultInfinity: true }),
    ),
    unit: fc.constantFrom('m', 'm', 'm³/s', 'm³/s', 'm3/s', 'cumec', 'cm', 'l/s'),
    dead: fc.boolean(),
  });

  it('a generated layer gives valid, unique, ordered rows, and every value is kept or counted once', () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 40 }), (items) => {
        const bodyOf = items.map((i) => {
          const [no, p] = i.key.split('/') as [string, string];
          return layerItem({
            ts_id: i.id,
            station_no: no,
            stationparameter_no: p,
            ts_unitsymbol: i.unit,
            ts_value: i.value,
            timestamp: i.dead ? null : new Date(FETCHED + i.step * 300_000).toISOString(),
          });
        });
        const out = normaliseLayer(parseLayer(bytes(bodyOf)), ctx(LAYER_AT));
        for (const r of out.obs) ObsRow.parse(r);
        const order = out.obs.map((r) => `${r.series}|${r.ts}`);
        expect(new Set(order).size).toBe(order.length);
        // Ordered by series, then by instant.
        out.obs.forEach((r, i) => {
          const before = out.obs[i - 1];
          if (before) expect(before.series < r.series || (before.series === r.series && before.ts < r.ts)).toBe(true);
        });
        for (const r of out.obs) {
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(FETCHED + 900_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(FETCHED - 120 * 86_400_000);
        }
        const dropped = Object.values(out.dropped).reduce((a, b) => a + b, 0);
        const unknown = bodyOf.filter((i) => !registry.has(`${i.station_no}/${i.stationparameter_no}`)).length;
        expect(out.obs.length + dropped + unknown).toBe(bodyOf.length);
        expect(out.unitMismatch).toEqual([...(out.unitMismatch ?? [])].sort());
      }),
      { numRuns: 300 },
    );
  });

  const cell = fc.oneof(
    fc.constant(null),
    fc.integer({ min: -300, max: 300 }),
    fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
    fc.constantFrom('2030-01-01T00:00:00Z', '2030-01-01T00:05:00.000+02:00', '2030-01-01T02:00:00.000Z', 'x', ''),
  );
  const valuesDoc = fc.array(
    fc.record({
      ts_id: fc.constantFrom('1', '2', '3'),
      station_no: fc.constantFrom('5921', '9301', '9999'),
      stationparameter_no: fc.constantFrom('H', 'Q'),
      ts_unitsymbol: fc.constantFrom('m', 'm³/s', 'x'),
      columns: fc.constantFrom(
        'Timestamp,Value,Quality Code',
        'Timestamp,Value',
        'Value,Timestamp',
        'Timestamp,Timestamp',
        'Timestamp,,Value',
        'Quality Code',
      ),
      data: fc.array(fc.array(cell, { maxLength: 4 }), { maxLength: 6 }),
    }),
    { maxLength: 4 },
  );

  it('a generated values answer is valid or SchemaDrift, never anything else', () => {
    fc.assert(
      fc.property(valuesDoc, (doc) => {
        try {
          const out = normaliseValues(parseValues(bytes(doc)), ctx(CATCHUP_AT));
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a generated stations table never stores a zero out of range, unknown or not in DNG', () => {
    const datum = fc.oneof(
      fc.constantFrom(
        '109.9',
        '9999.0',
        '9999',
        '-3',
        '1e5',
        '',
        'abc',
        '12,5',
        '1000',
        '1001',
        '-10',
        '-11',
        null,
        50,
        9999,
      ),
      fc.integer({ min: -2000, max: 20_000 }).map((n) => String(n / 10)),
    );
    const row = fc.tuple(
      fc.constantFrom('8001', '8003', '8004', '9998', null),
      datum,
      fc.constantFrom('DNG', 'mNGF', '', null),
      fc.constantFrom('2019-01-01T00:00:00.000+01:00', '2029-06-15', 'x', '', null, '2019-13-45'),
    );
    fc.assert(
      fc.property(fc.array(row, { maxLength: 8 }), (rows) => {
        const names = ['station_no', 'station_gauge_datum', 'station_gauge_datum_unit', 'station_gauge_datum_from'];
        const out = normaliseStations(parseTable(bytes([names, ...rows])), { registry });
        for (const z of out.gaugeZeros) {
          GaugeZeroRow.parse(z);
          expect(z.datum).toBe('DNG');
          expect(z.value_m).toBeGreaterThanOrEqual(-10);
          expect(z.value_m).toBeLessThanOrEqual(1000);
        }
        const keys = out.gaugeZeros.map((z) => z.series);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 300 },
    );
  });

  it('arbitrary bytes into any parser throw only SchemaDrift', () => {
    const parsers = [parseLayer, parseValues, parseTable, parseCatchup];
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array().map((u) => Buffer.from(u)),
          fc.jsonValue().map((v) => bytes(v)),
          fc.jsonValue().map((v) => bytes([v])),
          fc.array(fc.jsonValue(), { maxLength: 5 }).map((a) => bytes([a, a])),
        ),
        (b) => {
          for (const parse of parsers) {
            try {
              parse(b);
            } catch (err) {
              expect(err).toBeInstanceOf(SchemaDrift);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
