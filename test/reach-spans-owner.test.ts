import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRegistry, readRiverRegistry } from '../apps/server/src/load/registry-sync.ts';
import { splitReaches } from '../apps/server/src/publish/render/reaches-owner.ts';
import { GAP_KM } from '../apps/web/src/features/flow/chain.ts';
import { reachColour } from '../apps/web/src/features/flow/reaches/colour.ts';
import { spansOf } from '../apps/web/src/features/flow/reaches/spans.ts';
import { ReachGraphFile } from '../apps/web/src/lib/data/contracts.ts';
import { ReachesFile } from '../packages/contracts/src/reaches.ts';
import type { RivernetFile } from '../packages/contracts/src/rivernet.ts';
import { repoRoot } from './catalogue.ts';

// P11b (D-2): on the owner variant of the river release (built as owner-reaches.test.ts builds it) a public reach that
// is cut into parts takes the span of the part that holds its midpoint. In the root test tree because the web tests
// may not import the server's splitter.

const release = ReachesFile.parse(JSON.parse(readFileSync(`${repoRoot}test/fixtures/reaches-fixture.json`, 'utf8')));
const { stations: rows } = readRegistry();
const rivernet = readRiverRegistry().rivernet as RivernetFile;
const ownerSet = new Set(
  rows.filter((r) => r.role === 'primary' && (r.audience === 'public' || r.audience === 'owner')).map((r) => r.id),
);
const split = splitReaches(release, ownerSet, rivernet);
const ownerGraph = ReachGraphFile.parse(split.file);
const publicGraph = ReachGraphFile.parse(release);
const owner = spansOf(ownerGraph, new Set(ownerGraph.stations.map((s) => s.id)));
const pub = spansOf(publicGraph, new Set(publicGraph.stations.map((s) => s.id)));
const ev = (v: number) => ({ v, ageS: 0, limitS: 3600 });

describe('spansOf on the owner variant', () => {
  it('is keyed by the public tile ids: every public reach, no part id', () => {
    expect([...owner.keys()].sort()).toEqual([...pub.keys()].sort());
    for (const r of ownerGraph.reaches) if (r.part_of !== undefined) expect(owner.has(r.id)).toBe(false);
  });

  it('maps meuse.24 to 26 onto the SPW span that holds their midpoint', () => {
    for (const id of ['meuse.24', 'meuse.25', 'meuse.26']) {
      const parts = ownerGraph.reaches.filter((r) => r.part_of === id);
      const fs = owner.get(id);
      expect(fs?.impounded, id).toBe(true);
      const span = fs?.span;
      if (parts.length === 0 || span === null || span === undefined) continue; // an unsplit reach keeps the public span
      expect(span.lengthKm as number, id).toBeLessThan(GAP_KM);
      expect(span.pos, id).toBeGreaterThanOrEqual(0);
      expect(span.pos, id).toBeLessThanOrEqual(1);
      expect(
        [...span.up, ...span.down].some((s) => s.startsWith('be.spw.')),
        id,
      ).toBe(true);
    }
    expect([...ownerGraph.reaches].some((r) => r.part_of === 'meuse.25')).toBe(true);
  });

  it('colours them: impounded in the change mode, a value in the discharge mode', () => {
    const fs = owner.get('meuse.25');
    if (fs === undefined) throw new Error('meuse.25');
    expect(fs.span?.lengthKm).toBeLessThan(GAP_KM);
    expect(reachColour(fs, [ev(5), ev(9)], 'delta')).toEqual({ k: 'impounded' });
    expect(reachColour(fs, [ev(50), ev(90)], 'q').k).toBe('v');
    // the public file keeps the 139 km gap
    expect(reachColour(pub.get('meuse.25') as NonNullable<ReturnType<typeof pub.get>>, [ev(50), ev(90)], 'q').k).toBe(
      'nodata',
    );
  });
});
