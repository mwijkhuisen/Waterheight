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
import { QUALIFICATION, STATUT } from '../_shared/hubeau/quality.ts';
import type { ElabRecord } from './parse.ts';

// FR-2 Hub'Eau obs_elab → canonical rows (catalogue §2.5, §4.4, §4.8): the daily mean discharge QmnJ and the daily
// maximum of the instantaneous stage HIXnJ, loaded only by the backfill (spec fr-2-backfill-elab) into the FR-1
// aggregate twin series `<code_station>/QmnJ` and `<code_station>/HIXnJ` (role twin, P1D, never a primary series).
// Declared here, never inferred per row:
//  - series: `<code_station>/<grandeur_hydro_elab>`, a key of the FR-1 registry (`ctx.registry` is FR-1's);
//  - time: the record carries a day (`date_obs_elab`, no time, no zone), and a row is stamped at the START of that
//    day. WHICH instant that is changed on 2007-03-23 (catalogue §2.5 l.1189, §4.4: recorded on the answers of
//    Uckange and Chooz, the cutover day itself included):
//      * from 2007-03-23 on, the day D is the UTC day: `D T00:00Z`;
//      * before it, the day D is the Europe/Paris day: the Paris midnight of D in UTC (`D-1 T23:00Z` in winter,
//        `D-1 T22:00Z` in summer), read with Temporal and an explicit zone through the convention below;
//    so the stamps run from a Paris midnight to a UTC one across a 25-hour step on 2007-03-22 → 2007-03-23. A Paris
//    midnight is never in a DST gap or twice (the changes are at 02:00 and 03:00), so the convention rejects both
//    and a day that is one is drift;
//  - unit and factor from the twin's registry row: QmnJ l/s (×0.001 → m³/s), HIXnJ mm (×0.1 → cm, a stage on the
//    gauge zero of the station's H series, D16);
//  - code_statut and qualification as FR-1 (`_shared/hubeau/quality.ts`): any other code withholds the value
//    (`unknown_quality`, kept for a replay);
//  - the window: a day outside the line's chunk (`ctx.backfill`, UTC days) or before 1950-01-01 is dropped as
//    `outside_backfill` (a forged or recovered line loads no other time), so the ledger's identities hold.
// Ledger identities (Backfilled): provider_values = rows + Σ dropped + unknown_values.

export const SOURCE = 'FR-2';
// A day starts at its first midnight (review round 2, F1): on 1976-09-26 summer time ended at 01:00, so 00:00 came twice
// in Paris (+02:00, then +01:00); `reject` quarantined any record of that day. It is the one ambiguous midnight of
// 1950-2007 (scanned); no Paris midnight falls in a spring gap.
export const TIME: TimeConvention = {
  kind: 'naive-local',
  zone: 'Europe/Paris',
  dst: { gap: 'reject', overlap: 'earlier' },
};

/** The first day that is a UTC day (earlier days start at the Paris midnight). */
export const UTC_FROM_DAY = '2007-03-23';
/** The spec's floor (registry/backfill.yaml); an earlier day is outside the backfill. */
export const FLOOR_DAY = '1950-01-01';

export type Context = {
  registry: Registry;
  /** When the payload was fetched (UTC ms): the reference for "future". */
  fetchedAt: number;
  /** The line's chunk [from, to) in UTC ms (UTC days); none (the DST proof, a replay of a lone body): no window. */
  backfill?: { from: number; to: number };
};

/** A Normalised with the ledger's per-record counts (structurally load/adapters.ts `Backfilled`). */
export type ElabNormalised = Normalised & { provider_values: number; unknown_values: number };

const UTC: TimeConvention = { kind: 'iso-offset' };

/** The instant a day D (`YYYY-MM-DD`) stands for, in UTC ms. Throws SchemaDrift for a day that does not exist. */
export function dayInstant(day: string): number {
  try {
    return day >= UTC_FROM_DAY ? parseInstant(UTC, `${day}T00:00:00Z`) : parseInstant(TIME, `${day}T00:00:00`);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

/**
 * One `obs_elab` answer. Two records of one series and day with equal values are one (`duplicate`); with different
 * values both are withheld (`conflict`), never chosen between.
 */
export function normaliseElab(rows: readonly ElabRecord[], ctx: Context): ElabNormalised {
  const out = emptyNormalised();
  let unknownValues = 0;
  const unknownKeys = new Set<string>();
  // Per series, per instant: the row, or null once two rows disagree.
  const series = new Map<string, Map<number, { value: number; qc: number } | null>>();
  for (const r of rows) {
    const decl = ctx.registry.get(`${r.code_station}/${r.grandeur_hydro_elab}`);
    if (decl === undefined) {
      unknownKeys.add(`${r.code_station}/${r.grandeur_hydro_elab}`);
      unknownValues += 1;
      continue;
    }
    const statut = STATUT.get(r.code_statut);
    const qualification = QUALIFICATION.get(r.code_qualification);
    if (statut === undefined || qualification === undefined) {
      count(out, 'unknown_quality');
      continue;
    }
    if (r.date_obs_elab < FLOOR_DAY) {
      count(out, 'outside_backfill');
      continue;
    }
    const ts = dayInstant(r.date_obs_elab);
    // The window is the days that were asked for: compared as UTC days, whatever instant the day stands for.
    const asked = Date.parse(`${r.date_obs_elab}T00:00:00Z`);
    if (ctx.backfill !== undefined && (asked < ctx.backfill.from || asked >= ctx.backfill.to)) {
      count(out, 'outside_backfill');
      continue;
    }
    if (isFuture(ts, ctx.fetchedAt)) {
      count(out, 'future');
      continue;
    }
    const value = scale(decl.to_canonical, r.resultat_obs_elab);
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
  out.unknown = unknownKeys.size;
  return { ...out, provider_values: rows.length, unknown_values: unknownValues };
}
