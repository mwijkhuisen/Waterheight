import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InputError, readGeoJsonSeq, type SeqCaps, type WayFeature } from '../tools/geo/rivernet/geojsonseq.ts';

const enc = new TextEncoder();

async function* chunked(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p;
}
async function collect(chunks: AsyncIterable<Uint8Array>, caps?: Partial<SeqCaps>): Promise<WayFeature[]> {
  const out: WayFeature[] = [];
  for await (const w of readGeoJsonSeq(chunks, caps)) out.push(w);
  return out;
}
async function codeOf(chunks: AsyncIterable<Uint8Array>, caps?: Partial<SeqCaps>): Promise<[string, number]> {
  try {
    await collect(chunks, caps);
  } catch (e) {
    if (e instanceof InputError) return [e.code, e.line];
    throw e;
  }
  throw new Error('expected an InputError');
}

/** The osmium line format, with the options the reader must tolerate. */
function osmiumLine(w: WayFeature, rs = true, eol = '\n'): string {
  const feature = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: w.coords },
    properties: { '@type': 'way', '@id': w.id, '@way_nodes': w.nodes, ...w.tags },
  };
  return `${rs ? '\x1e' : ''}${JSON.stringify(feature)}${eol}`;
}
const way = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [5.1, 51.9],
      [5.2, 51.95],
    ],
  },
  properties: { '@type': 'way', '@id': 7, '@way_nodes': [1, 2], ...props },
  ...over,
});
const lineOf = (v: unknown) => `\x1e${JSON.stringify(v)}\n`;

describe('readGeoJsonSeq golden', () => {
  const text = [
    '\x1e{"type":"Feature","geometry":{"type":"LineString","coordinates":[[6.0,51.8],[6.01,51.81],[6.02,51.82]]},"properties":{"@type":"way","@id":662657942,"@way_nodes":[10,11,12],"waterway":"river","name":"Rhein","name:nl":"Rijn","wikidata":"Q584"}}',
    '\x1e{"type":"Feature","geometry":{"type":"LineString","coordinates":[[4.5,52.0],[4.6,52.1]]},"properties":{"@type":"way","@id":42,"@way_nodes":[12,13],"waterway":"canal","name":"<script>alert(1)</script>"}}',
    '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-1.5,0],[1.5,-0.25]]},"properties":{"@type":"way","@id":9007199254740991,"@way_nodes":[1,2]}}',
  ].join('\n');

  it('parses three osmium lines, HTML in a tag stays data', async () => {
    expect(await collect(chunked(text, '\n'))).toEqual([
      {
        id: 662657942,
        nodes: [10, 11, 12],
        coords: [
          [6.0, 51.8],
          [6.01, 51.81],
          [6.02, 51.82],
        ],
        tags: { waterway: 'river', name: 'Rhein', 'name:nl': 'Rijn', wikidata: 'Q584' },
      },
      {
        id: 42,
        nodes: [12, 13],
        coords: [
          [4.5, 52.0],
          [4.6, 52.1],
        ],
        tags: { waterway: 'canal', name: '<script>alert(1)</script>' },
      },
      {
        id: 9007199254740991,
        nodes: [1, 2],
        coords: [
          [-1.5, 0],
          [1.5, -0.25],
        ],
        tags: {},
      },
    ]);
  });

  it('handles no final newline, CRLF, empty lines and a Feature id', async () => {
    const f = way({ id: 'x' });
    const got = await collect(chunked(`\n${lineOf(f).trimEnd()}\r\n\r\n\x1e\n`, lineOf(way()).trimEnd()));
    expect(got.map((w) => w.id)).toEqual([7, 7]);
  });

  it('keeps a __proto__ tag as data', async () => {
    const [w] = await collect(
      chunked(
        '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,1],[2,2]]},"properties":{"@type":"way","@id":1,"@way_nodes":[1,2],"__proto__":"x"}}\n',
      ),
    );
    expect(Object.keys((w as WayFeature).tags)).toEqual(['__proto__']);
  });
});

describe('readGeoJsonSeq errors', () => {
  it('line_too_long without ever buffering past the cap', async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      const piece = new Uint8Array(100).fill(0x61);
      for (;;) {
        pulled += piece.length;
        yield piece;
      }
    }
    expect(await codeOf(endless(), { maxLineBytes: 1024 })).toEqual(['line_too_long', 1]);
    expect(pulled).toBeLessThanOrEqual(1024 + 100);
  });

  it('line_too_long for a 10 KiB line split in chunks, reported at its line', async () => {
    const big = `{"x":"${'a'.repeat(10 * 1024)}"}\n`;
    expect(await codeOf(chunked(lineOf(way()), big), { maxLineBytes: 1024 })).toEqual(['line_too_long', 2]);
  });

  it('input_too_large counts all bytes', async () => {
    const l = lineOf(way());
    expect(await codeOf(chunked(l, l, l), { maxTotalBytes: l.length * 2 })).toEqual(['input_too_large', 3]);
  });

  it('bad_utf8', async () => {
    expect(await codeOf(chunked(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a])))).toEqual(['bad_utf8', 1]);
    // a multi-byte sequence cut in half by the line end
    expect(await codeOf(chunked(lineOf(way()), new Uint8Array([0xc3, 0x0a])))).toEqual(['bad_utf8', 2]);
  });

  it('bad_json', async () => {
    expect(await codeOf(chunked('\x1e{"type":\n'))).toEqual(['bad_json', 1]);
    expect(await codeOf(chunked('not json\n'))).toEqual(['bad_json', 1]);
  });

  const feature = (patch: (f: ReturnType<typeof way>) => unknown) => lineOf(patch(way()));
  const badFeatures: [string, string][] = [
    ['wrong @type', lineOf(way({}, { '@type': 'node' }))],
    ['not a Feature', feature((f) => ({ ...f, type: 'FeatureCollection' }))],
    ['array', '[]\n'],
    ['null', 'null\n'],
    ['unknown Feature key', feature((f) => ({ ...f, extra: 1 }))],
    ['not a LineString', feature((f) => ({ ...f, geometry: { type: 'Point', coordinates: [1, 2] } }))],
    ['node count mismatch', lineOf(way({}, { '@way_nodes': [1, 2, 3] }))],
    [
      'one coordinate',
      feature((f) => ({
        ...f,
        geometry: { type: 'LineString', coordinates: [[1, 2]] },
        properties: { ...f.properties, '@way_nodes': [1] },
      })),
    ],
    [
      'lat out of range',
      feature((f) => ({
        ...f,
        geometry: {
          type: 'LineString',
          coordinates: [
            [1, 91],
            [2, 2],
          ],
        },
      })),
    ],
    [
      'lon out of range',
      feature((f) => ({
        ...f,
        geometry: {
          type: 'LineString',
          coordinates: [
            [181, 1],
            [2, 2],
          ],
        },
      })),
    ],
    [
      '3D coordinate',
      feature((f) => ({
        ...f,
        geometry: {
          type: 'LineString',
          coordinates: [
            [1, 1, 5],
            [2, 2],
          ],
        },
      })),
    ],
    [
      'string coordinate',
      feature((f) => ({
        ...f,
        geometry: {
          type: 'LineString',
          coordinates: [
            ['1', 1],
            [2, 2],
          ],
        },
      })),
    ],
    ['zero id', lineOf(way({}, { '@id': 0 }))],
    ['float id', lineOf(way({}, { '@id': 1.5 }))],
    ['negative node', lineOf(way({}, { '@way_nodes': [1, -2] }))],
    ['missing @way_nodes', lineOf(way({}, { '@way_nodes': undefined }))],
    ['non-string tag', lineOf(way({}, { maxspeed: 50 }))],
    ['null tag', lineOf(way({}, { name: null }))],
    ['unknown @ key', lineOf(way({}, { '@version': '1' }))],
    ['tag value over 255', lineOf(way({}, { name: 'x'.repeat(256) }))],
    ['tag key over 255', lineOf(way({}, { ['k'.repeat(256)]: 'x' }))],
  ];
  it.each(badFeatures)('bad_feature: %s', async (_name, line) => {
    expect(await codeOf(chunked(line))).toEqual(['bad_feature', 1]);
  });

  it('bad_feature: too many tags, too many nodes', async () => {
    const tags = Object.fromEntries([1, 2, 3].map((i) => [`k${i}`, 'v']));
    expect(await codeOf(chunked(lineOf(way({}, tags))), { maxTags: 2 })).toEqual(['bad_feature', 1]);
    expect(await codeOf(chunked(lineOf(way())), { maxWayNodes: 1 })).toEqual(['bad_feature', 1]);
  });

  it('accepts a 255 char tag and exactly the cap of tags', async () => {
    const got = await collect(chunked(lineOf(way({}, { name: 'x'.repeat(255), a: 'b' }))), { maxTags: 2 });
    expect(Object.keys(got[0]?.tags ?? {})).toEqual(['name', 'a']);
  });

  it('messages never carry input', async () => {
    const e = await collect(chunked('{"secret-marker":\n')).catch((x: unknown) => x);
    expect((e as InputError).message).toBe('bad_json at line 1');
  });
});

const uni = fc
  .array(fc.oneof(fc.integer({ min: 0x20, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), {
    maxLength: 10,
  })
  .map((a) => String.fromCodePoint(...a));
const wayArb: fc.Arbitrary<WayFeature> = fc.integer({ min: 2, max: 8 }).chain((n) =>
  fc.record({
    id: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    nodes: fc.array(fc.integer({ min: 1, max: 2 ** 40 }), { minLength: n, maxLength: n }),
    coords: fc.array(
      fc
        .tuple(fc.integer({ min: -18_000_000, max: 18_000_000 }), fc.integer({ min: -9_000_000, max: 9_000_000 }))
        .map(([x, y]): [number, number] => [x / 1e5, y / 1e5]),
      { minLength: n, maxLength: n },
    ),
    tags: fc.dictionary(
      uni.filter((k) => k !== '' && !k.startsWith('@') && k !== '__proto__'),
      uni,
      { maxKeys: 6 },
    ),
  }),
);
const cutsArb = fc.array(fc.nat(100_000), { maxLength: 12 });
function split(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const p of [...points, bytes.length]) {
    out.push(bytes.subarray(prev, p));
    prev = p;
  }
  return out;
}

describe('readGeoJsonSeq properties', () => {
  it('yields exactly the generated features for any RS, line ending and chunking', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(wayArb, fc.boolean(), fc.boolean()), { maxLength: 6 }),
        cutsArb,
        fc.boolean(),
        async (items, cuts, finalNl) => {
          let text = items.map(([w, rs, crlf]) => osmiumLine(w, rs, crlf ? '\r\n' : '\n')).join('');
          if (!finalNl) text = text.replace(/\r?\n$/, '');
          const got = await collect(chunked(...split(enc.encode(text), cuts)));
          expect(got).toEqual(items.map(([w]) => w));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('arbitrary bytes either parse or throw an InputError', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), cutsArb, async (bytes, cuts) => {
        try {
          await collect(chunked(...split(bytes, cuts)), { maxLineBytes: 200 });
        } catch (e) {
          expect(e).toBeInstanceOf(InputError);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('mutated valid lines either parse or throw an InputError', async () => {
    await fc.assert(
      fc.asyncProperty(wayArb, fc.nat(1000), fc.integer({ min: 0, max: 255 }), async (w, at, byte) => {
        const bytes = enc.encode(osmiumLine(w));
        bytes[at % bytes.length] = byte;
        try {
          await collect(chunked(bytes));
        } catch (e) {
          expect(e).toBeInstanceOf(InputError);
        }
      }),
      { numRuns: 200 },
    );
  });
});
