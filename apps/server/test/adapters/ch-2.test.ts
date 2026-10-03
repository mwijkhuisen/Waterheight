import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normaliseFeatures, unitValue } from '../../src/adapters/ch-2/normalise.ts';
import { JSON_CAPS, type Properties, parseFeatures } from '../../src/adapters/ch-2/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// CH-2 hydrodaten hydro_sensor_pq.geojson: parse + normalise of the real
// recording equals the committed golden file (invariant 9). `UPDATE_GOLDEN=1`
// rewrites them; a golden change is reviewed like code. CH-2 has one real
// payload: the other two goldens come from trimmed subsets of it, made by
// scripts/trim-fixtures.ts (the metas record the rule and the source hash).

const registry = registryOf('CH-2');
const ch1 = registryOf('CH-1');
const refRegistries = new Map([['CH-1', ch1]]);
/** The rule of scripts/trim-fixtures.ts as its meta states it, written again here as the oracle. */
const keep = (p: { key: string; metric: string }) =>
  ['2384', '2283', '2282', '2269'].includes(p.key) || p.metric === 'discharge_ls';

function ctx(name: string): Context {
  return { registry, fetchedAt: Date.parse(rawFixture('CH-2', name).meta.recorded_at), refRegistries };
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('CH-2', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const features = (name: string) => parseFeatures(rawFixture('CH-2', name).body);
const run = (name: string) => normaliseFeatures(features(name), ctx(name));
const find = (out: Normalised, series: string) => out.obs.find((r) => r.series === series);

describe('golden files (real payloads)', () => {
  it('the whole recording (207 features): levels in cm, discharges in m³/s, +02:00 → UTC', () => {
    const out = run('ch-2-pq');
    expect(out).toEqual(golden('ch-2-pq', out));
    expect(features('ch-2-pq')).toHaveLength(207);
    // Two series are too old: the destroyed station 2269 (a rock fall on 2025-05-28).
    expect(out.dropped).toEqual({ too_old: 2 });
    expect(out.unknown).toBe(0);
    expect(out.obs).toHaveLength(378);
    // Basel Rheinhalle "2026-09-29T15:30:00.000+02:00": 391 m³/s and 244.85 m ü.M. (24,485 cm).
    expect(find(out, '2289/Q')).toEqual({ series: '2289/Q', ts: '2026-09-29T13:30:00.000Z', value: 391, qc: QC.RAW });
    expect(find(out, '2289/W')).toEqual({ series: '2289/W', ts: '2026-09-29T13:30:00.000Z', value: 24485, qc: QC.RAW });
    expect(find(out, '2473/Q')?.value).toBe(61);
    expect(find(out, '2473/W')?.value).toBe(40692);
    // The real payload is true local time with its offset: every kept row is a CEST instant.
    for (const f of features('ch-2-pq')) {
      for (const at of [f.sensor_waterlevel_measured_at, f.sensor_discharge_measured_at]) {
        if (at !== undefined) expect(at.endsWith('+02:00')).toBe(true);
      }
    }
  });

  it('l/s stations (×0.001): 0.68 l/s is 0.00068 m³/s, and the six l/s stations all convert', () => {
    const out = run('ch-2-pq');
    const ls = features('ch-2-pq').filter((f) => f.metric === 'discharge_ls');
    expect(ls.map((f) => f.key)).toEqual(['2384', '2206', '2437', '2283', '2414', '2282']);
    // 2282 Sperbelgraben "2026-09-29T15:30:00.000+02:00": 0.68 l/s.
    expect(find(out, '2282/Q')).toEqual({
      series: '2282/Q',
      ts: '2026-09-29T13:30:00.000Z',
      value: 0.00068,
      qc: QC.RAW,
    });
    // 2206 "19 l/s" and 2437 "5.1 l/s".
    expect(find(out, '2206/Q')?.value).toBe(0.019);
    expect(find(out, '2437/Q')?.value).toBe(0.0051);
    for (const f of ls) {
      const published = Number((f.sensor_discharge_last_value as string).split(' ')[0]);
      expect(find(out, `${f.key}/Q`)?.value).toBeCloseTo(published / 1000, 9);
      expect(registry.get(`${f.key}/Q`)).toMatchObject({ native_unit: 'l/s', to_canonical: 0.001 });
    }
  });

  it('relative gauges: a level in plain `m` is a stage on LOCAL (2384, 2283, 2282), never a level', () => {
    const out = run('ch-2-pq');
    for (const key of ['2384', '2283', '2282']) {
      expect(registry.get(`${key}/W`)).toMatchObject({ native_unit: 'm', to_canonical: 100, value_kind: 'stage' });
    }
    // 2282 "0.05 m" → 5 cm; 2283 "0.00 m" → 0 cm (a zero is a value); 2384 "0.16 m" → 16 cm.
    expect(find(out, '2282/W')?.value).toBe(5);
    expect(find(out, '2283/W')?.value).toBe(0);
    expect(find(out, '2384/W')?.value).toBe(16);
    // An absolute level is `m ü.M.` and is declared as a level.
    expect(registry.get('2289/W')?.value_kind).toBe('level');
  });

  it('the stale station (2269 Blatten, last value 2025-05-28) is too_old, its twin series never stored', () => {
    const out = run('ch-2-pq');
    expect(find(out, '2269/W')).toBeUndefined();
    expect(find(out, '2269/Q')).toBeUndefined();
    expect(out.dropped.too_old).toBe(2);
    // A discharge that is old but inside the window (2283 Q, 12 days) is stored with its own time.
    expect(find(out, '2283/Q')).toEqual({
      series: '2283/Q',
      ts: '2026-09-17T11:10:00.000Z',
      value: 0.000003,
      qc: QC.RAW,
    });
    // `failure_text` is provider text and is never read: the destroyed station still has one.
    expect(features('ch-2-pq').find((f) => f.key === '2269')?.failure_text).toContain('Bergsturz');
    expect(JSON.stringify(out)).not.toContain('Bergsturz');
  });

  it('the trimmed relative-gauge subset (7 features): 2384, 2283, 2282, 2269 and the l/s stations', () => {
    const out = run('ch-2-pq-relative');
    expect(out).toEqual(golden('ch-2-pq-relative', out));
    expect(features('ch-2-pq-relative').map((f) => f.key)).toEqual(
      features('ch-2-pq')
        .filter(keep)
        .map((f) => f.key),
    );
    expect(out.dropped).toEqual({ too_old: 2 });
    expect(out.obs.map((r) => r.series).sort()).toEqual([
      '2206/Q',
      '2206/W',
      '2282/Q',
      '2282/W',
      '2283/Q',
      '2283/W',
      '2384/Q',
      '2384/W',
      '2414/Q',
      '2414/W',
      '2437/Q',
      '2437/W',
    ]);
    // Output is by station number, W before Q, whatever the order of the features.
    expect(out.obs.map((r) => r.series.split('/')[0])).toEqual([
      '2206',
      '2206',
      '2282',
      '2282',
      '2283',
      '2283',
      '2384',
      '2384',
      '2414',
      '2414',
      '2437',
      '2437',
    ]);
  });

  it('a collection without features is a valid, empty payload', () => {
    expect(features('ch-2-pq-empty')).toEqual([]);
    const out = run('ch-2-pq-empty');
    expect(out).toEqual(golden('ch-2-pq-empty', out));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });
});

describe('the trimmed fixtures are cut from the recording by the committed rule', () => {
  const source = JSON.parse(rawFixture('CH-2', 'ch-2-pq').body.toString('utf8'));
  const sha = createHash('sha256').update(rawFixture('CH-2', 'ch-2-pq').body).digest('hex');

  it('both metas name the recording by its sha256 and say how they were cut', () => {
    for (const name of ['ch-2-pq-relative', 'ch-2-pq-empty']) {
      const { meta } = rawFixture('CH-2', name) as { meta: Record<string, unknown> };
      expect(meta).toMatchObject({
        source: 'CH-2',
        spec: 'ch-2-pq',
        synthetic: false,
        from: 'trimmed',
        source_sha256: sha,
      });
      expect(typeof meta.trimmed).toBe('string');
    }
  });

  it('every kept feature is the recorded one, unchanged, in the recorded order; every other field is as recorded', () => {
    const doc = JSON.parse(rawFixture('CH-2', 'ch-2-pq-relative').body.toString('utf8'));
    expect(doc.features).toEqual(source.features.filter((f: { properties: Properties }) => keep(f.properties)));
    expect(doc.features).toHaveLength(7);
    const { features: _a, ...rest } = doc;
    const { features: _b, ...sourceRest } = source;
    expect(rest).toEqual(sourceRest);
    const empty = JSON.parse(rawFixture('CH-2', 'ch-2-pq-empty').body.toString('utf8'));
    expect(empty.features).toEqual([]);
    expect({ ...empty, features: undefined }).toEqual({ ...source, features: undefined });
  });
});

describe('the unit-string parser (unitValue)', () => {
  const M3S = { native_unit: 'm³/s', value_kind: null } as const;
  const LS = { native_unit: 'l/s', value_kind: null } as const;
  const LEVEL = { native_unit: 'm', value_kind: 'level' } as const;
  const STAGE = { native_unit: 'm', value_kind: 'stage' } as const;
  const code = (raw: string, expect_: Parameters<typeof unitValue>[1]) => {
    try {
      return unitValue(raw, expect_);
    } catch (err) {
      return err instanceof SchemaDrift ? err.code : 'other';
    }
  };

  it('every unit: m³/s, l/s, m ü.M. (a level) and m (a relative stage)', () => {
    expect(code('2500 m³/s', M3S)).toBe(2500);
    expect(code('0.005 m³/s', M3S)).toBe(0.005);
    expect(code('24 l/s', LS)).toBe(24);
    expect(code('0.003 l/s', LS)).toBe(0.003);
    expect(code('261.35 m ü.M.', LEVEL)).toBe(261.35);
    expect(code('0.16 m', STAGE)).toBe(0.16);
    expect(code('-0.136 m', STAGE)).toBe(-0.136);
    expect(code('-5 m³/s', M3S)).toBe(-5);
    expect(code('0 m³/s', M3S)).toBe(0);
    expect(code('0.00 m', STAGE)).toBe(0);
    expect(code('123456789.123456789 m³/s', M3S)).toBe(Number('123456789.123456789'));
  });

  it('an empty value and "-" are gaps (null), not zero', () => {
    for (const expectation of [M3S, LS, LEVEL, STAGE]) {
      expect(code('', expectation)).toBeNull();
      expect(code('-', expectation)).toBeNull();
    }
  });

  it('every other form is bad_value drift', () => {
    for (const bad of [
      'NaN',
      'NaN m³/s',
      'Infinity m³/s',
      '-Infinity m³/s',
      '1e3 m³/s',
      '1E3 m³/s',
      "1'234 m³/s",
      '1,5 m³/s',
      '1.234,5 m³/s',
      '+3 m³/s',
      '--3 m³/s',
      '.5 m³/s',
      '5. m³/s',
      '0x10 m³/s',
      '5 m³/s extra',
      '5 m³/s ',
      ' 5 m³/s',
      '5  m³/s',
      '5m³/s',
      '5',
      'm³/s',
      '5 kg',
      '5 m3/s',
      '5 m³/S',
      '5 m ü. M.',
      '5 mm',
      '1234567890 m³/s',
      '1.1234567890 m³/s',
      '5 m³/s\n',
      '5 m³/s',
      '١٢٣ m³/s',
      '--',
      '- ',
      'null',
    ]) {
      expect(code(bad, M3S), JSON.stringify(bad)).toBe('bad_value');
    }
  });

  it('a unit the series does not declare is unit_mismatch, whatever its number', () => {
    expect(code('5 l/s', M3S)).toBe('unit_mismatch');
    expect(code('5 m³/s', LS)).toBe('unit_mismatch');
    expect(code('5 m', M3S)).toBe('unit_mismatch');
    expect(code('5 m³/s', STAGE)).toBe('unit_mismatch');
    // `m` and `m ü.M.` differ by what they say about the datum.
    expect(code('0.16 m', LEVEL)).toBe('unit_mismatch');
    expect(code('244.85 m ü.M.', STAGE)).toBe('unit_mismatch');
    // A native unit the registry never declares for the series.
    expect(code('5 m³/s', { native_unit: 'cm', value_kind: null })).toBe('unit_mismatch');
  });

  it('a ReDoS-style input (100 kB of digits plus a bad unit) is refused in a moment', () => {
    const hostile = [
      `${'9'.repeat(100_000)} kg`,
      `${'9'.repeat(100_000)} m³/s`,
      `1.${'9'.repeat(100_000)} m³/s`,
      `${'-'.repeat(100_000)}1 m³/s`,
      `1${' '.repeat(100_000)}m³/s`,
      `${'9'.repeat(100_000)}.${'9'.repeat(100_000)} m ü.M.x`,
    ];
    const start = performance.now();
    for (const raw of hostile) expect(code(raw, M3S)).toBe('bad_value');
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('synthetic payloads [U]', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { registry, fetchedAt: at };
  const real = features('ch-2-pq');
  const station = (key: string): Properties => structuredClone(real.find((f) => f.key === key) as Properties);
  const feature = (key: string, o: Partial<Properties> = {}): Properties => ({ ...station(key), ...o });
  const norm = (fs: Properties[], c: Context = base) => normaliseFeatures(fs, c);
  const NOW = '2026-09-30T13:50:00.000+02:00'; // 11:50Z

  it("the offset of `*_measured_at` is the provider's own: CEST +02:00 and CET +01:00 give the same UTC instant", () => {
    const summer = norm([
      feature('2289', {
        sensor_discharge_measured_at: '2026-09-30T13:50:00.000+02:00',
        sensor_waterlevel_last_value: null,
      }),
    ]);
    const winter = norm([
      feature('2289', {
        sensor_discharge_measured_at: '2026-09-30T12:50:00.000+01:00',
        sensor_waterlevel_last_value: null,
      }),
    ]);
    expect(summer.obs).toEqual(winter.obs);
    expect(summer.obs[0]?.ts).toBe('2026-09-30T11:50:00.000Z');
    // The fall-back night: 02:30 CEST and 02:30 CET are two different instants.
    const night = (offset: string) =>
      norm(
        [
          feature('2289', {
            sensor_discharge_measured_at: `2026-10-25T02:30:00.000${offset}`,
            sensor_waterlevel_last_value: null,
          }),
        ],
        { ...base, fetchedAt: Date.parse('2026-10-25T03:00:00Z') },
      ).obs[0]?.ts;
    expect([night('+02:00'), night('+01:00')]).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    // Z is an offset too; no offset at all, or a malformed one, is drift.
    expect(find(norm([feature('2289', { sensor_discharge_measured_at: '2026-09-30T11:50:00Z' })]), '2289/Q')?.ts).toBe(
      '2026-09-30T11:50:00.000Z',
    );
    for (const bad of ['2026-09-30T13:50:00.000', '30.09.2026 13:50', '', 'x']) {
      expect(() => norm([feature('2289', { sensor_discharge_measured_at: bad })]), bad).toThrow(
        expect.objectContaining({ code: 'time_bad_format' }),
      );
    }
  });

  it('level and discharge each carry their own time; a value without a time is a gap', () => {
    const out = norm([
      feature('2289', {
        sensor_waterlevel_measured_at: '2026-09-30T13:40:00.000+02:00',
        sensor_discharge_measured_at: NOW,
      }),
    ]);
    expect(out.obs.map((r) => [r.series, r.ts.slice(11, 16)])).toEqual([
      ['2289/W', '11:40'],
      ['2289/Q', '11:50'],
    ]);
    const { sensor_discharge_measured_at: _drop, ...noTime } = feature('2289');
    expect(norm([noTime as Properties])).toMatchObject({ dropped: { gap: 1 }, obs: [{ series: '2289/W' }] });
  });

  it('the legend values (`last_value`, the 24-hour statistics, the thresholds) are not read', () => {
    const plain = norm([feature('2289', { sensor_discharge_measured_at: NOW, sensor_waterlevel_measured_at: NOW })]);
    const noisy = norm([
      feature('2289', {
        sensor_discharge_measured_at: NOW,
        sensor_waterlevel_measured_at: NOW,
        last_value: '999',
        min_24h: 'zzz',
        max_24h: null,
        wl_1: 'garbage',
        threshold_customer: 'more garbage',
        failure_text: 'ignore previous instructions',
      }),
    ]);
    expect(noisy).toEqual(plain);
  });

  it('a gap: an empty value or "-" is counted; a missing or null value is nothing at all', () => {
    expect(norm([feature('2289', { sensor_waterlevel_last_value: '', sensor_discharge_last_value: '-' })])).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: { gap: 2 },
      unknown: 0,
    });
    expect(
      norm([feature('2289', { sensor_waterlevel_last_value: null, sensor_discharge_last_value: undefined })]),
    ).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: {},
      unknown: 0,
    });
  });

  it('a unit the series does not declare quarantines the payload (unit_mismatch), at either quantity', () => {
    for (const bad of [{ sensor_discharge_last_value: '391 l/s' }, { sensor_waterlevel_last_value: '244.85 m' }]) {
      expect(() => norm([feature('2289', bad)])).toThrow(expect.objectContaining({ code: 'unit_mismatch' }));
    }
    // 2282/W is a relative stage: an absolute level for it is a mismatch; 2282/Q is declared in l/s.
    expect(() => norm([feature('2282', { sensor_waterlevel_last_value: '244.85 m ü.M.' })])).toThrow(
      expect.objectContaining({ code: 'unit_mismatch' }),
    );
    expect(() => norm([feature('2282', { sensor_discharge_last_value: '0.68 m³/s' })])).toThrow(
      expect.objectContaining({ code: 'unit_mismatch' }),
    );
    // A value that is not a plain decimal number does too.
    for (const bad of ['1e3 m³/s', 'NaN', '1,5 m³/s']) {
      expect(() => norm([feature('2289', { sensor_discharge_last_value: bad })]), bad).toThrow(
        expect.objectContaining({ code: 'bad_value' }),
      );
    }
  });

  it('a duplicate key is drift; the same key as a different station is not a thing', () => {
    expect(() => norm([feature('2289'), feature('2289')])).toThrow(expect.objectContaining({ code: 'duplicate_key' }));
    expect(norm([feature('2289'), feature('2473')]).obs.length).toBeGreaterThan(0);
  });

  it('a station the registry does not know is counted once per value, never registered', () => {
    const out = norm([feature('2289', { key: '999999' })]);
    expect(out).toMatchObject({ obs: [], unknown: 2 });
    expect(norm([feature('2289', { key: '999999', sensor_discharge_last_value: null })]).unknown).toBe(1);
  });

  it('a value ahead of the fetch by more than 15 minutes is dropped, one older than 45 days is too_old', () => {
    const t = (min: number) => new Date(at + min * 60_000).toISOString().replace('Z', '+00:00');
    const q = (min: number) =>
      norm([feature('2289', { sensor_discharge_measured_at: t(min), sensor_waterlevel_last_value: null })]);
    expect(q(15).obs).toHaveLength(1);
    expect(q(16)).toMatchObject({ obs: [], dropped: { future: 1 } });
    expect(q(-45 * 24 * 60).obs).toHaveLength(1);
    expect(q(-45 * 24 * 60 - 1)).toMatchObject({ obs: [], dropped: { too_old: 1 } });
  });

  it('a negative discharge is kept (the range allows it) and an absurd one gets the range bit', () => {
    expect(
      norm([feature('2289', { sensor_discharge_last_value: '-3 m³/s', sensor_discharge_measured_at: NOW })]).obs.find(
        (r) => r.series === '2289/Q',
      ),
    ).toMatchObject({ value: -3, qc: QC.RAW });
    expect(
      norm([
        feature('2289', { sensor_discharge_last_value: '999999 m³/s', sensor_discharge_measured_at: NOW }),
      ]).obs.find((r) => r.series === '2289/Q'),
    ).toMatchObject({ qc: QC.RAW | QC.RANGE });
  });

  it('the output is sorted by station number, W before Q, whatever the order of the features', () => {
    const fs = ['2473', '2289', '2282', '2016'].map((k) =>
      feature(k, { sensor_discharge_measured_at: NOW, sensor_waterlevel_measured_at: NOW }),
    );
    const forward = norm(fs).obs.map((r) => r.series);
    expect(forward.slice(0, 2)).toEqual(['2016/W', '2016/Q']);
    expect(norm([...fs].reverse()).obs.map((r) => r.series)).toEqual(forward);
    expect(forward.indexOf('2282/W')).toBeLessThan(forward.indexOf('2289/W'));
  });
});

describe('wl_1..wl_4 → WL2..WL5 on the CH-1 primary series (P7a)', () => {
  const real = features('ch-2-pq');
  const station = (key: string, o: Partial<Properties> = {}): Properties => ({
    ...structuredClone(real.find((f) => f.key === key) as Properties),
    ...o,
  });
  const c: Context = { registry, fetchedAt: Date.parse('2026-09-30T12:00:00Z'), refRegistries };
  const out = (fs: Properties[], extra: Partial<Context> = {}) => normaliseFeatures(fs, { ...c, ...extra });
  const kinds = (n: Normalised, series: string) => n.references?.filter((r) => r.series === series);

  it('a river: the Q series of CH-1, m³/s as is, target CH-1, operational, no period', () => {
    const n = out([station('2437')]);
    expect(kinds(n, '2437/Q')?.map((r) => [r.kind, r.value, r.unit])).toEqual([
      ['WL2', 6.15, 'm³/s'],
      ['WL3', 11.45, 'm³/s'],
      ['WL4', 15.6, 'm³/s'],
      ['WL5', 21.1, 'm³/s'],
    ]);
    for (const r of n.references ?? []) {
      expect(r).toMatchObject({
        target: 'CH-1',
        semantics: 'operational',
        convention: null,
        period: null,
        valid_from: null,
      });
      expect([r.season_from_md, r.season_to_md, r.priority]).toEqual([101, 1231, 0]);
    }
    expect(n.refScope).toEqual([{ target: 'CH-1', series: '2437/Q' }]);
  });

  it('the l/s stations are divided by 1000 (2206: 1450 l/s is 1.45 m³/s)', () => {
    const n = out(features('ch-2-pq').filter((f) => f.metric === 'discharge_ls'));
    expect(kinds(n, '2206/Q')?.map((r) => r.value)).toEqual([1.45, 2.9, 4.05, 5.55]);
    expect(n.dropped.unit_mismatch).toBeUndefined();
    expect(Math.min(...(n.references ?? []).map((r) => r.value))).toBeGreaterThan(0);
  });

  it('a lake: the W level series of CH-1, m ü.M. × 100 in cm (2031: 724.10 m ü.M. is 72,410 cm)', () => {
    const n = out([station('2031')]);
    expect(kinds(n, '2031/W')?.map((r) => [r.kind, r.value, r.unit])).toEqual([
      ['WL2', 72410, 'cm'],
      ['WL3', 72445, 'cm'],
      ['WL4', 72500, 'cm'],
      ['WL5', 72525, 'cm'],
    ]);
    // A masl station with a discharge sensor too (2446): the thresholds are levels, so they sit on its W series.
    expect(kinds(out([station('2446')]), '2446/W')).toHaveLength(4);
    expect(out([station('2446')]).references?.some((r) => r.series === '2446/Q')).toBe(false);
  });

  it('a unit that does not fit the target is unit_mismatch (counted, no row); the scope still names the target', () => {
    const n = out([station('2437', { wl_2: '724.10 m ü.M.', wl_3: '5 l/s', wl_4: '1 m' })]);
    expect(kinds(n, '2437/Q')?.map((r) => r.kind)).toEqual(['WL2', 'WL4']);
    expect(n.dropped).toMatchObject({ unit_mismatch: 2 });
    // A lake with a discharge threshold, and a relative-stage gauge with a level threshold.
    expect(out([station('2031', { wl_1: '5 m³/s' })]).dropped).toMatchObject({ unit_mismatch: 1 });
    expect(out([station('2283', { metric: 'masl', wl_1: '5 m ü.M.' })]).dropped).toMatchObject({ unit_mismatch: 1 });
    expect(() => out([station('2437', { wl_1: 'garbage' })])).toThrow(SchemaDrift);
  });

  it('empty thresholds give no row; the target stays in the scope so a withdrawn threshold is closed', () => {
    const n = out([station('2437', { wl_1: null, wl_2: null, wl_3: null, wl_4: null })]);
    expect(n.references).toBeUndefined();
    expect(n.refScope).toEqual([{ target: 'CH-1', series: '2437/Q' }]);
  });

  it('a station CH-1 does not register has no target (no row, no scope); without the CH-1 registry nothing is emitted', () => {
    const n = out([station('2437', { key: '999999' })]);
    expect([n.references, n.refScope]).toEqual([undefined, undefined]);
    const { refRegistries: _, ...bare } = c;
    const none = normaliseFeatures([station('2437')], bare);
    expect([none.references, none.refScope]).toEqual([undefined, undefined]);
    expect(none.obs.length).toBeGreaterThan(0);
  });

  it('threshold_customer is not stored', () => {
    const plain = out([station('2437')]);
    expect(out([station('2437', { threshold_customer: '12 m³/s' })])).toEqual(plain);
  });

  it('the synthetic copy with one changed wl_2 differs in exactly that reference (promotion test input)', () => {
    const before = run('ch-2-pq-relative');
    const after = run('ch-2-pq-wl-changed.synthetic');
    expect(after.obs).toEqual(before.obs);
    const diff = (after.references ?? []).filter(
      (r, i) => JSON.stringify(r) !== JSON.stringify(before.references?.[i]),
    );
    expect(diff).toEqual([expect.objectContaining({ series: '2269/Q', kind: 'WL3', value: 55 })]);
    expect(before.references?.find((r) => r.series === '2269/Q' && r.kind === 'WL3')?.value).toBe(50);
    expect(after.refScope).toEqual(before.refScope);
  });
});

describe('strict schema', () => {
  const doc = (
    o: Record<string, unknown> = {},
    feature: Record<string, unknown> = {},
    props: Record<string, unknown> = {},
  ) => {
    const f = JSON.parse(rawFixture('CH-2', 'ch-2-pq-relative').body.toString('utf8'));
    const first = f.features[0];
    return Buffer.from(
      JSON.stringify({
        ...f,
        features: [{ ...first, ...feature, properties: { ...first.properties, ...props } }],
        ...o,
      }),
    );
  };
  const drift = (body: Buffer) => {
    try {
      parseFeatures(body);
    } catch (err) {
      return err instanceof SchemaDrift ? `${err.code} at ${err.path}` : 'other';
    }
    return 'parsed';
  };

  it('a property we do not know, a bad key, metric or kind, or a wrong type is drift with a path', () => {
    expect(drift(doc())).toBe('parsed');
    expect(drift(doc({}, {}, { extra: 1 }))).toBe('unrecognized_keys at features.0.properties');
    expect(drift(doc({}, {}, { key: 'abc' }))).toBe('invalid_format at features.0.properties.key');
    expect(drift(doc({}, {}, { key: '1234567' }))).toBe('invalid_format at features.0.properties.key');
    expect(drift(doc({}, {}, { metric: 'discharge_m3' }))).toBe('invalid_value at features.0.properties.metric');
    expect(drift(doc({}, {}, { kind: 'pond' }))).toBe('invalid_value at features.0.properties.kind');
    expect(drift(doc({}, {}, { hydro_station_id: '5' }))).toBe(
      'invalid_type at features.0.properties.hydro_station_id',
    );
    expect(drift(doc({}, {}, { last_value: 'x'.repeat(41) }))).toBe('too_big at features.0.properties.last_value');
    expect(drift(doc({}, {}, { failure_text: 'x'.repeat(2001) }))).toBe(
      'too_big at features.0.properties.failure_text',
    );
    expect(drift(doc({}, {}, { sensor_discharge_last_value: 5 }))).toBe(
      'invalid_type at features.0.properties.sensor_discharge_last_value',
    );
  });

  it('a feature that is not a point feature, and a collection of another shape, is drift', () => {
    expect(drift(doc({}, { type: 'Polygon' }))).toBe('invalid_value at features.0.type');
    expect(drift(doc({}, { geometry: { type: 'Polygon', coordinates: [] } }))).toBe(
      'invalid_value at features.0.geometry.type',
    );
    expect(drift(doc({}, { geometry: { type: 'Point', coordinates: [1, 2, 3, 4] } }))).toBe(
      'too_big at features.0.geometry.coordinates',
    );
    expect(drift(doc({ type: 'Feature' }))).toBe('invalid_value at type');
    expect(drift(doc({ crs: null }))).toBe('invalid_type at crs');
    expect(drift(doc({ features: 'x' }))).toBe('invalid_type at features');
    expect(drift(Buffer.from('{"error":"not found"}'))).toBe('invalid_value at type');
  });

  it('the legend (`meta`) is presentation: any shape is accepted and never read', () => {
    expect(drift(doc({ meta: { anything: [1, { nested: true }] } }))).toBe('parsed');
    expect(drift(doc({ meta: null }))).toBe('parsed');
  });

  it('the optional sensor fields may be missing or null', () => {
    const f = JSON.parse(doc().toString('utf8'));
    const { sensor_discharge_last_value: _a, sensor_waterlevel_measured_at: _b, ...rest } = f.features[0].properties;
    expect(drift(Buffer.from(JSON.stringify({ ...f, features: [{ ...f.features[0], properties: rest }] })))).toBe(
      'parsed',
    );
    expect(drift(doc({}, {}, { sensor_discharge_last_value: null, wl_1: null, threshold_customer: null }))).toBe(
      'parsed',
    );
  });
});

describe('bounded parsing', () => {
  // The hostile bodies themselves run in child processes with a small heap: bounded.int.test.ts.
  const wrap = (features: string) =>
    Buffer.from(
      `{"type":"FeatureCollection","name":"x","crs":{"type":"name","properties":{"name":"x"}},"meta":null,"features":[${features}]}`,
    );

  it('a collection over its feature cap is too_big before any feature is parsed', () => {
    expect(JSON_CAPS.maxItems).toBe(1000);
    expect(() => parseFeatures(wrap(Array(1001).fill('0').join(',')))).toThrow(
      expect.objectContaining({ code: 'too_big', path: 'features' }),
    );
  });

  it('a body with more values than the node cap, or nested too deep, is refused by the scan', () => {
    expect(() => parseFeatures(wrap(Array(60_001).fill('0').join(',')))).toThrow(
      expect.objectContaining({ code: 'json_too_many_nodes' }),
    );
    expect(() => parseFeatures(wrap(`${'['.repeat(9)}${']'.repeat(9)}`))).toThrow(
      expect.objectContaining({ code: 'json_too_deep' }),
    );
  });

  it('the caps admit the recording (207 features, about a quarter of the cap)', () => {
    expect(parseFeatures(rawFixture('CH-2', 'ch-2-pq').body)).toHaveLength(207);
  });
});

describe('property and fuzz tests', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { registry, fetchedAt: at };
  const real = features('ch-2-pq');
  const template = (key: string) => real.find((f) => f.key === key) as Properties;
  const instant = fc
    .tuple(fc.integer({ min: -(50 * 144), max: 4 }), fc.constantFrom('+02:00', '+01:00', 'Z'))
    .map(([step, offset]) => {
      const ms = Math.floor(at / 600_000) * 600_000 + step * 600_000;
      const shift = offset === 'Z' ? 0 : Number(offset.slice(1, 3)) * 3_600_000;
      return `${new Date(ms + shift).toISOString().slice(0, 23)}${offset}`;
    });
  const number = fc.oneof(
    fc.integer({ min: -50, max: 99_999 }).map(String),
    fc.double({ min: -50, max: 5000, noNaN: true, noDefaultInfinity: true }).map((v) => v.toFixed(3)),
  );
  /** A published value for the unit the registry declares, a gap, or junk that must be drift. */
  const published = (unit: string) =>
    fc.oneof(
      { weight: 8, arbitrary: number.map((n) => `${n} ${unit}`) },
      { weight: 1, arbitrary: fc.constantFrom('', '-', null, undefined) },
      { weight: 1, arbitrary: fc.string({ maxLength: 10 }) },
    );
  /** The units the registry declares per station: [level, discharge]. */
  const UNITS: Record<string, [string, string]> = {
    '2289': ['m ü.M.', 'm³/s'],
    '2473': ['m ü.M.', 'm³/s'],
    '2282': ['m', 'l/s'],
    '2283': ['m', 'l/s'],
    '2206': ['m ü.M.', 'l/s'],
    '2016': ['m ü.M.', 'm³/s'],
    '999999': ['m ü.M.', 'm³/s'],
  };
  const featureArb = fc.constantFrom(...Object.keys(UNITS)).chain((key) =>
    fc.record({
      key: fc.constant(key),
      w: published((UNITS[key] as [string, string])[0]),
      q: published((UNITS[key] as [string, string])[1]),
      wt: instant,
      qt: instant,
    }),
  );
  const collection = fc.array(featureArb, { maxLength: 12 }).map((fs) => {
    const seen = new Set<string>();
    return fs.flatMap((f) => {
      if (seen.has(f.key)) return [];
      seen.add(f.key);
      return [
        {
          ...template(f.key === '999999' ? '2289' : f.key),
          key: f.key,
          sensor_waterlevel_last_value: f.w as string | null | undefined,
          sensor_discharge_last_value: f.q as string | null | undefined,
          sensor_waterlevel_measured_at: f.wt,
          sensor_discharge_measured_at: f.qt,
        },
      ];
    });
  });

  it('normalise yields valid, sorted, unique, never-future rows, the same whatever the order; junk is only ever drift', () => {
    fc.assert(
      fc.property(collection, (fs) => {
        let out: Normalised;
        try {
          out = normaliseFeatures(fs, base);
        } catch (err) {
          // A unit that the series does not declare, or a value that is not a plain number.
          expect(err).toBeInstanceOf(SchemaDrift);
          expect(['unit_mismatch', 'bad_value']).toContain((err as SchemaDrift).code);
          return;
        }
        for (const r of out.obs) {
          ObsRow.parse(r);
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(at + 15 * 60_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(at - 45 * 86_400_000);
        }
        const keys = out.obs.map((r) => r.series);
        expect(new Set(keys).size).toBe(keys.length);
        const order = out.obs.map((r) => [Number(r.series.split('/')[0]), r.series.endsWith('/W') ? 0 : 1]);
        expect(order).toEqual(
          [...order].sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
        );
        expect(normaliseFeatures(fs, base)).toEqual(out);
        expect(normaliseFeatures([...fs].reverse(), base)).toEqual(out);
      }),
      { numRuns: 200 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary JSON or bytes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((d) => Buffer.from(JSON.stringify(d))),
          fc.uint8Array().map(Buffer.from),
        ),
        (body) => {
          try {
            parseFeatures(body);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
    const doc = JSON.parse(rawFixture('CH-2', 'ch-2-pq-relative').body.toString('utf8'));
    const props = Object.keys(doc.features[0].properties).concat('extra');
    const mutation = fc.tuple(
      fc.integer({ min: 0, max: doc.features.length - 1 }),
      fc.constantFrom(...props),
      fc.oneof(
        fc.jsonValue(),
        fc.constantFrom('5 m³/s', '5 l/s', '5 m', '5 m ü.M.', '-', '', '1e3 m', '2026-09-30T13:50:00.000+02:00'),
      ),
    );
    fc.assert(
      fc.property(mutation, ([i, key, junk]) => {
        const copy = structuredClone(doc);
        copy.features[i].properties[key] = junk;
        try {
          const out = normaliseFeatures(parseFeatures(Buffer.from(JSON.stringify(copy))), ctx('ch-2-pq-relative'));
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });
});
