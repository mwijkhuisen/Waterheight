import {
  type Datum,
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
import type { Observation, Station } from './parse.ts';

// FR-1 Hub'Eau → canonical rows (catalogue §2.5, §4.2, §4.4, §4.5, §4.8).
// Declared here, never inferred per row:
//  - series: `<code_station>/<H|Q>`; a row without `code_station` is a
//    site-level series that duplicates the station's own and is dropped;
//  - time: ISO 8601 UTC with `Z` (any explicit offset is accepted as stated);
//  - unit and factor from the series' registry row: H mm relative to the
//    gauge zero (×0.1, negative values are normal), Q l/s (×0.001);
//  - code_statut 0, 4, 8 and 12 (no validation, raw, corrected,
//    pre-validated) → qc "raw"; 16 → "validated";
//  - code_qualification_obs 16 "Non qualifiée" and 20 "Bonne" set no bit,
//    12 "Douteuse" sets "provider-suspect". Any other statut or qualification
//    withholds the value (`unknown_quality`, kept for a replay);
//  - a negative Q is kept and marked with our range bit (16): physically
//    possible at a few gauges (E172751201), never at most;
//  - a gauge zero (referentiel, `altitude_ref_alti_station`) is stored as
//    published, untrusted: its datum is IGN69 (system 3) or NGF1884 (system 2),
//    which nothing ever converts (packages/core datums.ts, D16); another or no
//    system is not stored.

export const SOURCE = 'FR-1';
export const TIME: TimeConvention = { kind: 'iso-offset' };

/** The seed reaches 30 days back; an older value belongs to a request we never make. */
const MAX_AGE_MS = 45 * 86_400_000;

export type Context = {
  registry: Registry;
  /** When the payload was fetched (UTC ms): the reference for "future" and "too old". */
  fetchedAt: number;
};

// Maps, not objects: a provider value must not find an inherited property.
const STATUT: ReadonlyMap<number, number> = new Map([
  [0, QC.RAW],
  [4, QC.RAW],
  [8, QC.RAW],
  [12, QC.RAW],
  [16, QC.VALIDATED],
]);
const QUALIFICATION: ReadonlyMap<number, number> = new Map([
  [12, QC.PROVIDER_SUSPECT],
  [16, 0],
  [20, 0],
]);
const ZERO_DATUM: ReadonlyMap<number, Datum> = new Map([
  [2, 'NGF1884'],
  [3, 'IGN69'],
]);

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

/**
 * One `observations_tr` page. A timestamp that a series states twice on one
 * page with the same value is kept once; with different values it is withheld
 * (`conflict`), never chosen between. Pages of one walk overlap by a minute
 * (P1): the loader's upsert takes the same row twice as one.
 */
export function normaliseObservations(rows: readonly Observation[], ctx: Context): Normalised {
  const out = emptyNormalised();
  // Per series, per instant: the row, or null once two rows disagree.
  const series = new Map<string, Map<number, { value: number; qc: number } | null>>();
  for (const r of rows) {
    if (r.code_station === null) {
      count(out, 'site_level');
      continue;
    }
    const decl = ctx.registry.get(`${r.code_station}/${r.grandeur_hydro}`);
    if (decl === undefined) {
      out.unknown += 1;
      continue;
    }
    if (r.resultat_obs === null) {
      count(out, 'gap');
      continue;
    }
    const statut = STATUT.get(r.code_statut);
    const qualification = QUALIFICATION.get(r.code_qualification_obs);
    if (statut === undefined || qualification === undefined) {
      count(out, 'unknown_quality');
      continue;
    }
    const ts = instant(r.date_obs);
    if (isFuture(ts, ctx.fetchedAt)) {
      count(out, 'future');
      continue;
    }
    if (ts < ctx.fetchedAt - MAX_AGE_MS) {
      count(out, 'too_old');
      continue;
    }
    const value = scale(decl.to_canonical, r.resultat_obs);
    const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'stage');
    const negativeQ = decl.quantity === 'Q' && value < 0 ? QC.RANGE : 0;
    const qc = statut | qualification | rangeBit(kind, value) | negativeQ;
    let byTime = series.get(decl.key);
    if (byTime === undefined) {
      byTime = new Map();
      series.set(decl.key, byTime);
    }
    const before = byTime.get(ts);
    if (before === undefined) byTime.set(ts, { value, qc });
    else if (before === null) count(out, 'conflict');
    else if (before.value === value && before.qc === qc) count(out, 'duplicate');
    else {
      byTime.set(ts, null);
      count(out, 'conflict', 2);
    }
  }
  for (const key of [...series.keys()].sort()) {
    const byTime = series.get(key) ?? new Map();
    for (const ts of [...byTime.keys()].sort((a, b) => a - b)) {
      const row = byTime.get(ts);
      if (row) out.obs.push({ series: key, ts: toIso(ts), value: row.value, qc: row.qc });
    }
  }
  return out;
}

/** The daily `referentiel/stations` prefixes: the published gauge zero of every registered H series. */
export function normaliseStations(stations: readonly Station[], ctx: Context): Normalised {
  const out = emptyNormalised();
  for (const s of stations) {
    const decl = ctx.registry.get(`${s.code_station}/H`);
    if (decl === undefined) continue;
    if (s.altitude_ref_alti_station === null) {
      count(out, 'zero_missing');
      continue;
    }
    const datum = s.code_systeme_alti_site === null ? undefined : ZERO_DATUM.get(s.code_systeme_alti_site);
    if (datum === undefined) {
      count(out, 'zero_datum_unknown');
      continue;
    }
    const from = s.date_debut_ref_alti_station;
    out.gaugeZeros.push({
      series: decl.key,
      value_m: s.altitude_ref_alti_station,
      datum,
      valid_from: from === null ? null : toIso(instant(from)),
    });
  }
  return out;
}
