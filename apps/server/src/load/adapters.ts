import type { Normalised, Registry } from '@rws/core';
import { normaliseCube } from '../adapters/ch-1/normalise.ts';
import { parseCube } from '../adapters/ch-1/parse.ts';
import { normaliseFeatures } from '../adapters/ch-2/normalise.ts';
import { parseFeatures } from '../adapters/ch-2/parse.ts';
import { normalisePlot } from '../adapters/ch-3/normalise.ts';
import { parsePlot } from '../adapters/ch-3/parse.ts';
import { driftReport } from '../adapters/de-1/drift.ts';
import { normaliseBasin, normaliseMeta, normaliseSeries } from '../adapters/de-1/normalise.ts';
import { JSON_CAPS, parseMeasurements, parseStations } from '../adapters/de-1/parse.ts';
import { normaliseStations as normaliseFr1Stations, normaliseObservations } from '../adapters/fr-1/normalise.ts';
import { parseStations as parseFr1Stations, parseObservations } from '../adapters/fr-1/parse.ts';
import { normaliseSerie } from '../adapters/fr-3/normalise.ts';
import { parseSerie } from '../adapters/fr-3/parse.ts';
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
  /** The registry of the spec's `fill` source (its series that the payload's fill rows may fill). */
  fillRegistry?: Registry;
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
  /**
   * The source whose primary series the payload's `fill` rows gap-fill (FR-3 → FR-1, CH-3 → CH-1): stored only
   * where that source states no value, with the backfilled bit, never as a revision (load/store.ts).
   */
  fill?: string;
};

export type LoadAdapter = {
  /** Bumped when parse or normalise changes what is stored; recorded on every batch. */
  version: number;
  specs: Readonly<Record<string, SpecLoader>>;
};

const MIB = 1024 * 1024;

/** One Vigicrues series (the seed and the twin spec): rows of the FR-3 twin series, and the same rows as FR-1 fill. */
const fr3Serie: SpecLoader = {
  maxBytes: 4 * MIB,
  needsVariant: false,
  run: (b, c) => normaliseSerie(parseSerie(b), c),
  fill: 'FR-1',
};

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
  // Every page of an observations_tr walk is its own payload and names its own series; a recovered line loads too.
  'FR-1': {
    version: 1,
    specs: {
      'fr-1-obs': {
        maxBytes: 16 * MIB,
        needsVariant: false,
        run: (b, c) => normaliseObservations(parseObservations(b).data, c),
      },
      'fr-1-ref': {
        maxBytes: 8 * MIB,
        needsVariant: false,
        run: (b, c) => normaliseFr1Stations(parseFr1Stations(b), c),
      },
    },
  },
  // A twin and gap-fill source, never primary (A§7.2): the ~2-month seed and the 6-hourly Chooz/Uckange twin spec.
  'FR-3': { version: 1, specs: { 'fr-3-obs': fr3Serie, 'fr-3-twin': fr3Serie } },
  'CH-1': {
    version: 1,
    specs: { 'ch-1-lindas': { maxBytes: 4 * MIB, needsVariant: false, run: (b, c) => normaliseCube(parseCube(b), c) } },
  },
  // A twin of CH-1, nothing depends on it (C13 may move it to the owner audience, or stop it).
  'CH-2': {
    version: 1,
    specs: {
      'ch-2-pq': { maxBytes: 4 * MIB, needsVariant: false, run: (b, c) => normaliseFeatures(parseFeatures(b), c) },
    },
  },
  // The 40-day seed: gap-fill rows of the CH-1 series only; the station is the seed row (the variant).
  'CH-3': {
    version: 1,
    specs: {
      'ch-3-40d': {
        maxBytes: 8 * MIB,
        needsVariant: true,
        run: (b, c) => normalisePlot(parsePlot(b), c),
        fill: 'CH-1',
      },
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
