import { boundedJson, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// FR-5 Vigicrues (catalogue §2.5): the vigilance map of the river sections (InfoVigiCru GeoJSON), the
// TronEntVigiCru and territory documents whose `aNMoinsUn` links stations to sections, and station.json (the
// historical floods, `CruesHistoriques`). Strict and bounded: a key or shape the schema does not know is a
// SchemaDrift, which quarantines the payload and alerts. Provider strings are data.

export const CAPS = {
  /** 175,955 values in the whole-France map of 2026-10-02 (about 5x). */
  vigilance: { maxNodes: 1_000_000, maxDepth: 12 } satisfies JsonCaps,
  /** 112 values in the largest recorded document; a territory lists at most a few dozen sections. */
  tron: { maxNodes: 20_000, maxDepth: 8 } satisfies JsonCaps,
  /** 110 values in the largest recorded station.json. */
  station: { maxNodes: 20_000, maxDepth: 10 } satisfies JsonCaps,
};
export const MAX_FEATURES = 2000;

const text = (max: number) => z.string().max(max);
const code = z.string().regex(/^[A-Za-z0-9_-]{1,20}$/);

/**
 * The InfoVigiCru property keys, by their lower-case spelling. The provider changed the casing between the 2023
 * capture (`LbEntCru`, `TypEnSup_1`, `CdInt`, `CdDiEnt_1`) and the current service (`lbentcru`, `typensup_1`,
 * `cdint`, `cddient_1`): both are read through this one explicit map, and a key that is in neither is drift.
 */
const KEYS: ReadonlyMap<string, keyof Properties> = new Map(
  (
    [
      'CdEntCru',
      'typentcru',
      'lbentcru',
      'acroentcru',
      'cddient_1',
      'dhcentcru',
      'dhmentcru',
      'stentcru',
      'cdensup_1',
      'typensup_1',
      'cdint',
      'CdTCC',
      'id',
      'NivInfViCr',
    ] as const
  ).map((k) => [k.toLowerCase(), k]),
);

// Everything but the section's code, name, type and level may be null (`cdint` is, for 8 of the 233 recorded).
const maybe = <T extends z.ZodType>(t: T) => t.nullable().optional();

const Properties = z.strictObject({
  CdEntCru: code,
  typentcru: text(10),
  lbentcru: text(200),
  acroentcru: maybe(text(40)),
  cddient_1: maybe(text(40)),
  dhcentcru: maybe(text(40)),
  dhmentcru: maybe(text(40)),
  stentcru: maybe(text(40)),
  cdensup_1: maybe(text(40)),
  typensup_1: maybe(text(10)),
  cdint: maybe(z.union([text(20), z.number().int()])),
  CdTCC: maybe(text(20)),
  id: maybe(z.union([text(20), z.number().int()])),
  /** 1 vert, 2 jaune, 3 orange, 4 rouge; another integer is mapped (or dropped as unmapped) by the normaliser. */
  NivInfViCr: z.number().int().min(0).max(99),
});
type Properties = z.infer<typeof Properties>;

const Geometry = z.strictObject({
  type: z.enum(['LineString', 'MultiLineString']),
  // Bounded by the node cap of the document; checked by `lines` and stored as published.
  coordinates: z.array(z.unknown()),
});
export type Geometry = z.infer<typeof Geometry>;

/** A WGS84 position [lon, lat] or, as RFC 7946 allows, [lon, lat, altitude] (every recorded one has two numbers). */
const position = (p: unknown) =>
  Array.isArray(p) &&
  (p.length === 2 || p.length === 3) &&
  p.every((x) => typeof x === 'number' && Number.isFinite(x)) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;
const line = (l: unknown) => Array.isArray(l) && l.length >= 2 && l.every(position);

/**
 * The geometry as GeoJSON nests it (every recorded section is a MultiLineString): a LineString of positions, a
 * MultiLineString of at least one such line. Anything else is drift `bad_geometry`, never stored (review SR-3).
 */
function checkGeometry(g: Geometry, at: string): Geometry {
  const ok = g.type === 'LineString' ? line(g.coordinates) : g.coordinates.length > 0 && g.coordinates.every(line);
  if (!ok) throw new SchemaDrift('bad_geometry', at);
  return g;
}

const Feature = z.strictObject({
  type: z.literal('Feature'),
  id: z
    .union([text(20), z.number().int()])
    .nullable()
    .optional(),
  geometry: Geometry.nullable(),
  properties: z.record(z.string().max(40), z.unknown()),
});

const Collection = z.strictObject({
  type: z.literal('FeatureCollection'),
  name: text(100),
  bbox: z.array(z.number()).max(6).optional(),
  features: z.array(z.unknown()).max(MAX_FEATURES),
  RefInfoVigiCru: text(40).optional(),
  /** Absent in the 2023 capture (cut inside the features); the normaliser then takes the fetch time. */
  DtHrInfoVigiCru: text(40).optional(),
});

export type Section = {
  code: string;
  name: string;
  level: number;
  geometry: Geometry | null;
};

export type Vigilance = {
  /** `DtHrInfoVigiCru` as published (an ISO instant with offset), or null when the payload has none. */
  at: string | null;
  sections: Section[];
};

/** One feature's properties under the case-insensitive map of the known keys; an unknown key is drift. */
function properties(raw: Record<string, unknown>, at: string): Properties {
  const known: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = KEYS.get(key.toLowerCase());
    if (name === undefined) throw new SchemaDrift('unknown_key', at);
    if (name in known) throw new SchemaDrift('duplicate_key', at);
    known[name] = value;
  }
  return parseStrict(Properties, known, [at]);
}

export function parseVigilance(body: Uint8Array): Vigilance {
  const doc = parseStrict(
    Collection,
    boundedJson(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'), CAPS.vigilance),
  );
  const sections = doc.features.map((element, i): Section => {
    const f = parseStrict(Feature, element, ['features', i]);
    const p = properties(f.properties, `features.${i}.properties`);
    const geometry = f.geometry === null ? null : checkGeometry(f.geometry, `features.${i}.geometry`);
    return { code: p.CdEntCru, name: p.lbentcru, level: p.NivInfViCr, geometry };
  });
  return { at: doc.DtHrInfoVigiCru ?? null, sections };
}

// ---- TronEntVigiCru and the territory documents ------------------------------------------------------------------

const Link = z.strictObject({
  CdEntVigiCruInferieur: code,
  TypEntVigiCruInferieur: z.enum(['5', '7', '8']),
  LbEntVigiCruInferieur: text(200),
  Link: text(300),
});

const Entity = z.strictObject({
  CdEntVigiCru: code,
  TypEntVigiCru: z.enum(['5', '8']),
  LbEntVigiCru: text(200),
  CdDistrictEntVigiCru_1: text(100).optional(),
  CdDistrictEntVigiCru_2: text(100).optional(),
  DtHrCreatEntVigiCru: text(100),
  DtHrMajEntVigiCru: text(100),
  StEntVigiCru: text(40),
  CdTCC: text(100),
  CdInt: text(100),
  aNPlusUn: z
    .strictObject({
      CdEntVigiCruSuperieur: code,
      TypEntVigiCruSuperieur: z.literal('5'),
      Link: text(300),
    })
    .optional(),
  aNMoinsUn: z.array(z.unknown()).max(500),
});

// The envelope is as stable as the entities (identical in all 59 recorded documents), so it is strict too.
const Tron = z.strictObject({
  Scenario: z.strictObject({
    Flux: z.strictObject({ Version: text(10), DateRevision: text(40) }),
    CodeScenario: text(10),
    VersionScenario: text(10),
    NomScenario: text(200),
    DateHeureCreationFichier: text(40),
    Emetteur: text(20),
  }),
  ListEntVigiCru: z.array(z.unknown()).length(1),
});

export type Links =
  /** A river section (type 8): the stations (type 7) it covers. */
  | { kind: 'section'; code: string; territory: string | null; stations: string[] }
  /** A territory (type 5): the sections (type 8) it lists. */
  | { kind: 'territory'; code: string; sections: string[] };

export function parseTron(body: Uint8Array): Links {
  const doc = parseStrict(
    Tron,
    boundedJson(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'), CAPS.tron),
  );
  const e = parseStrict(Entity, doc.ListEntVigiCru[0], ['ListEntVigiCru', 0]);
  const wanted = e.TypEntVigiCru === '8' ? '7' : '8';
  const children = e.aNMoinsUn.map((l, i) => parseStrict(Link, l, ['aNMoinsUn', i]));
  // A child of another type than the level below is drift (a station list that turned into something else).
  if (children.some((c) => c.TypEntVigiCruInferieur !== wanted)) throw new SchemaDrift('bad_child_type', 'aNMoinsUn');
  const codes = children.map((c) => c.CdEntVigiCruInferieur);
  return e.TypEntVigiCru === '8'
    ? { kind: 'section', code: e.CdEntVigiCru, territory: e.aNPlusUn?.CdEntVigiCruSuperieur ?? null, stations: codes }
    : { kind: 'territory', code: e.CdEntVigiCru, sections: codes };
}

// ---- station.json ------------------------------------------------------------------------------------------------

const Flood = z.strictObject({
  LbUsuel: z.string().min(1).max(200),
  /** The flood's peak stage in m (at the station's own gauge zero). */
  ValHauteur: z.number().min(-100).max(1000).nullable(),
  /** The peak discharge in m³/s; 0 is "none". Not stored: the references of P7a are stage references. */
  ValDebit: z.number().nullable().optional(),
});

// Only the station code and the flood list are read; every other key of a station.json (coordinates, basin
// links, flux URLs) is presentation, so unlike the maps this envelope tolerates keys we do not read.
const Station = z.looseObject({
  CdStationHydro: z.string().regex(/^[A-Z0-9]{8,12}$/),
  VigilanceCrues: z
    .looseObject({ CruesHistoriques: z.array(z.unknown()).max(100).nullable().optional() })
    .nullable()
    .optional(),
});

export type Floods = {
  station: string;
  /** null: the document does not state the list (absent or null); [] states that there is none. */
  floods: { label: string; heightM: number | null }[] | null;
};

export function parseStation(body: Uint8Array): Floods {
  const doc = parseStrict(
    Station,
    boundedJson(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'), CAPS.station),
  );
  const list = doc.VigilanceCrues?.CruesHistoriques;
  return {
    station: doc.CdStationHydro,
    floods:
      list === undefined || list === null
        ? null
        : list.map((f, i) => {
            const flood = parseStrict(Flood, f, ['VigilanceCrues', 'CruesHistoriques', i]);
            return { label: flood.LbUsuel, heightM: flood.ValHauteur };
          }),
  };
}
