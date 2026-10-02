import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../../../test/catalogue.ts';
import { SourcesFile } from '../src/registry.ts';
import { StationsFile, validateStations, validateTwins } from '../src/stations.ts';
import { NATIVE_UNITS, TO_CANONICAL } from '../src/units.ts';

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
    ['name', 'Bad\u202EName'],
    ['name', 'Bad\u2028Name'],
    ['water_name', 'Bad\u2029Name'],
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

  /** The sample with a second H row on the Lobith station: the same gauge in another datum. */
  const withSecond = (n: number, role: string) => {
    const copy = structuredClone(sample);
    for (let i = 0; i < n; i += 1) {
      copy.stations.push({
        ...structuredClone(sample.stations[lobith]),
        provider_key: `lobith.bovenrijn.tolkamer/WATHTE/TAW/${i}`,
        role,
        datum: 'TAW',
        first_release: false,
      });
    }
    return copy;
  };

  it('a station has one row per quantity, plus at most one twin row', () => {
    expect(validateStations(withSecond(1, 'primary'), sources).problems.join('\n')).toMatch(/duplicate$/);
    expect(validateStations(withSecond(1, 'mirror'), sources).problems.join('\n')).toMatch(/duplicate$/);
    expect(validateStations(withSecond(1, 'twin'), sources).problems).toEqual([]);
    expect(validateStations(withSecond(2, 'twin'), sources).problems.join('\n')).toMatch(/duplicate$/);
  });
});

describe('twin registry', () => {
  const stations = validateStations(withTwinRow(), sources).stations;
  const nap = { source: 'NL-1', provider_key: 'lobith.bovenrijn.tolkamer/WATHTE' };
  const taw = { source: 'NL-1', provider_key: 'lobith.bovenrijn.tolkamer/WATHTE/TAW' };
  const relation = { kind: 'offset', expected: 233, tolerance: 1, unit: 'cm' };
  const problems = (twins: unknown[]) => validateTwins({ twins }, stations).problems.join('\n');

  function withTwinRow() {
    const copy = structuredClone(sample);
    copy.stations.push({
      ...structuredClone(sample.stations[lobith]),
      provider_key: 'lobith.bovenrijn.tolkamer/WATHTE/TAW',
      role: 'twin',
      datum: 'TAW',
      first_release: false,
    });
    return copy;
  }

  it('registry/twins.yaml validates against the station files', () => {
    const all = files.flatMap((f) => validateStations(load(dir + f), sources).stations);
    const doc = parse(readFileSync(`${repoRoot}registry/twins.yaml`, 'utf8'));
    expect(validateTwins(doc, all).problems).toEqual([]);
  });

  it('accepts a pair of two registered series of one quantity', () => {
    expect(problems([{ id: 'lobith-taw-nap', a: taw, b: nap, relation }])).toBe('');
  });

  it('fails an unregistered side, a pair of one series, a duplicate id and a wrong unit', () => {
    const ghost = { source: 'NL-1', provider_key: 'nowhere/WATHTE' };
    expect(problems([{ id: 't', a: ghost, b: nap, relation }])).toMatch(/a is not a registered series/);
    expect(problems([{ id: 't', a: taw, b: ghost, relation }])).toMatch(/b is not a registered series/);
    expect(problems([{ id: 't', a: nap, b: nap, relation }])).toMatch(/the same series/);
    const pair = { id: 't', a: taw, b: nap, relation };
    expect(problems([pair, pair])).toMatch(/duplicate/);
    expect(problems([{ ...pair, relation: { ...relation, unit: 'm³/s' } }])).toMatch(/unit of a H pair/);
  });

  it('is strict: an unknown relation kind, a bad id or an extra key fails', () => {
    const pair = { id: 't', a: taw, b: nap, relation };
    expect(
      validateTwins({ twins: [{ ...pair, relation: { ...relation, kind: 'lag' } }] }, stations).problems,
    ).not.toEqual([]);
    expect(validateTwins({ twins: [{ ...pair, id: 'Eijsden.TAW' }] }, stations).problems).not.toEqual([]);
    expect(validateTwins({ twins: [{ ...pair, note: 'x' }] }, stations).problems).not.toEqual([]);
    expect(
      validateTwins({ twins: [{ ...pair, relation: { ...relation, tolerance: -1 } }] }, stations).problems,
    ).not.toEqual([]);
  });
});
