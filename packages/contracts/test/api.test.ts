import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  API_ERROR_CODES,
  ApiError,
  ApiStation,
  Attribution,
  BASIS_KINDS,
  BUCKET_MS,
  floorBucket,
  INSTANT_MAX_LENGTH,
  INSTANT_RE,
  instantMs,
  MAX_POINTS,
  Meta,
  RESOLUTIONS,
  SERIES_ID_MAX,
  SERIES_ID_RE,
  Series,
  SeriesMeta,
  SeriesPath,
  SeriesQuery,
  Snapshot,
  SnapshotQuery,
  SPAN_CAP_MS,
  STATES,
  Stations,
} from '../src/api.ts';
import { CANARY_RENDERINGS } from '../src/canaries.ts';
import { HealthUnavailable } from '../src/health.ts';
import { openApiDocument } from '../src/openapi.ts';
import { DATUMS } from '../src/units.ts';

// The public read API: its strict answer schemas, the query grammar and the OpenAPI document built from them.

const T = '2026-11-20T10:00:00.000Z';
const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
/** A copy of `obj` without `key`. */
const without = (obj: object, key: string) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

const attribution = {
  lang: 'nl',
  text: 'Bron: Rijkswaterstaat',
  url: 'https://waterinfo.rws.nl/',
  required: true,
  needsDate: false,
};
const meta = {
  now: T,
  dataEpoch: '2026-10-02T00:00:00.000Z',
  displayStart: '2026-08-24T00:00:00.000Z',
  build: 'a'.repeat(40),
  sources: [{ id: 'NL-1', attribution: [attribution] }],
};
const seriesMeta = {
  id: 12,
  source: 'NL-1',
  quantity: 'H',
  valueKind: 'stage',
  unit: 'cm',
  datum: 'NAP',
  nativeUnit: 'cm',
  expectedStepSeconds: 600,
  stalenessLimitSeconds: 2700,
  dataSince: '2026-10-02T00:00:00.000Z',
};
const station = {
  id: 'nl.rws.lobith.bovenrijn.tolkamer',
  name: 'Lobith',
  waterName: 'Rijn',
  country: 'NL',
  lon: 6.1,
  lat: 51.85,
  tier: 1,
  flags: { tidal: false, impounded: null },
  series: [seriesMeta],
};
const stations = { stations: [station] };
const stateBasis = {
  source: 'DE-1',
  kind: 'operational',
  measure: 'stage',
  ref: 'MNW/MHW',
  label: 'WSV MNW 2010–2020',
};
const snapshotValue = {
  series: 12,
  ts: T,
  value: 1234.5,
  qc: 0,
  ageSeconds: 300,
  state: 'no_ref',
  basis: null,
  section: false,
};
const snapshot = { t: T, values: [snapshotValue] };
const span = { id: 12, from: '2026-11-20T09:00:00.000Z', to: T, truncated: false };
const rawPoint = { ts: T, value: 12.5, qc: 3 };
const bucketPoint = { bucket: T, vmin: 1, vmax: 3, vavg: 2, vlast: 3, n: 6, qcOr: 0 };
const seriesRaw = { ...span, res: 'raw', points: [rawPoint] };
const series1h = { ...span, res: '1h', points: [bucketPoint] };
const series1d = { ...span, res: '1d', points: [bucketPoint] };

describe('the answer schemas', () => {
  it('accept a valid answer', () => {
    expect(Meta.parse(meta)).toEqual(meta);
    expect(Stations.parse(stations)).toEqual(stations);
    expect(Snapshot.parse(snapshot)).toEqual(snapshot);
    expect(Series.parse(seriesRaw)).toEqual(seriesRaw);
    expect(Series.parse(series1h)).toEqual(series1h);
    expect(Series.parse(series1d)).toEqual(series1d);
  });

  it('accept the empty answers', () => {
    expect(ok(Meta, { ...meta, sources: [] })).toBe(true);
    expect(ok(Meta, { ...meta, sources: [{ id: 'NL-1', attribution: [] }] })).toBe(true);
    expect(ok(Stations, { stations: [] })).toBe(true);
    expect(ok(Snapshot, { t: T, values: [] })).toBe(true);
    expect(ok(Series, { ...seriesRaw, points: [] })).toBe(true);
    expect(ok(Series, { ...series1h, points: [], truncated: true })).toBe(true);
  });

  it('are strict: an extra field fails at every level', () => {
    const extra = { extra: 1 };
    const cases: [string, z.ZodType, unknown][] = [
      ['meta', Meta, { ...meta, ...extra }],
      ['meta source', Meta, { ...meta, sources: [{ ...meta.sources[0], ...extra }] }],
      ['meta attribution', Meta, { ...meta, sources: [{ id: 'NL-1', attribution: [{ ...attribution, ...extra }] }] }],
      ['stations', Stations, { ...stations, ...extra }],
      ['station', Stations, { stations: [{ ...station, ...extra }] }],
      ['station flags', Stations, { stations: [{ ...station, flags: { ...station.flags, ...extra } }] }],
      ['station series', Stations, { stations: [{ ...station, series: [{ ...seriesMeta, ...extra }] }] }],
      ['snapshot', Snapshot, { ...snapshot, ...extra }],
      ['snapshot value', Snapshot, { ...snapshot, values: [{ ...snapshotValue, ...extra }] }],
      ['series raw', Series, { ...seriesRaw, ...extra }],
      ['series raw point', Series, { ...seriesRaw, points: [{ ...rawPoint, ...extra }] }],
      ['series 1h', Series, { ...series1h, ...extra }],
      ['series 1h point', Series, { ...series1h, points: [{ ...bucketPoint, ...extra }] }],
      ['error', ApiError, { error: 'busy', ...extra }],
    ];
    for (const [name, schema, value] of cases) expect(ok(schema, value), name).toBe(false);
  });

  it('are strict: a missing field fails', () => {
    expect(ok(ApiStation, station)).toBe(true);
    expect(ok(SeriesMeta, seriesMeta)).toBe(true);
    expect(ok(Attribution, attribution)).toBe(true);
    for (const key of Object.keys(meta)) expect(ok(Meta, without(meta, key)), `meta.${key}`).toBe(false);
    for (const key of Object.keys(station)) expect(ok(ApiStation, without(station, key)), `station.${key}`).toBe(false);
    for (const key of Object.keys(seriesMeta)) expect(ok(SeriesMeta, without(seriesMeta, key)), key).toBe(false);
    for (const key of Object.keys(attribution)) expect(ok(Attribution, without(attribution, key)), key).toBe(false);
    for (const key of Object.keys(snapshot)) expect(ok(Snapshot, without(snapshot, key)), key).toBe(false);
    for (const key of Object.keys(seriesRaw)) expect(ok(Series, without(seriesRaw, key)), `raw.${key}`).toBe(false);
    for (const key of Object.keys(series1h)) expect(ok(Series, without(series1h, key)), `1h.${key}`).toBe(false);
  });

  it('every timestamp is UTC: an offset or a free text fails', () => {
    for (const bad of ['2026-11-20T12:00:00+02:00', '2026-11-20', 'yesterday', '', 1763632800000])
      expect(ok(Snapshot, { ...snapshot, t: bad }), String(bad)).toBe(false);
    expect(ok(Snapshot, { ...snapshot, t: '2026-11-20T10:00:00Z' })).toBe(true);
    expect(ok(Meta, { ...meta, now: '2026-11-20T12:00:00+02:00' })).toBe(false);
    expect(ok(SeriesMeta, { ...seriesMeta, dataSince: null })).toBe(true);
    expect(ok(SeriesMeta, { ...seriesMeta, dataSince: '2026-10-02' })).toBe(false);
  });
});

describe('Meta', () => {
  it('only catalogue source IDs: no canary, no owner-only spelling, no free text', () => {
    for (const id of ['CANARY-OWNER', 'de-1', 'DE-0', 'DE-100', 'DE-1 ', 'XX-1', '', 'DE-1\n'])
      expect(ok(Meta, { ...meta, sources: [{ id, attribution: [] }] }), JSON.stringify(id)).toBe(false);
    for (const id of ['NL-1', 'DE-9', 'CH-4', 'LU-4', 'BE-3', 'FR-12'])
      expect(ok(Meta, { ...meta, sources: [{ id, attribution: [] }] }), id).toBe(true);
  });

  it('the build is a git commit or dev', () => {
    for (const build of ['dev', '0123456789abcdef0123456789abcdef01234567'])
      expect(ok(Meta, { ...meta, build }), build).toBe(true);
    for (const build of ['', 'v1.2.3', 'DEV', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)])
      expect(ok(Meta, { ...meta, build }), build).toBe(false);
  });

  it('bounds the sources and the attribution of each', () => {
    const source = { id: 'NL-1', attribution: [] };
    expect(ok(Meta, { ...meta, sources: Array.from({ length: 100 }, () => source) })).toBe(true);
    expect(ok(Meta, { ...meta, sources: Array.from({ length: 101 }, () => source) })).toBe(false);
    const many = (n: number) => ({ id: 'NL-1', attribution: Array.from({ length: n }, () => attribution) });
    expect(ok(Meta, { ...meta, sources: [many(20)] })).toBe(true);
    expect(ok(Meta, { ...meta, sources: [many(21)] })).toBe(false);
  });
});

describe('Attribution', () => {
  const withAttr = (over: Record<string, unknown>) => ok(Attribution, { ...attribution, ...over });

  it('the url is https or null: nothing else can become a link', () => {
    expect(withAttr({ url: null })).toBe(true);
    expect(withAttr({ url: 'https://example.org/a?b=c#d' })).toBe(true);
    for (const url of [
      'http://example.org/',
      'javascript:alert(1)',
      'data:text/html,x',
      '//example.org/',
      'example.org',
      'HTTPS://example.org/',
      'https://',
      'https://example.org/a b',
      ' https://example.org/',
      `https://example.org/${'a'.repeat(500)}`,
      '',
    ])
      expect(withAttr({ url }), url).toBe(false);
  });

  it('the language is a supported one or null, the text is non-empty and bounded', () => {
    expect(withAttr({ lang: null })).toBe(true);
    for (const lang of ['nl', 'en', 'de', 'fr']) expect(withAttr({ lang }), lang).toBe(true);
    for (const lang of ['es', 'NL', '', 'nl-NL']) expect(withAttr({ lang }), lang).toBe(false);
    expect(withAttr({ text: 'x'.repeat(1000) })).toBe(true);
    expect(withAttr({ text: 'x'.repeat(1001) })).toBe(false);
    expect(withAttr({ text: '' })).toBe(false);
  });
});

describe('Stations', () => {
  it('a station has between 1 and 20 series', () => {
    const withSeries = (n: number) => ({
      stations: [{ ...station, series: Array.from({ length: n }, () => seriesMeta) }],
    });
    expect(ok(Stations, withSeries(0))).toBe(false);
    expect(ok(Stations, withSeries(1))).toBe(true);
    expect(ok(Stations, withSeries(20))).toBe(true);
    expect(ok(Stations, withSeries(21))).toBe(false);
  });

  it('bounds the stations and checks each field', () => {
    expect(ok(Stations, { stations: Array.from({ length: 10_001 }, () => station) })).toBe(false);
    const st = (over: Record<string, unknown>) => ok(ApiStation, { ...station, ...over });
    expect(st({})).toBe(true);
    expect(st({ lon: null, lat: null, waterName: null, flags: { tidal: null, impounded: null } })).toBe(true);
    expect(st({ tier: 3 })).toBe(false);
    expect(st({ country: 'XX' })).toBe(false);
    expect(st({ lon: 181 })).toBe(false);
    expect(st({ lat: -90.5 })).toBe(false);
    expect(st({ name: '' })).toBe(false);
    expect(st({ name: 'x'.repeat(201) })).toBe(false);
    for (const id of ['', 'NL.rws.x', 'nl.rws', 'nl.rws.x y', `nl.rws.${'x'.repeat(80)}`])
      expect(st({ id }), id).toBe(false);
  });

  it('a series says H or Q, in cm or m³/s, with positive steps', () => {
    const sm = (over: Record<string, unknown>) => ok(SeriesMeta, { ...seriesMeta, ...over });
    expect(sm({ quantity: 'Q', unit: 'm³/s', nativeUnit: 'l/s', valueKind: null, datum: null })).toBe(true);
    expect(sm({ quantity: 'W' })).toBe(false);
    expect(sm({ unit: 'm' })).toBe(false);
    expect(sm({ nativeUnit: 'ft' })).toBe(false);
    expect(sm({ datum: 'XYZ' })).toBe(false);
    expect(sm({ valueKind: 'depth' })).toBe(false);
    expect(sm({ expectedStepSeconds: 0 })).toBe(false);
    expect(sm({ stalenessLimitSeconds: 0 })).toBe(false);
    expect(sm({ stalenessLimitSeconds: 1.5 })).toBe(false);
    expect(sm({ id: 0 })).toBe(false);
    expect(sm({ id: SERIES_ID_MAX })).toBe(true);
    expect(sm({ id: SERIES_ID_MAX + 1 })).toBe(false);
  });
});

describe('Snapshot', () => {
  it('bounds the values', () => {
    const many = (n: number) => ({ t: T, values: Array.from({ length: n }, () => snapshotValue) });
    expect(ok(Snapshot, many(MAX_POINTS))).toBe(true);
    expect(ok(Snapshot, many(MAX_POINTS + 1))).toBe(false);
  });

  it('a value is finite, its QC is a 10-bit mask and its age is not negative', () => {
    const sv = (over: Record<string, unknown>) => ok(Snapshot, { t: T, values: [{ ...snapshotValue, ...over }] });
    expect(sv({ qc: 1023 })).toBe(true);
    expect(sv({ qc: 1024 })).toBe(false);
    expect(sv({ qc: -1 })).toBe(false);
    expect(sv({ qc: 1.5 })).toBe(false);
    expect(sv({ ageSeconds: 0 })).toBe(true);
    expect(sv({ ageSeconds: -1 })).toBe(false);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, null, '1', undefined])
      expect(sv({ value }), String(value)).toBe(false);
    expect(sv({ value: -0.5 })).toBe(true);
  });
});

describe('Snapshot state and basis', () => {
  const sv = (over: Record<string, unknown>) => ok(Snapshot, { t: T, values: [{ ...snapshotValue, ...over }] });
  const classed = { state: 'low', basis: stateBasis };

  it('state is one of the six, basis is a strict object', () => {
    for (const state of STATES) expect(sv({ state, basis: stateBasis }), state).toBe(true);
    for (const state of ['LOW', 'critical', '', null, undefined]) expect(sv({ state }), String(state)).toBe(false);
    expect(sv(classed)).toBe(true);
    expect(sv({ ...classed, basis: { ...stateBasis, extra: 1 } })).toBe(false);
    for (const key of Object.keys(stateBasis))
      expect(sv({ ...classed, basis: without(stateBasis, key) }), key).toBe(false);
    for (const key of ['state', 'basis', 'section'])
      expect(ok(Snapshot, { t: T, values: [without(snapshotValue, key)] })).toBe(false);
  });

  it('bounds the basis: kind, measure, label at 700, ref at 200, an empty text and a source that is not a public id', () => {
    const b = (over: Record<string, unknown>) => sv({ ...classed, basis: { ...stateBasis, ...over } });
    expect(b({ label: 'x'.repeat(700) })).toBe(true);
    expect(b({ label: 'x'.repeat(701) })).toBe(false);
    expect(b({ label: '' })).toBe(false);
    expect(b({ ref: 'x'.repeat(200) })).toBe(true);
    expect(b({ ref: 'x'.repeat(201) })).toBe(false);
    for (const kind of BASIS_KINDS) expect(b({ kind }), kind).toBe(true);
    expect(b({ kind: 'owner' })).toBe(false);
    for (const measure of ['stage', 'discharge', 'area']) expect(b({ measure }), measure).toBe(true);
    expect(b({ measure: 'level' })).toBe(false);
    for (const source of ['CANARY-OWNER', 'owner', 'de-1', 'DE-', 'XX-1', 'DE-100'])
      expect(b({ source }), source).toBe(false);
  });

  it('area takes a state of low or above and a basis; nap and zero are strict', () => {
    const a = (area: unknown) => sv({ area });
    expect(a({ state: 'high', basis: { ...stateBasis, kind: 'area', measure: 'area' } })).toBe(true);
    expect(a({ state: 'no_ref', basis: stateBasis })).toBe(false);
    expect(a({ state: 'high' })).toBe(false);
    expect(a({ state: 'high', basis: stateBasis, extra: 1 })).toBe(false);
    expect(sv({ nap: { m: 1.2, pm: 0 } })).toBe(true);
    expect(sv({ nap: { m: -1.2, pm: 0.05 } })).toBe(true);
    expect(sv({ nap: { m: 1.2, pm: -0.01 } })).toBe(false);
    expect(sv({ nap: { m: 1.2 } })).toBe(false);
    expect(sv({ nap: { m: 1.2, pm: 0, x: 1 } })).toBe(false);
    for (const datum of DATUMS) expect(sv({ zero: { m: 3, datum } }), datum).toBe(true);
    expect(sv({ zero: { m: 3, datum: 'SEA' } })).toBe(false);
    expect(sv({ zero: { m: 3, datum: 'IGN69', x: 1 } })).toBe(false);
  });
});

describe('Series', () => {
  it('bounds the points of every resolution', () => {
    const raw = (n: number) => ({ ...seriesRaw, points: Array.from({ length: n }, () => rawPoint) });
    const bucket = (res: string, n: number) => ({ ...span, res, points: Array.from({ length: n }, () => bucketPoint) });
    expect(ok(Series, raw(MAX_POINTS))).toBe(true);
    expect(ok(Series, raw(MAX_POINTS + 1))).toBe(false);
    for (const res of ['1h', '1d']) {
      expect(ok(Series, bucket(res, MAX_POINTS)), res).toBe(true);
      expect(ok(Series, bucket(res, MAX_POINTS + 1)), res).toBe(false);
    }
  });

  it('the resolution decides the shape of the points', () => {
    expect(ok(Series, { ...seriesRaw, points: [bucketPoint] })).toBe(false);
    expect(ok(Series, { ...series1h, points: [rawPoint] })).toBe(false);
    expect(ok(Series, { ...series1d, points: [rawPoint] })).toBe(false);
    expect(ok(Series, { ...seriesRaw, res: '5m' })).toBe(false);
    expect(ok(Series, { ...seriesRaw, res: undefined })).toBe(false);
  });

  it('checks the ids, the counts and the masks', () => {
    expect(ok(Series, { ...seriesRaw, id: 0 })).toBe(false);
    expect(ok(Series, { ...seriesRaw, id: SERIES_ID_MAX + 1 })).toBe(false);
    expect(ok(Series, { ...seriesRaw, truncated: 'no' })).toBe(false);
    expect(ok(Series, { ...seriesRaw, points: [{ ...rawPoint, qc: 1024 }] })).toBe(false);
    expect(ok(Series, { ...seriesRaw, points: [{ ...rawPoint, value: Number.NaN }] })).toBe(false);
    expect(ok(Series, { ...series1h, points: [{ ...bucketPoint, n: 0 }] })).toBe(false);
    expect(ok(Series, { ...series1h, points: [{ ...bucketPoint, n: 1.5 }] })).toBe(false);
    expect(ok(Series, { ...series1h, points: [{ ...bucketPoint, qcOr: 1024 }] })).toBe(false);
    expect(ok(Series, { ...series1h, points: [{ ...bucketPoint, vavg: null }] })).toBe(false);
  });
});

describe('ApiError', () => {
  it('carries exactly one of the fixed codes', () => {
    expect(API_ERROR_CODES).toEqual([
      'unknown_parameter',
      'repeated_parameter',
      'bad_parameter',
      'out_of_range',
      'span_too_long',
      'not_found',
      'method_not_allowed',
      'busy',
      'unavailable',
      'internal',
    ]);
    for (const error of API_ERROR_CODES) expect(ApiError.parse({ error })).toEqual({ error });
    for (const bad of [{}, { error: 'nope' }, { error: '' }, { error: 400 }, { error: 'busy', status: 503 }])
      expect(ok(ApiError, bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('the query schemas', () => {
  const t = '2026-11-20T10:00:00Z';

  it('are strict, and an extra key is reported as unrecognized_keys', () => {
    expect(ok(SnapshotQuery, { t })).toBe(true);
    const r = SnapshotQuery.safeParse({ t, x: '1' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.code)).toEqual(['unrecognized_keys']);
    expect(ok(SeriesQuery, { from: t, to: t, x: '1' })).toBe(false);
    expect(ok(SeriesPath, { id: '1', x: '1' })).toBe(false);
  });

  it('a missing key is reported as something else than unrecognized_keys', () => {
    for (const r of [SnapshotQuery.safeParse({}), SeriesQuery.safeParse({ from: t }), SeriesPath.safeParse({})]) {
      expect(r.success).toBe(false);
      expect(r.error?.issues.some((i) => i.code === 'unrecognized_keys')).toBe(false);
    }
  });

  it('an instant is at most 32 characters and in the grammar', () => {
    expect(ok(SnapshotQuery, { t: '2026-11-20T10:00:00.123456+02:00' })).toBe(true);
    expect(ok(SnapshotQuery, { t: '2026-11-20T10:00:00.1234567+02:00' })).toBe(false);
    expect(ok(SnapshotQuery, { t: '2026-11-20t10:00:00Z' })).toBe(false);
    expect(ok(SnapshotQuery, { t: 1763632800 })).toBe(false);
  });

  it('res is optional and one of raw, 1h and 1d', () => {
    expect(RESOLUTIONS).toEqual(['raw', '1h', '1d']);
    expect(ok(SeriesQuery, { from: t, to: t })).toBe(true);
    for (const res of RESOLUTIONS) expect(ok(SeriesQuery, { from: t, to: t, res }), res).toBe(true);
    for (const res of ['', 'RAW', '1w', 'bogus']) expect(ok(SeriesQuery, { from: t, to: t, res }), res).toBe(false);
  });

  it('the series id is digits without a leading zero, at most 10 of them', () => {
    expect(SERIES_ID_RE.test('1')).toBe(true);
    expect(SERIES_ID_RE.test('9999999999')).toBe(true);
    for (const id of ['', '0', '01', '-1', '1.5', 'a', '99999999999', ' 1', '1\n'])
      expect(SERIES_ID_RE.test(id), JSON.stringify(id)).toBe(false);
    expect(ok(SeriesPath, { id: '12' })).toBe(true);
    expect(ok(SeriesPath, { id: 12 })).toBe(false);
  });
});

describe('instantMs', () => {
  const utc = (iso: string) => Date.parse(iso);

  it('reads RFC 3339 with an offset into UTC milliseconds', () => {
    const accepted: [string, number][] = [
      ['2026-11-20T10:00:00Z', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T10:00Z', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T12:00:00+02:00', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T05:00:00-05:00', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T10:00:00+00:00', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T15:30:00+05:30', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T23:59:00+23:59', utc('2026-11-20T00:00:00Z')],
      ['2026-11-20T00:00:00-23:59', utc('2026-11-20T23:59:00Z')],
      ['1900-01-01T00:00:00Z', utc('1900-01-01T00:00:00Z')],
      ['2099-12-31T23:59:59Z', utc('2099-12-31T23:59:59Z')],
      ['2024-02-29T12:00:00Z', utc('2024-02-29T12:00:00Z')],
      ['2000-02-29T12:00:00Z', utc('2000-02-29T12:00:00Z')],
      // The fraction (1 to 9 digits) does not move the instant out of its second.
      ['2026-11-20T10:00:00.1Z', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T10:00:00.999999999Z', utc('2026-11-20T10:00:00Z')],
      ['2026-11-20T10:00:00.123456+00:00', utc('2026-11-20T10:00:00Z')],
      // A wall clock that happens twice, and one that does not happen.
      ['2026-10-25T02:30:00+02:00', utc('2026-10-25T00:30:00Z')],
      ['2026-10-25T02:30:00+01:00', utc('2026-10-25T01:30:00Z')],
      ['2026-03-29T02:30:00+01:00', utc('2026-03-29T01:30:00Z')],
    ];
    for (const [text, ms] of accepted) expect(instantMs(text), text).toBe(ms);
  });

  it('refuses everything outside the grammar or the calendar', () => {
    const refused = [
      '',
      '2026-11-20T10:00:00',
      '2026-11-20T10:00',
      '2026-11-20',
      '2026-11-20t10:00:00Z',
      '2026-11-20T10:00:00z',
      '2026-11-20 10:00:00Z',
      '2026-11-20T10:00:60Z',
      '2026-11-20T10:60:00Z',
      '2026-11-20T24:00:00Z',
      '2026-13-20T10:00:00Z',
      '2026-00-20T10:00:00Z',
      '2026-11-00T10:00:00Z',
      '2026-11-31T10:00:00Z',
      '2026-02-30T10:00:00Z',
      '2026-02-29T10:00:00Z',
      '1900-02-29T10:00:00Z',
      '0000-11-20T10:00:00Z',
      '9999-11-20T10:00:00Z',
      '1899-12-31T23:59:59Z',
      '2100-01-01T00:00:00Z',
      '2026-11-20T10:00:00-00:00',
      '2026-11-20T10:00:00+24:00',
      '2026-11-20T10:00:00-24:00',
      '2026-11-20T10:00:00+05:60',
      '2026-11-20T10:00:00+0200',
      '2026-11-20T10:00:00 02:00',
      '2026-11-20T10:00:00.Z',
      '2026-11-20T10:00:00.1234567890Z',
      '2026-11-20T10:00.5Z',
      ' 2026-11-20T10:00:00Z',
      '2026-11-20T10:00:00Z ',
      '2026-11-20T10:00:00Z\n',
      '1763632800',
      // 33 characters: too long even though the grammar would take it.
      '2026-11-20T10:00:00.1234567+02:00',
    ];
    for (const text of refused) expect(instantMs(text), JSON.stringify(text)).toBeUndefined();
  });

  it('takes 32 characters and not 33', () => {
    expect(instantMs('2026-11-20T10:00:00.123456+02:00')).toBe(Date.parse('2026-11-20T08:00:00Z'));
    expect(INSTANT_MAX_LENGTH).toBe(32);
    expect(INSTANT_RE.test('2026-11-20T10:00:00.1234567+02:00')).toBe(true);
    expect(instantMs('2026-11-20T10:00:00.1234567+02:00')).toBeUndefined();
  });

  it('agrees with the grammar: whatever instantMs reads, the regular expression accepts', () => {
    for (const text of ['2026-11-20T10:00:00Z', '2026-11-20T10:00Z', '2026-11-20T10:00:00.5-05:00'])
      expect(INSTANT_RE.test(text) && instantMs(text) !== undefined).toBe(true);
  });
});

describe('the grid and the caps', () => {
  it('floors to the 10-minute UTC bucket', () => {
    expect(BUCKET_MS).toBe(600_000);
    const at = Date.parse('2026-11-20T00:30:00Z');
    expect(floorBucket(at)).toBe(at);
    expect(floorBucket(at + 9 * 60_000 + 59_999)).toBe(at);
    expect(floorBucket(at + BUCKET_MS)).toBe(at + BUCKET_MS);
    expect(floorBucket(at - 1)).toBe(at - BUCKET_MS);
    expect(floorBucket(0)).toBe(0);
    expect(floorBucket(-1)).toBe(-BUCKET_MS);
  });

  it('the span caps and the bounds of the answers', () => {
    const day = 86_400_000;
    expect(SPAN_CAP_MS).toEqual({ raw: 14 * day, '1h': 366 * day, '1d': 3660 * day });
    expect(MAX_POINTS).toBe(20_000);
    expect(SERIES_ID_MAX).toBe(2 ** 31 - 1);
  });
});

describe('openApiDocument', () => {
  type Doc = {
    openapi: string;
    info: Record<string, unknown>;
    paths: Record<
      string,
      Record<string, { parameters?: Record<string, unknown>[]; responses: Record<string, unknown> }>
    >;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  const doc = openApiDocument() as Doc;
  const text = JSON.stringify(doc);

  /** Every `$ref` in a tree. */
  function refs(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) for (const n of node) refs(n, out);
    else if (node !== null && typeof node === 'object')
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') out.push(value);
        else refs(value, out);
      }
    return out;
  }
  const parameter = (path: string, name: string) =>
    doc.paths[path]?.get?.parameters?.find((p) => p.name === name) as Record<string, unknown> & {
      schema: Record<string, unknown>;
    };

  it('is OpenAPI 3.1.0 with exactly the seven public paths, each a GET', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/api/v1/health',
        '/api/v1/health/sources',
        '/api/v1/meta',
        '/api/v1/openapi.json',
        '/api/v1/series/{id}',
        '/api/v1/snapshot',
        '/api/v1/stations',
      ].sort(),
    );
    for (const [path, item] of Object.entries(doc.paths)) expect(Object.keys(item), path).toEqual(['get']);
  });

  it('has a component for every answer and every error', () => {
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining([
        'ApiError',
        'Meta',
        'Stations',
        'Snapshot',
        'Series',
        'Health',
        'HealthSources',
        'HealthUnavailable',
      ]),
    );
  });

  it('every $ref resolves to a component', () => {
    const found = refs(doc);
    expect(found.length).toBeGreaterThan(10);
    for (const ref of found) {
      expect(ref.startsWith('#/components/schemas/'), ref).toBe(true);
      expect(doc.components.schemas[ref.slice('#/components/schemas/'.length)], ref).toBeDefined();
    }
  });

  it('every operation answers 200, and the errors are the ApiError body', () => {
    for (const [path, item] of Object.entries(doc.paths)) expect(item.get?.responses['200'], path).toBeDefined();
    for (const code of ['400', '405', '503'])
      expect(refs(doc.paths['/api/v1/meta']?.get?.responses[code])).toEqual(['#/components/schemas/ApiError']);
    expect(refs(doc.paths['/api/v1/series/{id}']?.get?.responses['404'])).toEqual(['#/components/schemas/ApiError']);
    expect(doc.paths['/api/v1/meta']?.get?.responses['404']).toBeUndefined();
  });

  it('the health routes answer their own 503 body; their 400 and 405 are the ApiError body', () => {
    for (const path of ['/api/v1/health', '/api/v1/health/sources']) {
      const responses = doc.paths[path]?.get?.responses ?? {};
      expect(refs(responses['503']), path).toEqual(['#/components/schemas/HealthUnavailable']);
      for (const code of ['400', '405'])
        expect(refs(responses[code]), `${path} ${code}`).toEqual(['#/components/schemas/ApiError']);
    }
    for (const path of ['/api/v1/meta', '/api/v1/stations', '/api/v1/snapshot', '/api/v1/series/{id}'])
      expect(refs(doc.paths[path]?.get?.responses['503']), path).toEqual(['#/components/schemas/ApiError']);
    // The schema is exactly the body the health routes send.
    expect(doc.components.schemas.HealthUnavailable).toEqual({
      type: 'object',
      properties: { status: { type: 'string', const: 'down' }, error: { type: 'string', const: 'unavailable' } },
      required: ['status', 'error'],
      additionalProperties: false,
    });
    expect(HealthUnavailable.parse(JSON.parse('{"status":"down","error":"unavailable"}'))).toEqual({
      status: 'down',
      error: 'unavailable',
    });
    expect(ok(HealthUnavailable, { error: 'unavailable' })).toBe(false);
    expect(ok(HealthUnavailable, { status: 'down', error: 'busy' })).toBe(false);
    expect(ok(HealthUnavailable, { status: 'down', error: 'unavailable', detail: 'x' })).toBe(false);
  });

  it('the schema of the error codes is the list of the contract', () => {
    const apiError = doc.components.schemas.ApiError as {
      properties: { error: { enum: string[] } };
      additionalProperties: boolean;
    };
    expect(apiError.properties.error.enum).toEqual([...API_ERROR_CODES]);
    expect(apiError.additionalProperties).toBe(false);
  });

  it('the answer schemas are strict, as the API checks them', () => {
    for (const name of ['Meta', 'Stations', 'Snapshot', 'Health', 'HealthSources', 'HealthUnavailable'])
      expect(doc.components.schemas[name]?.additionalProperties, name).toBe(false);
  });

  it('the instant parameters are at most 32 characters and carry the grammar', () => {
    for (const [path, name] of [
      ['/api/v1/snapshot', 't'],
      ['/api/v1/series/{id}', 'from'],
      ['/api/v1/series/{id}', 'to'],
    ] as const) {
      const p = parameter(path, name);
      expect(p.in, name).toBe('query');
      expect(p.required, name).toBe(true);
      expect(p.schema.type, name).toBe('string');
      expect(p.schema.maxLength, name).toBe(32);
      expect(p.schema.pattern, name).toBe(INSTANT_RE.source);
      const re = new RegExp(p.schema.pattern as string);
      expect(re.test('2026-11-20T10:00:00Z'), name).toBe(true);
      expect(re.test('2026-11-20t10:00:00z'), name).toBe(false);
    }
  });

  it('the series id and res are described as the API reads them', () => {
    const id = parameter('/api/v1/series/{id}', 'id');
    expect([id.in, id.required, id.schema.pattern]).toEqual(['path', true, SERIES_ID_RE.source]);
    const res = parameter('/api/v1/series/{id}', 'res');
    expect([res.in, res.required, res.schema.enum]).toEqual(['query', false, [...RESOLUTIONS]]);
    expect(doc.paths['/api/v1/meta']?.get?.parameters).toBeUndefined();
    expect(doc.paths['/api/v1/stations']?.get?.parameters).toBeUndefined();
  });

  it('holds no software version, and no canary in any spelling', () => {
    expect(text.replaceAll('3.1.0', '')).not.toMatch(/\d+\.\d+\.\d+/);
    for (const canary of CANARY_RENDERINGS) expect(text, canary).not.toContain(canary);
    expect(text).not.toMatch(/CANARY/i);
  });

  it('is plain JSON, and the same document every time', () => {
    expect(JSON.parse(text)).toEqual(doc);
    expect(openApiDocument()).toEqual(doc);
  });
});
