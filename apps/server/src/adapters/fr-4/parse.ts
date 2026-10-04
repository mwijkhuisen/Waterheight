import { cappedArray, type JsonCaps, parseStrict } from '@rws/core';
import { z } from 'zod';
import { readEnvelope } from '../_shared/vigicrues/parse.ts';

// FR-4 Vigicrues forecasts (catalogue §2.5), spec `fr-4`, `https://www.vigicrues.gouv.fr/services/v1.1/prevision.json`.
// Two kinds of body share the spec:
//  - the national list of the stations that have a forecast (`?FormatDate=iso&GrdSimul=H|Q`): strict, checked, and
//    nothing is read from it (the capture expands it, adapters/fr-4/capture.ts);
//  - one station's forecast (`?CdEntVigiCru=…&TypEntVigiCru=7&FormatDate=iso&GrdSimul=H|Q`): the station, the
//    parameter, the production time and the points, each with a minimum, a mean and a maximum.
// Strict: a key or shape the schema does not know is a SchemaDrift. HTTP-200 error and "no content" bodies are the
// shared envelope's (`_shared/vigicrues`). Provider strings are data: length-capped, and the free text of a station
// (its label, link and comment) and the file's own header (`Scenario`) are validated and then dropped here, so that
// nothing downstream can return them.

const text = (max: number) => z.string().max(max);

/** The Sandre code of a station (adapters/fr-4/capture.ts checks the same before it builds a URL). */
export const CODE = /^[A-Z][0-9A-Z]{9}$/;

/** The longest recorded run has 359 points (10 minutes over 72 h would be 433); core's own cap is 2,000. */
export const MAX_PREVS = 1000;
/** 27 to 31 stations are listed (2026-09-29/10-02); the capture follows at most 200. */
export const MAX_LISTED = 500;

/** Nodes per point are 5 and per listed station 6: 1,000 points are 5,000 values. The deepest value is 4 levels down. */
export const JSON_CAPS: JsonCaps = { maxNodes: 6_000, maxDepth: 4 };

const Scenario = z.strictObject({
  Flux: z.strictObject({ Version: text(40), DateRevision: text(40) }),
  CodeScenario: text(40),
  VersionScenario: text(40),
  NomScenario: text(500),
  // Changes on every fetch: the bytes differ, the run does not.
  DateHeureCreationFichier: text(40),
  Emetteur: text(40),
});

const Prev = z.strictObject({
  DtPrev: text(40),
  // The envelope of the forecast: minimum, mean and maximum. A number, or null where the provider leaves it out.
  ResMinPrev: z.number().nullable(),
  ResMoyPrev: z.number().nullable(),
  ResMaxPrev: z.number().nullable(),
});
export type Prev = z.infer<typeof Prev>;

const Grd = z.enum(['H', 'Q']);
export type Grd = z.infer<typeof Grd>;

const Station = z.strictObject({
  Scenario,
  Simul: z.strictObject({
    CdEntVigiCru: z.string().regex(CODE),
    TypEntVigiCru: z.literal('7'),
    LbEntVigiCru: text(1000),
    Link: text(1000),
    GrdSimul: Grd,
    DtProdSimul: text(40),
    // Free text (up to 389 characters in the 1,878 recorded bodies); a flood may well write more.
    CommentSimul: text(10_000),
    Prevs: cappedArray(Prev, MAX_PREVS),
  }),
});

const List = z.strictObject({
  Scenario,
  GrdSimul: Grd,
  count: z.number().int().min(0),
  ListEntVigiCru: cappedArray(
    z.strictObject({
      DtProdSimul: text(40),
      CdEntVigiCru: text(20),
      TypEntVigiCru: text(10),
      LbEntVigiCru: text(1000),
      Link: text(1000),
    }),
    MAX_LISTED,
  ),
});

/** What a body says, reduced to what the normaliser may use. */
export type Parsed =
  | { kind: 'station'; code: string; grd: Grd; producedAt: string; prevs: Prev[] }
  | { kind: 'list'; grd: Grd }
  | { kind: 'none' };

export function parseDocument(body: Uint8Array): Parsed {
  const env = readEnvelope(body, JSON_CAPS);
  if (env.kind === 'none') return { kind: 'none' };
  const doc = env.doc;
  if (typeof doc === 'object' && doc !== null && Object.hasOwn(doc, 'ListEntVigiCru'))
    return { kind: 'list', grd: parseStrict(List, doc).GrdSimul };
  const { Simul } = parseStrict(Station, doc);
  return {
    kind: 'station',
    code: Simul.CdEntVigiCru,
    grd: Simul.GrdSimul,
    producedAt: Simul.DtProdSimul,
    prevs: Simul.Prevs,
  };
}
