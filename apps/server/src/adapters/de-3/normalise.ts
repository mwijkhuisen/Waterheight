import {
  emptyNormalised,
  FORECAST_FLAGS,
  FORECAST_SOURCES,
  type ForecastPoint,
  type ForecastRunIn,
  type Normalised,
  parseInstant,
  SchemaDrift,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import { LEVELS, type Table } from './parse.ts';

// DE-3 BfG 14-day probabilistic forecast → one quantile run per gauge and capture (catalogue §2.2, A§6, A§7.4
// item 9). Declared here, never inferred per row:
//  - time: a row's label is a naive `dd.mm.yyyy hh:mm` that BfG states in CET all year (`GMT+1`, checked by parse) and
//    that labels the START of its interval (`!!!! Zeitstempel Beginn des Zeitschritts !!!!`), so a fixed +01:00 offset
//    (`start-of-interval`), no zone and no DST rule: the label 23.09.2026 00:00 is 2026-09-22T23:00:00Z, the day
//    that starts there. Rows are daily means (`stepMs` one day, FORECAST_SOURCES['DE-3']); the days stay one UTC day
//    apart across the DST changes of 2026-10-25 and 2027-03-28 (the DST proof fixtures). The future-time rule of
//    invariant 4 is for observations: a forecast's valid times are ahead by design; the loader bounds them by the
//    source's 15-day horizon;
//  - columns: BfG publishes 13 percentiles (5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95 %). The run keeps the
//    seven the forecast schema has a column for, 5 → p05, 10 → p10, 25 → p25, 50 → p50, 75 → p75, 90 → p90, 95 → p95,
//    and `value` holds p50; the six others (20, 30, 40, 60, 70, 80 %) are dropped, never relabelled (p30 and p70 are
//    LU-3's). Percentiles that cross (p05 ≤ … ≤ p95 broken) are flagged ORDER by the loader (core checkRun), and the
//    values are never reordered here;
//  - unit: whole centimetres of stage, as published (negative levels occur), the forecast source's own declaration
//    (FORECAST_SOURCES['DE-3'].units.cm), never read from the DE-1 series' row;
//  - `---` is BfG's "not published" for a level above the station's publication limit, and is no 0: that column is
//    null and the point carries FORECAST_FLAGS.CENSORED, a point that has a `---` in a column that is kept (a
//    `---` in a dropped column leaves no trace). A row of only `---` is kept, as a point with every column null and
//    CENSORED (core checkRun keeps a censored all-null point, and drops any other as a `gap`);
//  - series: the capture manifest variant is the file's path `14-Tage-Vorhersage/<Station>_Quantile_<number>.csv`;
//    the PEGELONLINE number names the DE-1 station `de.wsv.<number>`, and `keyOf` (the loader wiring, from the DE-1
//    registry) gives that station's stage series, `<uuid>/W`. A number DE-1 does not have is counted (`unknown`),
//    never guessed. Only the 14-day files are read: a `6-Wochen-Vorhersage/` variant (QuansBox, Pie: another
//    structure) is not parsed and not drift (`SIX_WEEK`, the wiring skips it; its raw payload stays in the archive);
//    any other variant is drift (`bad_variant`, the variant is ours, never provider text);
//  - no issue time: the header's date has no time of day and no time zone beyond the offset. The run states no
//    `issuedAt` (`providerSegmentEnd` none: BfG states no forecast/estimate split), so the loader infers it from the
//    fetch (`issued_inferred`) and keys the run by (series, first valid time, content hash); a re-capture of the
//    same file is a confirmation.

export const SOURCE = 'DE-3';
export const TIME: TimeConvention = { kind: 'start-of-interval', offset: '+01:00' };

const DECL = FORECAST_SOURCES['DE-3'];
const [, TO_CM] = DECL.units.cm;

/** The forecast column of each percentile that is kept, with its place in `Row.cells`. */
const KEPT = (
  [
    ['p05', 5],
    ['p10', 10],
    ['p25', 25],
    ['p50', 50],
    ['p75', 75],
    ['p90', 90],
    ['p95', 95],
  ] as const
).map(([column, level]) => [column, LEVELS.indexOf(level)] as const);

const FOURTEEN_DAY = /^14-Tage-Vorhersage\/[A-Za-z]{1,40}(?:-[A-Za-z]{1,40}){0,3}_Quantile_(\d{6,9})\.csv$/;
const SIX_WEEK = /^6-Wochen-Vorhersage\/[A-Za-z0-9_-]{1,100}\.csv$/;

/** Whether a manifest variant is a 6-week file (not parsed, not drift); drift (`bad_variant`) when it is neither kind. */
export function isSixWeek(variant: string): boolean {
  if (SIX_WEEK.test(variant)) return true;
  if (!FOURTEEN_DAY.test(variant)) throw new SchemaDrift('bad_variant');
  return false;
}

export type Context = {
  /** The manifest line's variant: the file's path. */
  variant: string;
  /** The DE-1 provider_key of the stage series of the station with this PEGELONLINE number, none when it has no such series. */
  keyOf: (number: string) => string | undefined;
};

const count = (dropped: Record<string, number>, code: string) => {
  dropped[code] = (dropped[code] ?? 0) + 1;
};

/** The PEGELONLINE number of a 14-day file's variant; drift (`bad_variant`) for anything else. */
export function numberOf(variant: string): string {
  const m = FOURTEEN_DAY.exec(variant);
  if (m === null) throw new SchemaDrift('bad_variant');
  return m[1] as string;
}

export function normalise(table: Table, ctx: Context): Normalised {
  const out = emptyNormalised();
  const number = numberOf(ctx.variant);
  const points: ForecastPoint[] = [];
  for (const [i, row] of table.rows.entries()) {
    let ms: number;
    try {
      ms = parseInstant(TIME, row.label);
    } catch (err) {
      if (!(err instanceof TimeError)) throw err;
      throw new SchemaDrift(`time_${err.code}`, `rows.${i}`);
    }
    const point: ForecastPoint = { ts: toIso(ms), flags: 0 };
    for (const [column, at] of KEPT) {
      const v = row.cells[at] ?? null;
      point[column] = v === null ? null : v * TO_CM;
      if (v === null) point.flags = FORECAST_FLAGS.CENSORED;
    }
    point.value = point.p50 ?? null;
    points.push(point);
  }
  if (points.length === 0) {
    count(out.dropped, 'empty_run');
    return out;
  }
  const series = ctx.keyOf(number);
  if (series === undefined) {
    out.unknown = 1;
    return out;
  }
  const run: ForecastRunIn = {
    target: 'DE-1',
    series,
    kind: DECL.kind,
    stepMs: DECL.stepMs,
    issuedAt: null,
    providerSegmentEnd: null,
    points,
  };
  out.forecasts = [run];
  return out;
}
