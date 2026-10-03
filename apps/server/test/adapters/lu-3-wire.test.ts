import { SchemaDrift } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { normalisePart, PERCENTILES } from '../../src/adapters/lu-3/normalise.ts';
import { parsePercentile } from '../../src/adapters/lu-3/parse.ts';
import { loadRegistry, REGISTRY_DIR, readSeed, variantKey } from '../../src/capture/specs.ts';
import type { LoadContext } from '../../src/load/adapters.ts';
import { checkPart } from '../../src/load/forecasts.ts';
import { ADAPTER, lu3Seed } from '../../src/load/wire/lu-3.ts';
import { ADAPTER as LU4 } from '../../src/load/wire/lu-4.ts';
import { rawFixture, registryOf } from './registry.ts';

// P8a: the loader wiring of LU-3 (load/wire/lu-3.ts) and the LU-4 forecast-limit drift count (load/wire/lu-4.ts), on
// synthetic files only (owner audience, invariant 9): which slugs load, the staged part a file becomes, the display
// limits of registry/seed/lu-3.csv, and that Perl, Stadtbredimus and Wasserbillig can never load.

const wire = ADAPTER.specs['lu-3-percentile'];
const lu1 = registryOf('LU-1');
const FETCHED = Date.parse('2030-03-30T21:20:00Z');
const body = (name: string) => new Uint8Array(rawFixture('LU-3', name).body);
const ctx = (variant: string, patch: Partial<LoadContext> = {}): LoadContext => ({
  registry: new Map(),
  fetchedAt: FETCHED,
  variant,
  unitMismatch: new Set(),
  refRegistries: new Map([['LU-1', lu1]]),
  ...patch,
});
const run = async (file: string, variant: string, patch: Partial<LoadContext> = {}) => {
  if (wire === undefined) throw new Error('no lu-3-percentile loader');
  return wire.run(body(file), ctx(variant, patch));
};
const SEED = {
  bigonville: 24,
  bissen: 24,
  dasbourg: 24,
  diekirch: 24,
  'ettelbruck-alzette': 24,
  'ettelbruck-wark': 24,
  'gemund-our': null,
  hesperange: 24,
  kautenbach: 24,
  mersch: 24,
  rosport: 48,
} as const;
const LFU_RLP = ['perl', 'stadtbredimus', 'wasserbillig'] as const;

describe('the LU-3 loader entry', () => {
  it('is one spec per file: a variant per file, five parts a run, the station series of LU-1', () => {
    expect(Object.keys(ADAPTER.specs)).toEqual(['lu-3-percentile']);
    expect(wire?.needsVariant).toBe(true);
    expect(wire?.refTarget).toEqual(['LU-1']);
    expect(wire?.maxBytes).toBe(1024 * 1024);
    expect(wire?.combine?.parts).toBe(PERCENTILES.length);
    expect(PERCENTILES).toHaveLength(5);
  });

  it('a file is the staged part of its station, UTC fetch hour and percentile, with the LU-1 key of the station', async () => {
    const out = await run('lu-3-percentile-diekirch-p50.synthetic', 'diekirch/50');
    const expected = normalisePart(parsePercentile(rawFixture('LU-3', 'lu-3-percentile-diekirch-p50.synthetic').body), {
      variant: 'diekirch/50',
      keyOf: (slug) => (slug === 'diekirch' ? 'Diekirch' : undefined),
    });
    expect(out.forecastPart).toEqual({
      target: 'LU-1',
      series: 'Diekirch',
      slot: 'diekirch',
      group: '2030-03-30T21',
      part: '50',
      data: expected.part,
    });
    expect(out.unknown).toBe(0);
    expect(out.dropped).toEqual({});
    // No observation and nothing else: a part is staged by the loader, never stored by the adapter.
    expect([out.obs, out.gaugeZeros, out.forecasts]).toEqual([[], [], undefined]);
  });

  it('the group is the UTC hour of the fetch, not the local one, and it changes at the hour', async () => {
    const group = async (at: string) =>
      (await run('lu-3-percentile-diekirch-p10.synthetic', 'diekirch/10', { fetchedAt: Date.parse(at) })).forecastPart
        ?.group;
    expect(await group('2030-03-30T21:00:00Z')).toBe('2030-03-30T21');
    expect(await group('2030-03-30T21:59:59.999Z')).toBe('2030-03-30T21');
    expect(await group('2030-03-30T22:00:00Z')).toBe('2030-03-30T22');
    // 00:30+02:00 on 31 March is 22:30Z on the 30th.
    expect(await group('2030-03-30T22:30:00+02:00')).toBe('2030-03-30T20');
  });

  it('every seed slug and percentile names a valid part for the loader staging (our own identifiers only)', async () => {
    for (const slug of Object.keys(SEED))
      for (const p of PERCENTILES) {
        const out = await run('lu-3-percentile-diekirch-p50.synthetic', `${slug}/${p}`);
        const part = out.forecastPart;
        expect([slug, p, part === undefined]).toEqual([slug, p, false]);
        if (part !== undefined) {
          expect(() => checkPart(part)).not.toThrow();
          expect([part.slot, part.part]).toEqual([slug, String(p)]);
          expect(part.target).toBe('LU-1');
        }
      }
  });

  it('Gemünd names its LU-1 series (which is off: the loader stores and stages nothing for it)', async () => {
    const out = await run('lu-3-percentile-diekirch-p50.synthetic', 'gemund-our/50');
    expect(out.forecastPart?.series).toBe('Gemünd_Our');
    expect(lu1.get('Gemünd_Our')?.station).toBe('lu.age.gemund-our');
  });

  it('a gap is counted (dropped), a file of nothing is no part', async () => {
    const gap = await run('lu-3-percentile-gap.synthetic', 'diekirch/30');
    expect(gap.dropped).toEqual({ gap: 1 });
    expect(gap.forecastPart?.part).toBe('30');
    const empty = await run('lu-3-percentile-empty.synthetic', 'diekirch/30');
    expect(empty.forecastPart).toBeUndefined();
    expect(empty.dropped).toEqual({ empty: 1 });
  });

  it('a variant that is no `<slug>/<p>` is drift, a file that is no percentile file is drift', async () => {
    await expect(run('lu-3-percentile-diekirch-p50.synthetic', 'diekirch')).rejects.toBeInstanceOf(SchemaDrift);
    await expect(run('lu-3-percentile-diekirch-p50.synthetic', 'diekirch/20')).rejects.toMatchObject({
      code: 'bad_variant',
    });
    expect(() => wire?.run(new Uint8Array(Buffer.from('{}')), ctx('diekirch/50'))).toThrow(SchemaDrift);
  });
});

describe('only the 11 seed slugs load; Perl, Stadtbredimus and Wasserbillig never do (catalogue §0.8)', () => {
  it('registry/seed/lu-3.csv: the 11 slugs with their display limit (24 or 48; Gemünd none)', () => {
    expect(Object.fromEntries(lu3Seed())).toEqual(SEED);
    const rows = readSeed(REGISTRY_DIR, 'lu-3');
    expect(rows).toHaveLength(11);
    for (const r of rows) expect(Object.keys(r)).toEqual(['slug', 'limit_h']);
    expect(rows.map((r) => r.limit_h)).toEqual(['24', '24', '24', '24', '24', '24', '', '24', '24', '24', '48']);
  });

  it('the capture spec keeps its 55 variants exactly: the limit is no variant key', () => {
    const spec = loadRegistry().specs.find((s) => s.id === 'lu-3-percentile');
    const variants = spec?.rows.map((r) => variantKey(r, spec.variants?.key)) ?? [];
    expect(variants).toHaveLength(55);
    expect(new Set(variants)).toEqual(
      new Set(Object.keys(SEED).flatMap((slug) => PERCENTILES.map((p) => `${slug}/${p}`))),
    );
    // The seed column is not part of any request (the URL names only the slug and the percentile).
    expect(spec?.request.url).toBe('https://inondations.public.lu/percentile/{slug}-p{p}.json');
  });

  it('none of the three LfU RLP gauges is in the seed, the capture variants or the loader', async () => {
    const spec = loadRegistry().specs.find((s) => s.id === 'lu-3-percentile');
    for (const slug of LFU_RLP) {
      expect([slug, lu3Seed().has(slug)]).toEqual([slug, false]);
      expect([slug, spec?.rows.some((r) => r.slug === slug)]).toEqual([slug, false]);
      // Even with the file of their own run in hand and the station in the LU-1 registry, the loader counts it unknown.
      expect([slug, [...lu1.values()].some((d) => d.station === `lu.age.${slug}`)]).toEqual([slug, true]);
      for (const p of PERCENTILES) {
        const out = await run(`lu-3-percentile-perl-p${p}.synthetic`, `${slug}/${p}`);
        expect([slug, p, out.forecastPart, out.unknown]).toEqual([slug, p, undefined, 1]);
        expect(out.dropped).toEqual({});
      }
    }
  });

  it('a slug that is no LU-1 station, a seed slug without an LU-1 registry, and any other slug are unknown', async () => {
    for (const slug of ['nowhere', 'bollendorf', 'livange', 'mondorf-les-bains'])
      expect((await run('lu-3-percentile-diekirch-p50.synthetic', `${slug}/50`)).unknown).toBe(1);
    const noRegistry = await run('lu-3-percentile-diekirch-p50.synthetic', 'diekirch/50', {
      refRegistries: new Map(),
    });
    expect([noRegistry.unknown, noRegistry.forecastPart]).toEqual([1, undefined]);
    const absent = await run('lu-3-percentile-diekirch-p50.synthetic', 'diekirch/50', {
      refRegistries: undefined as never,
    });
    expect([absent.unknown, absent.forecastPart]).toEqual([1, undefined]);
  });
});

describe('the LU-4 page whose forecast limit is not the seed limit (forecast_limit_drift, counted only)', () => {
  const page = LU4.specs['lu-4-pages'];
  const drift = (name: string, variant: string, edit: (html: string) => string = (x) => x) => {
    if (page === undefined) throw new Error('no lu-4-pages loader');
    const html = edit(rawFixture('LU-4', name).body.toString('utf8'));
    const out = page.run(new Uint8Array(Buffer.from(html)), {
      registry: new Map(),
      fetchedAt: FETCHED,
      variant,
      unitMismatch: new Set(),
    }) as { dropped: Record<string, number> };
    return out.dropped.forecast_limit_drift;
  };
  const LIMIT_48 = 'forecastsLimit&#34;:&#34;h48&#34;';
  const MERSCH = 'alzette/alzette/mersch';

  it('a page that states 48 hours where the seed has 24 is counted once', () => {
    expect(lu3Seed().get('mersch')).toBe(24);
    expect(drift('lu-4-page-normal.synthetic', MERSCH)).toBe(1);
  });

  it('a page that states the seed limit is not counted', () => {
    const edit = (h: string) => {
      expect(h).toContain(LIMIT_48);
      return h.replaceAll(LIMIT_48, 'forecastsLimit&#34;:&#34;h24&#34;');
    };
    expect(drift('lu-4-page-normal.synthetic', MERSCH, edit)).toBeUndefined();
    expect(drift('lu-4-pages-hesperange.synthetic', 'alzette/alzette/hesperange')).toBeUndefined();
  });

  it('a page that no longer states a limit differs from the seed too', () => {
    expect(drift('lu-4-page-no-levels.synthetic', 'alzette/alzette/ettelbruck-alzette')).toBe(1);
  });

  it('a page of a station that has no LU-3 run is never compared', () => {
    expect(drift('lu-4-pages-stadtbredimus.synthetic', 'moselle/moselle/stadtbredimus')).toBeUndefined();
    expect(drift('lu-4-pages-heiderscheidergrund.synthetic', 'sure/sure/heiderscheidergrund')).toBeUndefined();
  });
});
