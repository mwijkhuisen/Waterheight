import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normaliseBasin, normaliseMeta, normaliseSeries } from '../../src/adapters/de-1/normalise.ts';
import { parseMeasurements, parseStations } from '../../src/adapters/de-1/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// DE-1 PEGELONLINE: parse + normalise of real recorded payloads equals the
// committed golden files (invariant 9). `UPDATE_GOLDEN=1` rewrites them; a
// golden change is reviewed like code.

const registry = registryOf('DE-1');
const EMMERICH_W = '9598e4cb-0849-401e-bba0-689234b27644/W';
const RUHRWEHR_W = '12a3037f-cbf3-49d3-8da5-77fb38730bba/W';
const MAXAU_Q = 'b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea/Q';
const KAUB_W = '1d26e504-7f9e-480a-b52c-5932be6549ab/W';

function ctx(name: string, variant = ''): Context {
  return { registry, fetchedAt: Date.parse(rawFixture('DE-1', name).meta.recorded_at), variant };
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('DE-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const series = (name: string, variant: string) =>
  normaliseSeries(parseMeasurements(rawFixture('DE-1', name).body), ctx(name, variant));

describe('golden files (real payloads)', () => {
  it('basin stations.json: the current value of every registered W and Q series', () => {
    const out = normaliseBasin(parseStations(rawFixture('DE-1', 'de-1-basin').body), ctx('de-1-basin'));
    expect(out).toEqual(golden('de-1-basin', out));
    expect(out.unknown).toBe(0);
    // Spot checks against the raw payload (2026-09-29 15:43 CEST).
    // PANNERDENSE KOP (an RWS mirror) published 99999.0: dropped, never stored.
    expect(out.dropped).toEqual({ sentinel: 1 });
    expect(out.obs).toHaveLength(237);
    expect(out.obs.some((r) => r.value >= 99999)).toBe(false);
    expect(out.obs.find((r) => r.series === '3046493f-971f-4d22-9f29-7ef8e3b645a4/W')).toBeUndefined();
    // EMMERICH W "2026-09-29T15:30:00+02:00", -28.0: a negative stage is a valid value.
    expect(out.obs.find((r) => r.series === EMMERICH_W)).toEqual({
      series: EMMERICH_W,
      ts: '2026-09-29T13:30:00.000Z',
      value: -28,
      qc: QC.RAW,
    });
    // EMMERICH Q "2026-09-19T16:45:00+02:00", 678.0: ten days stale at the provider, stored as published.
    expect(out.obs.find((r) => r.series === EMMERICH_W.replace('/W', '/Q'))).toMatchObject({
      ts: '2026-09-19T14:45:00.000Z',
      value: 678,
    });
    expect(out.obs.filter((r) => r.value < 0)).toHaveLength(7);
    // RUHRWEHR OW: 25.0 m+NN is stored as 2500 cm.
    expect(out.obs.find((r) => r.series === RUHRWEHR_W)?.value).toBe(2500);
    // A 1-minute tidal gauge (PAPENBURG) keeps its off-grid current value as published.
    expect(out.obs.find((r) => r.series === 'ec4a598d-773d-44c1-935e-2053b54e45a3/W')?.ts).toBe(
      '2026-09-29T13:39:00.000Z',
    );
  });

  it('measurements.json PT6H (EMMERICH W): negative stages, offsets parsed', () => {
    const out = series('de-1-series', EMMERICH_W);
    expect(out).toEqual(golden('de-1-series', out));
    expect(out.obs).toHaveLength(24);
    // First raw point: "2026-09-29T09:45:00+02:00", -29.0.
    expect(out.obs[0]).toEqual({ series: EMMERICH_W, ts: '2026-09-29T07:45:00.000Z', value: -29, qc: QC.RAW });
    expect(out.dropped).toEqual({});
  });

  it('a 1-minute m+NN series (RUHRWEHR OW) is thinned to 15 minutes and converted ×100', () => {
    const out = series('de-1-series-ruhrwehr-ow-w', RUHRWEHR_W);
    expect(out).toEqual(golden('de-1-series-ruhrwehr-ow-w', out));
    // 344 one-minute points from 03:17 to 09:00 CEST: the partial bucket 03:15 is dropped, 03:30 … 09:00 kept.
    expect(out.obs).toHaveLength(23);
    expect(out.dropped).toEqual({ thinned: 321 });
    expect(out.obs[0]).toEqual({ series: RUHRWEHR_W, ts: '2026-09-30T01:30:00.000Z', value: 2500, qc: QC.RAW });
    expect(out.obs.at(-1)?.ts).toBe('2026-09-30T07:00:00.000Z');
    for (const r of out.obs) expect(Date.parse(r.ts) % 900_000).toBe(0);
  });

  it('a discharge series (MAXAU Q)', () => {
    const out = series('de-1-series-maxau-q', MAXAU_Q);
    expect(out).toEqual(golden('de-1-series-maxau-q', out));
    expect(out.obs[0]).toEqual({ series: MAXAU_Q, ts: '2026-09-30T01:30:00.000Z', value: 328, qc: QC.RAW });
  });

  it('the 31-day seed window (KAUB W) crosses a month boundary and keeps every point', () => {
    const out = series('de-1-series-kaub-w-p31d', KAUB_W);
    expect(out).toEqual(golden('de-1-series-kaub-w-p31d', out));
    expect(out.obs).toHaveLength(2973);
    expect(out.obs[0]?.ts).toBe('2026-08-30T07:30:00.000Z');
    expect(out.obs.at(-1)).toEqual({ series: KAUB_W, ts: '2026-09-30T07:15:00.000Z', value: 1, qc: QC.RAW });
    expect(Math.min(...out.obs.map((r) => r.value))).toBe(-3);
    expect(new Set(out.obs.map((r) => r.ts.slice(0, 7)))).toEqual(new Set(['2026-08', '2026-09']));
  });

  it('daily metadata: the gauge zero of every registered series that has one', () => {
    const out = normaliseMeta(parseStations(rawFixture('DE-1', 'de-1-meta').body), ctx('de-1-meta'));
    expect(out).toEqual(golden('de-1-meta', out));
    expect(out.obs).toEqual([]);
    expect(out.gaugeZeros).toHaveLength(181);
    const zero = (key: string) => out.gaugeZeros.find((z) => z.series === key);
    expect(zero('a6ee8177-107b-47dd-bcfd-30960ccc6e9c/W')).toEqual({
      series: 'a6ee8177-107b-47dd-bcfd-30960ccc6e9c/W',
      value_m: 35.038,
      datum: 'NHN',
      valid_from: '2019-11-01',
    });
    // Basel-Rheinhalle: "mü.M." is the Swiss datum.
    expect(zero('94f6eff1-4f3f-4850-82e0-a086198e9ffd/W')).toMatchObject({ value_m: 240, datum: 'LN02' });
    expect(new Set(out.gaugeZeros.map((z) => z.datum))).toEqual(new Set(['NHN', 'NN', 'LN02']));
  });
});

describe('empty and error payloads (real)', () => {
  it('[] with HTTP 200 is a valid, empty payload', () => {
    const out = series('de-1-series-empty', EMMERICH_W);
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });

  it('the JSON body of a 404 is not a measurements payload', () => {
    const { body } = rawFixture('DE-1', 'de-1-series-404');
    expect(() => parseMeasurements(body)).toThrow(SchemaDrift);
    expect(() => parseStations(body)).toThrow(SchemaDrift);
  });
});

describe('synthetic payloads [U]', () => {
  it('the fall-back night: both passes of the repeated hour, the sentinel, a repeated and a future timestamp', () => {
    const out = series('de-1-series-dst.synthetic', EMMERICH_W);
    expect(out).toEqual(golden('de-1-series-dst.synthetic', out));
    const at = (ts: string) => out.obs.find((r) => r.ts === ts)?.value;
    // 02:00–02:59 local occurs twice: +02:00 is 00:00Z–00:59Z, +01:00 is 01:00Z–01:59Z.
    expect(at('2026-10-25T00:15:00.000Z')).toBe(104);
    expect(at('2026-10-25T01:15:00.000Z')).toBe(108);
    expect(out.obs.map((r) => r.ts)).toEqual([...new Set(out.obs.map((r) => r.ts))].sort());
    expect(out.obs).toHaveLength(12);
    expect(at('2026-10-25T02:30:00.000Z')).toBe(-11);
    expect(out.dropped).toEqual({ duplicate: 1, sentinel: 1, future: 1 });
  });

  it('a mutated payload is a SchemaDrift with a fixed code and a schema path', () => {
    const { body } = rawFixture('DE-1', 'de-1-basin-drift.synthetic');
    let err: unknown;
    try {
      parseStations(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaDrift);
    expect(err).toMatchObject({ code: 'unrecognized_keys', path: '0.timeseries.0.currentMeasurement' });
  });
});

describe('rules', () => {
  const at = Date.parse('2026-09-29T13:43:26Z');
  const base: Context = { registry, fetchedAt: at, variant: EMMERICH_W };
  const points = (...p: [string, number][]) => p.map(([timestamp, value]) => ({ timestamp, value }));

  it('a series the registry does not know is counted, never registered', () => {
    const variant = '00000000-0000-4000-8000-000000000000/W';
    expect(normaliseSeries(points(['2026-09-29T15:00:00+02:00', 1]), { ...base, variant })).toMatchObject({
      obs: [],
      unknown: 1,
    });
    const stations = parseStations(rawFixture('DE-1', 'de-1-basin').body);
    const fewer = new Map([...registry].filter(([key]) => key !== EMMERICH_W));
    const out = normaliseBasin(stations, { ...base, registry: fewer });
    expect(out.unknown).toBe(1);
    expect(out.obs.find((r) => r.series === EMMERICH_W)).toBeUndefined();
  });

  it('only W and Q are read; every other timeseries is ignored, not even counted as unknown', () => {
    const stations = parseStations(rawFixture('DE-1', 'de-1-basin').body).map((s) => ({
      ...s,
      timeseries: s.timeseries.map((t) => (`${s.uuid}/${t.shortname}` === EMMERICH_W ? { ...t, shortname: 'WT' } : t)),
    }));
    const out = normaliseBasin(stations, base);
    expect(out.unknown).toBe(0);
    expect(out.obs).toHaveLength(236);
    expect(out.obs.find((r) => r.series === EMMERICH_W)).toBeUndefined();
    // The daily metadata call carries WT, LT, … for all 786 stations: none of them yields a row.
    const meta = normaliseBasin(parseStations(rawFixture('DE-1', 'de-1-meta').body), base);
    expect(meta.obs).toEqual([]);
  });

  it('a payload unit that differs from the declared unit drops that series and is counted', () => {
    const stations = parseStations(rawFixture('DE-1', 'de-1-basin').body).map((s) => ({
      ...s,
      timeseries: s.timeseries.map((t) => (`${s.uuid}/${t.shortname}` === EMMERICH_W ? { ...t, unit: 'm+NN' } : t)),
    }));
    const out = normaliseBasin(stations, base);
    expect(out.dropped.unit_mismatch).toBe(1);
    expect(out.obs.find((r) => r.series === EMMERICH_W)).toBeUndefined();
  });

  it('rejects a timestamp more than 15 minutes ahead and one older than the provider window', () => {
    const out = normaliseSeries(
      points(['2026-09-29T15:58:00+02:00', 1], ['2026-09-29T15:59:00+02:00', 2], ['2026-08-01T00:00:00+02:00', 3]),
      base,
    );
    expect(out.obs.map((r) => r.value)).toEqual([1]);
    expect(out.dropped).toEqual({ future: 1, too_old: 1 });
  });

  it('a timestamp without an offset, a wrong variant and an out-of-range value', () => {
    expect(() => normaliseSeries(points(['2026-09-29T15:00:00', 1]), base)).toThrow(SchemaDrift);
    expect(() => normaliseSeries([], { ...base, variant: '' })).toThrow(SchemaDrift);
    expect(() => normaliseSeries([], { ...base, variant: 'x/W' })).toThrow(SchemaDrift);
    const out = normaliseSeries(points(['2026-09-29T15:00:00+02:00', 88888]), base);
    expect(out.obs[0]).toMatchObject({ value: 88888, qc: QC.RAW | QC.RANGE });
  });

  it('an unknown gauge-zero unit is counted; a malformed validFrom is drift', () => {
    const [station] = parseStations(rawFixture('DE-1', 'de-1-meta').body).filter((s) =>
      s.timeseries.some((t) => t.gaugeZero && registry.has(`${s.uuid}/${t.shortname}`)),
    );
    const withZero = (gaugeZero: { unit: string; value: number; validFrom: string }) =>
      [
        { ...station, timeseries: station?.timeseries.map((t) => (t.gaugeZero ? { ...t, gaugeZero } : t)) },
      ] as Parameters<typeof normaliseMeta>[0];
    expect(normaliseMeta(withZero({ unit: 'm ü. A.', value: 1, validFrom: '2020-01-01' }), base).dropped).toEqual({
      unknown_zero_unit: 1,
    });
    expect(() => normaliseMeta(withZero({ unit: 'm. ü. NHN', value: 1, validFrom: '01.01.2020' }), base)).toThrow(
      SchemaDrift,
    );
  });

  it('rejects oversized and non-JSON bodies', () => {
    expect(() => parseMeasurements(Buffer.from('<html>'))).toThrow(SchemaDrift);
    expect(() => parseStations(Buffer.from('{"a":'))).toThrow(SchemaDrift);
    const big = JSON.stringify(
      Array.from({ length: 60_001 }, () => ({ timestamp: '2026-09-29T15:00:00+02:00', value: 1 })),
    );
    expect(() => parseMeasurements(Buffer.from(big))).toThrow(SchemaDrift);
  });
});

describe('property and fuzz tests', () => {
  const at = Date.parse('2026-09-29T13:43:26Z');
  const base: Context = { registry, fetchedAt: at, variant: EMMERICH_W };
  const offsetTs = fc
    .tuple(fc.integer({ min: -50 * 96, max: 8 }), fc.constantFrom('+02:00', '+01:00', 'Z'))
    .map(([quarter, offset]) => {
      const ms = Math.floor(at / 900_000) * 900_000 + quarter * 900_000;
      const shift = offset === 'Z' ? 0 : Number(offset.slice(1, 3)) * 3_600_000;
      return { ms, text: `${new Date(ms + shift).toISOString().slice(0, 19)}${offset}` };
    });
  const value = fc.oneof(
    fc.integer({ min: -500, max: 1500 }),
    fc.constant(99999),
    fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  );
  const payload = fc.array(fc.tuple(offsetTs, value), { maxLength: 300 });

  it('normalise never stores a sentinel, a future or a repeated timestamp, and is idempotent', () => {
    fc.assert(
      fc.property(payload, (rows) => {
        const pts = rows.map(([t, v]) => ({ timestamp: t.text, value: v }));
        const out = normaliseSeries(pts, base);
        for (const r of out.obs) {
          ObsRow.parse(r);
          expect(r.value).not.toBe(99999);
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(at + 15 * 60_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(at - 45 * 86_400_000);
        }
        const times = out.obs.map((r) => r.ts);
        expect(times).toEqual([...new Set(times)].sort());
        // The same payload twice (overlapping windows) gives the same rows.
        expect(normaliseSeries([...pts, ...pts], base).obs).toEqual(out.obs);
      }),
      { numRuns: 200 },
    );
  });

  it('two overlapping windows of one series agree on every timestamp they share', () => {
    fc.assert(
      fc.property(payload, fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 300 }), (rows, a, b) => {
        const unique = [...new Map(rows.map(([t, v]) => [t.ms, { timestamp: t.text, value: v }])).values()];
        const first = normaliseSeries(unique.slice(0, Math.max(a, b)), base).obs;
        const second = normaliseSeries(unique.slice(Math.min(a, b)), base).obs;
        const seen = new Map(first.map((r) => [r.ts, r.value]));
        for (const r of second) if (seen.has(r.ts)) expect(r.value).toBe(seen.get(r.ts));
      }),
      { numRuns: 100 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (doc) => {
        const body = Buffer.from(JSON.stringify(doc));
        for (const parse of [parseMeasurements, parseStations]) {
          try {
            parse(body);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
    const doc = JSON.parse(rawFixture('DE-1', 'de-1-basin').body.toString('utf8')).slice(0, 20);
    const mutation = fc.tuple(
      fc.integer({ min: 0, max: 19 }),
      fc.constantFrom('uuid', 'timeseries', 'water', 'number', 'km'),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(mutation, ([i, key, junk]) => {
        const copy = structuredClone(doc);
        copy[i][key] = junk;
        try {
          const out = normaliseBasin(parseStations(Buffer.from(JSON.stringify(copy))), base);
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 200 },
    );
  });
});
