import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type BuildResult,
  buildFromFiles,
  buildGraph,
  canonicalJson,
  type Edge,
  type Provenance,
  readRivers,
  readWays,
} from '../tools/geo/rivernet/build.ts';
import type { WayFeature } from '../tools/geo/rivernet/geojsonseq.ts';
import { parseOplRelations } from '../tools/geo/rivernet/opl.ts';
import { readSources } from '../tools/geo/rivernet/sources.ts';
import { repoRoot } from './catalogue.ts';

// The P6a criterion on the committed fixture PBF's osmium exports (tools/geo/fixtures/README.md):
// the graph is acyclic, the Pannerdensche Kop and the IJsselkop each have 2 downstream edges, the
// Moselle mouth at Koblenz is a node of the Rhine, a tributary joining mid-way splits the way, and two
// runs on the same input, in any line order, give the same bytes. geo.yml re-exports the PBF and compares.

const FX = `${repoRoot}tools/geo/fixtures/`;
const files = {
  ways: `${FX}rivernet.ways.geojsonseq`,
  relations: `${FX}rivernet.relations.opl`,
  provenance: `${FX}rivernet.provenance.json`,
};
const SLOW = { timeout: 120_000 };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bytesOf = (r: BuildResult) =>
  sha([canonicalJson(r.graph), canonicalJson(r.reaches), canonicalJson(r.report, 2)].join(''));

const result = await buildFromFiles(files);
const edges = result.edges;
const out = new Map<string, Edge[]>();
const into = new Map<string, Edge[]>();
for (const e of edges) {
  out.set(e.from, [...(out.get(e.from) ?? []), e]);
  into.set(e.to, [...(into.get(e.to) ?? []), e]);
}
/** The node where a river begins: an edge of it leaves there and none of its edges arrives. */
const startOf = (river: string) => {
  const own = edges.filter((e) => e.rivers.includes(river));
  const arrives = new Set(own.map((e) => e.to));
  return [...new Set(own.map((e) => e.from).filter((n) => !arrives.has(n)))].sort();
};
const endOf = (river: string) => {
  const own = edges.filter((e) => e.rivers.includes(river));
  const leaves = new Set(own.map((e) => e.from));
  return [...new Set(own.map((e) => e.to).filter((n) => !leaves.has(n)))].sort();
};

describe('the fixture graph (P6a criterion)', () => {
  it('is no larger than 15 MB as a PBF', () => {
    expect(statSync(`${FX}rivernet.osm.pbf`).size).toBeLessThanOrEqual(15 * 1024 * 1024);
  });

  it('is acyclic: an independent topological order covers every node', () => {
    const indeg = new Map<string, number>();
    for (const e of edges) {
      indeg.set(e.from, indeg.get(e.from) ?? 0);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    const queue = [...indeg].filter(([, d]) => d === 0).map(([n]) => n);
    let seen = 0;
    while (queue.length > 0) {
      const n = queue.pop() as string;
      seen++;
      for (const e of out.get(n) ?? []) {
        const d = (indeg.get(e.to) ?? 0) - 1;
        indeg.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    expect(seen).toBe(indeg.size);
    expect(indeg.size).toBeGreaterThan(1000);
  });

  it('splits at the Pannerdensche Kop: the Waal begins at a node with exactly 2 downstream edges', () => {
    const [kop, ...more] = startOf('waal');
    expect(more).toEqual([]);
    const downstream = out.get(kop as string) ?? [];
    expect(downstream).toHaveLength(2);
    expect(downstream.some((e) => e.rivers.includes('waal'))).toBe(true);
    expect(downstream.some((e) => !e.rivers.includes('waal'))).toBe(true);
    // Upstream of it is the Rhine (Bovenrijn).
    expect((into.get(kop as string) ?? []).some((e) => e.rivers.includes('rhine'))).toBe(true);
  });

  it('splits at the IJsselkop: the IJssel begins at a node with exactly 2 downstream edges', () => {
    const [kop, ...more] = startOf('ijssel');
    expect(more).toEqual([]);
    const downstream = out.get(kop as string) ?? [];
    expect(downstream).toHaveLength(2);
    expect(downstream.some((e) => e.rivers.includes('ijssel'))).toBe(true);
    expect(downstream.some((e) => e.rivers.includes('nederrijn'))).toBe(true);
  });

  it('lists every bifurcation, and the list is the reviewed golden', () => {
    const golden = JSON.parse(readFileSync(`${FX}rivernet.bifurcations.golden.json`, 'utf8'));
    expect((result.report as { graph: { bifurcations: unknown } }).graph.bifurcations).toEqual(golden);
  });

  it('makes the Moselle mouth at Koblenz a node of the Rhine', () => {
    const [mouth, ...more] = endOf('moselle');
    expect(more).toEqual([]);
    expect((into.get(mouth as string) ?? []).some((e) => e.rivers.includes('rhine'))).toBe(true);
    expect((out.get(mouth as string) ?? []).some((e) => e.rivers.includes('rhine'))).toBe(true);
  });

  it('splits a way where another river joins it mid-way', () => {
    // A node where one input way runs on as two consecutive edges (w<way>.<k> ends there, w<way>.<k+1> starts
    // there) and an edge of another river ends. In run 37064062453's fixture, for one, the Ahr joins the Rhine way
    // w83015485 at n560170160.
    const byId = new Map(edges.map((e) => [e.id, e]));
    const joins = edges.filter((e) => {
      const [way, k] = e.id.slice(1).split('.');
      const next = byId.get(`w${way}.${Number(k) + 1}`);
      return (
        next?.from === e.to &&
        (into.get(e.to) ?? []).some((o) => o !== e && !o.rivers.some((r) => e.rivers.includes(r)))
      );
    });
    expect(joins.length).toBeGreaterThan(0);
  });

  it('carries the §0.6 rivers beside their stations, and the canal traps, which become edges only as river ways', async () => {
    const ways = await readWays(Readable.from([readFileSync(files.ways)]));
    const relations = parseOplRelations(readFileSync(files.relations, 'utf8'));
    const stations = new Map(
      readdirSync(`${repoRoot}registry/stations`)
        .flatMap((f) => parse(readFileSync(`${repoRoot}registry/stations/${f}`, 'utf8')).stations)
        .map((s: { id: string; lon: number; lat: number }) => [s.id, [s.lon, s.lat] as [number, number]]),
    );
    const metres = ([a, b]: [number, number], [c, d]: [number, number]) =>
      Math.hypot((a - c) * 111_320 * Math.cos((b * Math.PI) / 180), (b - d) * 110_540);
    const nearest = (at: [number, number], coords: [number, number][]) => Math.min(...coords.map((c) => metres(at, c)));
    const riverCoords = (river: string) =>
      result.edges.filter((e) => e.rivers.includes(river)).flatMap((e) => e.coords);
    // §0.6: the Belgian points and their own rivers (Semois at Membre, Chiers at Athus, Viroin at Treignes,
    // Lys at Menen, the Grensmaas at Maaseik and Lanaken) all have an edge of that river within 1 km.
    const points: [string, string][] = [
      ['semois', 'fr.sandre.B610000201'],
      ['chiers', 'fr.sandre.B400101101'],
      ['viroin', 'fr.sandre.B713000101'],
      ['lys', 'fr.sandre.E381126601'],
      ['meuse', 'nl.rws.maaseik'],
      ['meuse', 'nl.rws.lanaken'],
    ];
    for (const [river, station] of points) {
      expect(
        nearest(stations.get(station) as [number, number], riverCoords(river)),
        `${river} at ${station}`,
      ).toBeLessThan(1000);
    }
    const edgeWays = new Set(result.edges.map((e) => e.way));
    const trapWays = (name: string) => {
      const trap = readSources().canal_traps.find((t) => t.name === name);
      const rs = relations.filter(
        (r) => r.id === trap?.osm_relation_id || (trap?.wikidata != null && r.tags.wikidata === trap.wikidata),
      );
      const ids = new Set([
        ...rs.flatMap((r) => r.members.filter((m) => m.type === 'w').map((m) => m.ref)),
        ...[...ways.values()].filter((w) => w.tags.wikidata === trap?.wikidata).map((w) => w.id),
      ]);
      return [...ids].filter((id) => ways.has(id)).map((id) => ways.get(id) as WayFeature);
    };
    for (const name of [
      'Julianakanaal',
      'Albertkanaal',
      'Zuid-Willemsvaart',
      "Grand Canal d'Alsace",
      'Bijlands Kanaal',
    ]) {
      const tw = trapWays(name);
      expect(tw.length, name).toBeGreaterThan(0);
      // A canal way is never an edge. The only trap ways that are edges are river ways a curated river keeps:
      // the Bijlands Kanaal (the Rhine itself) and the Rhine below Breisach, which the Grand Canal d'Alsace relation also lists.
      const asEdges = tw.filter((w) => edgeWays.has(w.id));
      expect(
        asEdges.filter((w) => w.tags.waterway !== 'river'),
        name,
      ).toEqual([]);
      if (['Julianakanaal', 'Albertkanaal', 'Zuid-Willemsvaart'].includes(name)) expect(asEdges, name).toEqual([]);
    }
    // The Zuid-Willemsvaart at Smeermaas is in the fixture next to its station, for P6b's override.
    const smeermaas = stations.get('nl.rws.smeermaas.zuidwillemsvaart') as [number, number];
    expect(
      nearest(
        smeermaas,
        trapWays('Zuid-Willemsvaart').flatMap((w) => w.coords),
      ),
    ).toBeLessThan(1000);
  });

  it("reads the real exports to the reviewed counts and digests (the readers' golden)", SLOW, async () => {
    const ways = await readWays(Readable.from([readFileSync(files.ways)]));
    const relations = parseOplRelations(readFileSync(files.relations, 'utf8'));
    const digest = (v: unknown) => sha(canonicalJson(v));
    const golden = JSON.parse(readFileSync(`${FX}rivernet.readers.golden.json`, 'utf8'));
    const actual = {
      ways: ways.size,
      relations: relations.length,
      ways_sha256: digest([...ways.values()].sort((a, b) => a.id - b.id)),
      relations_sha256: digest(relations),
      rhine: relations.find((r) => r.id === 123924)?.members.length,
    };
    if (process.env.UPDATE_GOLDENS === '1')
      writeFileSync(`${FX}rivernet.readers.golden.json`, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(golden);
  });

  it('gives the same bytes on a second run and with the input lines shuffled', SLOW, async () => {
    const first = bytesOf(result);
    expect(bytesOf(await buildFromFiles(files))).toBe(first);
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const shuffle = <T>(xs: T[]) => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j] as T, a[i] as T];
      }
      return a;
    };
    const lines = shuffle(
      readFileSync(files.ways, 'utf8')
        .split('\n')
        .filter((l) => l !== ''),
    );
    const ways = await readWays(Readable.from([Buffer.from(`${lines.join('\n')}\n`)]));
    const relations = shuffle(parseOplRelations(readFileSync(files.relations, 'utf8')));
    const provenance = JSON.parse(readFileSync(files.provenance, 'utf8')) as Provenance;
    expect(bytesOf(buildGraph(ways, relations, readRivers(), provenance))).toBe(first);
  });

  it('writes byte-identical files from two CLI runs', SLOW, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivernet-'));
    try {
      const sums = [1, 2].map((n) => {
        const r = spawnSync(
          process.execPath,
          [
            'tools/geo/rivernet/build.ts',
            '--ways',
            files.ways,
            '--relations',
            files.relations,
            '--provenance',
            files.provenance,
            '--out',
            join(dir, `${n}`),
          ],
          { cwd: repoRoot, encoding: 'utf8' },
        );
        expect(r.status, r.stderr).toBe(0);
        return ['river_graph.json', 'reaches.geojson', 'build-report.json'].map((f) =>
          sha(readFileSync(join(dir, `${n}`, f), 'utf8')),
        );
      });
      expect(sums[1]).toEqual(sums[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
