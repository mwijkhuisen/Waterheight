import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
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
      // reported (review F3 of P2b). A forecast comes under its own method (RWSM-F232), a tide or a HW/LW
      // extreme under a grouping or a method of its own: never a registered key, and a plain count.
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
              : ts < ctx.fetchedAt - MAX_AGE_MS
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
