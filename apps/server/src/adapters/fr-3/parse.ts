import { boundedJson, cappedArray, type JsonCaps, parseStrict } from '@rws/core';
import { z } from 'zod';

// FR-3 Vigicrues `observations.json` (catalogue §2.5): one series per payload,
// its whole published history (about two months) as [epoch ms UTC, value]
// pairs. Strict: anything the schema does not know is a SchemaDrift. Provider
// strings are data.

const text = (max: number) => z.string().max(max);

/** About 2.3 months of 5-minute values (the Chooz H fixture: 15,588 points). */
const MAX_POINTS = 30_000;

const Point = z.tuple([z.number(), z.number().nullable()]);

const Document = z.strictObject({
  Serie: z.strictObject({
    CdStationHydro: text(20),
    LbStationHydro: text(500),
    Link: text(500),
    GrdSerie: z.enum(['H', 'Q']),
    ObssHydro: cappedArray(Point, MAX_POINTS),
  }),
  VersionFlux: text(40),
});
export type Serie = z.infer<typeof Document>['Serie'];

/** Node and depth caps: three values per point (in brackets: the fixture, 46,771 values, depth 4). */
export const JSON_CAPS = { maxNodes: 100_000, maxDepth: 5 } as const satisfies JsonCaps;

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

export const parseSerie = (body: Uint8Array): Serie =>
  parseStrict(Document, boundedJson(decode(body), JSON_CAPS)).Serie;
