import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReaches, ReachesFile } from '../packages/contracts/src/reaches.ts';
import { buildFromFiles, canonicalJson, readRivers } from '../tools/geo/rivernet/build.ts';
import { reachesFile } from '../tools/geo/rivernet/outputs.ts';
import { place, readOverrides } from '../tools/geo/rivernet/place.ts';
import { readStations } from '../tools/geo/rivernet/stations.ts';
import { repoRoot } from './catalogue.ts';

// The shared fixture river release of P11a (issue #26): the production placement and reachesFile on the committed
// tools/geo/fixtures inputs, as the e2e release 20261003 (E2E_RIVERS). The web e2e, the compose e2e and the chain,
// flow and owner-split tests read the committed file; the tiles beside it (tools/geo/fixtures/rivers-fixture.pmtiles)
// come from the same fixture, so their reach ids agree. `UPDATE_FIXTURE=1` rewrites it.

const FX = `${repoRoot}tools/geo/fixtures/`;
const REACHES_FIXTURE = `${repoRoot}test/fixtures/reaches-fixture.json`;

describe('the fixture river release', () => {
  it('equals the reaches file built from the committed fixture', { timeout: 180_000 }, async () => {
    const build = await buildFromFiles({
      ways: `${FX}rivernet.ways.geojsonseq`,
      relations: `${FX}rivernet.relations.opl`,
      provenance: `${FX}rivernet.provenance.json`,
    });
    const rivers = readRivers();
    const placed = place(build.edges, rivers, readStations(), readOverrides(rivers));
    const osm = (build.graph as { osm: { replication_timestamp: string } }).osm.replication_timestamp;
    const text = canonicalJson(reachesFile(placed, rivers, '20261003', osm));
    if (process.env.UPDATE_FIXTURE === '1') writeFileSync(REACHES_FIXTURE, text);
    if (!existsSync(REACHES_FIXTURE)) throw new Error('no reaches fixture: run with UPDATE_FIXTURE=1 and review it');
    expect(readFileSync(REACHES_FIXTURE, 'utf8') === text, 'regenerate with UPDATE_FIXTURE=1').toBe(true);
    expect(checkReaches(ReachesFile.parse(JSON.parse(text)))).toEqual([]);
  });
});
