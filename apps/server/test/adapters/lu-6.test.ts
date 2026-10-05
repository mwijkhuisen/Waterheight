import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { emptyNormalised, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type Drift, driftReport, GONE_M, MOVED_M, metres, normalise } from '../../src/adapters/lu-6/normalise.ts';
import { JSON_CAPS, parseFeatures, type Station } from '../../src/adapters/lu-6/parse.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import type { SeriesRow } from '../../src/load/store.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// LU-6 geoportail.lu `collections/655/items` (CC0): the AGE hydrometric station points. Parse of the real recordings
// equals the committed golden files (invariant 9); `UPDATE_GOLDEN=1` rewrites them. The adapter stores nothing: the
// points are registry input, and the loader's daily payload reports drift against the LU-1 registry (positions and
// fiche numbers only, never a name).

const spec = LOAD_ADAPTERS['LU-6']?.specs['lu-6-geo'];
const lu1 = registryOf('LU-1');

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('LU-6', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The LU-1 series with the positions registry/stations/lu-1.yaml declares (null for Perl: it has none). */
const positions = (() => {
  const file = new URL('../../../../registry/stations/lu-1.yaml', import.meta.url);
  const rows = StationsFile.parse(parse(readFileSync(file, 'utf8'))).stations;
  return new Map(rows.map((r) => [r.provider_key, { key: r.provider_key, lon: r.lon, lat: r.lat }]));
})();
const seriesRows = (): ReadonlyMap<string, SeriesRow> =>
  new Map(
    [...positions].map(([k, p]) => [
      k,
      {
        ...(lu1.get(k) as NonNullable<ReturnType<typeof lu1.get>>),
        id: 0,
        tier: 2,
        off: false,
        sameAudience: true,
        audience: 'public' as const,
        staleness_ms: 0,
        role: 'primary' as const,
        lon: p.lon,
        lat: p.lat,
      },
    ]),
  );

const body = (name: string) => rawFixture('LU-6', name).body;
const stations = (name: string) => parseFeatures(body(name));
const doc = (name = 'lu-6-geo-subset') => JSON.parse(body(name).toString('utf8'));
// biome-ignore lint/suspicious/noExplicitAny: a JSON document edited by hand in the tests
const edit = (fn: (d: any) => void, name?: string) => {
  const d = doc(name);
  fn(d);
  return Buffer.from(JSON.stringify(d));
};
const drift = (fn: () => unknown): [string, string] | 'parsed' => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return [(err as SchemaDrift).code, (err as SchemaDrift).path];
  }
  return 'parsed';
};

/** A point `m` metres north of `p`. */
const north = (p: { lon: number; lat: number }, m: number) => ({ lon: p.lon, lat: p.lat + m / 111_195 });
const st = (o: Partial<Station> = {}): Station => ({
  name: 'x',
  code: '11',
  inService: true,
  lon: 6.16,
  lat: 49.86,
  ...o,
});

describe('golden files (real payloads)', () => {
  it('the whole collection (51 stations): names with their accents, fiche numbers as text with their leading zeros', () => {
    const got = stations('lu-6-geo');
    expect({ stations: got }).toEqual(golden('lu-6-geo', { stations: got }));
    expect(got).toHaveLength(51);
    expect(got.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Esch/Sûre', 'Gemünd', 'Schéimelzerbesch', 'Rommelerkräiz']),
    );
    expect(got.some((s) => s.name.includes('�'))).toBe(false);
    // Fiche numbers are strings (`02`, `0029151`), not numbers; every station has one.
    expect(got.every((s) => typeof s.code === 'string')).toBe(true);
    expect(got.find((s) => s.name === 'Hesperange')?.code).toBe('02');
    expect(new Set(got.map((s) => s.code)).size).toBe(51);
    // Two stations are out of service.
    expect(got.filter((s) => !s.inService).map((s) => s.code)).toEqual(['77', '103']);
    for (const s of got) {
      expect(s.lon).toBeGreaterThan(5.7);
      expect(s.lon).toBeLessThan(6.6);
      expect(s.lat).toBeGreaterThan(49.4);
      expect(s.lat).toBeLessThan(50.2);
    }
  });

  it('eight stations (trimmed): the fiche codes of Wasserbillig and Gemünd, both Kautenbach and both Niederfeulen', () => {
    const got = stations('lu-6-geo-subset');
    expect({ stations: got }).toEqual(golden('lu-6-geo-subset', { stations: got }));
    const code = (name: string) => got.filter((s) => s.name === name).map((s) => s.code);
    expect(code('Wasserbillig')).toEqual(['0029151']);
    expect(code('Gemünd')).toEqual(['2626030300']);
    expect(code('Kautenbach')).toEqual(['14', '104']);
    // Niederfeulen is twice in the collection; the second is out of service.
    expect(got.filter((s) => s.name === 'Niederfeulen').map((s) => [s.code, s.inService])).toEqual([
      ['27', true],
      ['77', false],
    ]);
    expect(code('Diekirch')).toEqual(['11']);
    expect(code('Esch/Sûre')).toEqual(['40']);
    // Two points of one name are two stations: nothing is merged by name.
    expect(got).toHaveLength(8);
  });

  it('a collection without features (trimmed): no stations, no drift', () => {
    const got = stations('lu-6-geo-empty');
    expect({ stations: got }).toEqual(golden('lu-6-geo-empty', { stations: got }));
    expect(got).toEqual([]);
  });

  it('the loader spec stores nothing for any of them, and compares with the LU-1 registry', async () => {
    expect(spec?.driftSource).toBe('LU-1');
    for (const name of ['lu-6-geo', 'lu-6-geo-subset', 'lu-6-geo-empty']) {
      const out = await spec?.run(body(name), {
        registry: new Map(),
        fetchedAt: 0,
        variant: '',
        unitMismatch: new Set(),
      });
      expect([name, out]).toEqual([name, { obs: [], gaugeZeros: [], dropped: {}, unknown: 0 }]);
    }
    expect(() =>
      spec?.run(Buffer.from('[]'), { registry: new Map(), fetchedAt: 0, variant: '', unitMismatch: new Set() }),
    ).toThrow(SchemaDrift);
  });
});

describe('parse (strict schema)', () => {
  it.each([
    [
      'an unknown property of a station',
      (d: { features: { properties: object }[] }) => Object.assign(d.features[0]?.properties as object, { Extra: 1 }),
      'unrecognized_keys',
      'features.0.properties',
    ],
    ['an unknown top-level key', (d: object) => Object.assign(d, { extra: 1 }), 'unrecognized_keys', ''],
    [
      'an unknown key of a feature',
      (d: { features: object[] }) => Object.assign(d.features[1] as object, { extra: 1 }),
      'unrecognized_keys',
      'features.1',
    ],
    [
      'an unknown key of the geometry',
      (d: { features: { geometry: object }[] }) => Object.assign(d.features[2]?.geometry as object, { extra: 1 }),
      'unrecognized_keys',
      'features.2.geometry',
    ],
    [
      'a name that is not a string',
      (d: { features: { properties: { Nom: unknown } }[] }) => {
        (d.features[0] as { properties: { Nom: unknown } }).properties.Nom = 7;
      },
      'invalid_type',
      'features.0.properties.Nom',
    ],
    [
      'a name over 100 characters',
      (d: { features: { properties: { Nom: unknown } }[] }) => {
        (d.features[0] as { properties: { Nom: unknown } }).properties.Nom = 'x'.repeat(101);
      },
      'too_big',
      'features.0.properties.Nom',
    ],
    [
      'a link over 300 characters',
      (d: { features: { properties: { Hyperlinks: unknown } }[] }) => {
        (d.features[0] as { properties: { Hyperlinks: unknown } }).properties.Hyperlinks = 'x'.repeat(301);
      },
      'too_big',
      'features.0.properties.Hyperlinks',
    ],
    [
      'a missing Nom',
      (d: { features: { properties: { Nom?: unknown } }[] }) => {
        delete (d.features[0] as { properties: { Nom?: unknown } }).properties.Nom;
      },
      'invalid_type',
      'features.0.properties.Nom',
    ],
    [
      'a geometry that is not a Point',
      (d: { features: { geometry: { type: string } }[] }) => {
        (d.features[0] as { geometry: { type: string } }).geometry.type = 'Polygon';
      },
      'invalid_value',
      'features.0.geometry.type',
    ],
    [
      'a feature of another type',
      (d: { features: { type: string }[] }) => {
        (d.features[0] as { type: string }).type = 'Collection';
      },
      'invalid_value',
      'features.0.type',
    ],
    [
      'a collection of another type',
      (d: { type: string }) => {
        d.type = 'Feature';
      },
      'invalid_value',
      'type',
    ],
    [
      'coordinates as text',
      (d: { features: { geometry: { coordinates: unknown } }[] }) => {
        (d.features[0] as { geometry: { coordinates: unknown } }).geometry.coordinates = ['6', '49'];
      },
      'invalid_type',
      'features.0.geometry.coordinates.0',
    ],
    [
      'four coordinates',
      (d: { features: { geometry: { coordinates: unknown } }[] }) => {
        (d.features[0] as { geometry: { coordinates: unknown } }).geometry.coordinates = [6, 49, 1, 2];
      },
      'too_big',
      'features.0.geometry.coordinates',
    ],
    [
      'a station id that is a fraction',
      (d: { features: { id: unknown }[] }) => {
        (d.features[0] as { id: unknown }).id = 1.5;
      },
      'invalid_type',
      'features.0.id',
    ],
    [
      'no features key',
      (d: { features?: unknown }) => {
        delete d.features;
      },
      'invalid_type',
      'features',
    ],
    [
      'features that is not a list',
      (d: { features: unknown }) => {
        d.features = {};
      },
      'invalid_type',
      'features',
    ],
    [
      'more than 20 links',
      (d: { links: unknown }) => {
        d.links = Array(21).fill({});
      },
      'too_big',
      'links',
    ],
  ])('refuses %s as %s drift', (_, change, code, path) => {
    // biome-ignore lint/suspicious/noExplicitAny: the cases edit parts of the document
    expect(drift(() => parseFeatures(edit(change as any)))).toEqual([code, path]);
  });

  it('a position outside 5–7°E and 49–51°N is `position` drift (the corners are in); a point with one coordinate too', () => {
    const at = (coordinates: number[]) =>
      edit((d) => {
        d.features[0].geometry.coordinates = coordinates;
      });
    for (const bad of [[4.99, 50], [7.01, 50], [6, 48.99], [6, 51.01], [0, 0], [49.8, 6.1], [6]]) {
      expect([bad, drift(() => parseFeatures(at(bad)))]).toEqual([bad, ['position', 'features.0']]);
    }
    for (const ok of [
      [5, 49],
      [7, 51],
      [5, 51],
      [7, 49],
    ])
      expect(parseFeatures(at(ok))[0]).toMatchObject({ lon: ok[0], lat: ok[1] });
    // A third coordinate (height) is allowed and ignored.
    expect(parseFeatures(at([6.1, 49.8, 300]))[0]).toMatchObject({ lon: 6.1, lat: 49.8 });
  });

  it('the fiche code is the number before the first dash after FichesStations/; no usable link is code null', () => {
    const code = (link: string | null) =>
      parseFeatures(
        edit((d) => {
          d.features[0].properties.Hyperlinks = link;
        }),
      )[0]?.code;
    expect(code('http://geoportail.eau.etat.lu/pdf/hydrometrie/FichesStations/107-Eischen.pdf')).toBe('107');
    expect(code('http://x/FichesStations/0029151-Wasserbillig.pdf')).toBe('0029151');
    expect(code('http://x/FichesStations/2626030300-Gemünd.pdf')).toBe('2626030300');
    expect(code(null)).toBeNull();
    expect(code('')).toBeNull();
    expect(code('http://x/PhotoStations/Diekirch.jpg')).toBeNull();
    expect(code('http://x/FichesStations/12345678901-x.pdf')).toBeNull();
    expect(code('http://x/FichesStations/abc-x.pdf')).toBeNull();
  });

  it('inService is exactly the state "En service" (also null, "Hors service" and other text are not in service)', () => {
    const state = (s: string | null) =>
      parseFeatures(
        edit((d) => {
          d.features[0].properties.Etat_de_se = s;
        }),
      )[0]?.inService;
    expect([state('En service'), state('Hors service'), state(null), state('en service'), state('')]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('bounds the document before it is parsed: nodes, depth and the number of features', () => {
    expect(JSON_CAPS).toEqual({ maxItems: 200, maxNodes: 5000, maxDepth: 8 });
    const wrap = (features: string) =>
      Buffer.from(
        `{"type":"FeatureCollection","features":${features},"numberReturned":0,"numberMatched":0,"links":[],"timeStamp":"x"}`,
      );
    expect(drift(() => parseFeatures(wrap(`[${Array(6000).fill('0').join(',')}]`)))).toEqual([
      'json_too_many_nodes',
      '',
    ]);
    expect(drift(() => parseFeatures(wrap('[[[[[[[[[[0]]]]]]]]]]')))).toEqual(['json_too_deep', '']);
    expect(drift(() => parseFeatures(wrap(`[${Array(201).fill('0').join(',')}]`)))).toEqual(['too_big', 'features']);
    expect(drift(() => parseFeatures(wrap(`[${Array(200).fill('0').join(',')}]`)))).toEqual([
      'invalid_type',
      'features.0',
    ]);
    expect(drift(() => parseFeatures(Buffer.from('{"type":')))).toEqual(['not_json', '']);
    expect(drift(() => parseFeatures(Buffer.from('')))).toEqual(['not_json', '']);
  });
});

describe('normalise', () => {
  it('returns no rows, no zeros and no unknowns for any payload (the points are registry input)', () => {
    for (const name of ['lu-6-geo', 'lu-6-geo-subset', 'lu-6-geo-empty'])
      expect(normalise(stations(name))).toEqual(emptyNormalised());
    // A fresh object each time: the loader may add to it.
    const a: Normalised = normalise([]);
    a.dropped.x = 1;
    expect(normalise([]).dropped).toEqual({});
  });
});

describe('driftReport (the station points against the LU-1 registry)', () => {
  const placed = [...positions.values()].filter((p) => p.lon !== null);
  it('real: every registered station with a position has an LU-6 point within 50 m; the unregistered in-service points are listed', () => {
    expect(placed.length).toBeGreaterThanOrEqual(40);
    const points = stations('lu-6-geo');
    for (const p of placed) {
      const d = Math.min(...points.map((s) => metres({ lon: p.lon as number, lat: p.lat as number }, s)));
      expect([p.key, d <= MOVED_M]).toEqual([p.key, true]);
    }
    const out = driftReport(positions, points);
    expect(out.vanished).toEqual([]);
    expect(out.changed).toEqual([]);
    // The in-service points that no LU-1 row sits at (fiche numbers, sorted as text): Drosbech 101, the second
    // Kautenbach 104, Reisdorf 105, Sassel 106, Bavigne 46, Grondmillen 47, Rommelerkr\u00e4iz 48 and Sch\u00e9imelzerbesch 49.
    expect(out.unregistered).toEqual(['101', '104', '105', '106', '46', '47', '48', '49']);
    // Out-of-service points never appear, whatever the registry says.
    expect(out.unregistered).not.toContain('77');
    expect(out.unregistered).not.toContain('103');
    // The same through the loader's spec, with the series rows the loader passes.
    expect(spec?.drift?.(body('lu-6-geo'), seriesRows())).toEqual(out);
  });

  it('a registered station 200 m from its point is changed; 2 km away it is vanished; 40 m is rounding', () => {
    const p = st({ lon: 6.1618, lat: 49.8666, code: '11' });
    const reg = (m: number) => new Map([['Diekirch', { key: 'Diekirch', ...north(p, m) }]]);
    expect(driftReport(reg(40), [p])).toEqual({ unregistered: [], vanished: [], changed: [] });
    expect(driftReport(reg(60), [p]).changed).toHaveLength(1);
    expect(driftReport(reg(950), [p]).changed).toHaveLength(1);
    const moved = driftReport(reg(200), [p]);
    expect(moved.changed).toEqual([
      {
        key: 'Diekirch',
        field: 'position',
        declared: `${p.lon.toFixed(6)},${north(p, 200).lat.toFixed(6)}`,
        published: `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`,
      },
    ]);
    expect(moved.vanished).toEqual([]);
    // 200 m from its point, the point has no registered station within 50 m, so it is unregistered too.
    expect(moved.unregistered).toEqual(['11']);
    const gone = driftReport(reg(2000), [p]);
    expect([gone.vanished, gone.changed]).toEqual([['Diekirch'], []]);
    expect(gone.unregistered).toEqual(['11']);
    expect([MOVED_M, GONE_M]).toEqual([50, 1000]);
  });

  it('the nearest point decides; a registry entry without a position is ignored; no points at all makes every placed station vanished', () => {
    const a = st({ lon: 6.1, lat: 49.8, code: '1' });
    const b = st({ ...north(a, 300), code: '2' });
    const reg = new Map([
      ['X', { key: 'X', ...north(a, 120) }],
      ['Perl', { key: 'Perl', lon: null, lat: null }],
    ]);
    const out = driftReport(reg, [a, b]);
    // X is 120 m from a and 180 m from b: a is the nearest point.
    expect(out.changed.map((c) => c.published)).toEqual([`${a.lon.toFixed(6)},${a.lat.toFixed(6)}`]);
    expect(out.vanished).toEqual([]);
    expect(driftReport(reg, [])).toEqual({ unregistered: [], vanished: ['X'], changed: [] });
  });

  it('only an in-service point with a fiche number is reported unregistered, once per number, sorted', () => {
    const out = driftReport(new Map(), [
      st({ code: '9' }),
      st({ code: '10' }),
      st({ code: '9' }),
      st({ code: null }),
      st({ code: '8', inService: false }),
      st({ code: '02' }),
    ]);
    expect(out.unregistered).toEqual(['02', '10', '9']);
  });

  it('a point within 50 m of a registered station is registered, 60 m is not', () => {
    const p = st({ code: '5' });
    const reg = (m: number) => new Map([['S', { key: 'S', ...north(p, m) }]]);
    expect(driftReport(reg(49), [p]).unregistered).toEqual([]);
    expect(driftReport(reg(60), [p]).unregistered).toEqual(['5']);
  });

  it('lists are capped at 200; the distance is metres (1° of latitude is 111.2 km, 1° of longitude shrinks with latitude)', () => {
    const many = Array.from({ length: 250 }, (_, i) => st({ code: String(1000 + i), lon: 6 + i * 0.001, lat: 49.5 }));
    expect(driftReport(new Map(), many).unregistered).toHaveLength(200);
    const reg = new Map(many.map((s) => [`k${s.code}`, { key: `k${s.code}`, lon: 6.5, lat: 50.5 }]));
    expect(driftReport(reg, []).vanished).toHaveLength(200);
    expect(metres({ lon: 6, lat: 49 }, { lon: 6, lat: 50 })).toBeCloseTo(111_195, -2);
    expect(metres({ lon: 6, lat: 49.5 }, { lon: 7, lat: 49.5 }) / 111_195).toBeCloseTo(
      Math.cos((49.5 * Math.PI) / 180),
      3,
    );
    expect(metres({ lon: 6, lat: 49 }, { lon: 6, lat: 49 })).toBe(0);
  });
});

describe('property and fuzz tests', () => {
  const feature = fc.record({
    id: fc.integer({ min: 0, max: 1000 }),
    name: fc.string({ maxLength: 20 }),
    link: fc.option(
      fc.oneof(
        fc.stringMatching(/^http:\/\/x\/FichesStations\/\d{1,10}-[a-z]{1,5}\.pdf$/),
        fc.string({ maxLength: 40 }),
      ),
      { nil: null },
    ),
    state: fc.option(fc.constantFrom('En service', 'Hors service', 'x'), { nil: null }),
    lon: fc.double({ min: 5, max: 7, noNaN: true }),
    lat: fc.double({ min: 49, max: 51, noNaN: true }),
  });
  const collection = (fs: unknown[]) =>
    Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: fs,
        numberReturned: fs.length,
        numberMatched: fs.length,
        links: [],
        timeStamp: 'x',
      }),
    );
  const asFeature = (f: {
    id: number;
    name: string;
    link: string | null;
    state: string | null;
    lon: number;
    lat: number;
  }) => ({
    type: 'Feature',
    id: f.id,
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    properties: {
      OBJECTID: f.id,
      Nom: f.name,
      Etat_de_se: f.state,
      Hyperlinks: f.link,
      Hyperlin_1: null,
      Hyperlinks_112: null,
      Hyperlinks_graph: null,
      pygeoapi_id: f.id,
    },
  });

  it('parse throws nothing but SchemaDrift on arbitrary bytes or on the real document with a value replaced', () => {
    const base = doc('lu-6-geo-subset');
    const junk = fc.oneof(
      fc.constant(null),
      fc.integer(),
      fc.string({ maxLength: 6 }),
      fc.constant({}),
      fc.constant([]),
      fc.double({ noNaN: true }),
    );
    const path = fc.constantFrom(
      ['type'],
      ['features'],
      ['features', 0],
      ['features', 0, 'geometry'],
      ['features', 0, 'geometry', 'coordinates'],
      ['features', 1, 'properties', 'Nom'],
      ['features', 2, 'properties', 'Hyperlinks'],
      ['links'],
      ['numberReturned'],
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array().map((u) => Buffer.from(u)),
          fc.tuple(path, junk).map(([p, v]) => {
            const d = structuredClone(base);
            let at = d;
            for (const k of p.slice(0, -1)) at = at[k];
            at[p.at(-1) as string | number] = v;
            return Buffer.from(JSON.stringify(d));
          }),
        ),
        (b) => {
          try {
            driftReport(positions, parseFeatures(b));
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('well-formed features always parse back to their name, position, state and fiche number', () => {
    fc.assert(
      fc.property(fc.array(feature, { maxLength: 30 }), (fs) => {
        const got = parseFeatures(collection(fs.map(asFeature)));
        expect(got).toHaveLength(fs.length);
        fs.forEach((f, i) => {
          const code = /\/FichesStations\/(\d{1,10})-/.exec(f.link ?? '')?.[1] ?? null;
          expect(got[i]).toEqual({ name: f.name, code, inService: f.state === 'En service', lon: f.lon, lat: f.lat });
        });
        expect(normalise(got)).toEqual(emptyNormalised());
      }),
      { numRuns: 200 },
    );
  });

  it('driftReport: sorted, capped, deterministic, and its classes are consistent with the distances', () => {
    const point = fc.record({
      code: fc.option(fc.constantFrom('1', '2', '03', '10', '2626030300'), { nil: null }),
      inService: fc.boolean(),
      d: fc.integer({ min: 0, max: 3 }),
    });
    const reg = fc.array(
      fc.record({ k: fc.constantFrom('A', 'B', 'C', 'D'), m: fc.integer({ min: 0, max: 2500 }), n: fc.boolean() }),
      { maxLength: 6 },
    );
    fc.assert(
      fc.property(fc.array(point, { maxLength: 8 }), reg, (pts, decl) => {
        const base = { lon: 6.1, lat: 49.8 };
        const list = pts.map((p, i) =>
          st({ code: p.code, inService: p.inService, ...north(base, i * 5000 + p.d * 10) }),
        );
        const registry = new Map(
          decl.map((d, i) => [
            d.k,
            { key: d.k, ...(d.n ? { lon: null, lat: null } : north(base, d.m + (i % 2) * 5000)) },
          ]),
        );
        const out: Drift = driftReport(registry, list);
        for (const l of [out.unregistered, out.vanished, out.changed.map((c) => c.key)]) {
          expect(l).toEqual([...l].sort());
          expect(l.length).toBeLessThanOrEqual(200);
        }
        expect(new Set(out.unregistered).size).toBe(out.unregistered.length);
        // Each registered station with a position is in exactly one of: matched (≤ 50 m), changed, vanished.
        for (const r of registry.values()) {
          if (r.lon === null || r.lat === null) {
            expect([out.vanished.includes(r.key), out.changed.some((c) => c.key === r.key)]).toEqual([false, false]);
            continue;
          }
          const d = Math.min(
            Number.POSITIVE_INFINITY,
            ...list.map((s) => metres({ lon: r.lon as number, lat: r.lat as number }, s)),
          );
          expect([r.key, out.vanished.includes(r.key), out.changed.some((c) => c.key === r.key)]).toEqual([
            r.key,
            d > GONE_M,
            d > MOVED_M && d <= GONE_M,
          ]);
        }
        expect(driftReport(registry, [...list].reverse())).toEqual(out);
      }),
      { numRuns: 300 },
    );
  });
});
