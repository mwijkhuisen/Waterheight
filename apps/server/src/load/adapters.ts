import type { Normalised, Registry } from '@rws/core';
import { driftReport } from '../adapters/de-1/drift.ts';
import { normaliseBasin, normaliseMeta, normaliseSeries } from '../adapters/de-1/normalise.ts';
import { JSON_CAPS, parseMeasurements, parseStations } from '../adapters/de-1/parse.ts';
import { normalise as normaliseNl1 } from '../adapters/nl-1/normalise.ts';
import { parseWaarnemingen } from '../adapters/nl-1/parse.ts';
import { driftReport as driftNl2 } from '../adapters/nl-2/drift.ts';
import { normalise as normaliseNl2 } from '../adapters/nl-2/normalise.ts';
import { parseCollection } from '../adapters/nl-2/parse.ts';
import type { SeriesRow } from './store.ts';

// Which archived payloads the loader parses (A§7.4 step 1): adapter by source
// ID, function by capture spec. A source or spec that is not listed here is
// skipped: its payloads stay in the archive, unparsed, until its phase (the
// owner-audience specs wait for P5c and P8; NL-4 is converted offline into
// registry/thresholds/nl-4.csv, never loaded from the archive).

export type LoadContext = {
  registry: Registry;
  /** When the payload was fetched (UTC ms). */
  fetchedAt: number;
  /** The manifest line's variant (the series of a per-series call). */
  variant: string;
  /** The series keys whose unit the source's newest unit-stating payload showed changed (Normalised.unitMismatch). */
  unitMismatch: ReadonlySet<string>;
};

/**
 * What a payload that lists a provider's stations says that the registry does
 * not. A report only: a series enters or leaves the registry by a reviewed
 * change to its registry file. Our own keys and declared values, capped lists.
 */
export type Drift = {
  /** Series in the payload that the registry does not know. */
  unregistered: string[];
  /** Registered series that the payload no longer has. */
  vanished: string[];
  /** Registered series for which the payload states something else than the declaration (`field` names what). */
  changed: { key: string; field: string; declared: string; published: string }[];
};

export type SpecLoader = {
  /** Cap on the decoded payload before it is parsed. */
  maxBytes: number;
  /** The series is named only by the manifest variant: a `recovered` line (no variant) cannot be loaded. */
  needsVariant: boolean;
  /** Strict parse, then pure normalise. Throws SchemaDrift on a payload it does not recognise. */
  run: (body: Uint8Array, ctx: LoadContext) => Normalised;
  /**
   * For a payload that lists the provider's stations: what it says that the
   * registry does not (the loader runs it once a day and only reports).
   */
  drift?: (body: Uint8Array, registry: ReadonlyMap<string, SeriesRow>) => Drift;
  /** The source whose registry `drift` compares with, when it is not the payload's own (NL-2 lists NL-1's series). */
  driftSource?: string;
};

export type LoadAdapter = {
  /** Bumped when parse or normalise changes what is stored; recorded on every batch. */
  version: number;
  specs: Readonly<Record<string, SpecLoader>>;
};

const MIB = 1024 * 1024;

/** One `OphalenWaarnemingen` response: the lists name their own series, so a `recovered` line loads too. */
const nl1Observations: SpecLoader = {
  maxBytes: 4 * MIB,
  needsVariant: false,
  run: (b, c) => normaliseNl1(parseWaarnemingen(b), c),
};

export const LOAD_ADAPTERS: Readonly<Record<string, LoadAdapter>> = {
  'DE-1': {
    version: 1,
    specs: {
      'de-1-basin': {
        maxBytes: 4 * MIB,
        needsVariant: false,
        run: (b, c) => normaliseBasin(parseStations(b, JSON_CAPS.basin), c),
        drift: (b, registry) => driftReport(registry, parseStations(b, JSON_CAPS.basin)),
      },
      'de-1-series': { maxBytes: 8 * MIB, needsVariant: true, run: (b, c) => normaliseSeries(parseMeasurements(b), c) },
      'de-1-meta': {
        maxBytes: 16 * MIB,
        needsVariant: false,
        run: (b, c) => normaliseMeta(parseStations(b, JSON_CAPS.meta), c),
      },
    },
  },
  // Observations only: the `verwachting` specs (nl-1-fc-*) wait for P8, the catalogue is not a series payload.
  'NL-1': {
    version: 1,
    specs: {
      'nl-1-obs-key': nl1Observations,
      'nl-1-obs-other': nl1Observations,
      'nl-1-obs-twin': nl1Observations,
    },
  },
  // Discovery only: no row is ever stored (REST wins); the snapshot feeds NL-1's drift report. Listed only while
  // its DST fixtures pass (the DST gate of A§7.4; test/adapters/nl-2.test.ts).
  'NL-2': {
    version: 1,
    specs: {
      'nl-2-wfs': {
        maxBytes: 8 * MIB,
        needsVariant: false,
        run: (b) => normaliseNl2(parseCollection(b)),
        drift: (b, registry) => driftNl2(registry, parseCollection(b)),
        driftSource: 'NL-1',
      },
    },
  },
};
