import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  FORECAST_AHEAD_MS,
  FORECAST_BAND_KINDS,
  FORECAST_RUN_MAX_POINTS,
  MAX_POINTS,
  Meta,
  SeriesForecast,
  SeriesForecastQuery,
  Snapshot,
  SnapshotForecast,
} from '../src/api.ts';
import {
  FORECAST_FLAG_BITS,
  FORECAST_MAX_POINTS,
  FORECAST_PRECEDENCE,
  ForecastLatest,
  pickRun,
} from '../src/forecast.ts';
import { OwnerForecastLatest } from '../src/static-owner.ts';

// The forecast contracts of P8b: the display rule (FORECAST_PRECEDENCE, pickRun), the band of forecast/latest.json
// (kind p10p90 or p25p75, each column nullable, the kind's pair present, no number at a below-floor point), and the
// API answers of the forecast slider (SnapshotForecast, Snapshot.forecasts, SeriesForecast, Meta.forecastHorizons).

const repoRoot = new URL('../../../', import.meta.url);
const HOUR = 3_600_000;

describe('FORECAST_PRECEDENCE and pickRun', () => {
  it('is the order of those sources in registry/sources.yaml (DE-2 before DE-3), so the rule has one home', () => {
    const doc = parse(readFileSync(new URL('registry/sources.yaml', repoRoot), 'utf8')) as {
      sources: { id: string }[];
    };
    const registryOrder = doc.sources
      .map((s) => s.id)
      .filter((id) => (FORECAST_PRECEDENCE as readonly string[]).includes(id));
    expect(registryOrder).toEqual([...FORECAST_PRECEDENCE]);
    expect(FORECAST_PRECEDENCE.indexOf('DE-2')).toBeLessThan(FORECAST_PRECEDENCE.indexOf('DE-3'));
    expect(new Set(FORECAST_PRECEDENCE).size).toBe(FORECAST_PRECEDENCE.length);
  });

  const run = (source: string, tag = source) => ({ source, tag });
  const all = () => FORECAST_PRECEDENCE.map((s) => run(s));

  it('picks the first source of the precedence, whatever the order of the candidates', () => {
    expect(pickRun([run('DE-3'), run('DE-2')], () => true)?.source).toBe('DE-2');
    expect(pickRun([run('CH-4'), run('LU-3'), run('FR-4')], () => true)?.source).toBe('FR-4');
    expect(pickRun([...all()].reverse(), () => true)?.source).toBe('NL-1');
    expect(pickRun(all(), () => true)?.source).toBe(FORECAST_PRECEDENCE[0]);
    // the input is not reordered in place
    const given = [run('CH-4'), run('NL-1')];
    pickRun(given, () => true);
    expect(given.map((r) => r.source)).toEqual(['CH-4', 'NL-1']);
  });

  it('takes the first source that `current` accepts: a superseded DE-2 run falls back to DE-3', () => {
    const runs = [run('DE-3'), run('DE-2')];
    expect(pickRun(runs, (r) => r.source !== 'DE-2')?.source).toBe('DE-3');
    expect(pickRun(runs, (r) => r.source === 'DE-3')?.source).toBe('DE-3');
    expect(pickRun(runs, () => false)).toBeUndefined();
    expect(pickRun([], () => true)).toBeUndefined();
    // `current` decides on the candidate itself: one run of a source it rejects, another of the same source it accepts
    const two = [run('NL-1', 'old'), run('NL-1', 'new')];
    expect(pickRun(two, (r) => r.tag === 'new')?.tag).toBe('new');
  });

  it('ranks a source outside the list after every listed one (the owner canary shows only where nothing else does)', () => {
    expect(pickRun([run('CANARY-OWNER'), run('CH-4')], () => true)?.source).toBe('CH-4');
    expect(pickRun([run('CH-4'), run('CANARY-OWNER')], (r) => r.source !== 'CH-4')?.source).toBe('CANARY-OWNER');
    expect(pickRun([run('CANARY-OWNER')], () => true)?.source).toBe('CANARY-OWNER');
    expect(pickRun([run('CANARY-OWNER')], () => false)).toBeUndefined();
  });
});

describe('ForecastLatest: the band of a run', () => {
  const T0 = Date.parse('2026-10-05T10:00:00Z');
  const ts = (i: number) => new Date(T0 + i * HOUR).toISOString();
  const NO_BAND = { p10: null, p90: null, p25: null, p75: null, p30: null, p70: null, vmin: null, vmax: null };
  const base = (over: Record<string, unknown> = {}) => ({
    series: 1,
    source: 'CH-4',
    agency: 'BAFU',
    issuedAt: ts(0),
    issuedInferred: true,
    fetchedAt: ts(0),
    providerSegmentEnd: null,
    kind: 'ensemble_summary',
    stepSeconds: 3600,
    validTs: [ts(0), ts(1), ts(2)],
    value: [100, 110, 120],
    band: null,
    flags: [0, 0, 0],
    ...over,
  });
  const doc = (r: unknown, runs: unknown[] = [r]) => ({ schemaVersion: 1, now: ts(0), runs });
  const ok = (r: unknown) => ForecastLatest.safeParse(doc(r)).success;

  it('accepts a BAFU band: p25 and p75 with the ensemble minimum and maximum, the other columns null', () => {
    const band = {
      ...NO_BAND,
      kind: 'p25p75',
      p25: [90, 100, 110],
      p75: [110, 120, 130],
      vmin: [70, 80, 90],
      vmax: [130, 140, 150],
    };
    expect(ok(base({ band }))).toBe(true);
    expect(OwnerForecastLatest.safeParse(doc(base({ band }))).success).toBe(true);
    // the p10-p90 kind with AGE's p30 and p70 too, and a column with a null entry (a gap of that quantile)
    const wide = {
      ...NO_BAND,
      kind: 'p10p90',
      p10: [80, null, 100],
      p90: [120, 130, 140],
      p30: [90, 100, 110],
      p70: [110, 120, 130],
    };
    expect(ok(base({ kind: 'quantiles', band: wide }))).toBe(true);
    expect(ok(base())).toBe(true);
  });

  it('refuses a band whose kind has no pair: p10p90 without p10 or p90, p25p75 without p25 or p75', () => {
    const band = (o: Record<string, unknown>) => base({ band: { ...NO_BAND, ...o } });
    expect(ok(band({ kind: 'p10p90', p10: [1, 2, 3], p90: [2, 3, 4] }))).toBe(true);
    expect(ok(band({ kind: 'p10p90', p10: [1, 2, 3] }))).toBe(false);
    expect(ok(band({ kind: 'p10p90', p90: [2, 3, 4] }))).toBe(false);
    expect(ok(band({ kind: 'p10p90' }))).toBe(false);
    // the other pair does not stand in for it
    expect(ok(band({ kind: 'p10p90', p25: [1, 2, 3], p75: [2, 3, 4] }))).toBe(false);
    expect(ok(band({ kind: 'p25p75', p25: [1, 2, 3], p75: [2, 3, 4] }))).toBe(true);
    expect(ok(band({ kind: 'p25p75', p25: [1, 2, 3] }))).toBe(false);
    expect(ok(band({ kind: 'p25p75', p75: [2, 3, 4] }))).toBe(false);
    expect(ok(band({ kind: 'p25p75', vmin: [1, 2, 3], vmax: [2, 3, 4] }))).toBe(false);
    expect(ok(band({ kind: 'p25p75', p10: [1, 2, 3], p90: [2, 3, 4] }))).toBe(false);
  });

  it('refuses a kind outside the two, a missing column key, an extra one and a column of the wrong length', () => {
    const pair = { p25: [1, 2, 3], p75: [2, 3, 4] };
    expect(ok(base({ band: { ...NO_BAND, ...pair, kind: 'p05p95' } }))).toBe(false);
    expect(ok(base({ band: { ...NO_BAND, ...pair, kind: 'p30p70' } }))).toBe(false);
    expect(ok(base({ band: { ...NO_BAND, ...pair } }))).toBe(false);
    const { vmax: _omitted, ...short } = { ...NO_BAND, ...pair, kind: 'p25p75' };
    expect(ok(base({ band: short }))).toBe(false);
    expect(ok(base({ band: { ...NO_BAND, ...pair, kind: 'p25p75', p95: [1, 2, 3] } }))).toBe(false);
    expect(ok(base({ band: { ...NO_BAND, p25: [1, 2], p75: [2, 3, 4], kind: 'p25p75' } }))).toBe(false);
    expect(ok(base({ band: { ...NO_BAND, ...pair, vmin: [1, 2, 3, 4], kind: 'p25p75' } }))).toBe(false);
  });

  it('a below-floor point holds no number in the value or in any band column', () => {
    const FLOOR = FORECAST_FLAG_BITS.below_floor;
    const full = {
      ...NO_BAND,
      kind: 'p25p75',
      p25: [1, 2, 3],
      p75: [2, 3, 4],
      p10: [1, 2, 3],
      p90: [2, 3, 4],
      p30: [1, 2, 3],
      p70: [2, 3, 4],
      vmin: [1, 2, 3],
      vmax: [2, 3, 4],
    };
    // a number anywhere at the flagged point fails ...
    expect(ok(base({ value: [100, 110, 120], flags: [0, FLOOR, 0], band: null }))).toBe(false);
    for (const column of ['p10', 'p90', 'p25', 'p75', 'p30', 'p70', 'vmin', 'vmax'])
      expect(ok(base({ value: [100, null, 120], flags: [0, FLOOR, 0], band: { ...full } })), column).toBe(false);
    // ... and nulls there pass: the value and every band column
    const nulled = Object.fromEntries(
      Object.entries(full).map(([k, v]) => [k, Array.isArray(v) ? [v[0], null, v[2]] : v]),
    );
    expect(ok(base({ value: [100, null, 120], flags: [0, FLOOR, 0], band: nulled }))).toBe(true);
    // a column the run states for no point at all is null as a whole
    expect(ok(base({ value: [100, null, 120], flags: [0, FLOOR, 0], band: null }))).toBe(true);
    // the same numbers at an unflagged point are fine
    expect(ok(base({ band: full }))).toBe(true);
    // one flagged point among others: only that index is held to the rule
    expect(ok(base({ value: [null, 110, 120], flags: [FLOOR, 0, 0], band: { ...full, p25: [null, 2, 3] } }))).toBe(
      false,
    );
  });

  it('keeps the other shape rules: ordered times, one entry per time, flags of the forecast mask only', () => {
    expect(ok(base({ validTs: [ts(1), ts(0), ts(2)] }))).toBe(false);
    expect(ok(base({ value: [100, 110] }))).toBe(false);
    expect(ok(base({ flags: [0, 2, 0] }))).toBe(false);
    expect(ok(base({ flags: [16, 128, 256] }))).toBe(true);
    expect(ok(base({ source: 'CANARY-OWNER' }))).toBe(false);
    expect(ForecastLatest.safeParse(doc(base(), [])).success).toBe(true);
  });
});

describe('the forecast answers of the API', () => {
  const T = '2026-10-05T10:00:00.000Z';
  const basis = { source: 'DE-1', kind: 'statistical', measure: 'stage', ref: 'MNW', label: 'WSV MNW 2010–2020' };
  const entry = (over: Record<string, unknown> = {}) => ({
    series: 7,
    source: 'NL-1',
    agency: 'RWS',
    ts: T,
    value: 123.4,
    flags: 0,
    estimate: false,
    issuedAt: T,
    issuedInferred: true,
    providerSegmentEnd: null,
    band: { kind: 'p10p90', lo: 100, hi: 150 },
    horizonEnd: '2026-10-07T10:00:00.000Z',
    state: 'low',
    basis,
    ...over,
  });
  const ok = (o: Record<string, unknown>) => SnapshotForecast.safeParse(entry(o)).success;

  it('constants: 48 hours ahead, two band kinds, the file and the API bound a run the same', () => {
    expect(FORECAST_AHEAD_MS).toBe(48 * HOUR);
    expect([...FORECAST_BAND_KINDS]).toEqual(['p10p90', 'p25p75']);
    expect(FORECAST_RUN_MAX_POINTS).toBe(FORECAST_MAX_POINTS);
    expect(FORECAST_RUN_MAX_POINTS).toBe(2000);
  });

  describe('SnapshotForecast', () => {
    it('accepts a valid entry, with or without a band, a value or a basis', () => {
      expect(SnapshotForecast.safeParse(entry()).success).toBe(true);
      expect(ok({ band: null })).toBe(true);
      expect(ok({ band: { kind: 'p25p75', lo: 0, hi: 0 } })).toBe(true);
      expect(ok({ value: null, flags: FORECAST_FLAG_BITS.below_floor })).toBe(true);
      expect(ok({ value: null, flags: FORECAST_FLAG_BITS.censored })).toBe(true);
      expect(ok({ state: 'no_ref', basis: null })).toBe(true);
      expect(ok({ providerSegmentEnd: '2026-10-05T12:00:00.000Z', estimate: true, issuedInferred: false })).toBe(true);
      for (const source of ['NL-1', 'DE-2', 'DE-3', 'FR-4', 'LU-3', 'CH-4']) expect(ok({ source }), source).toBe(true);
    });

    it('refuses a flag bit the forecast mask does not know, and a negative or fractional one', () => {
      const bits = Object.values(FORECAST_FLAG_BITS);
      expect(bits).toEqual([16, 128, 256, 1024]);
      expect(ok({ flags: bits.reduce((a, b) => a | b, 0) })).toBe(true);
      for (const flags of [1, 2, 4, 8, 32, 64, 512, 2048, 4096, 16 | 1, 1024 | 2, -1, 1.5])
        expect(ok({ flags }), `${flags}`).toBe(false);
    });

    it('refuses an agency with markup or digits (ours, never provider text)', () => {
      for (const agency of [
        '<b>BfG</b>',
        'BfG2',
        '<img src=x onerror=alert(1)>',
        'B&fG',
        'BfG\n',
        '',
        '1BfG',
        ' BfG',
        'B'.repeat(41),
      ])
        expect(ok({ agency }), JSON.stringify(agency)).toBe(false);
      for (const agency of ['BfG', 'AGE', 'Vigicrues', 'RWS', 'BAFU', 'LU AGE', 'Rhine-Meuse'])
        expect(ok({ agency }), agency).toBe(true);
    });

    it('refuses a canary or any other source id that is not a catalogue source', () => {
      for (const source of ['CANARY-OWNER', 'CANARY-WITHHELD', 'NL-0', 'NL-100', 'XX-1', 'nl-1', 'NL1', '', 'NL-1 '])
        expect(ok({ source }), source).toBe(false);
    });

    it('refuses a band kind outside the two, a band with a missing or null bound and an unknown key', () => {
      for (const kind of ['p05p95', 'p30p70', 'minmax', 'p10p90 ', ''])
        expect(ok({ band: { kind, lo: 1, hi: 2 } }), kind).toBe(false);
      expect(ok({ band: { kind: 'p10p90', lo: null, hi: 2 } })).toBe(false);
      expect(ok({ band: { kind: 'p10p90', lo: 1 } })).toBe(false);
      expect(ok({ band: { kind: 'p10p90', lo: 1, hi: 2, vmin: 0 } })).toBe(false);
      expect(ok({ band: {} })).toBe(false);
    });

    it('is strict: an unknown key, a state outside the scale, a bad time or series, a basis with a canary source', () => {
      expect(ok({ extra: 1 })).toBe(false);
      expect(ok({ state: 'critical' })).toBe(false);
      expect(ok({ ts: '2026-10-05' })).toBe(false);
      expect(ok({ ts: '2026-10-05T10:00:00' })).toBe(false);
      expect(ok({ series: 0 })).toBe(false);
      expect(ok({ series: 1.5 })).toBe(false);
      expect(ok({ series: 2_147_483_648 })).toBe(false);
      expect(ok({ value: '1' })).toBe(false);
      expect(ok({ basis: { ...basis, source: 'CANARY-OWNER' } })).toBe(false);
      expect(ok({ basis: { ...basis, extra: 1 } })).toBe(false);
      const { horizonEnd: _gone, ...rest } = entry();
      expect(SnapshotForecast.safeParse(rest).success).toBe(false);
    });
  });

  describe('Snapshot', () => {
    const snap = (extra: Record<string, unknown> = {}) => ({ t: T, values: [], ...extra });

    it('is valid with and without `forecasts` (P4 answers carry none), and `values` stays required', () => {
      expect(Snapshot.safeParse(snap()).success).toBe(true);
      expect(Snapshot.safeParse(snap({ forecasts: [] })).success).toBe(true);
      expect(Snapshot.safeParse(snap({ forecasts: [entry(), entry({ series: 8, source: 'CH-4' })] })).success).toBe(
        true,
      );
      expect('forecasts' in Snapshot.parse(snap())).toBe(false);
      expect(Snapshot.safeParse({ t: T, forecasts: [] }).success).toBe(false);
      expect(Snapshot.safeParse(snap({ forecasts: [entry({ source: 'CANARY-OWNER' })] })).success).toBe(false);
      expect(Snapshot.safeParse(snap({ forecasts: [{ ...entry(), qc: 0 }] })).success).toBe(false);
      expect(Snapshot.safeParse(snap({ forecast: [] })).success).toBe(false);
    });

    it('bounds `forecasts` like `values`', () => {
      expect(Snapshot.safeParse(snap({ forecasts: Array.from({ length: MAX_POINTS }, () => entry()) })).success).toBe(
        true,
      );
      expect(
        Snapshot.safeParse(snap({ forecasts: Array.from({ length: MAX_POINTS + 1 }, () => entry()) })).success,
      ).toBe(false);
    });
  });

  describe('SeriesForecast', () => {
    const point = (i: number, over: Record<string, unknown> = {}) => ({
      ts: new Date(Date.parse(T) + i * 600_000).toISOString(),
      value: 100 + i,
      lo: 90 + i,
      hi: 110 + i,
      flags: 0,
      ...over,
    });
    const runBody = (points: unknown[], over: Record<string, unknown> = {}) => ({
      source: 'NL-1',
      agency: 'RWS',
      issuedAt: T,
      issuedInferred: true,
      fetchedAt: T,
      providerSegmentEnd: null,
      kind: 'deterministic',
      stepSeconds: 600,
      bandKind: 'p10p90',
      horizonEnd: '2026-10-07T10:00:00.000Z',
      points,
      ...over,
    });
    const answer = (run: unknown) => ({ series: 7, asof: T, run });
    const ok = (run: unknown) => SeriesForecast.safeParse(answer(run)).success;

    it('answers `run: null` where the series has no current run', () => {
      expect(SeriesForecast.safeParse(answer(null)).success).toBe(true);
      expect(SeriesForecast.safeParse({ series: 7, asof: T }).success).toBe(false);
      expect(SeriesForecast.safeParse({ series: 0, asof: T, run: null }).success).toBe(false);
      expect(SeriesForecast.safeParse({ series: 7, asof: '2026-10-05', run: null }).success).toBe(false);
      expect(SeriesForecast.safeParse({ ...answer(null), extra: 1 }).success).toBe(false);
    });

    it('holds 1 to 2000 points', () => {
      expect(ok(runBody([point(0)]))).toBe(true);
      expect(ok(runBody([]))).toBe(false);
      expect(ok(runBody(Array.from({ length: 2000 }, (_, i) => point(i))))).toBe(true);
      expect(ok(runBody(Array.from({ length: 2001 }, (_, i) => point(i))))).toBe(false);
    });

    it('accepts a point with no value, no band or a flag, and refuses an unknown flag bit or a stray key', () => {
      expect(ok(runBody([point(0, { value: null, lo: null, hi: null, flags: FORECAST_FLAG_BITS.below_floor })]))).toBe(
        true,
      );
      expect(ok(runBody([point(0, { flags: FORECAST_FLAG_BITS.estimate })], { bandKind: null }))).toBe(true);
      expect(ok(runBody([point(0, { flags: 2 })]))).toBe(false);
      expect(ok(runBody([point(0, { flags: 4096 })]))).toBe(false);
      expect(ok(runBody([point(0, { p10: 1 })]))).toBe(false);
      expect(ok(runBody([point(0, { ts: '2026-10-05' })]))).toBe(false);
    });

    it('refuses a source that is not a catalogue source, a band kind or run kind outside the lists, markup in the agency', () => {
      expect(ok(runBody([point(0)], { source: 'CANARY-OWNER' }))).toBe(false);
      expect(ok(runBody([point(0)], { bandKind: 'p05p95' }))).toBe(false);
      expect(ok(runBody([point(0)], { bandKind: 'p25p75' }))).toBe(true);
      expect(ok(runBody([point(0)], { kind: 'ensemble' }))).toBe(false);
      for (const kind of ['deterministic', 'quantiles', 'ensemble_summary'])
        expect(ok(runBody([point(0)], { kind })), kind).toBe(true);
      expect(ok(runBody([point(0)], { agency: '<i>BfG</i>' }))).toBe(false);
      expect(ok(runBody([point(0)], { stepSeconds: 0 }))).toBe(false);
      expect(ok(runBody([point(0)], { stepSeconds: null }))).toBe(true);
      expect(ok(runBody([point(0)], { extra: 1 }))).toBe(false);
    });
  });

  describe('SeriesForecastQuery', () => {
    it('takes an optional `asof` instant and nothing else', () => {
      expect(SeriesForecastQuery.safeParse({}).success).toBe(true);
      expect(SeriesForecastQuery.safeParse({ asof: '2026-10-05T10:00Z' }).success).toBe(true);
      expect(SeriesForecastQuery.safeParse({ asof: '2026-10-05' }).success).toBe(false);
      expect(SeriesForecastQuery.safeParse({ foo: '1' }).success).toBe(false);
      expect(SeriesForecastQuery.safeParse({ asof: '2026-10-05T10:00:00Z', t: '2026-10-05T10:00:00Z' }).success).toBe(
        false,
      );
    });
  });

  describe('Meta.forecastHorizons', () => {
    const meta = (forecastHorizons: unknown) => ({
      now: T,
      dataEpoch: T,
      displayStart: T,
      build: 'dev',
      sources: [{ id: 'NL-1', attribution: [] }],
      forecastHorizons,
    });
    const ok = (h: unknown) => Meta.safeParse(meta(h)).success;

    it('lists a catalogue source with whole hours from 1 to 48, and is required', () => {
      expect(ok([])).toBe(true);
      expect(ok([{ source: 'NL-1', hours: 48 }])).toBe(true);
      expect(ok([{ source: 'CH-4', hours: 1 }])).toBe(true);
      for (const hours of [0, -1, 49, 120, 1.5, Number.NaN, '48', null])
        expect(ok([{ source: 'NL-1', hours }]), `${hours}`).toBe(false);
      expect(ok([{ source: 'CANARY-OWNER', hours: 48 }])).toBe(false);
      expect(ok([{ source: 'NL-1', hours: 48, extra: 1 }])).toBe(false);
      expect(ok([{ source: 'NL-1' }])).toBe(false);
      const { forecastHorizons: _gone, ...without } = meta([]);
      expect(Meta.safeParse(without).success).toBe(false);
    });

    it('holds at most 20 sources', () => {
      expect(ok(Array.from({ length: 20 }, () => ({ source: 'NL-1', hours: 48 })))).toBe(true);
      expect(ok(Array.from({ length: 21 }, () => ({ source: 'NL-1', hours: 48 })))).toBe(false);
    });
  });
});
