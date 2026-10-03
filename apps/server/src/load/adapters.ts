import { emptyNormalised, type Normalised, type Registry, SchemaDrift, type TimeConvention } from '@rws/core';
import {
  TIME as BE3_TIME,
  normaliseLayer as normaliseBe3Layer,
  normaliseReferences as normaliseBe3References,
  normaliseStations as normaliseBe3Stations,
  normaliseValues as normaliseBe3Values,
} from '../adapters/be-3/normalise.ts';
import {
  parseCatchup as parseBe3Catchup,
  parseLayer as parseBe3Layer,
  parseTable as parseBe3Table,
} from '../adapters/be-3/parse.ts';
import { TIME as CH1_TIME, normaliseCube } from '../adapters/ch-1/normalise.ts';
import { parseCube } from '../adapters/ch-1/parse.ts';
import { TIME as CH2_TIME, normaliseFeatures } from '../adapters/ch-2/normalise.ts';
import { parseFeatures } from '../adapters/ch-2/parse.ts';
import { TIME as CH3_TIME, normalisePlot } from '../adapters/ch-3/normalise.ts';
import { parsePlot } from '../adapters/ch-3/parse.ts';
import { driftReport } from '../adapters/de-1/drift.ts';
import { TIME as DE1_TIME, normaliseBasin, normaliseMeta, normaliseSeries } from '../adapters/de-1/normalise.ts';
import { JSON_CAPS, parseMeasurements, parseStations } from '../adapters/de-1/parse.ts';
import {
  TIME as DE7_TIME,
  normalise as normaliseDe7,
  normaliseThresholds as normaliseDe7Thresholds,
} from '../adapters/de-7/normalise.ts';
import {
  STATIONS_MAX_BYTES as DE7_STATIONS_MAX,
  type Member as De7Member,
  lineSink as de7Lines,
  parseStationFile as parseDe7Stations,
} from '../adapters/de-7/parse.ts';
import { driftReport as driftDe8, normaliseHydro } from '../adapters/de-8/normalise.ts';
import { HYDRO_MEMBER, parseStations as parseDe8Stations, parseHydro } from '../adapters/de-8/parse.ts';
import {
  TIME as FR1_TIME,
  normaliseStations as normaliseFr1Stations,
  normaliseObservations,
} from '../adapters/fr-1/normalise.ts';
import { parseStations as parseFr1Stations, parseObservations } from '../adapters/fr-1/parse.ts';
import { TIME as FR3_TIME, normaliseSerie } from '../adapters/fr-3/normalise.ts';
import { parseSerie } from '../adapters/fr-3/parse.ts';
import { TIME as LU1_TIME, normalise as normaliseLu1 } from '../adapters/lu-1/normalise.ts';
import { parseCsv as parseLu1 } from '../adapters/lu-1/parse.ts';
import { TIME as LU2_TIME, normalise as normaliseLu2 } from '../adapters/lu-2/normalise.ts';
import { parseJson as parseLu2 } from '../adapters/lu-2/parse.ts';
import { driftReport as driftLu6, normalise as normaliseLu6 } from '../adapters/lu-6/normalise.ts';
import { parseFeatures as parseLu6 } from '../adapters/lu-6/parse.ts';
import { TIME as NL1_TIME, normalise as normaliseNl1 } from '../adapters/nl-1/normalise.ts';
import { parseWaarnemingen } from '../adapters/nl-1/parse.ts';
import { driftReport as driftNl2 } from '../adapters/nl-2/drift.ts';
import { TIME as NL2_TIME, normalise as normaliseNl2 } from '../adapters/nl-2/normalise.ts';
import { parseCollection } from '../adapters/nl-2/parse.ts';
import { checkZip, type Encoding, flatNames, GuardFailure, lineSplitter } from '../http/guards.ts';
import type { SeriesRow } from './store.ts';
import * as wireCh5 from './wire/ch-5.ts';
import * as wireDe6 from './wire/de-6.ts';
import * as wireFr5 from './wire/fr-5.ts';
import * as wireLu4 from './wire/lu-4.ts';
import * as wireLu5 from './wire/lu-5.ts';

// Which archived payloads the loader parses (A§7.4 step 1): adapter by source
// ID, function by capture spec. A source or spec that is not listed here is
// skipped: its payloads stay in the archive, unparsed, until its phase (the
// owner-audience forecasts and references wait for P8a and P7a (LU-3, LU-4, DE-2, DE-3; P5c parses LU-3 and LU-4
// without loading them); NL-4 is converted offline into
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
  /**
   * P5b: rows older than this instant (UTC ms) are outside the payload's window (`SpecLoader.window`): set
   * from the previous loaded payload of the spec, never for a seed or a replay of a lone payload.
   */
  since?: number;
  /** P5b: the label offset (minutes) measured per UTC day for a source whose labels are late (LU-1). */
  labelOffsets?: { days: Readonly<Record<string, number>> };
  /** P5b: the registry of the spec's `zeroTarget` source (the series that the payload's gauge zeros belong to). */
  zeroRegistry?: Registry;
  /** P7a: the registries of the spec's `refTarget` sources, by source (the series its references belong to). */
  refRegistries?: ReadonlyMap<string, Registry>;
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
  run: (body: Uint8Array, ctx: LoadContext) => Normalised | Promise<Normalised>;
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
  /**
   * P5b: a payload that re-states days the previous ones stated (DE-7: 7 days, LU-1: 5 days) loads only its
   * rows from `window` ms before the previous loaded payload of the spec on (LoadContext.since), so a point is
   * not rewritten as a confirmation by every payload that repeats it; a capture outage heals from the next
   * payload, because its window reaches back to the last one that loaded.
   */
  window?: number;
  /** P5b: the source whose series the payload's `gaugeZeros` belong to, when it is not its own (DE-8 → DE-7). */
  zeroTarget?: string;
  /** P5b: the source's labels are late by an offset measured per day (load/label-offset.ts); passed in the context. */
  labelOffsets?: true;
  /**
   * P7a: the sources whose series the payload's references may belong to, besides its own (CH-2 → CH-1,
   * LU-4 → LU-1 and LU-2, FR-5 → FR-1); a reference row names one by `target`. Its source_id stays the payload's.
   */
  refTarget?: readonly string[];
};

export type LoadAdapter = {
  /** Bumped when parse or normalise changes what is stored; recorded on every batch. */
  version: number;
  specs: Readonly<Record<string, SpecLoader>>;
};

const MIB = 1024 * 1024;
const HOUR = 3_600_000;
/** The DE-8 hydro member, read whole: 51,225 bytes (2024-06-12). */
export const HYDRO_MAX = 2 * MIB;

/**
 * One member of a ZIP payload, inflated under the §6.7 guard (central directory first, allowlisted flat names,
 * ≤ 10 members, ≤ 200 MB, ≤ 50:1, CRC) and fed to `read` line by line or whole. The other allowlisted members
 * are inflated for their checks and dropped. A guard failure is drift of the payload. Adapters may not import
 * the guards (scripts/check-boundaries.ts), so the wiring is here. A member read whole is held in memory: it has
 * a byte cap of its own (`max`), beyond which it is `zip_member_size` drift as soon as it is reached.
 */
async function zipMember(
  body: Uint8Array,
  members: readonly string[],
  read: string,
  sink: { line: (text: string) => void } | { bytes: (member: Uint8Array) => void; max: number },
  encoding: Encoding = 'utf-8',
  /** P7a: a second member read whole in the same pass (DE-7: `pegel_stationen.txt` beside the line-fed data). */
  whole?: { name: string; max: number; bytes: (member: Uint8Array) => void },
): Promise<void> {
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    await checkZip(Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
      names: flatNames(members),
      onMember: (name) => {
        if (whole !== undefined && name === whole.name) {
          const chunks: Uint8Array[] = [];
          let n = 0;
          return {
            data: (c: Uint8Array) => {
              n += c.length;
              if (n > whole.max) throw new SchemaDrift('zip_member_size');
              chunks.push(c.slice());
            },
            end: () => whole.bytes(Buffer.concat(chunks)),
          };
        }
        if (name !== read) return undefined;
        if ('bytes' in sink) {
          return {
            data: (c: Uint8Array) => {
              size += c.length;
              if (size > sink.max) throw new SchemaDrift('zip_member_size');
              parts.push(c.slice());
            },
            end: () => undefined,
          };
        }
        const split = lineSplitter(sink.line, encoding, 1024, { fatal: true });
        return { data: split.push, end: split.end };
      },
    });
  } catch (err) {
    if (err instanceof GuardFailure) throw new SchemaDrift(err.reason);
    throw err;
  }
  if ('bytes' in sink) sink.bytes(Buffer.concat(parts));
}

/** A DE-7 ZIP: its one data member read as lines into the strict sink, then normalised (chunked). */
const de7Zip =
  (members: readonly string[], member: De7Member, ascii: boolean): SpecLoader['run'] =>
  async (b, c) => {
    const sink = de7Lines(member, { ascii });
    await zipMember(b, members, member, sink);
    return normaliseDe7(sink.end(), c);
  };

const DE7_PEGELDATEN = [
  'pegel_messwerte.txt',
  'pegel_tagesmittelwerte.txt',
  'pegel_tagesmaxima.txt',
  'pegel_stationen.txt',
];

/**
 * The DE-7 seed and weekly ZIP, one pass: `pegel_messwerte.txt` into the line sink (obs, within the spec's window)
 * and `pegel_stationen.txt` read whole (the LANUK thresholds as references; the window never drops them).
 */
const de7Pegeldaten: SpecLoader['run'] = async (b, c) => {
  const sink = de7Lines('pegel_messwerte.txt', { ascii: false });
  let stations: Uint8Array | undefined;
  await zipMember(b, DE7_PEGELDATEN, 'pegel_messwerte.txt', sink, 'utf-8', {
    name: 'pegel_stationen.txt',
    max: DE7_STATIONS_MAX,
    bytes: (m) => {
      stations = m;
    },
  });
  if (stations === undefined) throw new SchemaDrift('zip_member_missing');
  const out = normaliseDe7(sink.end(), c);
  const th = normaliseDe7Thresholds(parseDe7Stations(stations), c);
  out.references = th.references ?? [];
  out.refScope = th.refScope ?? [];
  out.unknown += th.unknown;
  for (const [code, n] of Object.entries(th.dropped)) out.dropped[code] = (out.dropped[code] ?? 0) + n;
  return out;
};

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

/** P7a: the sources wired in load/wire/ (one file each, so their adapters are built side by side). */
const WIRED = [wireDe6, wireFr5, wireCh5, wireLu5, wireLu4] as const;

/** Every source the loader can parse; `LOAD_ADAPTERS` is this list after the DST gate. */
const ALL_ADAPTERS: Readonly<Record<string, LoadAdapter>> = {
  ...Object.fromEntries(WIRED.flatMap((w) => (w.ADAPTER === null ? [] : [[w.SOURCE, w.ADAPTER] as const]))),
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
      'ch-2-pq': {
        maxBytes: 4 * MIB,
        needsVariant: false,
        run: (b, c) => normaliseFeatures(parseFeatures(b), c),
        // WL2..WL5 land on the CH-1 primary series of the same station.
        refTarget: ['CH-1'],
      },
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
  // Discovery only: no row is ever stored (REST wins); the snapshot feeds NL-1's drift report. Loaded only while
  // a DST proof is declared for it (DST_PROOF: the gate below checks the declaration at run time; CI runs the
  // proof's fixtures against their goldens, test/adapters/dst-gate.test.ts).
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
  // LANUK NRW W at 15 (some 5) minutes: messwerte.zip holds 7 days, pegeldaten.zip 2 months (the seed and,
  // weekly, the thresholds of P7: pegel_messwerte.txt as obs, pegel_stationen.txt as references). Both re-state what earlier payloads said.
  'DE-7': {
    version: 1,
    specs: {
      'de-7-messwerte': {
        maxBytes: 8 * MIB,
        needsVariant: false,
        run: de7Zip(['messwerte.txt'], 'messwerte.txt', true),
        window: 6 * HOUR,
      },
      'de-7-pegeldaten': {
        maxBytes: 25 * MIB,
        needsVariant: false,
        run: de7Pegeldaten,
        window: 6 * HOUR,
      },
    },
  },
  // NRW station files: the master (registry input; daily drift against DE-7) and the gauge zeros of DE-7.
  'DE-8': {
    version: 1,
    specs: {
      'de-8-stations': {
        maxBytes: 10 * MIB,
        needsVariant: false,
        run: (b) => {
          parseDe8Stations(b);
          return emptyNormalised();
        },
        drift: (b, registry) => driftDe8(registry, parseDe8Stations(b)),
        driftSource: 'DE-7',
      },
      'de-8-hydro': {
        maxBytes: MIB,
        needsVariant: false,
        run: async (b, c) => {
          let member: Uint8Array = new Uint8Array();
          await zipMember(b, [HYDRO_MEMBER], HYDRO_MEMBER, { bytes: (m) => (member = m), max: HYDRO_MAX }, 'latin1');
          return normaliseHydro(parseHydro(member), { registry: c.zeroRegistry ?? new Map() });
        },
        zeroTarget: 'DE-7',
      },
    },
  },
  // The CC0 wide CSV: naive Europe/Luxembourg labels (their offset, 0 since 2026-09-30, is measured daily against
  // the DE-1 Perl twin), 7 days per payload. Loaded only while a DST proof is declared for it (DST_PROOF: the gate
  // below checks the declaration at run time; CI runs the proof's fixtures against their goldens).
  'LU-1': {
    version: 1,
    specs: {
      'lu-1-csv': {
        maxBytes: 2 * MIB,
        needsVariant: false,
        run: (b, c) => normaliseLu1(parseLu1(b), c),
        window: 6 * HOUR,
        labelOffsets: true,
      },
    },
  },
  // P5c, owner audience: SPW's KiWIS. The layers (the latest value of every series, every 10 minutes) and the
  // catch-up's values name their series (`<station_no>/<stationparameter_no>`) and state each stamp's offset; the
  // catch-up's list roots and the daily timeseries lists are parsed strictly (drift) and store nothing; the station
  // list gives the gauge zeros (m DNG) of the stage series.
  'BE-3': {
    version: 1,
    specs: {
      'be-3-values': { maxBytes: 2 * MIB, needsVariant: false, run: (b, c) => normaliseBe3Layer(parseBe3Layer(b), c) },
      'be-3-catchup': {
        maxBytes: 24 * MIB,
        needsVariant: false,
        run: (b, c) => {
          const doc = parseBe3Catchup(b);
          return doc.kind === 'list' ? emptyNormalised() : normaliseBe3Values(doc.items, c);
        },
      },
      // P7a: the weekly percentile and flood-reference lists: the root (the ts_id list) stores nothing, the values
      // calls state their series by metadata.
      'be-3-refs': {
        maxBytes: 2 * MIB,
        needsVariant: false,
        run: (b, c) => {
          const doc = parseBe3Catchup(b);
          return doc.kind === 'list' ? emptyNormalised() : normaliseBe3References(doc.items, c);
        },
      },
      'be-3-meta': {
        maxBytes: 16 * MIB,
        needsVariant: true,
        run: (b, c) => {
          const rows = parseBe3Table(b);
          if (c.variant === 'stations') return normaliseBe3Stations(rows, c);
          if (c.variant === 'timeseries-1962373' || c.variant === 'timeseries-1962340') return emptyNormalised();
          throw new SchemaDrift('bad_variant');
        },
      },
    },
  },
  // P5c, owner audience: AGE's per-station JSON, a twin of LU-1 in both audiences (never primary). Each file names its
  // series by `ts_path` and states its times with their offset, so a recovered line loads too. No load window:
  // `previousLoad` is per spec, and the 39 files of one run would each take the one before as their previous load.
  'LU-2': {
    version: 1,
    specs: {
      'lu-2-json': {
        maxBytes: MIB,
        needsVariant: false,
        run: (b, c) => normaliseLu2(parseLu2(b)[0], c),
      },
    },
  },
  // Station points only (registry input); the daily payload reports drift against the LU-1 registry.
  'LU-6': {
    version: 1,
    specs: {
      'lu-6-geo': {
        maxBytes: 2 * MIB,
        needsVariant: false,
        run: (b) => normaliseLu6(parseLu6(b)),
        drift: (b, registry) => driftLu6(registry, parseLu6(b)),
        driftSource: 'LU-1',
      },
    },
  },
};

/**
 * The time convention of each loaded source's observation timestamps (its adapter's `TIME`, A§7.4 step 2);
 * null: the source has no timestamps (station files). A source missing here counts as gated.
 */
export const ADAPTER_TIME: Readonly<Record<string, TimeConvention | null>> = {
  'BE-3': BE3_TIME,
  'DE-1': DE1_TIME,
  'NL-1': NL1_TIME,
  'FR-1': FR1_TIME,
  'FR-3': FR3_TIME,
  'CH-1': CH1_TIME,
  'CH-2': CH2_TIME,
  'CH-3': CH3_TIME,
  'NL-2': NL2_TIME,
  'DE-7': DE7_TIME,
  'DE-8': null,
  'LU-1': LU1_TIME,
  'LU-2': LU2_TIME,
  'LU-6': null,
  ...Object.fromEntries(WIRED.flatMap((w) => (w.ADAPTER === null ? [] : [[w.SOURCE, w.TIME] as const]))),
};

/** The conventions that need DST proof before a spec loads (A§7.4 step 2; catalogue §0.3). */
export const GATED_KINDS: ReadonlySet<TimeConvention['kind']> = new Set([
  'naive-local',
  'local-labelled-z',
  'start-of-interval',
]);

/**
 * The DST proof of each spec with a gated convention: its synthetic fall-back (the repeated local hour) and
 * spring-forward (the missing hour) fixtures, `<name>.raw` with `<name>.golden.json` in the adapter's
 * fixtures. apps/server/test/adapters/dst-gate.test.ts runs them against their goldens; a spec without an
 * entry is never loaded.
 */
export type DstProof = { fallBack: readonly string[]; springForward: readonly string[] };
export const DST_PROOF: Readonly<Record<string, DstProof>> = {
  ...Object.assign({}, ...WIRED.map((w) => w.PROOF)),
  'nl-2-wfs': {
    fallBack: ['nl-2-wfs-dst-fall-back.synthetic', 'nl-2-wfs-dst-fall-back-first.synthetic'],
    springForward: ['nl-2-wfs-dst-spring-forward.synthetic'],
  },
  'lu-1-csv': {
    fallBack: ['lu-1-csv-dst-fall-back.synthetic', 'lu-1-csv-dst-fall-back-inside.synthetic'],
    springForward: ['lu-1-csv-dst-spring-forward.synthetic'],
  },
};

/**
 * The DST gate (A§7.4 step 2): drops every spec of a source whose declared convention is gated (or missing)
 * and that has no DST proof. Pure, from the declarations above: no environment or configuration reaches it,
 * so nothing can switch a failing adapter on. It never throws: the API imports this module.
 */
export function gate(
  all: Readonly<Record<string, LoadAdapter>>,
  proof: Readonly<Record<string, unknown>> = DST_PROOF,
  times: Readonly<Record<string, TimeConvention | null>> = ADAPTER_TIME,
): {
  adapters: Record<string, LoadAdapter>;
  refused: string[];
} {
  const adapters: Record<string, LoadAdapter> = {};
  const refused: string[] = [];
  for (const [source, adapter] of Object.entries(all)) {
    const time = Object.hasOwn(times, source) ? times[source] : undefined;
    const gated = time === undefined || (time !== null && GATED_KINDS.has(time.kind));
    const specs: Record<string, SpecLoader> = {};
    for (const [id, spec] of Object.entries(adapter.specs)) {
      if (gated && !Object.hasOwn(proof, id)) refused.push(id);
      else specs[id] = spec;
    }
    if (Object.keys(specs).length > 0) adapters[source] = { version: adapter.version, specs };
  }
  return { adapters, refused: refused.sort() };
}

const gated = gate(ALL_ADAPTERS);

export const LOAD_ADAPTERS: Readonly<Record<string, LoadAdapter>> = gated.adapters;

/** The specs the DST gate keeps out of the loader (the loader logs them at start). */
export const DST_REFUSED: readonly string[] = gated.refused;

/**
 * The sources whose payloads fill each source's series (FR-1 ← FR-3, CH-1 ← CH-3), from the `fill` fields above:
 * the one place the mapping lives. `/api/v1/meta` lists their attribution beside the filled source's (review SR-1).
 */
export const FILLED_BY: ReadonlyMap<string, readonly string[]> = (() => {
  const by = new Map<string, Set<string>>();
  for (const [source, adapter] of Object.entries(LOAD_ADAPTERS))
    for (const spec of Object.values(adapter.specs))
      if (spec.fill !== undefined) by.set(spec.fill, (by.get(spec.fill) ?? new Set()).add(source));
  return new Map([...by].map(([target, fills]) => [target, [...fills].sort()]));
})();
