import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../../test/catalogue.ts';
import { SourcesFile } from '../src/registry.ts';
import { NATIVE_UNITS, StationsFile, TO_CANONICAL, validateStations } from '../src/stations.ts';

// The schema fixture: 5 rows across the audiences. registry/stations/ holds only real, synced files.
const dir = `${repoRoot}registry/stations/`;
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
const load = (path: string) => parse(readFileSync(path, 'utf8')) as { stations: Record<string, unknown>[] };
const sample = load(`${repoRoot}packages/contracts/test/fixtures/stations-sample.yaml`);
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;

const withRow = (index: number, change: (row: Record<string, unknown>) => void) => {
  const copy = structuredClone(sample);
  const row = copy.stations[index];
  if (row === undefined) throw new Error(`no row ${index}`);
  change(row);
  return StationsFile.safeParse(copy);
};
/** validateStations problems for the sample with one row changed. */
const problemsWith = (index: number, change: (row: Record<string, unknown>) => void) => {
  const copy = structuredClone(sample);
  const row = copy.stations[index];
  if (row === undefined) throw new Error(`no row ${index}`);
  change(row);
  return validateStations(copy, sources).problems.join('\n');
};
const ownerIndex = sample.stations.findIndex((r) => r.audience === 'owner');
const lobith = sample.stations.findIndex((r) => r.id === 'nl.rws.lobith.bovenrijn.tolkamer');
const basel = sample.stations.findIndex((r) => r.id === 'ch.bafu.2289');
const NEW_FIELDS = [
  'tier',
  'role',
  'provider_key',
  'native_unit',
  'to_canonical',
  'value_kind',
  'native_step',
  'expected_step',
  'staleness_limit',
];

describe('station registry', () => {
  it.each(files)('%s validates', (f) => {
    expect(StationsFile.safeParse(load(dir + f)).error).toBeUndefined();
  });

  it('holds the 5-row sample, one of them an owner-audience row', () => {
    expect(sample.stations).toHaveLength(5);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
  });

  it('accepts the sample', () => {
    expect(validateStations(sample, sources).problems).toEqual([]);
  });

  it.each(files)('%s names registered sources and never widens an audience', (f) => {
    expect(validateStations(load(dir + f), sources).problems).toEqual([]);
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

describe('station declarations (tier, role, provider_key, units, steps)', () => {
  it.each(NEW_FIELDS)('fails without %s, on a public and on an owner row', (key) => {
    expect(withRow(0, (r) => delete r[key]).success).toBe(false);
    expect(withRow(ownerIndex, (r) => delete r[key]).success).toBe(false);
  });

  it('accepts a null value_kind only as a declared key, not as a missing one', () => {
    expect(withRow(basel, (r) => (r.value_kind = null)).success).toBe(true);
  });

  it.each([
    ['tier', 3],
    ['role', 'copy'],
    ['provider_key', ''],
    ['provider_key', 'x'.repeat(121)],
    ['native_unit', 'ft'],
    ['to_canonical', 0],
    ['to_canonical', -1],
    ['value_kind', 'height'],
    ['native_step', '15 min'],
    ['expected_step', '15m'],
    ['staleness_limit', 'PT'],
  ])('rejects %s = %j', (key, value) => {
    expect(withRow(0, (r) => (r[key] = value)).success).toBe(false);
  });

  it.each(['PT1M', 'PT15M', 'PT45M', 'PT1H30M', 'P1D'])('takes the duration %s', (value) => {
    expect(withRow(0, (r) => (r.native_step = value)).success).toBe(true);
  });

  it('knows the factor of every native unit, so no unit is left without a check', () => {
    expect(Object.keys(TO_CANONICAL).sort()).toEqual([...NATIVE_UNITS].sort());
    expect(TO_CANONICAL).toMatchObject({ cm: 1, mm: 0.1, m: 100, 'm+NN': 100, 'm+PNP': 100, 'm³/s': 1, 'l/s': 0.001 });
  });

  it.each(NATIVE_UNITS)('accepts a row declared in %s with its own factor', (unit) => {
    const discharge = unit === 'm³/s' || unit === 'l/s';
    const change = (r: Record<string, unknown>) => {
      r.native_unit = unit;
      r.to_canonical = TO_CANONICAL[unit];
    };
    expect(problemsWith(discharge ? basel : lobith, change)).toBe('');
  });

  it.each([
    ['cm', 100],
    ['mm', 1],
    ['m', 1],
    ['m+NN', 1],
    ['l/s', 1],
  ])('fails when %s carries to_canonical %d', (unit, factor) => {
    const change = (r: Record<string, unknown>) => {
      r.native_unit = unit;
      r.to_canonical = factor;
    };
    expect(problemsWith(unit === 'l/s' ? basel : lobith, change)).toMatch(/to_canonical .* is not/);
  });

  it('fails when a discharge row has a value_kind', () => {
    expect(problemsWith(basel, (r) => (r.value_kind = 'stage'))).toMatch(/a discharge row has no value_kind/);
  });

  it('fails when a discharge row is declared in a level unit', () => {
    expect(problemsWith(basel, (r) => Object.assign(r, { native_unit: 'cm', to_canonical: 1 }))).toMatch(
      /native_unit cm is not a discharge unit/,
    );
  });

  it('fails when a level row has no value_kind', () => {
    expect(problemsWith(lobith, (r) => (r.value_kind = null))).toMatch(/needs value_kind stage or level/);
  });

  it('fails when a level row is declared in a discharge unit', () => {
    expect(problemsWith(lobith, (r) => Object.assign(r, { native_unit: 'm³/s', to_canonical: 1 }))).toMatch(
      /native_unit m³\/s is a discharge unit/,
    );
  });

  it('fails when two rows of a source share a provider_key', () => {
    const copy = structuredClone(sample);
    const [first, second] = copy.stations.filter((r) => r.source === 'NL-1' || r.source === 'DE-1');
    if (first === undefined || second === undefined) throw new Error('no rows to collide');
    second.source = first.source;
    second.provider_key = first.provider_key;
    expect(validateStations(copy, sources).problems.join('\n')).toMatch(/duplicate provider_key/);
  });

  it('allows the same provider_key in two different sources', () => {
    const copy = structuredClone(sample);
    const [first, second] = copy.stations;
    if (first === undefined || second === undefined) throw new Error('no rows');
    second.provider_key = first.provider_key;
    expect(validateStations(copy, sources).problems.join('\n')).not.toMatch(/duplicate provider_key/);
  });

  it('fails a first_release row on tier 2, and accepts a tier-2 row that is not first_release', () => {
    expect(problemsWith(0, (r) => (r.tier = 2))).toMatch(/first_release needs tier 1/);
    expect(problemsWith(0, (r) => Object.assign(r, { tier: 2, first_release: false }))).toBe('');
  });
});
