import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { LEVEL_NORM, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lv95ToWgs84, normaliseWarnings } from '../../src/adapters/ch-5/normalise.ts';
import { MAX_FEATURES, MIN_FEATURES, parseWarnings } from '../../src/adapters/ch-5/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// CH-5 BAFU flood-danger sections: parse + normalise of real recorded payloads equal the committed golden files
// (invariant 9); `UPDATE_GOLDEN=1` rewrites them and a golden change is reviewed like code. A warning's geometry is
// stored in a golden as its sha256 and length only (the polygons are real and large); the tests below read it.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const body = (name: string) => rawFixture('CH-5', name).body;
const text = (o: unknown) => Buffer.from(JSON.stringify(o));
const fetchedAt = (name: string) => Date.parse(rawFixture('CH-5', name).meta.recorded_at);
const rowsOf = (n: Normalised) => n.warnings?.rows ?? [];
const atOf = (n: Normalised) => (n.warnings?.mode === 'snapshot' ? n.warnings.at : undefined);

function digest(n: Normalised): unknown {
  return {
    ...n,
    warnings: n.warnings && {
      ...n.warnings,
      rows: n.warnings.rows.map((r) => ({
        ...r,
        geometry: r.geometry === null ? null : `sha256:${sha(r.geometry)}:${r.geometry.length}`,
      })),
    },
  };
}

function golden(name: string, actual: unknown): unknown {
  const url = goldenUrl('CH-5', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const run = (name: string, variant = 'de') =>
  normaliseWarnings(parseWarnings(body(name)), { fetchedAt: fetchedAt(name), variant });

describe('golden files (real payloads)', () => {
  it('the German map of 2026-10-03 (93 sections): river, lake and region areas, level 1 except one region at 0', () => {
    const out = run('ch-5-warn-de-archive');
    expect(digest(out)).toEqual(golden('ch-5-warn-de-archive', digest(out)));
    expect(out.dropped).toEqual({});
    expect(out.warnings?.mode).toBe('snapshot');
    // meta.produced_at "2026-10-03T07:52:38.233+02:00"
    expect(atOf(out)).toBe('2026-10-03T05:52:38.233Z');
    const rows = rowsOf(out);
    expect(rows).toHaveLength(93);
    expect(new Set(rows.map((r) => r.area_key)).size).toBe(93);
    expect(rows.filter((r) => r.area_key.startsWith('river:'))).toHaveLength(42);
    expect(rows.filter((r) => r.area_key.startsWith('lake:'))).toHaveLength(13);
    expect(rows.filter((r) => r.area_key.startsWith('hydro_region:'))).toHaveLength(38);
    const bern = rows.find((r) => r.area_key === 'river:2135');
    // valid_from "2026-10-03T08:00:00.000+02:00", valid_until "2026-10-05T11:00:00.000+02:00"
    expect(bern).toMatchObject({
      name: 'Aare - Bern, Schönau',
      label_raw: 'Aare von Mündung Gürbe bis Mündung Saane',
      level: LEVEL_NORM.normal,
      level_raw: '1',
      valid_from: '2026-10-03T06:00:00.000Z',
      valid_to: '2026-10-05T09:00:00.000Z',
      issued_at: null,
    });
    // Level 0 "Keine Gefahrenstufe" is no_ref: the raw 0 is kept, the common level is null.
    const zero = rows.filter((r) => r.level_raw === '0');
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({ area_key: 'hydro_region:53', name: 'Freiberge', level: null });
    expect(rows.filter((r) => r.level === LEVEL_NORM.normal)).toHaveLength(92);
  });

  it('the P1a recording of 2026-09-29 (93 sections, produced 06:14 +02:00)', () => {
    const out = run('ch-5-warn');
    expect(digest(out)).toEqual(golden('ch-5-warn', digest(out)));
    expect(atOf(out)).toBe('2026-09-29T04:14:03.296Z');
    expect(rowsOf(out)).toHaveLength(93);
    expect(rowsOf(out).find((r) => r.area_key === 'river:2135')?.valid_from).toBe('2026-09-29T05:00:00.000Z');
  });

  it('the English map is parsed and stores nothing; it states the same areas and the same geometries as the German one', () => {
    const out = run('ch-5-warn-en-archive', 'en');
    expect(out).toEqual(golden('ch-5-warn-en-archive', out));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
    const de = parseWarnings(body('ch-5-warn-de-archive'));
    const en = parseWarnings(body('ch-5-warn-en-archive'));
    expect(en.producedAt).toBe(de.producedAt);
    expect(en.sections.map((s) => [s.properties.kind, s.properties.key, s.properties.level])).toEqual(
      de.sections.map((s) => [s.properties.kind, s.properties.key, s.properties.level]),
    );
    expect(en.sections.map((s) => s.geometry)).toEqual(de.sections.map((s) => s.geometry));
    // The water-body text and the label of a region are translated (rivers keep their name): only the German one is stored.
    expect(en.sections.find((s) => s.properties.key === '43')?.properties.label).toBe('Lake Zurich Region');
    expect(en.sections[0]?.properties.hydro_body).toBe('Aare from confluence with Gürbe until confluence with Saane');
  });
});

describe('synthetic payload [U]: a flood', () => {
  it('a river at level 4 and a region at level 5 (hand-built from the real German map): levels 5 and 5 on the common scale', () => {
    const out = run('ch-5-warn-flood.synthetic');
    expect(digest(out)).toEqual(golden('ch-5-warn-flood.synthetic', digest(out)));
    expect(rowsOf(out)).toHaveLength(93);
    const pick = new Set(['river:2135', 'hydro_region:47', 'lake:2208', 'hydro_region:53']);
    expect(rowsOf(out).flatMap((r) => (pick.has(r.area_key) ? [[r.area_key, r.level_raw, r.level]] : []))).toEqual([
      ['river:2135', '4', LEVEL_NORM.extreme],
      ['hydro_region:47', '5', LEVEL_NORM.extreme],
      ['lake:2208', '1', LEVEL_NORM.normal],
      ['hydro_region:53', '0', null],
    ]);
    // Every other section as published (level 1, the one region at 0).
    expect(rowsOf(out).filter((r) => r.level === LEVEL_NORM.extreme)).toHaveLength(2);
  });
});

describe('the geometry: LV95 → WGS84', () => {
  it("swisstopo's origin (2,600,000, 1,200,000) is 7.438637°E 46.951081°N, rounded to 6 decimals", () => {
    expect(lv95ToWgs84(2_600_000, 1_200_000)).toEqual([7.438637, 46.951081]);
  });

  it('Zimmerwald observatory (LV95 2,602,030.74 / 1,191,775.03) is at 7.4653°E 46.8771°N within 50 m', () => {
    const [lon, lat] = lv95ToWgs84(2_602_030.74, 1_191_775.03);
    expect(Math.abs(lon - 7.4653)).toBeLessThan(0.0007);
    expect(Math.abs(lat - 46.8771)).toBeLessThan(0.0005);
  });

  it('the converted Aare section at Bern passes near the CH-1 station Bern, Schönau (registry position)', () => {
    const station = [...registryOf('CH-1').values()].find((s) => s.key === '2135/W');
    expect(station).toBeDefined();
    const row = rowsOf(run('ch-5-warn-de-archive')).find((r) => r.area_key === 'river:2135');
    const geometry = JSON.parse(row?.geometry ?? 'null') as { type: string; coordinates: [number, number][][] };
    expect(geometry.type).toBe('MultiLineString');
    const reg = (
      parse(readFileSync(new URL('../../../../registry/stations/ch-1.yaml', import.meta.url), 'utf8')) as {
        stations: { provider_key: string; lon: number; lat: number }[];
      }
    ).stations.find((s) => s.provider_key === '2135/W') as { lon: number; lat: number };
    const metres = (a: [number, number]) =>
      Math.hypot((a[0] - reg.lon) * 111_320 * Math.cos((reg.lat * Math.PI) / 180), (a[1] - reg.lat) * 110_574);
    expect(Math.min(...geometry.coordinates.flat().map(metres))).toBeLessThan(300);
  });

  it('every stored coordinate of the real map is WGS84 inside Switzerland, with at most 6 decimals', () => {
    for (const row of rowsOf(run('ch-5-warn-de-archive'))) {
      const g = JSON.parse(row.geometry ?? 'null') as { type: string; coordinates: unknown };
      const walk = (c: unknown): void => {
        if (typeof (c as number[])[0] === 'number') {
          const [lon, lat] = c as [number, number];
          expect(lon).toBeGreaterThan(5.9);
          expect(lon).toBeLessThan(10.6);
          expect(lat).toBeGreaterThan(45.7);
          expect(lat).toBeLessThan(47.9);
          expect(String(lon).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
          expect(String(lat).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
        } else for (const x of c as unknown[]) walk(x);
      };
      expect(['MultiLineString', 'MultiPolygon']).toContain(g.type);
      walk(g.coordinates);
    }
  });
});

describe('rules', () => {
  // biome-ignore lint/suspicious/noExplicitAny: a plain JSON fixture edited in place
  const de = () => JSON.parse(body('ch-5-warn-de-archive').toString('utf8')) as Record<string, any>;
  const ctx = { fetchedAt: fetchedAt('ch-5-warn-de-archive'), variant: 'de' };
  const norm = (doc: unknown, c = ctx) => normaliseWarnings(parseWarnings(text(doc)), c);
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDrift);
      return (err as SchemaDrift).code;
    }
    return 'no drift';
  };

  it('a level the crosswalk lacks is dropped unmapped; a key stated twice is withheld; both stay listed (kept)', () => {
    const doc = de();
    doc.features[0].properties.level = 7;
    doc.features[2].properties.key = doc.features[1].properties.key;
    doc.features[2].properties.kind = doc.features[1].properties.kind;
    const out = norm(doc);
    expect(out.dropped).toEqual({ unmapped_class: 1, conflict: 2 });
    expect(rowsOf(out)).toHaveLength(93 - 3);
    // The payload lists them, so their stored ranges stay as they are (review CR-5).
    const key = (i: number) => `${doc.features[i].properties.kind}:${doc.features[i].properties.key}`;
    expect(out.warnings?.mode === 'snapshot' && out.warnings.kept).toEqual([key(0), key(1)]);
  });

  it('a map of fewer than MIN_FEATURES sections is not the whole map: drift too_few_areas (review SR-6)', () => {
    const doc = de();
    doc.features = doc.features.slice(0, MIN_FEATURES);
    expect(code(() => parseWarnings(text(doc)))).toBe('no drift');
    doc.features = doc.features.slice(0, MIN_FEATURES - 1);
    expect(code(() => parseWarnings(text(doc)))).toBe('too_few_areas');
    doc.features = [];
    expect(code(() => parseWarnings(text(doc)))).toBe('too_few_areas');
  });

  it('a kind and a key may repeat across kinds (river:1 and lake:1 are two areas)', () => {
    const doc = de();
    doc.features[0].properties.kind = 'river';
    doc.features[0].properties.key = '99999';
    doc.features[1].properties.kind = 'lake';
    doc.features[1].properties.key = '99999';
    expect(norm(doc).dropped).toEqual({});
  });

  it('a variant other than de or en, and a production time ahead of the fetch, are drift', () => {
    expect(code(() => norm(de(), { ...ctx, variant: 'fr' }))).toBe('bad_variant');
    expect(code(() => norm(de(), { ...ctx, variant: '' }))).toBe('bad_variant');
    const doc = de();
    doc.meta.produced_at = '2026-10-03T09:30:00.000+02:00';
    expect(code(() => norm(doc))).toBe('future_time');
    doc.meta.produced_at = 'gestern';
    expect(code(() => norm(doc))).toBe('bad_time');
    doc.meta.produced_at = '2026-10-03T07:52:38.233+02:00';
    doc.features[0].properties.valid_from = '2026-10-03 08:00';
    expect(code(() => norm(doc))).toBe('bad_time');
    // A null valid_until is an open end.
    const open = de();
    open.features[0].properties.valid_until = null;
    expect(rowsOf(norm(open))[0]?.valid_to).toBeNull();
  });

  it('another CRS, coordinates that are no LV95, an unknown kind, key or shape and too many features are drift', () => {
    let doc = de();
    doc.crs.properties.name = 'EPSG:4326';
    expect(code(() => parseWarnings(text(doc)))).toBe('invalid_value');
    doc = de();
    doc.features[0].geometry.coordinates[0][0] = [7.4, 46.9];
    expect(code(() => parseWarnings(text(doc)))).toBe('too_small');
    doc = de();
    doc.features[0].geometry.coordinates[0][0] = [7.4, 46.9, 500];
    expect(code(() => parseWarnings(text(doc)))).toBe('too_big');
    doc = de();
    doc.features[0].geometry.coordinates[0][0] = [27.4, 46.9];
    expect(code(() => parseWarnings(text(doc)))).toBe('too_small');
    doc = de();
    doc.features[0].geometry = { type: 'Point', coordinates: [2600000, 1200000] };
    expect(code(() => parseWarnings(text(doc)))).toBe('invalid_union');
    doc = de();
    doc.features[0].properties.kind = 'glacier';
    expect(code(() => parseWarnings(text(doc)))).toBe('invalid_value');
    doc = de();
    doc.features[0].properties.newkey = 1;
    expect(code(() => parseWarnings(text(doc)))).toBe('unrecognized_keys');
    doc = de();
    doc.features[0].properties.key = 'a b';
    expect(code(() => parseWarnings(text(doc)))).toBe('invalid_format');
    doc = de();
    doc.features = new Array(MAX_FEATURES + 1).fill(null);
    expect(code(() => parseWarnings(text(doc)))).toBe('too_big');
    expect(code(() => parseWarnings(Buffer.from('{')))).toBe('not_json');
  });
});

describe('property', () => {
  it('any JSON value is a SchemaDrift or a result, never another error', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        try {
          parseWarnings(Buffer.from(JSON.stringify(value)));
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a valid map with any properties: drift or rows, and every stored geometry is finite WGS84', () => {
    const doc = JSON.parse(body('ch-5-warn-flood.synthetic').toString('utf8'));
    const feature = doc.features[0];
    // The other sections as published but with a short line each: a map of fewer than MIN_FEATURES is drift, and the
    // property is about the first feature.
    const others = doc.features.slice(1).map((g: object) => ({
      ...g,
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [2_600_000, 1_200_000],
            [2_600_100, 1_200_100],
          ],
        ],
      },
    }));
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue(), { maxKeys: 5 }),
        fc.integer({ min: -3, max: 12 }),
        (extra, level) => {
          const f = { ...feature, properties: { ...feature.properties, ...extra, level } };
          try {
            const out = normaliseWarnings(parseWarnings(text({ ...doc, features: [f, ...others] })), {
              fetchedAt: Date.parse('2026-10-03T06:09:00Z'),
              variant: 'de',
            });
            // The first number of each geometry, a line's or a polygon's.
            for (const r of rowsOf(out))
              expect(Number.isFinite(JSON.parse(r.geometry ?? '[]').coordinates.flat(3)[0])).toBe(true);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('any LV95 position inside the accepted box converts to a finite WGS84 position near Switzerland, monotone in E and N', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2_480_000, max: 2_840_000, noNaN: true }),
        fc.double({ min: 1_070_000, max: 1_300_000, noNaN: true }),
        (e, n) => {
          const [lon, lat] = lv95ToWgs84(e, n);
          expect(lon).toBeGreaterThan(5.8);
          expect(lon).toBeLessThan(10.7);
          expect(lat).toBeGreaterThan(45.7);
          expect(lat).toBeLessThan(48);
          // 100 m further east is further east, 100 m further north is further north.
          expect(lv95ToWgs84(e + 100, n)[0]).toBeGreaterThan(lon);
          expect(lv95ToWgs84(e, n + 100)[1]).toBeGreaterThan(lat);
        },
      ),
      { numRuns: 300 },
    );
  });
});
