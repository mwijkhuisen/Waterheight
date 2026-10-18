import {
  emptyNormalised,
  FORECAST_SOURCES,
  type ForecastPoint,
  type ForecastRunIn,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TideRowIn,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Waarnemingen } from './parse.ts';

// NL-1 RWS observations → canonical rows (catalogue §2.1, §4.4, §4.8).
// Declared here, never inferred per row:
//  - series: `<Locatie.Code>/<Grootheid>/<Hoedanigheid>/<WaardeBepalingsMethode>`,
//    all four verbatim from the list's own metadata. The registry row is the one
//    declaration of a series' method (F007, F155 on the Vecht; per station for
//    Q): a list with another method is a different, unregistered series. The
//    key leaves out the instrument (MeetApparaat), the sampling height and the
//    commissioning body (OpdrachtgevendeInstantie): two sensors under one
//    method would merge into one series, and an instant they state with
//    different values is withheld as `conflict` (review N5 of P2b);
//  - time: ISO 8601 with a fixed +01:00 all year (no DST); any other offset is
//    drift;
//  - units: `cm` and `m3/s` (the registry's `m³/s`); factor from the registry;
//  - gap: Kwaliteitswaardecode 99, served with the value 0.0. Dropped on the
//    code alone, whatever the value;
//  - quality codes 00, 10, 20, 25, 30 and 40 (the ones Waterinfo shows) are
//    kept and set no bit: what 25 means is unverified (catalogue §2.1, C7), so
//    no meaning is invented. Any other code withholds its value (counted, so the
//    payload is kept for a replay once the code is understood);
//  - status: Ongecontroleerd → qc bit "raw"; Gecontroleerd and Definitief →
//    "validated";
//  - only ProcesType `meting`, compartment OW, no Groepering (no high/low-water
//    extremes), quantities WATHTE and Q. A list that fails one of the first
//    three under a registered key is withheld as `registered_dropped` (RWS
//    changed a series we store), any other is only counted. WATHTE in a datum
//    other than NAP (TAW, MSL, PLAATSLR) is a duplicate and dropped, unless the
//    registry declares that very series (the Eijsden-grens TAW twin);
//  - series RWS publishes but that are stale or wrong are dropped by an
//    explicit list (catalogue §1b, §2.1 pitfall 5, §3.1).
// A value list is split whenever its metadata changes: the lists of one series
// are merged and sorted by time. Where two lists state the same instant with
// the same value, one row is kept (the validated one); with different values,
// none is: the instant is withheld and counted, never chosen between.

export const SOURCE = 'NL-1';
export const TIME: TimeConvention = { kind: 'fixed-offset', offset: '+01:00' };

/** Our longest window is P31D; an older value belongs to a request we never make. */
const MAX_AGE_MS = 45 * 86_400_000;

export type Context = {
  registry: Registry;
  /** When the payload was fetched (UTC ms): the reference for "future" and "too old". */
  fetchedAt: number;
  /**
   * P14a: how old a value may be (ms; default MAX_AGE_MS). `null` drops nothing for its age: a backfill payload
   * (spec nl-1-backfill-obs) asks for history on purpose. The future check stays.
   */
  maxAgeMs?: number | null;
};

// Maps and Sets, not objects: a provider string such as `constructor` must not find an inherited property.
/** The payload's unit code → the registry's `native_unit`. `m3/d` (Sommatie) is not a series of ours. */
const UNIT: ReadonlyMap<string, string> = new Map([
  ['cm', 'cm'],
  ['m3/s', 'm³/s'],
]);
const QUANTITIES: ReadonlySet<string> = new Set(['WATHTE', 'Q']);
const GAP = '99';
const KNOWN_QUALITY: ReadonlySet<string> = new Set(['00', '10', '20', '25', '30', '40']);

/**
 * Series we never store, as key prefixes (`<code>/<Grootheid>/<Hoedanigheid>`
 * with or without the method): arnhem.nederrijn H and Q and driel.boven Q are
 * stale or gaps at the provider, westervoort.ijsselkop Q F230 stopped on
 * 2025-11-27 (westervoort.1 Q F006 carries the IJssel).
 */
export const STALE_SERIES: readonly string[] = [
  'arnhem.nederrijn/WATHTE/NAP',
  'arnhem.nederrijn/Q/NVT',
  'driel.boven/Q/NVT',
  'westervoort.ijsselkop/Q/NVT/other:F230',
];
/** Both gauges at the Pannerden weir read about 11.4 m NAP: not river levels (catalogue §2.1 pitfall 5). */
const EXCLUDED_LOCATION = /^pannerden\.regelwerk\./;

const isStale = (key: string) => STALE_SERIES.some((s) => key === s || key.startsWith(`${s}/`));

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

const count = (out: Normalised, code: string, n = 1) => {
  if (n > 0) out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

type Sample = { value: number; qc: number };

/** Every registered series of one `OphalenWaarnemingen` response. */
export function normalise(lists: readonly Waarnemingen[], ctx: Context): Normalised {
  const out = emptyNormalised();
  const maxAge = ctx.maxAgeMs === undefined ? MAX_AGE_MS : ctx.maxAgeMs;
  /** A registered `<code>/<Grootheid>/<Hoedanigheid>`, whatever its method. */
  let combinations: Set<string> | undefined;
  const merged = new Map<string, { samples: Map<number, Sample>; conflicts: Set<number> }>();

  for (const { aquo, locatie, metingen } of lists) {
    const n = metingen.length;
    const combination = `${locatie.Code}/${aquo.Grootheid.Code}/${aquo.Hoedanigheid.Code}`;
    const key = `${combination}/${aquo.WaardeBepalingsMethode.Code}`;
    const decl = ctx.registry.get(key);
    const reason =
      aquo.ProcesType !== 'meting'
        ? 'process'
        : aquo.Compartiment.Code !== 'OW'
          ? 'compartment'
          : aquo.Groepering.Code !== ''
            ? 'grouping'
            : EXCLUDED_LOCATION.test(locatie.Code)
              ? 'excluded'
              : aquo.Eenheid.Code === 'm3/d'
                ? 'sommatie'
                : !QUANTITIES.has(aquo.Grootheid.Code)
                  ? 'quantity'
                  : isStale(key)
                    ? 'stale_series'
                    : null;
    if (reason !== null) {
      // A series we store that now arrives under another ProcesType, compartment or grouping is withheld and
      // reported (review F3 of P2b). A forecast comes under ProcesType `verwachting` and a method of its own
      // (RWSM-F232, other:F058), a tide or a HW/LW extreme under a grouping or a method of its own: never a
      // registered key, and a plain count.
      const registered =
        decl !== undefined && (reason === 'process' || reason === 'compartment' || reason === 'grouping');
      count(out, registered ? 'registered_dropped' : reason, n);
      continue;
    }
    if (decl === undefined) {
      combinations ??= new Set([...ctx.registry.keys()].map((k) => k.slice(0, k.lastIndexOf('/'))));
      // A registered series that now arrives under another method is not the series we declared: withheld and
      // reported, never stored under the old key. A datum duplicate is dropped. Any other series the registry
      // does not know is only counted.
      if (combinations.has(combination)) count(out, 'unregistered_method', n);
      else if (aquo.Grootheid.Code === 'WATHTE' && aquo.Hoedanigheid.Code !== 'NAP') count(out, 'datum', n);
      else out.unknown += 1;
      continue;
    }
    if (UNIT.get(aquo.Eenheid.Code) !== decl.native_unit) {
      count(out, 'unit_mismatch', n);
      continue;
    }

    let series = merged.get(decl.key);
    if (series === undefined) {
      series = { samples: new Map(), conflicts: new Set() };
      merged.set(decl.key, series);
    }
    for (const m of metingen) {
      const ts = instant(m.Tijdstip);
      const quality = m.WaarnemingMetadata.Kwaliteitswaardecode;
      const dropped =
        quality === GAP
          ? 'gap'
          : !KNOWN_QUALITY.has(quality)
            ? 'unknown_quality'
            : isFuture(ts, ctx.fetchedAt)
              ? 'future'
              : maxAge !== null && ts < ctx.fetchedAt - maxAge
                ? 'too_old'
                : series.conflicts.has(ts)
                  ? 'conflict'
                  : null;
      if (dropped !== null) {
        count(out, dropped);
        continue;
      }
      const value = scale(decl.to_canonical, m.Meetwaarde.Waarde_Numeriek);
      const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'level');
      const status = m.WaarnemingMetadata.Statuswaarde === 'Ongecontroleerd' ? QC.RAW : QC.VALIDATED;
      const sample = { value, qc: status | rangeBit(kind, value) };
      const before = series.samples.get(ts);
      if (before === undefined) {
        series.samples.set(ts, sample);
      } else if (before.value === value) {
        count(out, 'duplicate');
        if (status === QC.VALIDATED) series.samples.set(ts, sample);
      } else {
        // Two values for one instant: neither is stored.
        series.samples.delete(ts);
        series.conflicts.add(ts);
        count(out, 'conflict', 2);
      }
    }
  }

  for (const [key, { samples }] of merged) {
    for (const [ts, s] of [...samples].sort((a, b) => a[0] - b[0])) {
      out.obs.push({ series: key, ts: toIso(ts), value: s.value, qc: s.qc });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ forecasts (P8a)
// An `OphalenWaarnemingen` response of ProcesType `verwachting` (specs nl-1-fc-*, A§7.4 item 9, catalogue §2.1):
// RWS issues one run a day and a capture asks T−10 min … T+48 h, so a capture is a run without its leading values
// (the loader's merge, packages/core mergeDecision, knows that: FORECAST_SOURCES['NL-1'].headDrops). Declared here:
//  - only ProcesType `verwachting`; a list of any other ProcesType is drift of the whole payload;
//  - series: a list attaches to the one registered series of `<code>/WATHTE/NAP/` (H) or `<code>/Q/NVT/` (Q) of the
//    registry, whatever its observation method; no such series, or two, is `unknown` (counted once; the object is
//    kept for a replay after a registry change), whatever its method. The TAW twin and every other datum never
//    attach;
//  - method: declared per series, as for observations (`FORECAST_METHODS`): a list that would attach but carries
//    another method is not the forecast we declared, so its values are `unregistered_method` (retained: counted,
//    alerted, kept for a replay) and the payload's other lists still load. Checked after the attachment, so an
//    unregistered series stays `unknown`, and before the unit, as the observations do;
//  - units: from FORECAST_SOURCES (cm for H, m3/s for Q), never from the observation series; another unit, or the
//    unit of the other quantity, is `unit_mismatch` (retained);
//  - time: the fixed +01:00 of `TIME`; no `isFuture` and no age limit (a forecast is in the future by nature);
//  - gap: quality 99, dropped on the code alone (the all-gap list carries 2147483648); the only other code the
//    forecast lists use is 00, any other is `unknown_quality` (retained);
//  - an instant stated twice: the same value is one row (`duplicate`), different values withhold the instant
//    (`conflict`, retained), as for observations;
//  - the run: deterministic, step PT10M, issue time inferred by the loader (RWS states none), no segment end.
// The lists of one series are merged and sorted by time; a list left without a value is no run.

const FORECAST = FORECAST_SOURCES['NL-1'];
/**
 * The forecast method of each series, keyed `<Locatie.Code>/<H|Q>`: the recorded catalogue (nl-1-catalogue.raw,
 * 2026-09-29) lists exactly one `verwachting` method per row of registry/seed/nl-1-forecast.csv, RWSM-F232 for 195
 * and other:F058 for maaseik Q alone (test/adapters/nl-1-forecast.test.ts pins this map to the catalogue).
 */
const FORECAST_METHOD = 'RWSM-F232';
const FORECAST_METHODS: ReadonlyMap<string, string> = new Map([['maaseik/Q', 'other:F058']]);
export const forecastMethod = (code: string, quantity: 'H' | 'Q') =>
  FORECAST_METHODS.get(`${code}/${quantity}`) ?? FORECAST_METHOD;
/** Grootheid → its quantity and the Hoedanigheid whose registered series it attaches to. */
const FORECAST_SERIES: ReadonlyMap<string, { quantity: 'H' | 'Q'; datum: string }> = new Map([
  ['WATHTE', { quantity: 'H', datum: 'NAP' }],
  ['Q', { quantity: 'Q', datum: 'NVT' }],
]);
/** The provider's unit code → quantity and factor to the canonical unit (a Map: `constructor` is no unit). */
const FORECAST_UNITS: ReadonlyMap<string, readonly ['H' | 'Q', number]> = new Map(Object.entries(FORECAST.units));
const FORECAST_QUALITY = '00';

/** The forecast runs of one response: one per registered series it states a value for. */
export function normaliseForecast(lists: readonly Waarnemingen[], ctx: Context): Normalised {
  const runs: ForecastRunIn[] = [];
  const out = { ...emptyNormalised(), forecasts: runs };
  /** The registered keys under `<code>/<Grootheid>/<Hoedanigheid>`, built once. */
  const byCombination = new Map<string, string[]>();
  for (const key of ctx.registry.keys()) {
    const combination = key.slice(0, key.lastIndexOf('/'));
    byCombination.set(combination, [...(byCombination.get(combination) ?? []), key]);
  }
  const merged = new Map<string, { samples: Map<number, number>; conflicts: Set<number> }>();
  const unknown = new Set<string>();

  for (const { aquo, locatie, metingen } of lists) {
    if (aquo.ProcesType !== 'verwachting') throw new SchemaDrift('forecast_process');
    const combination = `${locatie.Code}/${aquo.Grootheid.Code}/${aquo.Hoedanigheid.Code}`;
    const what = FORECAST_SERIES.get(aquo.Grootheid.Code);
    const keys = byCombination.get(combination);
    const key = keys?.length === 1 ? keys[0] : undefined;
    if (
      what === undefined ||
      aquo.Hoedanigheid.Code !== what.datum ||
      aquo.Compartiment.Code !== 'OW' ||
      aquo.Groepering.Code !== '' ||
      key === undefined
    ) {
      unknown.add(combination);
      continue;
    }
    if (aquo.WaardeBepalingsMethode.Code !== forecastMethod(locatie.Code, what.quantity)) {
      count(out, 'unregistered_method', metingen.length);
      continue;
    }
    const unit = FORECAST_UNITS.get(aquo.Eenheid.Code);
    if (unit === undefined || unit[0] !== what.quantity) {
      count(out, 'unit_mismatch', metingen.length);
      continue;
    }

    let series = merged.get(key);
    if (series === undefined) {
      series = { samples: new Map(), conflicts: new Set() };
      merged.set(key, series);
    }
    for (const m of metingen) {
      const ms = instant(m.Tijdstip);
      const quality = m.WaarnemingMetadata.Kwaliteitswaardecode;
      const dropped =
        quality === GAP
          ? 'gap'
          : quality !== FORECAST_QUALITY
            ? 'unknown_quality'
            : series.conflicts.has(ms)
              ? 'conflict'
              : null;
      if (dropped !== null) {
        count(out, dropped);
        continue;
      }
      const value = scale(unit[1], m.Meetwaarde.Waarde_Numeriek);
      const before = series.samples.get(ms);
      if (before === undefined) {
        series.samples.set(ms, value);
      } else if (before === value) {
        count(out, 'duplicate');
      } else {
        // Two values for one instant: neither is stored.
        series.samples.delete(ms);
        series.conflicts.add(ms);
        count(out, 'conflict', 2);
      }
    }
  }

  out.unknown = unknown.size;
  for (const [key, { samples }] of merged) {
    if (samples.size === 0) continue;
    const points: ForecastPoint[] = [...samples]
      .sort((a, b) => a[0] - b[0])
      .map(([ms, value]) => ({ ts: toIso(ms), value, flags: 0 }));
    runs.push({
      series: key,
      kind: FORECAST.kind,
      stepMs: FORECAST.stepMs,
      issuedAt: null,
      providerSegmentEnd: null,
      points,
    });
  }
  return out;
}

/** P16b: which tide a payload holds (its spec decides: nl-1-astro, nl-1-hwlw, nl-1-hwlw-astro). */
export type TideKind = 'astro' | 'extreme' | 'extreme_astro';

// ------------------------------------------------------------------------------------------------ tide (P16b)
// The astronomical tide (spec nl-1-astro), the measured high and low waters (nl-1-hwlw, Grouping GETETM2) and the
// astronomical ones (nl-1-hwlw-astro, GETETBRKD2) of one location, as `tide` rows, never `obs`. Declared here:
//  - the provider must answer what the request asked: WATHTE in cm in OW, the ProcesType and Groepering of the
//    kind (below), a `*MSL2` grouping exactly with Hoedanigheid MSL; anything else is drift of the whole payload
//    (`tide_quantity`, `tide_unit`, `tide_compartment`, `tide_process`, `tide_grouping`, `tide_datum`);
//  - series: the one registered key under `<code>/WATHTE/<NAP|MSL>/` (the measured H series of that location and
//    datum); none or several is `unknown` (counted once per combination, the object is kept for a replay). A
//    registered series of another datum cannot match by construction, so there is no `datum_mismatch` here: an MSL
//    list at a location registered in NAP only is `unknown`;
//  - method: astronomical lists must be other:F012 (the catalogue's only method); measured extremes one of GETETM2's
//    F009, F010, F029 or none ('' or 'NVT'); another is `unregistered_method` (retained);
//  - time: `extreme` drops `future` and `too_old` as observations do; the astronomical kinds accept rows from
//    fetch − P1D to fetch + P400D + P1D (`before_window`, `beyond_horizon`, both retained);
//  - quality 99 is a gap, any code outside the observation list `unknown_quality`; an instant stated twice with the
//    same value is one row (`duplicate`), with different values neither (`conflict`); a value outside the range the
//    observation path applies to the series (`rangeBit` of its value kind) is dropped as `out_of_range` (review SR-4:
//    a garbled number, or one a `real` cannot hold);
//  - high and low (Q1, owner decision 2026-10-17): RWS labels no extreme in this response, so the label is derived by
//    strict alternation over the merged, time-ordered values of a series: each value is a strict extreme of its
//    neighbours and highs and lows alternate. A series that breaks it (fewer than 2 values, equal neighbours, two
//    highs or two lows in a row), that lost a value between its first and last kept one (`gap`, `unknown_quality`,
//    `conflict`, `out_of_range`: the rest may still alternate with every label after the hole flipped, review CR-2)
//    stores nothing from this payload and counts its values as `hwlw_unlabelled` (retained). There is no spacing
//    rule (see `alternation`). `astro` rows carry no label.
//    The first and the last value of a labelled series are never stored (counted `hwlw_edge`, not retained): their
//    label rests on one neighbour, and an extreme missing next to them can leave the list alternating with the end
//    value wrongly labelled. Consecutive monthly astronomical windows (and the daily P3D measured ones) overlap, so
//    a payload's end extremes lie inside a neighbouring payload and are stored from there; only the very first
//    extreme of the very first run is never stored.

const TIDE_PROCESS: Record<TideKind, string> = {
  astro: 'astronomisch',
  extreme: 'meting',
  extreme_astro: 'astronomisch',
};
/** The Groepering asked, by Hoedanigheid (an astronomical tide has none). */
const TIDE_GROUPING: Record<TideKind, { NAP: string; MSL: string }> = {
  astro: { NAP: '', MSL: '' },
  extreme: { NAP: 'GETETM2', MSL: 'GETETMSL2' },
  extreme_astro: { NAP: 'GETETBRKD2', MSL: 'GETETBRKDMSL2' },
};
const TIDE_METHODS: Record<TideKind, ReadonlySet<string>> = {
  astro: new Set(['other:F012']),
  extreme: new Set(['other:F009', 'other:F010', 'other:F029', '', 'NVT']),
  extreme_astro: new Set(['other:F012']),
};
const DAY_MS = 86_400_000;
/** The request asks P400D from now (adapters/nl-1/capture.ts); one day of slack on both sides. */
const TIDE_AHEAD_MS = 401 * DAY_MS;

/**
 * `high`/`low` by strict alternation, or null when the values do not alternate. No spacing limit (P16b follow-up):
 * in the 78 production lists of 2026-10-17 one spacing reaches 10.32 h (the double low waters of the Holland coast
 * and the Rotterdam mouths) while two consecutive spacings sum to as little as 6.88 h at 35 locations, so a limit
 * either withholds real lists (10 h withheld 8) or misses an omission. Inside a list a single missing extreme always
 * breaks the alternation (two highs or two lows meet), and a missing pair leaves every label right. The first and
 * last values are labelled from one neighbour only, so `normaliseTide` does not store them.
 */
function alternation(values: readonly number[]): ('high' | 'low')[] | null {
  if (values.length < 2) return null;
  const up = values.slice(1).map((v, i) => v > (values[i] as number));
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i + 1] === values[i]) return null;
    if (i > 0 && up[i] === up[i - 1]) return null;
  }
  return values.map((_, i) => (i === 0 ? (up[0] ? 'low' : 'high') : up[i - 1] ? 'high' : 'low'));
}

/**
 * P16b: the astronomical tide or the high and low waters of one `OphalenWaarnemingen` response, as `tide` rows
 * (never `obs`) of the registered measured H series of the same location and datum.
 */
export function normaliseTide(lists: readonly Waarnemingen[], ctx: Context, kind: TideKind): Normalised {
  const tide: TideRowIn[] = [];
  const out = { ...emptyNormalised(), tide };
  const maxAge = ctx.maxAgeMs === undefined ? MAX_AGE_MS : ctx.maxAgeMs;
  const byCombination = new Map<string, string[]>();
  for (const key of ctx.registry.keys()) {
    const combination = key.slice(0, key.lastIndexOf('/'));
    byCombination.set(combination, [...(byCombination.get(combination) ?? []), key]);
  }
  // `holes`: the instants of every value dropped from a series (only those between its first and last kept value
  // matter: the time-window drops lie outside by construction).
  const merged = new Map<string, { samples: Map<number, number>; conflicts: Set<number>; holes: number[] }>();
  const unknown = new Set<string>();

  for (const { aquo, locatie, metingen } of lists) {
    const hoedanigheid = aquo.Hoedanigheid.Code;
    if (aquo.Grootheid.Code !== 'WATHTE') throw new SchemaDrift('tide_quantity');
    if (aquo.Eenheid.Code !== 'cm') throw new SchemaDrift('tide_unit');
    if (aquo.Compartiment.Code !== 'OW') throw new SchemaDrift('tide_compartment');
    if (aquo.ProcesType !== TIDE_PROCESS[kind]) throw new SchemaDrift('tide_process');
    if (hoedanigheid !== 'NAP' && hoedanigheid !== 'MSL') throw new SchemaDrift('tide_datum');
    if (aquo.Groepering.Code !== TIDE_GROUPING[kind][hoedanigheid]) {
      // A grouping of the kind but of the other datum is a datum problem, any other grouping is not what we asked.
      const other = TIDE_GROUPING[kind][hoedanigheid === 'NAP' ? 'MSL' : 'NAP'];
      throw new SchemaDrift(aquo.Groepering.Code === other ? 'tide_datum' : 'tide_grouping');
    }
    const combination = `${locatie.Code}/WATHTE/${hoedanigheid}`;
    const keys = byCombination.get(combination);
    const key = keys?.length === 1 ? keys[0] : undefined;
    if (key === undefined) {
      unknown.add(combination);
      continue;
    }
    if (!TIDE_METHODS[kind].has(aquo.WaardeBepalingsMethode.Code)) {
      count(out, 'unregistered_method', metingen.length);
      continue;
    }

    // A WATHTE key: the H range of the observation path (a level unless the row declares a stage).
    const valueKind = ctx.registry.get(key)?.value_kind ?? 'level';
    let series = merged.get(key);
    if (series === undefined) {
      series = { samples: new Map(), conflicts: new Set(), holes: [] };
      merged.set(key, series);
    }
    for (const m of metingen) {
      const ts = instant(m.Tijdstip);
      const quality = m.WaarnemingMetadata.Kwaliteitswaardecode;
      const late = kind === 'extreme' ? isFuture(ts, ctx.fetchedAt) : ts > ctx.fetchedAt + TIDE_AHEAD_MS;
      const early = kind === 'extreme' ? maxAge !== null && ts < ctx.fetchedAt - maxAge : ts < ctx.fetchedAt - DAY_MS;
      const dropped =
        quality === GAP
          ? 'gap'
          : !KNOWN_QUALITY.has(quality)
            ? 'unknown_quality'
            : late
              ? kind === 'extreme'
                ? 'future'
                : 'beyond_horizon'
              : early
                ? kind === 'extreme'
                  ? 'too_old'
                  : 'before_window'
                : series.conflicts.has(ts)
                  ? 'conflict'
                  : rangeBit(valueKind, m.Meetwaarde.Waarde_Numeriek) !== 0
                    ? 'out_of_range'
                    : null;
      if (dropped !== null) {
        count(out, dropped);
        series.holes.push(ts);
        continue;
      }
      const value = m.Meetwaarde.Waarde_Numeriek;
      const before = series.samples.get(ts);
      if (before === undefined) {
        series.samples.set(ts, value);
      } else if (before === value) {
        count(out, 'duplicate');
      } else {
        // Two values for one instant: neither is stored.
        series.samples.delete(ts);
        series.conflicts.add(ts);
        series.holes.push(ts);
        count(out, 'conflict', 2);
      }
    }
  }

  out.unknown = unknown.size;
  for (const [key, { samples, holes }] of merged) {
    const rows = [...samples].sort((a, b) => a[0] - b[0]);
    if (kind === 'astro') {
      for (const [ts, value] of rows) tide.push({ series: key, kind, ts: toIso(ts), value, hilo: null });
      continue;
    }
    if (rows.length === 0) continue;
    const first = (rows[0] as [number, number])[0];
    const last = (rows[rows.length - 1] as [number, number])[0];
    const whole = !holes.some((ts) => ts > first && ts < last);
    const labels = whole ? alternation(rows.map((r) => r[1])) : null;
    if (labels === null) {
      count(out, 'hwlw_unlabelled', rows.length);
      continue;
    }
    // The end values' labels rest on one neighbour: never stored (see the comment above `normaliseTide`).
    count(out, 'hwlw_edge', 2);
    rows.forEach(([ts, value], i) => {
      if (i === 0 || i === rows.length - 1) return;
      tide.push({ series: key, kind, ts: toIso(ts), value, hilo: labels[i] as 'high' | 'low' });
    });
  }
  return out;
}
