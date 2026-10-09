import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReachesFile } from '../packages/contracts/src/reaches.ts';
import { buildFromFiles, readRivers } from '../tools/geo/rivernet/build.ts';
import { haversine, type LonLat } from '../tools/geo/rivernet/network.ts';
import { writeOutputs } from '../tools/geo/rivernet/outputs.ts';
import { place, readOverrides } from '../tools/geo/rivernet/place.ts';
import { readStations } from '../tools/geo/rivernet/stations.ts';
import { repoRoot } from './catalogue.ts';

// The flow direction's data (P11a, issue #26 C2): the dash layer `rivers-flow` filters on the tile property `tidal`
// and moves its dashes along the line's own direction. Both are facts of the tile input (`rivers.geojsonseq`, the file
// tippecanoe turns into rivers-<ver>.pmtiles), proved here on the committed fixture graph: the tile `tidal` is the
// reaches file's `flags.tidal` of the same `reach_id` (the join of the layer's filter), and every reach's line runs in
// the direction of its `downstream` reaches (up to down, so a dash that moves along the line moves downstream).

const FX = `${repoRoot}tools/geo/fixtures/`;
const build = await buildFromFiles({
  ways: `${FX}rivernet.ways.geojsonseq`,
  relations: `${FX}rivernet.relations.opl`,
  provenance: `${FX}rivernet.provenance.json`,
});
const rivers = readRivers();
const placed = place(build.edges, rivers, readStations(), readOverrides(rivers));
const osm = (build.graph as { osm: { replication_timestamp: string } }).osm.replication_timestamp;

const tmp = mkdtempSync(join(tmpdir(), 'flow-tiles-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
writeOutputs(tmp, placed, rivers, '20261003', osm);

interface TileLine {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: LonLat[] };
  properties: { reach_id?: string; tidal?: boolean };
}
const lines = readFileSync(join(tmp, 'rivers.geojsonseq'), 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as TileLine);
// The committed release the web e2e serves: its reach ids are those of the tiles committed beside it.
const release = ReachesFile.parse(JSON.parse(readFileSync(`${repoRoot}test/fixtures/reaches-fixture.json`, 'utf8')));
const lineOf = new Map(lines.map((l) => [l.properties.reach_id, l]));

describe('the tidal join of the flow layer’s filter', () => {
  it('gives every reach of the release exactly one tile line, and no line without a reach', () => {
    expect(release.reaches.length).toBeGreaterThan(100);
    expect(lines).toHaveLength(release.reaches.length);
    expect(lineOf.size).toBe(lines.length); // no reach_id twice
    expect(lines.every((l) => typeof l.properties.reach_id === 'string')).toBe(true);
    expect([...lineOf.keys()].sort()).toEqual(release.reaches.map((r) => r.id).sort());
  });

  it('has a tile `tidal` equal to the reaches file’s `flags.tidal` of the same reach_id, on both values', () => {
    for (const r of release.reaches) expect(lineOf.get(r.id)?.properties.tidal, r.id).toBe(r.flags.tidal);
    // A join that never meets a true (or never a false) value would prove nothing.
    expect(release.reaches.some((r) => r.flags.tidal)).toBe(true);
    expect(release.reaches.some((r) => !r.flags.tidal)).toBe(true);
  });

  it('selects, with the layer’s filter, exactly the non-tidal reaches', () => {
    // ['all', ['has','reach_id'], ['!=', ['get','tidal'], true]] on the tile properties.
    const animated = lines.filter((l) => l.properties.reach_id !== undefined && l.properties.tidal !== true);
    expect(animated.map((l) => l.properties.reach_id).sort()).toEqual(
      release.reaches
        .filter((r) => !r.flags.tidal)
        .map((r) => r.id)
        .sort(),
    );
  });
});

describe('the direction of the tile lines', () => {
  const last = (l: TileLine) => l.geometry.coordinates.at(-1) as LonLat;
  const first = (l: TileLine) => l.geometry.coordinates[0] as LonLat;
  /** Metres: the build's own sub-metre float noise where a reach ends at the node the next one starts at. */
  const TOUCH_M = 1;
  const joins = placed.net.joins.map((j) => ({
    ...j,
    from_at: placed.net.coord.get(j.from) as LonLat,
    to_at: placed.net.coord.get(j.to) as LonLat,
  }));

  it('ends each reach where each of its downstream reaches starts, except across the transparent joins', () => {
    let touching = 0;
    const across: { reach: string; next: string; gap_m: number; join_m: number }[] = [];
    for (const r of release.reaches) {
      const line = lineOf.get(r.id) as TileLine;
      for (const d of r.downstream) {
        const next = lineOf.get(d);
        expect(next, `${r.id} → ${d} has a line`).toBeDefined();
        const gap = haversine(last(line), first(next as TileLine));
        if (gap <= TOUCH_M) {
          touching++;
          continue;
        }
        // Not touching: it must be the very join (KG-161) that links the two end points, no looser than its own length.
        const join = joins.find(
          (j) => haversine(j.from_at, last(line)) <= TOUCH_M && haversine(j.to_at, first(next as TileLine)) <= TOUCH_M,
        );
        expect(join, `${r.id} → ${d} is ${gap.toFixed(1)} m apart and no join links them`).toBeDefined();
        expect(Math.abs(gap - (join?.length_m ?? 0)), `${r.id} → ${d}`).toBeLessThanOrEqual(TOUCH_M);
        across.push({ reach: r.id, next: d, gap_m: Math.round(gap), join_m: join?.length_m ?? 0 });
      }
    }
    expect(touching).toBeGreaterThan(release.reaches.length / 2);
    // Every join that is used is one the placement lists; report how many reach pairs cross one.
    for (const a of across) expect(joins.some((j) => j.length_m === a.join_m)).toBe(true);
  });

  it('does not draw a reach against its flow: no reach starts where one of its downstream reaches ends', () => {
    for (const r of release.reaches) {
      const line = lineOf.get(r.id) as TileLine;
      for (const d of r.downstream) {
        const next = lineOf.get(d) as TileLine;
        // A loop (a reach that starts and ends in one place) would satisfy both directions; none exists in the data.
        if (haversine(first(line), last(line)) <= TOUCH_M) continue;
        if (haversine(last(line), first(next)) > TOUCH_M) continue; // across a join: checked above
        expect(haversine(first(line), last(next)), `${r.id} ← ${d}`).toBeGreaterThan(TOUCH_M);
      }
    }
  });

  it('has, in `upstream`, the mirror of `downstream`', () => {
    const by = new Map(release.reaches.map((r) => [r.id, r]));
    for (const r of release.reaches)
      for (const d of r.downstream) expect(by.get(d)?.upstream, `${d} lists ${r.id}`).toContain(r.id);
  });
});
