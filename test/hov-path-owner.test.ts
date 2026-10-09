import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRegistry, readRiverRegistry } from '../apps/server/src/load/registry-sync.ts';
import { splitReaches } from '../apps/server/src/publish/render/reaches-owner.ts';
import { buildPath } from '../apps/web/src/features/flow/hovmoller/path.ts';
import { ReachGraphFile } from '../apps/web/src/lib/data/contracts.ts';
import type { ApiStation } from '../packages/contracts/src/api.ts';
import { ReachesFile } from '../packages/contracts/src/reaches.ts';
import type { RivernetFile } from '../packages/contracts/src/rivernet.ts';
import { repoRoot } from './catalogue.ts';

// P11c (D-3, C5): the Meuse column path on the owner variant of the river release (built as owner-reaches.test.ts builds
// it): the SPW main-stem gauges fill the Walloon gap, and a public column that an owner station shares its km with
// stays. In the root test tree because the web tests may not import the server's splitter. Ids and km only: no value.

const release = ReachesFile.parse(JSON.parse(readFileSync(`${repoRoot}test/fixtures/reaches-fixture.json`, 'utf8')));
const registry = readRegistry();
const rivernet = readRiverRegistry().rivernet as RivernetFile;
const primaries = registry.stations.filter(
  (r) => r.role === 'primary' && (r.audience === 'public' || r.audience === 'owner'),
);
const ownerGraph = ReachGraphFile.parse(splitReaches(release, new Set(primaries.map((r) => r.id)), rivernet).file);
const publicGraph = ReachGraphFile.parse(release);
const ownerSources = new Set(registry.sources.filter((s) => s.audience === 'owner').map((s) => s.id));
const sourceOf = new Map(primaries.map((r) => [r.id, r.source]));
const kmOf = new Map(ownerGraph.stations.map((s) => [s.id, s.km_to_nl_entry]));

function station(id: string, source: string): ApiStation {
  return {
    id,
    name: id,
    waterName: null,
    country: 'NL',
    lon: null,
    lat: null,
    tier: 1,
    flags: { tidal: null, impounded: null },
    series: [
      {
        id: 1,
        source,
        quantity: 'H',
        valueKind: 'stage',
        unit: 'cm',
        datum: null,
        nativeUnit: 'cm',
        expectedStepSeconds: 600,
        stalenessLimitSeconds: 3600,
        dataSince: null,
      },
    ],
  } as ApiStation;
}

/** The owner site's stations.json: the public and the owner primaries, plus the owner canary (never in the graph). */
const ownerStations = [
  ...ownerGraph.stations.map((s) => station(s.id, sourceOf.get(s.id) ?? 'NL-1')),
  station('nl.canary.owner', 'CANARY-OWNER'),
];
const owner = buildPath('meuse', ownerGraph, ownerStations, ownerSources);
const ids = owner.columns.map((c) => c.id);

describe('buildPath on the owner variant of the Meuse', { timeout: 30_000 }, () => {
  it('puts the SPW main-stem gauges between Chooz and Lixhe in km order, flagged owner', () => {
    const spw = owner.columns.filter((c) => c.id.startsWith('be.spw.'));
    expect(spw.length).toBeGreaterThanOrEqual(8);
    for (const c of spw) {
      expect(c.owner, c.id).toBe(true);
      expect(c.riverId, c.id).toBe('meuse');
    }
    const from = ids.indexOf('fr.sandre.B720000001');
    const to = ids.indexOf('nl.rws.lixhebiefaval');
    expect(from).toBe(0);
    for (const c of spw) expect(ids.indexOf(c.id)).toBeGreaterThan(from);
    for (const c of spw) expect(ids.indexOf(c.id)).toBeLessThan(to);
    // Km order, as in the registry: strictly increasing x over the whole path.
    for (let i = 1; i < owner.columns.length; i++)
      expect(owner.columns[i]?.x as number, ids[i]).toBeGreaterThan(owner.columns[i - 1]?.x as number);
    expect(ids).toContain('be.spw.5447');
    expect(ids).toContain('be.spw.8078');
    // Only the SPW gauges are owner columns on the Meuse.
    expect(owner.columns.filter((c) => c.owner).map((c) => c.id)).toEqual(spw.map((c) => c.id));
  });

  it('has no Wallonia gap, where the public file has one', () => {
    expect(owner.gaps).toEqual([]);
    const pub = buildPath(
      'meuse',
      publicGraph,
      publicGraph.stations.map((s) => station(s.id, 'NL-1')),
      ownerSources,
    );
    expect(pub.gaps.map((g) => g.kind)).toEqual(['wallonia']);
    expect(pub.columns.some((c) => c.owner)).toBe(false);
  });

  it('never makes a column of the owner canary, and none of an SPW gauge off the main stem', () => {
    expect(ids).not.toContain('nl.canary.owner');
    // be.spw.2707 sits on a Dender part reach, be.spw.7319 on the Sambre: tributaries.
    for (const t of ['be.spw.2707', 'be.spw.7319', 'be.spw.5803']) expect(ids).not.toContain(t);
  });

  it('keeps the public column where an owner station shares its km (C5)', () => {
    // be.spw.8702 copies the km of fr.sandre.B720000002 in the owner file.
    expect(kmOf.get('be.spw.8702')).toBe(kmOf.get('fr.sandre.B720000002'));
    expect(ids).toContain('fr.sandre.B720000002');
    expect(ids).not.toContain('be.spw.8702');
    expect(owner.columns.find((c) => c.id === 'fr.sandre.B720000002')?.owner).toBe(false);
    // The same, with the owner station named first and a better tier: public still wins.
    const rows = ownerStations.map((s) =>
      s.id === 'be.spw.8702' ? { ...s, tier: 1 as const } : { ...s, tier: 2 as const },
    );
    const cols = buildPath('meuse', ownerGraph, rows, ownerSources).columns.map((c) => c.id);
    expect(cols).toContain('fr.sandre.B720000002');
    expect(cols).not.toContain('be.spw.8702');
  });

  it('is the public path plus the SPW columns, and nothing else', () => {
    const pub = buildPath(
      'meuse',
      publicGraph,
      publicGraph.stations.map((s) => station(s.id, 'NL-1')),
      ownerSources,
    ).columns.map((c) => c.id);
    expect(ids.filter((i) => !i.startsWith('be.spw.'))).toEqual(pub);
  });
});
