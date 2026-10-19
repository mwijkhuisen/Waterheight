import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { slug } from '../scripts/gen-web-labels.ts';
import {
  BuildError,
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
import { buildNetwork } from '../tools/geo/rivernet/network.ts';
import { parseOplRelations } from '../tools/geo/rivernet/opl.ts';
import { reachesFile } from '../tools/geo/rivernet/outputs.ts';
import { place, readOverrides } from '../tools/geo/rivernet/place.ts';
import { readSources } from '../tools/geo/rivernet/sources.ts';
import { readStations } from '../tools/geo/rivernet/stations.ts';
import { repoRoot } from './catalogue.ts';
import { fixtureWaterbodies } from './rivernet-waterbodies.ts';

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
const rivers = readRivers();
const canalIds = new Set(rivers.rivers.filter((r) => r.kind === 'canal').map((r) => r.id));
const mouths = (result.graph as { mouths: { id: string; river: string; node: string; waterbody: string }[] }).mouths;
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

  it('is acyclic: an independent topological order covers every node of the downstream edges', () => {
    // P17a: edges with direction `none` (tidal zone, canals) may form loops; the rest may not.
    const directed = edges.filter((e) => (e.direction ?? 'downstream') === 'downstream');
    const outD = new Map<string, Edge[]>();
    const indeg = new Map<string, number>();
    for (const e of directed) {
      outD.set(e.from, [...(outD.get(e.from) ?? []), e]);
      indeg.set(e.from, indeg.get(e.from) ?? 0);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    const queue = [...indeg].filter(([, d]) => d === 0).map(([n]) => n);
    let seen = 0;
    while (queue.length > 0) {
      const n = queue.pop() as string;
      seen++;
      for (const e of outD.get(n) ?? []) {
        const d = (indeg.get(e.to) ?? 0) - 1;
        indeg.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    expect(seen).toBe(indeg.size);
    expect(indeg.size).toBeGreaterThan(1000);
  });

  it('fails with cycle, naming both ways, when a reversed copy of an IJssel way is added', SLOW, async () => {
    const ways = await readWays(Readable.from([readFileSync(files.ways)]));
    const relations = parseOplRelations(readFileSync(files.relations, 'utf8'));
    const provenance = JSON.parse(readFileSync(files.provenance, 'utf8')) as Provenance;
    const original = result.edges.find((e) => e.rivers.includes('ijssel') && e.direction === 'downstream');
    expect(original).toBeDefined();
    const src = ways.get((original as Edge).way) as WayFeature;
    const newId = Math.max(...ways.keys()) + 1;
    ways.set(newId, {
      id: newId,
      nodes: [...src.nodes].reverse(),
      coords: [...src.coords].reverse(),
      tags: { ...src.tags },
    });
    const ijssel = rivers.rivers.find((r) => r.id === 'ijssel')?.osm_relation_id;
    const planted = relations.map((r) =>
      r.id === ijssel ? { ...r, members: [...r.members, { type: 'w' as const, ref: newId, role: 'main_stream' }] } : r,
    );
    let error: unknown;
    try {
      buildGraph(ways, planted, rivers, provenance);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).code).toBe('cycle');
    expect((error as BuildError).ids.sort()).toEqual([`w${src.id}`, `w${newId}`].sort());
  });

  it('has the Noord, the Oude Maas and the Dordtsche Kil on loops of the tidal zone, with direction none', () => {
    const zone = edges.filter((e) => e.direction_reason === 'tidal_zone');
    // Whether the undirected zone subgraph without `skip` still connects its two ends: then it lies on a loop.
    const connectedWithout = (skip: Edge) => {
      const adj = new Map<string, string[]>();
      for (const e of zone) {
        if (e === skip) continue;
        adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
        adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
      }
      const seen = new Set([skip.from]);
      const stack = [skip.from];
      while (stack.length > 0) {
        for (const m of adj.get(stack.pop() as string) ?? []) {
          if (seen.has(m)) continue;
          seen.add(m);
          stack.push(m);
        }
      }
      return seen.has(skip.to);
    };
    for (const river of ['noord', 'oude-maas', 'dordtsche-kil']) {
      const own = edges.filter((e) => e.rivers.includes(river));
      expect(own.length, river).toBeGreaterThan(0);
      for (const e of own)
        expect([e.direction, e.direction_reason], `${river} ${e.id}`).toEqual(['none', 'tidal_zone']);
      expect(own.some(connectedWithout), `${river} lies on a loop`).toBe(true);
    }
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
    // P17a: the Julianakanaal and the Zuid-Willemsvaart are curated `kind: canal` rows now (own tests below); three traps remain.
    expect(readSources().canal_traps.map((t) => t.name)).toEqual([
      'Albertkanaal',
      "Grand Canal d'Alsace",
      'Bijlands Kanaal',
    ]);
    for (const name of ['Albertkanaal', "Grand Canal d'Alsace", 'Bijlands Kanaal']) {
      const tw = trapWays(name);
      expect(tw.length, name).toBeGreaterThan(0);
      // A canal way is never an edge. The only trap ways that are edges are river ways a curated river keeps:
      // the Bijlands Kanaal (the Rhine itself) and the Rhine below Breisach, which the Grand Canal d'Alsace relation also lists.
      const asEdges = tw.filter((w) => edgeWays.has(w.id));
      expect(
        asEdges.filter((w) => w.tags.waterway !== 'river'),
        name,
      ).toEqual([]);
      if (name === 'Albertkanaal') expect(asEdges, name).toEqual([]);
    }
    // The Zuid-Willemsvaart at Smeermaas is in the fixture next to its station, for P6b's override.
    const smeermaas = stations.get('nl.rws.smeermaas.zuidwillemsvaart') as [number, number];
    expect(nearest(smeermaas, riverCoords('zuid-willemsvaart'))).toBeLessThan(1000);
  });

  it('keeps the ways of every canal row to edges of canals only, with direction none', () => {
    for (const id of canalIds)
      expect(
        edges.some((e) => e.rivers.includes(id)),
        id,
      ).toBe(true);
    for (const e of edges.filter((x) => x.rivers.some((r) => canalIds.has(r)))) {
      expect(
        e.rivers.filter((r) => !canalIds.has(r)),
        `${e.id} is shared with a river`,
      ).toEqual([]);
      expect([e.direction, e.direction_reason], e.id).toEqual(['none', 'canal']);
    }
  });

  it('carries wikidata on the relation of every canal whose evidence says two-way P402 (A6)', () => {
    const relations = parseOplRelations(readFileSync(files.relations, 'utf8'));
    const twoWay = rivers.rivers.filter((r) => r.kind === 'canal' && r.evidence.includes('two-way P402'));
    expect(twoWay.map((r) => r.id).sort()).toEqual([
      'eindhovensch-kanaal',
      'julianakanaal',
      'kanaal-wessem-nederweert',
      'maas-waalkanaal',
      'zwolle-ijsselkanaal',
    ]);
    for (const r of twoWay) {
      expect(relations.find((x) => x.id === r.osm_relation_id)?.tags.wikidata, r.id).toBe(r.wikidata);
    }
  });

  it('lets no canal reach, station, river entry or label into a public output (P17a)', SLOW, async () => {
    const placed = place(edges, rivers, readStations(), readOverrides(rivers), null, await fixtureWaterbodies(rivers));
    expect(placed.reaches.filter((r) => canalIds.has(r.river))).toEqual([]);
    expect(placed.stations.filter((s) => s.river !== null && canalIds.has(s.river))).toEqual([]);
    const file = reachesFile(placed, rivers, '20261018', '2026-10-17T20:20:51Z');
    expect(file.rivers.filter((r) => canalIds.has(r.id))).toEqual([]);
    for (const lang of ['nl', 'en']) {
      const messages = JSON.parse(readFileSync(`${repoRoot}apps/web/messages/${lang}.json`, 'utf8')) as object;
      for (const id of canalIds) expect(messages, `${lang} river_${slug(id)}`).not.toHaveProperty(`river_${slug(id)}`);
    }
  });

  describe('the five delta and Zwarte Water paths (P17a criterion)', () => {
    const net = buildNetwork(edges, rivers);
    const entry = (id: string) => net.entries.find((e) => e.id === id)?.node as string;
    const mouth = (id: string) => mouths.find((m) => m.id === id)?.node as string;

    /**
     * Whether a walk from `start` reaches `end` through the river `stages` in order: a downstream edge is followed
     * forward, a `none` edge both ways, a reviewed join forward; each link carries the current or the next stage's
     * river. A search over (node, stage), independent of startOf/endOf, which follow the digitising direction.
     */
    const pathThrough = (
      all: readonly Edge[],
      start: string,
      stages: readonly string[],
      end: string | ReadonlySet<string>,
    ) => {
      const links = new Map<string, { to: string; rivers: readonly string[] }[]>();
      const add = (from: string, to: string, rs: readonly string[]) =>
        links.set(from, [...(links.get(from) ?? []), { to, rivers: rs }]);
      for (const e of all) {
        add(e.from, e.to, e.rivers);
        if (e.direction === 'none') add(e.to, e.from, e.rivers);
      }
      for (const j of net.joins) add(j.from, j.to, [j.river]);
      const goal = (n: string) => (typeof end === 'string' ? n === end : end.has(n));
      const seen = new Set([`${start}|0`]);
      const stack: [string, number][] = [[start, 0]];
      while (stack.length > 0) {
        const [node, i] = stack.pop() as [string, number];
        if (i === stages.length - 1 && goal(node)) return true;
        for (const l of links.get(node) ?? []) {
          for (const j of [i, i + 1]) {
            const key = `${l.to}|${j}`;
            if (j >= stages.length || !l.rivers.includes(stages[j] as string) || seen.has(key)) continue;
            seen.add(key);
            stack.push([l.to, j]);
          }
        }
      }
      return false;
    };

    it('resolves every mouth of rivers.yaml to a node of its river (the water body: validateWaterbodies)', () => {
      expect(mouths.map((m) => m.id)).toEqual((rivers.mouths ?? []).map((m) => m.id).sort());
      for (const m of mouths) {
        expect(
          edges.some((e) => e.rivers.includes(m.river) && (e.from === m.node || e.to === m.node)),
          m.id,
        ).toBe(true);
      }
    });

    it('goes from Lobith through Noord and the Nieuwe Maas to the Nieuwe Waterweg mouth', () => {
      const stages = [
        'rhine',
        'waal',
        'boven-merwede',
        'beneden-merwede',
        'noord',
        'nieuwe-maas',
        'het-scheur',
        'nieuwe-waterweg',
      ];
      expect(pathThrough(edges, entry('lobith'), stages, mouth('nieuwe-waterweg-noordzee'))).toBe(true);
    });

    it('goes from Lobith through the Nieuwe Merwede and the Hollandsch Diep to the Haringvliet mouth', () => {
      const stages = ['rhine', 'waal', 'boven-merwede', 'nieuwe-merwede', 'hollandsch-diep', 'haringvliet'];
      expect(pathThrough(edges, entry('lobith'), stages, mouth('haringvliet-noordzee'))).toBe(true);
    });

    it('goes from Eijsden through the Bergsche Maas into the Amer', () => {
      const amer = new Set(edges.filter((e) => e.rivers.includes('amer')).flatMap((e) => [e.from, e.to]));
      expect(amer.size).toBeGreaterThan(0);
      expect(pathThrough(edges, entry('eijsden'), ['meuse', 'bergsche-maas', 'amer'], amer)).toBe(true);
    });

    it('goes from Lobith through the Pannerdensch Kanaal and the Nederrijn to the IJssel mouth', () => {
      const stages = ['rhine', 'pannerdensch-kanaal', 'nederrijn', 'ijssel'];
      expect(pathThrough(edges, entry('lobith'), stages, mouth('ijssel-ketelmeer'))).toBe(true);
    });

    it('goes from the Vecht border through the Zwarte Water to its mouth', () => {
      const stages = ['vechte', 'zwarte-water'];
      expect(pathThrough(edges, entry('vecht-border'), stages, mouth('zwarte-water-zwarte-meer'))).toBe(true);
    });

    it('finds no path that skips a stage', () => {
      const stages = ['rhine', 'waal', 'nieuwe-waterweg'];
      expect(pathThrough(edges, entry('lobith'), stages, mouth('nieuwe-waterweg-noordzee'))).toBe(false);
    });
  });

  it("reads the real exports to the reviewed counts and digests (the readers' golden)", SLOW, async () => {
    const ways = await readWays(Readable.from([readFileSync(files.ways)]));
    const relations = parseOplRelations(readFileSync(files.relations, 'utf8'));
    const digest = (v: unknown) => sha(canonicalJson(v));
    const actual = {
      ways: ways.size,
      relations: relations.length,
      ways_sha256: digest([...ways.values()].sort((a, b) => a.id - b.id)),
      relations_sha256: digest(relations),
      rhine: relations.find((r) => r.id === 123924)?.members.length,
    };
    if (process.env.UPDATE_GOLDENS === '1')
      writeFileSync(`${FX}rivernet.readers.golden.json`, `${JSON.stringify(actual, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(`${FX}rivernet.readers.golden.json`, 'utf8'));
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
