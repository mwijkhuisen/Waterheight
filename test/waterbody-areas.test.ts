import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import type { WaterbodiesFile, Waterbody } from '../packages/contracts/src/waterbodies.ts';
import { BuildError } from '../tools/geo/rivernet/build.ts';
import { type AreaCaps, type AreaFeature, InputError, readAreaSeq } from '../tools/geo/rivernet/geojsonseq.ts';
import { loadWaterbodyInput } from '../tools/geo/rivernet/waterbodies.ts';

// P17b: the reader of the water-body export (`osmium export -f geojsonseq -a type,id --geometry-types=polygon`) and
// its join to registry/waterbodies.yaml. Synthetic lines in osmium's format.

const enc = new TextEncoder();
async function* chunked(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p;
}
async function collect(chunks: AsyncIterable<Uint8Array>, caps?: Partial<AreaCaps>): Promise<AreaFeature[]> {
  const out: AreaFeature[] = [];
  for await (const a of readAreaSeq(chunks, caps)) out.push(a);
  return out;
}
async function codeOf(chunks: AsyncIterable<Uint8Array>, caps?: Partial<AreaCaps>): Promise<[string, number]> {
  try {
    await collect(chunks, caps);
  } catch (e) {
    if (e instanceof InputError) return [e.code, e.line];
    throw e;
  }
  throw new Error('expected an InputError');
}

const square = (x: number, y: number, d = 0.1): [number, number][] => [
  [x, y],
  [x + d, y],
  [x + d, y + d],
  [x, y + d],
  [x, y],
];
const area = (
  type: string,
  id: number,
  geometry: { type: string; coordinates: unknown },
  tags: Record<string, unknown> = { natural: 'water', name: 'Meer' },
) => ({ type: 'Feature', geometry, properties: { '@type': type, '@id': id, ...tags } });
const polygon = (rings: [number, number][][]) => ({ type: 'Polygon', coordinates: rings });
const lineOf = (v: unknown) => `\x1e${JSON.stringify(v)}\n`;

describe('readAreaSeq', () => {
  it('reads a Polygon and a MultiPolygon with a hole, and drops every tag', async () => {
    const lake = area('way', 12, polygon([square(5, 52)]));
    const multi = area(
      'relation',
      945096,
      {
        type: 'MultiPolygon',
        coordinates: [[square(5, 52, 1), square(5.2, 52.2, 0.1)], [square(7, 53)]],
      },
      { type: 'multipolygon', natural: 'water', name: '<b>IJsselmeer</b>' },
    );
    const got = await collect(chunked(lineOf(lake), lineOf(multi)));
    expect(got).toEqual([
      { type: 'way', id: 12, polygons: [[square(5, 52)]] },
      { type: 'relation', id: 945096, polygons: [[square(5, 52, 1), square(5.2, 52.2, 0.1)], [square(7, 53)]] },
    ]);
    expect(JSON.stringify(got)).not.toContain('IJsselmeer');
    for (const a of got) expect(Object.keys(a).sort()).toEqual(['id', 'polygons', 'type']);
  });

  it('reads lines with no RS, CRLF, empty lines and no final newline, like the way reader', async () => {
    const l = JSON.stringify(area('way', 1, polygon([square(1, 1)])));
    const got = await collect(chunked(`\n${l}\r\n\r\n\x1e\n`, l));
    expect(got.map((a) => a.id)).toEqual([1, 1]);
  });

  const ok = polygon([square(5, 52)]);
  const bad: [string, unknown][] = [
    ['not a Feature', { ...area('way', 1, ok), type: 'FeatureCollection' }],
    ['unknown Feature key', { ...area('way', 1, ok), extra: 1 }],
    ['a LineString', area('way', 1, { type: 'LineString', coordinates: square(5, 52) })],
    ['a Point', area('way', 1, { type: 'Point', coordinates: [5, 52] })],
    ['no geometry', { type: 'Feature', properties: { '@type': 'way', '@id': 1 } }],
    ['@type node', area('node', 1, ok)],
    ['@type area', area('area', 1, ok)],
    ['no @type', { type: 'Feature', geometry: ok, properties: { '@id': 1 } }],
    ['no @id', { type: 'Feature', geometry: ok, properties: { '@type': 'way' } }],
    ['zero @id', area('way', 0, ok)],
    ['another @ key', area('way', 1, ok, { '@way_nodes': [1, 2] })],
    ['a non-string tag', area('way', 1, ok, { depth: 5 })],
    ['a tag over 255', area('way', 1, ok, { note: 'x'.repeat(256) })],
    ['no polygon', area('way', 1, { type: 'MultiPolygon', coordinates: [] })],
    ['no ring', area('way', 1, polygon([]))],
    ['a ring of 3', area('way', 1, polygon([square(5, 52).slice(2)]))],
    ['an open ring', area('way', 1, polygon([[...square(5, 52).slice(0, 4), [5.05, 52]]]))],
    [
      'a 3D position',
      area('way', 1, polygon([square(5, 52).map(([x, y]) => [x, y, 0] as unknown as [number, number])])),
    ],
    ['lat out of range', area('way', 1, polygon([square(5, 90)]))],
    ['lon out of range', area('way', 1, polygon([square(180, 52)]))],
    ['a string coordinate', area('way', 1, polygon([[['5', 52], ...square(5, 52).slice(1)] as [number, number][]]))],
  ];
  it.each(bad)('bad_feature: %s', async (_name, v) => {
    expect(await codeOf(chunked(lineOf(v)))).toEqual(['bad_feature', 1]);
  });

  it('bad_feature on too many tags', async () => {
    expect(await codeOf(chunked(lineOf(area('way', 1, ok))), { maxTags: 1 })).toEqual(['bad_feature', 1]);
  });

  it('too_many_vertices and too_many_rings, counted over the whole area', async () => {
    // two polygons of one ring of 5 positions each
    const two = area('relation', 2, { type: 'MultiPolygon', coordinates: [[square(5, 52)], [square(6, 52)]] });
    expect(await collect(chunked(lineOf(two)), { maxVertices: 10, maxRings: 2 })).toHaveLength(1);
    expect(await codeOf(chunked(lineOf(two)), { maxVertices: 9 })).toEqual(['too_many_vertices', 1]);
    expect(await codeOf(chunked(lineOf(area('way', 1, ok)), lineOf(two)), { maxRings: 1 })).toEqual([
      'too_many_rings',
      2,
    ]);
  });

  it('line_too_long, input_too_large, bad_utf8 and bad_json', async () => {
    const l = lineOf(area('way', 1, ok));
    expect(await codeOf(chunked(l, `{"x":"${'a'.repeat(2048)}"}\n`), { maxLineBytes: 1024 })).toEqual([
      'line_too_long',
      2,
    ]);
    expect(await codeOf(chunked(l, l, l), { maxTotalBytes: l.length * 2 })).toEqual(['input_too_large', 3]);
    expect(await codeOf(chunked(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a])))).toEqual(['bad_utf8', 1]);
    expect(await codeOf(chunked('\x1e{"type":\n'))).toEqual(['bad_json', 1]);
  });

  it('never puts input into a message', async () => {
    const e = await collect(chunked(lineOf(area('node', 1, ok, { name: 'secret-marker' })))).catch((x: unknown) => x);
    expect((e as InputError).message).toBe('bad_feature at line 1');
  });

  it('either parses or throws an InputError on mutated lines', async () => {
    const bytes = enc.encode(lineOf(area('relation', 7, { type: 'MultiPolygon', coordinates: [[square(5, 52)]] })));
    await fc.assert(
      fc.asyncProperty(fc.nat(10_000), fc.integer({ min: 0, max: 255 }), async (at, byte) => {
        const b = bytes.slice();
        b[at % b.length] = byte;
        try {
          for (const a of await collect(chunked(b))) expect(['way', 'relation']).toContain(a.type);
        } catch (e) {
          expect(e).toBeInstanceOf(InputError);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('loadWaterbodyInput', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'waterbody-areas-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let serial = 0;
  const write = (text: string, gz = false) => {
    const path = join(tmp, `a${++serial}.geojsonseq${gz ? '.gz' : ''}`);
    writeFileSync(path, gz ? gzipSync(Buffer.from(text)) : text);
    return path;
  };
  const body = (id: string, osm: Waterbody['osm'], extra: Partial<Waterbody> = {}): Waterbody => ({
    id,
    kind: 'lake',
    name_nl: id,
    name_en: id,
    wikidata: 'Q1',
    osm,
    names: {},
    managed_level: true,
    outflows: [],
    reference_station: null,
    evidence: ['https://example.org/e'],
    ...extra,
  });
  const file: WaterbodiesFile = {
    version: 1,
    waterbodies: [
      body('meer', { type: 'relation', id: 945096 }),
      body('plas', { type: 'way', id: 12 }),
      body('zee', null, { kind: 'sea', point: [3, 53], bbox: [2, 52, 4, 54] }),
    ],
  };
  const relation = lineOf(area('relation', 945096, { type: 'MultiPolygon', coordinates: [[square(5, 52)]] }));
  const way = lineOf(area('way', 12, polygon([square(6, 52)])));
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: unknown) => (e instanceof BuildError ? `${e.code} ${e.ids.join(',')}` : String(e)),
    );

  it('maps each export area to its body by OSM object, from a plain or a gzipped file', async () => {
    for (const gz of [false, true]) {
      const input = await loadWaterbodyInput(file, write(way + relation, gz));
      expect(input.file).toBe(file);
      expect([...input.areas.keys()].sort()).toEqual(['meer', 'plas']);
      expect(input.areas.get('meer')).toEqual({ id: 'meer', polygons: [[square(5, 52)]] });
      expect(input.areas.get('plas')).toEqual({ id: 'plas', polygons: [[square(6, 52)]] });
      expect(input.areas.has('zee')).toBe(false); // point-only: no area
    }
  });

  it('fails on an area no body declares, an area twice and a polygon body without an area', async () => {
    const stray = lineOf(area('way', 945096, polygon([square(7, 52)]))); // the relation's number, as a way
    expect(await code(loadWaterbodyInput(file, write(way + relation + stray)))).toBe('waterbody_unexpected w945096');
    expect(await code(loadWaterbodyInput(file, write(way + relation + way)))).toBe('waterbody_duplicate w12');
    expect(await code(loadWaterbodyInput(file, write(way)))).toBe('waterbody_unassembled meer');
    expect(await code(loadWaterbodyInput(file, write('')))).toBe('waterbody_unassembled meer,plas');
  });

  it('passes on the reader errors (a gzipped file too), a missing file and a .gz that is not gzip', async () => {
    const e = await loadWaterbodyInput(file, write('not json\n', true)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InputError);
    expect((e as InputError).code).toBe('bad_json');
    await expect(loadWaterbodyInput(file, join(tmp, 'none.geojsonseq'))).rejects.toThrow(/ENOENT/);
    await expect(loadWaterbodyInput(file, join(tmp, 'none.geojsonseq.gz'))).rejects.toThrow(/ENOENT/);
    const notGzip = join(tmp, 'plain.geojsonseq.gz');
    writeFileSync(notGzip, way);
    await expect(loadWaterbodyInput(file, notGzip)).rejects.toThrow();
  });
});
