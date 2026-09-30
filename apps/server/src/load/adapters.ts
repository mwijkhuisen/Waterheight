import type { Normalised, Registry } from '@rws/core';
import { normaliseBasin, normaliseMeta, normaliseSeries } from '../adapters/de-1/normalise.ts';
import { parseMeasurements, parseStations } from '../adapters/de-1/parse.ts';

// Which archived payloads the loader parses (A§7.4 step 1): adapter by source
// ID, function by capture spec. A source or spec that is not listed here is
// skipped: its payloads stay in the archive, unparsed, until its phase (the
// owner-audience specs wait for P5c and P8).

export type LoadContext = {
  registry: Registry;
  /** When the payload was fetched (UTC ms). */
  fetchedAt: number;
  /** The manifest line's variant (the series of a per-series call). */
  variant: string;
};

export type SpecLoader = {
  /** Cap on the decoded payload before it is parsed. */
  maxBytes: number;
  /** The series is named only by the manifest variant: a `recovered` line (no variant) cannot be loaded. */
  needsVariant: boolean;
  /** Strict parse, then pure normalise. Throws SchemaDrift on a payload it does not recognise. */
  run: (body: Uint8Array, ctx: LoadContext) => Normalised;
};

export type LoadAdapter = {
  /** Bumped when parse or normalise changes what is stored; recorded on every batch. */
  version: number;
  specs: Readonly<Record<string, SpecLoader>>;
};

const MIB = 1024 * 1024;

export const LOAD_ADAPTERS: Readonly<Record<string, LoadAdapter>> = {
  'DE-1': {
    version: 1,
    specs: {
      'de-1-basin': { maxBytes: 4 * MIB, needsVariant: false, run: (b, c) => normaliseBasin(parseStations(b), c) },
      'de-1-series': { maxBytes: 8 * MIB, needsVariant: true, run: (b, c) => normaliseSeries(parseMeasurements(b), c) },
      'de-1-meta': { maxBytes: 16 * MIB, needsVariant: false, run: (b, c) => normaliseMeta(parseStations(b), c) },
    },
  },
};
