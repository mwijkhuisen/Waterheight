import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../../test/catalogue.ts';
import { SourcesFile } from '../src/registry.ts';
import { StationsFile, validateStations } from '../src/stations.ts';

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

  it.each(files)('%s names registered sources and never widens an audience', (f) => {
    expect(validateStations(load(f), sources).problems).toEqual([]);
  });

  it('fails when a public row names an owner source as its forecast source (invariant 11)', () => {
    const copy = structuredClone(sample);
    const kaub = copy.stations.find((r) => r.id === 'de.wsv.25700100');
    if (kaub === undefined) throw new Error('no Kaub row');
    kaub.expected_forecast_source = 'DE-2';
    expect(validateStations(copy, sources).problems.join('\n')).toMatch(
      /a public row may not name the owner source DE-2 as expected_forecast_source/,
    );
  });

  it('fails when a row widens its source (a public row of an owner source)', () => {
    const copy = structuredClone(sample);
    const owner = copy.stations[ownerIndex];
    if (owner === undefined) throw new Error('no owner row');
    Object.assign(owner, { audience: 'public', datum: null, gauge_zero: [] });
    expect(validateStations(copy, sources).problems.join('\n')).toMatch(/audience public widens its source BE-3/);
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
