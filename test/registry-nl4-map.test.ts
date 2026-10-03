import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { H_DESCRIPTION, Q_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { Nl4MapFile, StationsFile } from '../packages/contracts/src/index.ts';
import { repoRoot } from './catalogue.ts';

// registry/thresholds/nl-4-map.yaml (P7a): the NL-4 workbook Code is the NL-1 Locatie.Code, and `none` lists exactly
// the registered public primary NL-1 series that the edition gives no class (the registry sync's own match rule).

const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8');
const map = Nl4MapFile.parse(parse(read('registry/thresholds/nl-4-map.yaml'), { maxAliasCount: 0 }));
const thresholds = readThresholds(read('registry/thresholds/nl-4.csv'));
const series = StationsFile.parse(parse(read('registry/stations/nl-1.yaml'))).stations.filter(
  (s) =>
    s.source === 'NL-1' &&
    s.audience === 'public' &&
    s.role === 'primary' &&
    (s.quantity === 'Q' || ('datum' in s && s.datum === 'NAP')),
);
const classed = new Set(thresholds.rows.map((r) => `${r.description}\n${r.code}`));
const description = (q: 'H' | 'Q') => (q === 'H' ? H_DESCRIPTION : Q_DESCRIPTION);

describe('registry/thresholds/nl-4-map.yaml', () => {
  it('is for the pinned edition of nl-4.csv', () => {
    expect(map.edition).toBe(thresholds.edition);
  });

  it('`none` is exactly the registered public primary NL-1 series without a class row, each once, each with a reason', () => {
    const expected = series
      .filter((s) => !classed.has(`${description(s.quantity)}\n${s.provider_code}`))
      .map((s) => `${s.provider_code}/${s.quantity}`)
      .sort();
    const listed = map.none.map((n) => `${n.code}/${n.quantity}`);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(expected);
    expect(expected).toHaveLength(10);
    for (const n of map.none) expect(n.reason.length).toBeGreaterThan(10);
  });

  it('the other registered series each have at least one class row (the identity rule holds)', () => {
    const listed = new Set(map.none.map((n) => `${n.code}/${n.quantity}`));
    const matched = series.filter((s) => !listed.has(`${s.provider_code}/${s.quantity}`));
    expect(matched.length + listed.size).toBe(series.length);
    for (const s of matched) expect(classed.has(`${description(s.quantity)}\n${s.provider_code}`)).toBe(true);
  });
});
