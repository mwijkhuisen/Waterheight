import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCheck } from '../../src/adapters/nl-1/parse.ts';
import { LOAD_ADAPTERS, type LoadContext } from '../../src/load/adapters.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// P14a: the NL-1 backfill payloads recorded live on 2026-10-12 (scripts/smoke-capture.ts --backfill / --check),
// run through the loader's own backfill spec (maxAgeMs null) and compared with their goldens (invariant 9).
// `UPDATE_GOLDEN=1` rewrites them. The facts they show are in catalogue §2.1.

const registry = registryOf('NL-1');
const run = (name: string) => {
  const { body, meta } = rawFixture('NL-1', name);
  const ctx: LoadContext = {
    registry,
    fetchedAt: Date.parse(meta.recorded_at),
    variant: '',
    unitMismatch: new Set(),
  };
  const loader = LOAD_ADAPTERS['NL-1']?.specs['nl-1-backfill-obs'];
  if (loader === undefined) throw new Error('no nl-1-backfill-obs loader');
  return loader.run(body, ctx) as unknown as {
    obs: { series: string; ts: string; value: number; qc: number }[];
    provider_values: number;
    unknown_values: number;
    dropped: Record<string, number>;
  };
};
function golden(name: string, actual: unknown) {
  const url = goldenUrl('NL-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

describe('backfill golden files (real payloads)', () => {
  it('Lobith H, the flood of 1995-01-25 .. 02-05: 265 hourly F007 values, Definitief', () => {
    const out = run('nl-1-backfill-lobith-h-19950125');
    expect(out).toEqual(golden('nl-1-backfill-lobith-h-19950125', out));
    expect(out.obs).toHaveLength(265);
    expect(out.obs[0]?.ts).toBe('1995-01-25T00:00:00.000Z');
    expect(out.provider_values).toBe(265);
    expect(Math.max(...out.obs.map((o) => o.value))).toBe(1666);
  });

  it('Lobith Q 2010 with Hoedanigheid NVT: the hourly F216 list and the daily mean are both dropped as unregistered_method (the registry has F230)', () => {
    const out = run('nl-1-backfill-lobith-q-20100101');
    expect(out).toEqual(golden('nl-1-backfill-lobith-q-20100101', out));
    expect(out.obs).toHaveLength(0);
    expect(out.provider_values).toBe(251);
    expect(out.dropped).toEqual({ unregistered_method: 251 });
  });

  it('Lobith H 1960: a daily F009 list, not the live method: nothing is stored', () => {
    const out = run('nl-1-backfill-lobith-h-19600101');
    expect(out).toEqual(golden('nl-1-backfill-lobith-h-19600101', out));
    expect(out.obs).toHaveLength(0);
    expect(out.provider_values).toBe(40);
    expect(out.dropped).toEqual({ unregistered_method: 40 });
  });
});

describe('parseCheck on the recorded answers', () => {
  const body = (name: string) => rawFixture('NL-1', name).body;
  it('1995 is true, 1950 is false', () => {
    expect(parseCheck(body('nl-1-check-lobith-h-1995'))).toBe(true);
    expect(parseCheck(body('nl-1-check-lobith-h-1950'))).toBe(false);
  });

  it('property: only the strings true and false parse; anything else, or a missing key, is drift', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom('true', 'false'), fc.string(), fc.boolean(), fc.integer(), fc.constant(null)),
        (v) => {
          const doc = { Succesvol: true, WaarnemingenAanwezig: v };
          if (v === 'true' || v === 'false') return parseCheck(enc(doc)) === (v === 'true');
          try {
            parseCheck(enc(doc));
            return false;
          } catch (e) {
            return e instanceof SchemaDrift;
          }
        },
      ),
    );
    expect(() => parseCheck(enc({ Succesvol: true }))).toThrow(SchemaDrift);
    expect(() => parseCheck(new Uint8Array())).toThrow(SchemaDrift);
  });
});
