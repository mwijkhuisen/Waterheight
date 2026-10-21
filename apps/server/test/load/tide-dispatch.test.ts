import { SchemaDrift } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { LOAD_ADAPTERS, type SpecLoader } from '../../src/load/adapters.ts';
import { rawFixture, registryOf } from '../adapters/registry.ts';

// #174: the `nl-1-hwlw-astro` loader parses once and lets the first list's Typering choose: the GETETTPE type series
// gives `tideLabels` (RWS's labels), the heights give `tide`; a payload that mixes the two drifts.

const spec = LOAD_ADAPTERS['NL-1']?.specs['nl-1-hwlw-astro'] as SpecLoader;
const registry = registryOf('NL-1');
const HEIGHTS = 'nl-1-hwlw-astro-goeree-lichteiland-msl';
const TYPE = 'nl-1-hwlw-astro-goeree-lichteiland-msl-getettpe';
const ctx = (name: string) => ({
  registry,
  fetchedAt: Date.parse(rawFixture('NL-1', name).meta.recorded_at),
  variant: '',
  unitMismatch: new Set<string>(),
});
type Doc = { WaarnemingenLijst: unknown[] };
const doc = (name: string) => JSON.parse(rawFixture('NL-1', name).body.toString('utf8')) as Doc;

describe('the tide specs', () => {
  it('defer their day bumps like the catch-up (P18a: a replay of 79 payloads bumps each settled day once)', () => {
    for (const id of ['nl-1-astro', 'nl-1-hwlw-astro', 'nl-1-hwlw'])
      expect(LOAD_ADAPTERS['NL-1']?.specs[id], id).toMatchObject({ deferBumps: true });
  });
});

describe('nl-1-hwlw-astro dispatch', () => {
  it('a type payload gives tideLabels and no tide, obs or heights', async () => {
    const out = await spec.run(rawFixture('NL-1', TYPE).body, ctx(TYPE));
    expect(out.tideLabels?.length).toBeGreaterThan(1000);
    expect(out.tideLabels?.every((l) => l.hilo === 'high' || l.hilo === 'low')).toBe(true);
    expect(out.tide ?? []).toEqual([]);
    expect(out.obs).toEqual([]);
  });

  it('a heights payload gives tide and no tideLabels', async () => {
    const out = await spec.run(rawFixture('NL-1', HEIGHTS).body, ctx(HEIGHTS));
    expect(out.tide?.length).toBeGreaterThan(1000);
    expect(out.tide?.every((r) => r.kind === 'extreme_astro')).toBe(true);
    expect(out.tideLabels ?? []).toEqual([]);
  });

  it('a payload that mixes the two drifts, whichever list comes first', async () => {
    const heights = doc(HEIGHTS).WaarnemingenLijst;
    const type = doc(TYPE).WaarnemingenLijst;
    for (const lists of [
      [...type, ...heights],
      [...heights, ...type],
    ]) {
      const body = Buffer.from(JSON.stringify({ ...doc(HEIGHTS), WaarnemingenLijst: lists }));
      await expect(Promise.resolve().then(() => spec.run(body, ctx(HEIGHTS)))).rejects.toBeInstanceOf(SchemaDrift);
    }
  });
});
