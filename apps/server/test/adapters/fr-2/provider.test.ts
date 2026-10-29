import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { normaliseElab } from '../../../src/adapters/fr-2/normalise.ts';
import { parseElab } from '../../../src/adapters/fr-2/parse.ts';
import { validate } from '../../../src/archive/validity.ts';
import { PROVIDERS } from '../../../src/backfill/provider.ts';
import { Fr2BackfillSpec, type Fr2Unit, type LoadedBackfillSpec } from '../../../src/backfill/spec.ts';
import { REGISTRY_DIR } from '../../../src/capture/specs.ts';
import { rawFixture, registryOf } from '../registry.ts';

// The FR-2 backfill provider (P14b): units from the registry, the request of a chunk, the truncation check and the
// validity of an answer, on the recorded fixtures. No network: nothing here sends a request.

const provider = PROVIDERS['FR-2'];
if (provider === undefined) throw new Error('no FR-2 provider');

const spec = Fr2BackfillSpec.parse({
  id: 'fr-2-backfill-elab',
  source: 'FR-2',
  target: 'FR-1',
  version: 1,
  url: 'https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab',
  select: { aggregates: ['QmnJ', 'HIXnJ'] },
  chunk: 'P7300D',
  floor: '1950-01-01',
  max_bytes: 16_777_216,
  retention: 'backfill',
});
const loaded = {
  ...spec,
  host: 'hubeau.eaufrance.fr',
  limits: { min_interval_ms: 2000, max_per_hour: 1800, window_utc: { from: '22:00', to: '05:00' } },
  chunk_ms: 7300 * 86_400_000,
  series: [],
} as unknown as LoadedBackfillSpec;
const only = (aggregates: ('QmnJ' | 'HIXnJ')[]) => ({ ...spec, select: { aggregates } });

describe('units', () => {
  it('are the 71 aggregate twins of the registry: 31 QmnJ then 40 HIXnJ by station, one day a step', () => {
    const units = provider.units(spec, REGISTRY_DIR) as Fr2Unit[];
    expect(units).toHaveLength(71);
    expect(units.filter((u) => u.grandeur === 'QmnJ')).toHaveLength(31);
    expect(units.filter((u) => u.grandeur === 'HIXnJ')).toHaveLength(40);
    expect(units.every((u) => u.step_ms === 86_400_000 && u.series_key === `${u.code}/${u.grandeur}`)).toBe(true);
    expect(new Set(units.map((u) => u.series_key)).size).toBe(71);
    expect(units.find((u) => u.code === 'A850061001' && u.grandeur === 'QmnJ')?.series_key).toBe('A850061001/QmnJ');
    // No site code, no primary series: every key is a Sandre station code and an aggregate grandeur.
    expect(units.every((u) => /^[A-Z][0-9A-Z]{9}\/(QmnJ|HIXnJ)$/.test(u.series_key))).toBe(true);
  });

  it('follow the spec: one grandeur selects only its rows', () => {
    expect(provider.units(only(['QmnJ']), REGISTRY_DIR)).toHaveLength(31);
    expect(provider.units(only(['HIXnJ']), REGISTRY_DIR)).toHaveLength(40);
  });

  it('refuse a spec of another source', () => {
    expect(() => provider.units({ ...spec, source: 'NL-1' } as never, REGISTRY_DIR)).toThrow('another source');
  });

  describe('registry faults', () => {
    const dirOf = (rows: string) => {
      const tmp = mkdtempSync(join(tmpdir(), 'fr2-units-'));
      mkdirSync(join(tmp, 'stations'));
      writeFileSync(join(tmp, 'stations', 'fr-1.yaml'), `stations:\n${rows}`);
      return { tmp, dir: new URL(`${pathToFileURL(tmp).href}/`) };
    };
    const row = (key: string, over: Record<string, string> = {}) =>
      Object.entries({
        provider_code: 'A850061001',
        provider_key: key,
        role: 'twin',
        audience: 'public',
        aggregate: 'mean',
        ...over,
      })
        .map(([k, v], i) => `  ${i === 0 ? '-' : ' '} ${k}: ${v}`)
        .join('\n');
    const fails = (rows: string, text: string) => {
      const { tmp, dir } = dirOf(rows);
      try {
        expect(() => provider.units(spec, dir)).toThrow(text);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    };

    it('a row that is not public like its source', () => {
      fails(row('A850061001/QmnJ', { audience: '"off"' }), 'not public');
    });
    it('a row that is not a twin, or whose key is not its own station and an aggregate grandeur', () => {
      fails(row('A850061001/QmnJ', { role: 'primary' }), 'not an aggregate twin key');
      fails(row('A850061001/Q'), 'not an aggregate twin key');
      fails(row('A443064001/QmnJ'), 'not an aggregate twin key');
      fails(row('A850061001/QmnJ/x'), 'not an aggregate twin key');
    });
    it('and passes a good one', () => {
      const { tmp, dir } = dirOf(row('A850061001/QmnJ'));
      try {
        expect(provider.units(spec, dir)).toEqual([
          { series_key: 'A850061001/QmnJ', code: 'A850061001', grandeur: 'QmnJ', step_ms: 86_400_000 },
        ]);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });
});

describe('chunkRequest', () => {
  const unit: Fr2Unit = { series_key: 'A850061001/QmnJ', code: 'A850061001', grandeur: 'QmnJ', step_ms: 86_400_000 };
  const at = (from: string, to: string) => ({ from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`) });
  const now = new Date('2026-10-18T22:00:00Z');

  it('is one GET by station code and grandeur over the UTC days of the chunk, the last day being the one before `to`', () => {
    expect(provider.chunkRequest(loaded, unit, at('2000-01-01', '2020-01-01'), now)).toEqual({
      url: 'https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab?code_entite=A850061001&grandeur_hydro_elab=QmnJ&date_debut_obs_elab=2000-01-01&date_fin_obs_elab=2019-12-31&size=20000',
      method: 'GET',
      headers: { accept: 'application/json' },
      variant: 'A850061001/QmnJ',
    });
  });

  it('a one-day chunk asks that day as both ends', () => {
    const one = provider.chunkRequest(loaded, unit, at('2026-07-30', '2026-07-31'), now);
    expect(one.url).toContain('date_debut_obs_elab=2026-07-30&date_fin_obs_elab=2026-07-30&size=20000');
  });

  it('encodes every part it takes from data and carries no body', () => {
    const odd: Fr2Unit = { ...unit, code: 'A&b=1 ', series_key: 'x' };
    const req = provider.chunkRequest(loaded, odd, at('2000-01-01', '2000-01-02'), now);
    expect(req.url).toContain('code_entite=A%26b%3D1%20&');
    expect(req.body).toBeUndefined();
    expect(provider.checkRequest).toBeUndefined();
  });
});

describe('inspect', () => {
  const body = (name: string) => rawFixture('FR-2', name).body;
  it('accepts a whole answer and counts its records', () => {
    expect(provider.inspect(body('fr-2-elab-uckange-qmnj-1981'))).toEqual({ ok: true, values: 400 });
    expect(provider.inspect(body('fr-2-elab-uckange-qmnj-2026'))).toEqual({ ok: true, values: 139 });
    expect(provider.inspect(body('fr-2-elab-empty'))).toEqual({ ok: true, values: 0 });
  });

  it('accepts an answer with null days (#242) and counts every record, so the chunk reconciles', () => {
    // values is the chunk's provider_values; normalise accounts for each record as a row, a drop or an unknown one.
    for (const [name, values, from, to] of [
      ['fr-2-elab-iwuy-qmnj-null-days', 91, '1989-12-22', '2009-12-17'],
      ['fr-2-elab-toul-hixnj-null-days', 30, '1950-01-01', '1969-12-27'],
    ] as const) {
      expect(provider.inspect(body(name)), name).toEqual({ ok: true, values });
      const out = normaliseElab(parseElab(body(name)).data, {
        registry: registryOf('FR-1'),
        fetchedAt: Date.parse('2026-10-29T12:47:10Z'),
        backfill: { from: Date.parse(`${from}T00:00:00Z`), to: Date.parse(`${to}T00:00:00Z`) },
      });
      const dropped = Object.values(out.dropped).reduce((a, b) => a + b, 0) + out.unknown_values;
      expect([name, out.provider_values, out.obs.length + dropped]).toEqual([name, values, values]);
    }
  });

  it('calls a page truncated: a `next`, or a `count` above the records it holds', () => {
    expect(provider.inspect(body('fr-2-elab-page'))).toEqual({ ok: false, code: 'truncated' });
    const doc = JSON.parse(body('fr-2-elab-uckange-qmnj-2026').toString('utf8'));
    expect(provider.inspect(Buffer.from(JSON.stringify({ ...doc, count: 140 })))).toEqual({
      ok: false,
      code: 'truncated',
    });
    expect(provider.inspect(Buffer.from(JSON.stringify({ ...doc, next: 'https://hubeau.eaufrance.fr/x' })))).toEqual({
      ok: false,
      code: 'truncated',
    });
  });

  it('calls an answer over the parse caps truncated and any other drift schema_drift with the parser code', () => {
    expect(
      provider.inspect(
        Buffer.from(
          JSON.stringify({
            count: 0,
            first: null,
            prev: null,
            next: null,
            api_version: '2',
            data: Array(20_001).fill(0),
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      code: 'truncated',
    });
    expect(provider.inspect(Buffer.from('{"count":0}'))).toEqual({
      ok: false,
      code: 'schema_drift',
      drift: expect.stringMatching(/^[a-z0-9_]{1,40}$/),
    });
    expect(provider.inspect(Buffer.from('not json'))).toEqual({ ok: false, code: 'schema_drift', drift: 'not_json' });
  });
});

describe('validity and statuses', () => {
  it('accepts 200 with records, 200 with none, 206 (a page) and 204 (no body); refuses the rest', async () => {
    expect(provider.okStatus).toEqual([200, 204, 206]);
    const full = rawFixture('FR-2', 'fr-2-elab-uckange-qmnj-2026').body;
    expect(await validate(provider.validity, 200, full)).toMatchObject({ ok: true, count: 139 });
    expect(await validate(provider.validity, 200, rawFixture('FR-2', 'fr-2-elab-empty').body)).toMatchObject({
      ok: true,
      count: 0,
    });
    expect(await validate(provider.validity, 206, rawFixture('FR-2', 'fr-2-elab-page').body)).toMatchObject({
      ok: true,
      count: 3,
    });
    expect(await validate(provider.validity, 204, Buffer.alloc(0))).toMatchObject({ ok: true, count: 0 });
    expect(await validate(provider.validity, 500, full)).toMatchObject({ ok: false, reason: 'status' });
    expect(await validate(provider.validity, 200, Buffer.from('{"data":[]}'))).toMatchObject({
      ok: false,
      reason: 'required',
    });
    expect(await validate(provider.validity, 200, Buffer.alloc(0))).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('the dry-run constants', () => {
  const within = (measured: number, constant: number) => constant >= measured * 0.75 && constant <= measured * 1.25;
  const zstd9 = (b: Buffer) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 9 } }).length;

  it('are within 25 % of what the fixtures measure (bytes a record, the archive ratio of a long answer, the heap row)', () => {
    expect(provider.dryRun).toEqual({ bytes_per_value: 383, zstd_ratio: 45, db_bytes_per_row: 90 });
    for (const name of ['fr-2-elab-uckange-qmnj-1981', 'fr-2-elab-uckange-qmnj-2026']) {
      const raw = readFileSync(new URL(`../../../src/adapters/fr-2/fixtures/${name}.raw`, import.meta.url));
      const records = JSON.parse(raw.toString('utf8')).data.length;
      expect(within(raw.length / records, provider.dryRun?.bytes_per_value ?? 0), name).toBe(true);
      expect(within(raw.length / zstd9(raw), provider.dryRun?.zstd_ratio ?? 0), name).toBe(true);
    }
  });
});
