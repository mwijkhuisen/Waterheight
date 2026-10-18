import { boundedJson, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// NL-1 RWS WaterWebservices (catalogue §2.1): the strict schema of an archived
// `OphalenWaarnemingen` response. One request names one location, but the
// response splits its values into a `WaarnemingenLijst` entry per metadata
// combination (method, status, …), each with its own `AquoMetadata`. Anything
// the schema does not know is a SchemaDrift: that payload is quarantined and
// nothing of it is stored (A§7.4 step 5). Provider strings are data; none is
// interpreted here. The document is bounded before it is parsed, and its lists
// and values are parsed one at a time (packages/core json.ts).
//
// "No data" is HTTP 204 with an empty body, for which the recorder writes no
// object: an adapter never sees one, so an empty body here is not JSON (drift).

const text = (max: number) => z.string().max(max);
const Coded = z.strictObject({ Code: text(80), Omschrijving: text(300) });

const AquoMetadata = z.strictObject({
  BemonsteringsApparaat: Coded,
  BemonsteringsMethode: Coded,
  BemonsteringsSoort: Coded,
  BioTaxon: Coded,
  BioTaxonType: Coded,
  Compartiment: Coded,
  Eenheid: Coded,
  Groepering: Coded,
  Grootheid: Coded,
  Hoedanigheid: Coded,
  MeetApparaat: Coded,
  Orgaan: Coded,
  Parameter: Coded,
  Parameter_Wat_Omschrijving: text(500),
  ProcesType: text(40),
  Typering: Coded,
  WaardeBepalingsMethode: Coded,
  WaardeBepalingsTechniek: Coded,
  WaardeBewerkingsMethode: Coded,
});

const Locatie = z.strictObject({
  Code: text(80),
  Coordinatenstelsel: text(40),
  Lat: z.number().min(-90).max(90),
  Lon: z.number().min(-180).max(180),
  Naam: text(200),
  Omschrijving: text(300),
});

const Meting = z.strictObject({
  Meetwaarde: z.strictObject({ Waarde_Alfanumeriek: text(40), Waarde_Numeriek: z.number() }),
  Tijdstip: text(40),
  WaarnemingMetadata: z.strictObject({
    Bemonsteringshoogte: text(40),
    /**
     * Two to four digits (older history carries 1004, KG-355). What each code means to us is the normaliser's
     * table, never inferred here: a code it lacks is the retained drop `unknown_quality` (alerted, kept for a replay).
     */
    Kwaliteitswaardecode: z.string().regex(/^\d{2,4}$/),
    OpdrachtgevendeInstantie: text(80),
    Referentievlak: text(40),
    /** The catalogue's `StatuswaardeLijst`. */
    Statuswaarde: z.enum(['Ongecontroleerd', 'Gecontroleerd', 'Definitief']),
  }),
});
export type Meting = z.infer<typeof Meting>;

const Envelope = z.strictObject({ Succesvol: z.literal(true), WaarnemingenLijst: z.array(z.unknown()) });
const Lijst = z.strictObject({ AquoMetadata, Locatie, MetingenLijst: z.array(z.unknown()) });

export type Waarnemingen = {
  aquo: z.infer<typeof AquoMetadata>;
  locatie: z.infer<typeof Locatie>;
  metingen: Meting[];
};

/**
 * The caps of one response (in brackets: the recorded fixtures). A value is
 * about 11 JSON values, so the longest window we ask for (P31D of a 10-minute
 * series: 4,464 values, about 50,000 JSON values) fits with room for a few
 * split lists; the spec's 2 MiB byte cap holds about 6,400 values.
 */
export const JSON_CAPS = {
  /** A 3 h or 6 h window (242–451 values, depth 6). */
  maxNodes: 150_000,
  maxDepth: 8,
  /** One list per metadata combination (1 in every fixture). */
  maxLists: 50,
  /** Values of one list. */
  maxValues: 10_000,
} as const satisfies JsonCaps & { maxLists: number; maxValues: number };

export type WaarnemingenCaps = JsonCaps & { maxLists: number; maxValues: number };

/**
 * P16b, spec nl-1-astro: one location, P400D ahead at 10 minutes. Measured on the untrimmed Vlissingen NAP body of
 * 2026-10-17 (17,003,443 B): 633,666 nodes, depth 6, 1 list, 57,600 values; about 1.25 × each.
 */
export const ASTRO_CAPS = {
  maxNodes: 800_000,
  maxDepth: 8,
  maxLists: 4,
  maxValues: 72_000,
} as const satisfies WaarnemingenCaps;

/**
 * P16b, specs nl-1-hwlw and nl-1-hwlw-astro: the high and low waters of one location. Measured on the Goeree
 * lichteiland MSL astronomical body of 2026-10-17 (P400D, 457,172 B): 17,072 nodes, depth 6, 1 list, 1,546 values
 * (about 3.9 a day). The value cap allows an agger station's double low water (6 a day over 401 days: 2,406).
 */
export const TIDE_CAPS = {
  maxNodes: 40_000,
  maxDepth: 8,
  maxLists: 4,
  maxValues: 3_000,
} as const satisfies WaarnemingenCaps;

/**
 * P16b, the catch-up seeds nl-1-obs-{sea,wide,slow}-catchup: one window from DATA_EPOCH to the seed's start per row,
 * 144 values a day (about 11 nodes each). 60,000 values is about 416 days of one list; the spec's 25 MiB byte cap
 * holds about 88,000 values (about 300 B each, measured on the astro body), so the node cap binds first.
 */
export const CATCHUP_CAPS = {
  maxNodes: 750_000,
  maxDepth: 8,
  maxLists: 50,
  maxValues: 60_000,
} as const satisfies WaarnemingenCaps;

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

/** `OphalenWaarnemingen`: every list of the response, in the response's order. */
export function parseWaarnemingen(body: Uint8Array, caps: WaarnemingenCaps = JSON_CAPS): Waarnemingen[] {
  const envelope = parseStrict(Envelope, boundedJson(decode(body), caps));
  if (envelope.WaarnemingenLijst.length > caps.maxLists) throw new SchemaDrift('too_big', 'WaarnemingenLijst');
  return envelope.WaarnemingenLijst.map((element, i) => {
    const at = ['WaarnemingenLijst', i];
    const lijst = parseStrict(Lijst, element, at);
    if (lijst.MetingenLijst.length > caps.maxValues) {
      throw new SchemaDrift('too_big', [...at, 'MetingenLijst'].join('.'));
    }
    return {
      aquo: lijst.AquoMetadata,
      locatie: lijst.Locatie,
      metingen: lijst.MetingenLijst.map((m, j) => parseStrict(Meting, m, [...at, 'MetingenLijst', j])),
    };
  });
}

/** `CheckWaarnemingenAanwezig`: the answer is a STRING, "true" or "false" (catalogue §2.1; P14a probe). */
const Check = z.strictObject({ Succesvol: z.literal(true), WaarnemingenAanwezig: z.enum(['true', 'false']) });

export function parseCheck(body: Uint8Array): boolean {
  return parseStrict(Check, boundedJson(decode(body), { maxNodes: 100, maxDepth: 3 })).WaarnemingenAanwezig === 'true';
}
