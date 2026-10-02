import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// LU-6 geoportail.lu `collections/655/items` (pygeoapi; CC0; catalogue §2.6): the 51 hydrometric stations of
// AGE as WGS84 points with `Nom` and the link to each station's fiche, whose file name starts with the AGE
// station number (`…/FichesStations/107-Eischen.pdf`). No values. Strict: anything the schema does not know is
// a SchemaDrift. Names and links are provider strings: data, never followed or interpreted beyond the number.

const text = (max: number) => z.string().max(max);

const Properties = z.strictObject({
  OBJECTID: z.number().int(),
  Nom: text(100),
  Etat_de_se: text(40).nullable(),
  Hyperlinks: text(300).nullable(),
  Hyperlin_1: text(300).nullable(),
  Hyperlinks_112: text(300).nullable(),
  Hyperlinks_graph: text(300).nullable(),
  pygeoapi_id: z.number().int(),
});

const Feature = z.strictObject({
  type: z.literal('Feature'),
  id: z.number().int(),
  geometry: z.strictObject({ type: z.literal('Point'), coordinates: cappedArray(z.number(), 3) }),
  properties: Properties,
});

const Collection = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
  numberReturned: z.number().int(),
  numberMatched: z.number().int(),
  links: cappedArray(z.unknown(), 20),
  timeStamp: text(40),
});

/** About 4× the fixture (51 features, 13 values each, depth 5). */
export const JSON_CAPS = { maxItems: 200, maxNodes: 5_000, maxDepth: 8 } as const satisfies JsonCaps & {
  maxItems: number;
};

export type Station = {
  name: string;
  /** The AGE station number from the fiche link (`107`, `02610015`, `2626030300`), or null without one. */
  code: string | null;
  inService: boolean;
  lon: number;
  lat: number;
};

const FICHE = /\/FichesStations\/(\d{1,10})-/;

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

export function parseFeatures(body: Uint8Array): Station[] {
  const doc = parseStrict(Collection, boundedJson(decode(body), JSON_CAPS));
  if (doc.features.length > JSON_CAPS.maxItems) throw new SchemaDrift('too_big', 'features');
  return doc.features.map((f, i) => {
    const { geometry, properties: p } = parseStrict(Feature, f, ['features', i]);
    const [lon, lat] = geometry.coordinates;
    if (lon === undefined || lat === undefined || lon < 5 || lon > 7 || lat < 49 || lat > 51) {
      throw new SchemaDrift('position', `features.${i}`);
    }
    return {
      name: p.Nom,
      code: FICHE.exec(p.Hyperlinks ?? '')?.[1] ?? null,
      inService: p.Etat_de_se === 'En service',
      lon,
      lat,
    };
  });
}
