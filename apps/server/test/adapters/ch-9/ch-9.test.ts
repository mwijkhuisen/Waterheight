import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { QC, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normaliseRecords } from '../../../src/adapters/ch-9/normalise.ts';
import { type Ch9Record, countRecords, parseRecords } from '../../../src/adapters/ch-9/parse.ts';
import { validate } from '../../../src/archive/validity.ts';
import { PROVIDERS } from '../../../src/backfill/provider.ts';
import { provider } from '../../../src/backfill/providers/ch-9.ts';
import { goldenUrl, rawFixture, registryOf } from '../registry.ts';

// CH-9 data.bs.ch (P14b backfill): parse + normalise of the recorded exports equals the committed goldens (invariant 9).
// A golden is the counts, a digest of the observations and the first and last three; `UPDATE_GOLDEN=1` rewrites them.

const registry = registryOf('CH-1');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (ms: number) => iso(ms).replaceAll('Z', '+00:00');

function ctx(name: string, dataset: string, window?: [string, string]): Context {
  return {
    registry,
    fetchedAt: Date.parse(rawFixture('CH-9', name).meta.recorded_at),
    dataset,
    backfill: window === undefined ? undefined : { from: Date.parse(window[0]), to: Date.parse(window[1]) },
  };
}
const MONTH: [string, string] = ['2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'];
const DAY: [string, string] = ['2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z'];
const run = (name: string, dataset: string, window: [string, string]) =>
  normaliseRecords(parseRecords(rawFixture('CH-9', name).body, dataset), ctx(name, dataset, window));

function summary(out: ReturnType<typeof normaliseRecords>) {
  return {
    provider_values: out.provider_values,
    unknown_values: out.unknown_values,
    unknown: out.unknown,
    dropped: out.dropped,
    obs_count: out.obs.length,
    obs_sha256: sha(JSON.stringify(out.obs)),
    first: out.obs.slice(0, 3),
    last: out.obs.slice(-3),
  };
}
function golden(name: string, actual: object): object {
  const url = goldenUrl('CH-9', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}
const kept = (out: ReturnType<typeof normaliseRecords>) =>
  out.obs.length + Object.values(out.dropped).reduce((a, b) => a + b, 0) + out.unknown_values;

describe('golden files (real exports)', () => {
  it('the Rhine, first 2,000 records of June: the 10-minute grid, W in cm and Q, 5-minute points off_grid', () => {
    const out = run('ch-9-backfill-100089', '100089', MONTH);
    expect(summary(out)).toEqual(golden('ch-9-backfill-100089', summary(out)));
    expect(out.dropped).toEqual({ off_grid: 2000 });
    expect(out.obs).toHaveLength(2000);
    expect(out.obs.slice(0, 2)).toEqual([
      { series: '2289/W', ts: '2026-06-01T00:00:00.000Z', value: 24530.5, qc: QC.RAW },
      { series: '2289/Q', ts: '2026-06-01T00:00:00.000Z', value: 714.976, qc: QC.RAW },
    ]);
    expect(kept(out)).toBe(out.provider_values);
  });

  it('the Rhine, last 300 records of June: the month ends at 23:55 and the chunk edge holds', () => {
    const out = run('ch-9-backfill-100089-tail', '100089', MONTH);
    expect(summary(out)).toEqual(golden('ch-9-backfill-100089-tail', summary(out)));
    expect(out.obs.at(-1)?.ts).toBe('2026-06-30T23:50:00.000Z');
    // The same body with a chunk that ends at 23:00: the rest is outside_backfill.
    const cut = run('ch-9-backfill-100089-tail', '100089', [MONTH[0], '2026-06-30T23:00:00Z']);
    expect(cut.dropped.outside_backfill).toBeGreaterThan(0);
    expect(kept(cut)).toBe(cut.provider_values);
  });

  it('the Birs, one day: W only, Q counted q_not_twin and never stored', () => {
    const out = run('ch-9-backfill-100236', '100236', DAY);
    expect(summary(out)).toEqual(golden('ch-9-backfill-100236', summary(out)));
    expect(out.dropped).toEqual({ q_not_twin: 288, off_grid: 144 });
    expect(out.obs).toHaveLength(144);
    expect(out.obs.every((r) => r.series === '2106/W' && r.qc === QC.RAW)).toBe(true);
    expect(out.obs[0]).toEqual({ series: '2106/W', ts: '2026-10-10T00:00:00.000Z', value: 26718.4, qc: QC.RAW });
    expect(kept(out)).toBe(out.provider_values);
  });

  it('an empty answer (synthetic): no value, no drop', () => {
    const out = run('ch-9-backfill-empty.synthetic', '100089', MONTH);
    expect(summary(out)).toEqual(golden('ch-9-backfill-empty.synthetic', summary(out)));
    expect(out.provider_values).toBe(0);
  });

  it('the reachability body carries its signature in the first 64 KB', () => {
    expect(rawFixture('CH-9', 'ch-9-records-100089').body.subarray(0, 65_536).toString()).toContain('"results"');
  });
});

describe('drift', () => {
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  const rhine = { timestamp: '2026-06-01T00:00:00+00:00', abfluss: 1, pegelhoehe: 600, pegel: 246 };
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      return err instanceof SchemaDrift ? err.code : 'other';
    }
    return 'none';
  };

  it('a record with other keys than its dataset states is drift', () => {
    expect(code(() => parseRecords(body([rhine]), '100089'))).toBe('none');
    expect(code(() => parseRecords(body([{ ...rhine, extra: 1 }]), '100089'))).toBe('unrecognized_keys');
    const { pegelhoehe: _, ...short } = rhine;
    expect(code(() => parseRecords(body([short]), '100089'))).not.toBe('none');
    // The Rhine's record under the Birs's dataset, and the other way round.
    expect(code(() => parseRecords(body([rhine]), '100236'))).not.toBe('none');
    expect(
      code(() =>
        parseRecords(body([{ timestamp: rhine.timestamp, abfluss: 1, pegel: 2, temperatur: null }]), '100089'),
      ),
    ).not.toBe('none');
  });

  it('an unknown or inherited variant is drift', () => {
    for (const v of ['', '100090', 'constructor', '__proto__'])
      expect([v, code(() => parseRecords(body([]), v))]).toEqual([v, 'unknown_variant']);
    expect(code(() => normaliseRecords([], { ...ctx('ch-9-backfill-100236', '100236'), dataset: 'toString' }))).toBe(
      'unknown_variant',
    );
  });

  it('a stamp without an explicit offset, a non-array, a string value and bad bytes are drift', () => {
    expect(code(() => parseRecords(body([{ ...rhine, timestamp: '2026-06-01T00:00:00' }]), '100089'))).not.toBe('none');
    expect(code(() => parseRecords(body({ results: [] }), '100089'))).toBe('invalid_type');
    expect(code(() => parseRecords(body([{ ...rhine, pegel: '246' }]), '100089'))).not.toBe('none');
    expect(code(() => parseRecords(Buffer.from([0xff, 0xfe]), '100089'))).toBe('encoding');
    expect(code(() => parseRecords(Buffer.from('[{'), '100089'))).toBe('not_json');
    expect(code(() => countRecords(body([rhine])))).toBe('none');
    expect(countRecords(body([rhine, rhine]))).toBe(2);
  });

  it('an impossible date that has the right shape is drift at the normaliser', () => {
    const bad = parseRecords(body([{ ...rhine, timestamp: '2026-13-45T00:00:00+00:00' }]), '100089');
    const ctx9 = { registry, fetchedAt: 0, dataset: '100089' };
    expect(code(() => normaliseRecords(bad, ctx9))).toMatch(/^time_/);
  });

  it('more records than the cap are drift, read before any is parsed', () => {
    expect(code(() => parseRecords(body(Array.from({ length: 20_001 }, () => rhine)), '100089'))).toMatch(
      /too_big|json_too_many_nodes/,
    );
  });
});

describe('normalise', () => {
  const c = (over: Partial<Context> = {}): Context => ({
    registry,
    fetchedAt: Date.parse('2026-10-18T00:00:00Z'),
    dataset: '100089',
    ...over,
  });
  const rec = (t: string, over: Partial<Ch9Record> = {}): Ch9Record => ({
    timestamp: t,
    abfluss: 500,
    pegelhoehe: 600,
    pegel: 246,
    ...over,
  });

  it('only the 10-minute grid loads, in any offset spelling', () => {
    const out = normaliseRecords(
      [rec('2026-06-01T00:00:00+00:00'), rec('2026-06-01T00:05:00+00:00'), rec('2026-06-01T02:10:00+02:00')],
      c(),
    );
    expect(out.obs.map((r) => r.ts)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:10:00.000Z',
      '2026-06-01T00:10:00.000Z',
    ]);
    expect(out.dropped).toEqual({ off_grid: 2 });
  });

  it('a record whose pegelhoehe disagrees with pegel over 1 cm loses W and Q; 1 cm is fine', () => {
    const out = normaliseRecords(
      [
        rec('2026-06-01T00:00:00+00:00', { pegelhoehe: 601.2 }),
        rec('2026-06-01T00:10:00+00:00', { pegelhoehe: 600.9 }),
      ],
      c(),
    );
    expect(out.dropped).toEqual({ inconsistent: 2 });
    expect(out.obs).toHaveLength(2);
    expect(out.obs.every((r) => r.ts === '2026-06-01T00:10:00.000Z')).toBe(true);
  });

  it('a null is a gap, never 0; a null pegelhoehe skips the consistency check', () => {
    const out = normaliseRecords(
      [rec('2026-06-01T00:00:00+00:00', { pegel: null, abfluss: 7, pegelhoehe: null })],
      c(),
    );
    expect(out.dropped).toEqual({ gap: 1 });
    expect(out.obs).toEqual([{ series: '2289/Q', ts: '2026-06-01T00:00:00.000Z', value: 7, qc: QC.RAW }]);
  });

  it('before the floor, outside the chunk and in the future are dropped', () => {
    const out = normaliseRecords(
      [rec('2020-05-31T23:50:00+00:00'), rec('2026-06-01T00:00:00+00:00'), rec('2026-06-01T00:10:00+00:00')],
      c({ backfill: { from: Date.parse('2026-06-01T00:10:00Z'), to: Date.parse('2026-07-01T00:00:00Z') } }),
    );
    expect(out.dropped).toEqual({ outside_backfill: 4 });
    expect(out.obs).toHaveLength(2);
    // A stamp over 15 minutes after the fetch (2026-10-18T00:00Z) is future.
    expect(normaliseRecords([rec('2026-10-18T00:20:00+00:00')], c()).dropped).toEqual({ future: 2 });
    // Without a window only the floor applies.
    expect(normaliseRecords([rec('2020-05-31T23:50:00+00:00')], c()).dropped).toEqual({ outside_backfill: 2 });
  });

  it('a series the registry lacks is counted unknown, a unit that is not the series is withheld', () => {
    const none = normaliseRecords([rec('2026-06-01T00:00:00+00:00')], c({ registry: new Map() }));
    expect([none.unknown_values, none.unknown, none.obs]).toEqual([2, 2, []]);
    expect(kept(none)).toBe(none.provider_values);
    const w = registry.get('2289/W');
    if (w === undefined) throw new Error('registry');
    const odd = new Map(registry).set('2289/W', { ...w, native_unit: 'cm' });
    const out = normaliseRecords([rec('2026-06-01T00:00:00+00:00')], c({ registry: odd }));
    expect(out.dropped).toEqual({ unit_mismatch: 1 });
    expect(out.obs.map((r) => r.series)).toEqual(['2289/Q']);
  });

  it('property: every stored stamp is on the grid and in the window, and provider_values = kept + dropped', () => {
    const base = Date.parse('2026-06-01T00:00:00Z');
    const num = fc.option(fc.double({ min: 0, max: 400, noNaN: true }), { nil: null });
    const record = fc.record({
      k: fc.integer({ min: -50, max: 9000 }),
      abfluss: num,
      pegel: num,
      pegelhoehe: fc.option(fc.double({ min: -50, max: 800, noNaN: true }), { nil: undefined }),
    });
    fc.assert(
      fc.property(
        fc.array(record, { maxLength: 60 }),
        fc.constantFrom('100089', '100236'),
        fc.integer({ min: 0, max: 8000 }),
        (rs, dataset, to) => {
          const records = rs.map(({ k, ...r }) => ({ timestamp: stamp(base + k * 300_000), ...r }));
          const window = { from: base, to: base + to * 300_000 };
          const out = normaliseRecords(records, c({ dataset, backfill: window }));
          for (const r of out.obs) {
            const t = Date.parse(r.ts);
            expect(t % 600_000).toBe(0);
            expect(t >= window.from && t < window.to).toBe(true);
            expect(r.qc).toBe(QC.RAW);
            if (dataset === '100236') expect(r.series).toBe('2106/W');
          }
          expect(out.provider_values).toBe(2 * records.length);
          expect(kept(out)).toBe(out.provider_values);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the provider', () => {
  const dir = new URL('../../../../../registry/', import.meta.url);
  const spec = {
    id: 'ch-9-backfill-bs',
    source: 'CH-9',
    target: 'CH-1',
    version: 1,
    url: 'https://data.bs.ch/api/explore/v2.1/catalog/datasets/',
    datasets: [
      { id: '100089', station: '2289' },
      { id: '100236', station: '2106' },
    ],
    chunk: 'P30D',
    floor: '2020-06-01',
    max_bytes: 4_194_304,
    retention: 'backfill',
  } as never;
  const p = provider as NonNullable<typeof provider>;

  it('is registered, one unit per dataset, from the registry only', () => {
    expect(PROVIDERS['CH-9']).toBe(provider);
    expect(p.units(spec, dir)).toEqual([
      {
        series_key: '100089',
        step_ms: 300_000,
        per_step: { values: 2, rows: 1 },
        dataset: '100089',
        station: '2289',
      },
      {
        series_key: '100236',
        step_ms: 300_000,
        per_step: { values: 2, rows: 0.5 },
        dataset: '100236',
        station: '2106',
      },
    ]);
    const wrong = { ...(spec as object), datasets: [{ id: '100089', station: '2106' }] } as never;
    expect(() => p.units(wrong, dir)).toThrow(/not station/);
    const other = { ...(spec as object), datasets: [{ id: '123456', station: '2289' }] } as never;
    expect(() => p.units(other, dir)).toThrow(/not station/);
  });

  it('builds the recorded request: an export, the chunk as a where clause, URL-encoded', () => {
    const [unit] = p.units(spec, dir);
    const req = p.chunkRequest(
      spec,
      unit as never,
      { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') },
      new Date(),
    );
    expect(req).toEqual({
      url: 'https://data.bs.ch/api/explore/v2.1/catalog/datasets/100089/exports/json?where=timestamp%20%3E%3D%20%272026-06-01T00%3A00%3A00Z%27%20AND%20timestamp%20%3C%20%272026-07-01T00%3A00%3A00Z%27&order_by=timestamp',
      method: 'GET',
      headers: { accept: 'application/json' },
      variant: '100089',
    });
    expect(p.lineVariant).toBe(true);
    expect(p.checkRequest).toBeUndefined();
  });

  it('inspects a body by its records and judges it valid, empty included', async () => {
    const fx = (n: string) => rawFixture('CH-9', n).body;
    expect(await p.inspect(fx('ch-9-backfill-100236'))).toEqual({ ok: true, values: 576 });
    expect(await p.inspect(Buffer.from('[{"a":1}]'))).toMatchObject({ ok: false, code: 'schema_drift' });
    expect(await validate(p.validity, 200, fx('ch-9-backfill-100089'))).toMatchObject({ ok: true, count: 2000 });
    expect(await validate(p.validity, 200, Buffer.from('[]'))).toMatchObject({ ok: true, count: 0 });
  });
});
