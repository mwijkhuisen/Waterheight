import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../../test/catalogue.ts';
import { audienceWithin, SourcesFile } from '../src/registry.ts';
import { StationsFile } from '../src/stations.ts';

const dir = `${repoRoot}registry/stations/`;
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
const load = (f: string) => parse(readFileSync(dir + f, 'utf8')) as { stations: Record<string, unknown>[] };
const sample = load('p0b-sample.yaml');
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;

const withRow = (index: number, change: (row: Record<string, unknown>) => void) => {
  const copy = structuredClone(sample);
  const row = copy.stations[index];
  if (row === undefined) throw new Error(`no row ${index}`);
  change(row);
  return StationsFile.safeParse(copy);
};
const ownerIndex = sample.stations.findIndex((r) => r.audience === 'owner');

describe('station registry', () => {
  it.each(files)('%s validates', (f) => {
    expect(StationsFile.safeParse(load(f)).error).toBeUndefined();
  });

  it('holds the 5-row sample, one of them an owner-audience row', () => {
    expect(sample.stations).toHaveLength(5);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
  });

  it('names registered sources and never widens their audience', () => {
    for (const f of files) {
      for (const row of StationsFile.parse(load(f)).stations) {
        const source = sources.find((s) => s.id === row.source);
        expect([row.id, source?.id]).toEqual([row.id, row.source]);
        if (source) expect([row.id, audienceWithin(row.audience, source.audience)]).toEqual([row.id, true]);
      }
    }
  });

  it.each(['first_release', 'licence_gate', 'audience', 'provider_code'])('fails without %s', (key) => {
    expect(withRow(0, (r) => delete r[key]).success).toBe(false);
  });

  it.each([
    ['value', 612],
    ['thresholds', [{ kind: 'WL2', value: 700 }]],
    ['forecast', [{ valid: '2026-10-01T00:00:00Z', value: 600 }]],
    ['gauge_zero', [{ value_m: 59.98, datum: 'DNG', valid_from: null, valid_to: null }]],
    ['datum', 'DNG'],
  ])('rejects an owner row that holds %s', (key, value) => {
    expect(withRow(ownerIndex, (r) => (r[key] = value)).success).toBe(false);
  });

  it('rejects an unknown key on a public row', () => {
    expect(withRow(0, (r) => (r.value = 612)).success).toBe(false);
  });
});
