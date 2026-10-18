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
const run = (name: string, backfill?: LoadContext['backfill'], edit?: (text: string) => string) => {
  const { body: raw, meta } = rawFixture('NL-1', name);
  const body = edit === undefined ? raw : new TextEncoder().encode(edit(new TextDecoder().decode(raw)));
  const ctx: LoadContext = {
    registry,
    fetchedAt: Date.parse(meta.recorded_at),
    variant: '',
    unitMismatch: new Set(),
    ...(backfill === undefined ? {} : { backfill }),
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

describe('KG-355: older history carries a 4-digit quality code', () => {
  it('Lith H 2003-01-29 .. 03-10: 5,801 provider values: 5,724 stored (Gecontroleerd), 10 code 1004 unknown_quality, 52 conflict, 14 duplicate, 1 outside_backfill', () => {
    const win = { from: Date.parse('2003-01-29T00:00:00Z'), to: Date.parse('2003-03-10T00:00:00Z') };
    const out = run('nl-1-backfill-lith-h-20030129', win);
    expect(out).toEqual(golden('nl-1-backfill-lith-h-20030129', out));
    expect(out.obs).toHaveLength(5724);
    expect(out.obs.every((o) => (o.qc & 2) === 2)).toBe(true);
    expect(out.provider_values).toBe(5801);
    expect(out.dropped).toEqual({ unknown_quality: 10, conflict: 52, duplicate: 14, outside_backfill: 1 });
  });
});

describe('the load window (review S3)', () => {
  const H95 = 'nl-1-backfill-lobith-h-19950125';
  const balanced = (out: ReturnType<typeof run>) => {
    const dropped = Object.values(out.dropped).reduce((n, v) => n + v, 0) + out.unknown_values;
    expect(out.provider_values).toBe(out.obs.length + dropped);
  };

  it('rows outside the line’s chunk [from, to) are dropped as outside_backfill, and the ledger still balances', () => {
    const from = Date.parse('1995-01-30T00:00:00Z');
    const to = Date.parse('1995-02-01T00:00:00Z');
    const out = run(H95, { from, to });
    expect(out.obs).toHaveLength(48);
    expect(out.obs.every((o) => Date.parse(o.ts) >= from && Date.parse(o.ts) < to)).toBe(true);
    expect(out.dropped.outside_backfill).toBe(265 - 48);
    balanced(out);
  });

  it('rows below the spec floor (1990-01-01) are dropped whatever the line says', () => {
    const out = run(H95, undefined, (t) => t.replaceAll('"1995-', '"1985-'));
    expect(out.provider_values).toBe(265);
    expect(out.obs).toHaveLength(0);
    expect(out.dropped.outside_backfill).toBe(265);
    balanced(out);
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
