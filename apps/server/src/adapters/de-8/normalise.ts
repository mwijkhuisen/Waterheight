import { emptyNormalised, type Normalised, QC, type Registry, rangeBit, SchemaDrift, scale } from '@rws/core';
import type { Held, HydroRow, Station } from './parse.ts';

export { TIME } from './parse.ts';

// DE-8 → the gauge zeros of the DE-7 series (catalogue §2.3, §4.1, §4.2). Declared here:
//  - a DE-7 W series is `<station_no>/W` (adapters/de-7/normalise.ts `keyOf`; adapters never import each
//    other, so the key is spelt out here and a test holds the two together);
//  - `Nullpunkt` is the gauge zero (PNP) in m on DHHN2016, i.e. datum NHN: m NHN = PNP + W/100;
//  - the file gives no validity date (`Errichtung` is when the gauge was built), so `valid_from` is null:
//    the loader never overwrites a stored zero without a date with another value (load/store.ts), it
//    withholds the new one and alerts (the history of zeros is P7);
//  - a station the DE-7 registry does not have is unknown (its zero loads once the registry has it);
//  - a registered station listed twice gives no zero: both rows are withheld as `conflict` (counted, alerted, and
//    retained for a replay), never one of them by a guess (two zeros of one series would also break the zero's
//    range key and quarantine the whole payload).
// The station master (`de-8-stations`) stores nothing: it is registry input for scripts/gen-de7-stations.ts,
// and in the loader its daily payload only reports drift against the DE-7 registry (our keys, numbers).

export const SOURCE = 'DE-8';

export const keyOf = (station: string): string => `${station}/W`;

export type Context = { registry: Registry };

export function normaliseHydro(rows: readonly HydroRow[], ctx: Context): Normalised {
  const out = emptyNormalised();
  const unknown = new Set<string>();
  const listed = new Map<string, number>();
  for (const r of rows) listed.set(r.id, (listed.get(r.id) ?? 0) + 1);
  for (const r of rows) {
    const key = keyOf(r.id);
    if (!ctx.registry.has(key)) {
      unknown.add(key);
      continue;
    }
    if ((listed.get(r.id) as number) > 1) {
      out.dropped.conflict = (out.dropped.conflict ?? 0) + 1;
      continue;
    }
    if (r.zero === null) {
      out.dropped.zero_missing = (out.dropped.zero_missing ?? 0) + 1;
      continue;
    }
    out.gaugeZeros.push({ series: key, value_m: r.zero, datum: 'NHN', valid_from: null });
  }
  out.unknown = unknown.size;
  return out;
}

/** A registered DE-7 series (the loader passes its SeriesRow map). */
type Registered = { key: string; lon: number | null; lat: number | null };

export type Drift = {
  /** Station numbers of the master that the DE-7 registry does not have (placeholders aside). */
  unregistered: string[];
  /** Registered DE-7 series whose station the master no longer lists. */
  vanished: string[];
  /** Registered DE-7 series whose station the master places elsewhere (`"<lon>,<lat>"`). */
  changed: { key: string; field: 'position'; declared: string; published: string }[];
};

/** Degrees in lon or lat (about 7 and 11 m). */
const TOLERANCE = 1e-4;
const LIMIT = 200;
const PLACEHOLDERS: ReadonlySet<string> = new Set(['1234567', '123456', '1234512345']);
const position = (lon: number, lat: number) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

export function driftReport(registry: ReadonlyMap<string, Registered>, stations: readonly Station[]): Drift {
  const listed = new Map(stations.map((s) => [keyOf(s.no), s]));
  const drift: Drift = { unregistered: [], vanished: [], changed: [] };
  for (const s of stations) if (!registry.has(keyOf(s.no)) && !PLACEHOLDERS.has(s.no)) drift.unregistered.push(s.no);
  for (const r of registry.values()) {
    const s = listed.get(r.key);
    if (s === undefined) drift.vanished.push(r.key);
    else if (
      r.lon !== null &&
      r.lat !== null &&
      (Math.abs(r.lon - s.lon) > TOLERANCE || Math.abs(r.lat - s.lat) > TOLERANCE)
    ) {
      drift.changed.push({
        key: r.key,
        field: 'position',
        declared: position(r.lon, r.lat),
        published: position(s.lon, s.lat),
      });
    }
  }
  drift.unregistered = [...new Set(drift.unregistered)].sort().slice(0, LIMIT);
  drift.vanished = drift.vanished.sort().slice(0, LIMIT);
  drift.changed = drift.changed.sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, LIMIT);
  return drift;
}

// ---------------------------------------------------------------- P14b: the decade ZIPs of hydro/w (backfill)
//
// The history of the DE-7 W series of the tier-1 gauges (spec de-8-backfill-w, `obsTarget: 'DE-7'`; catalogue §2.3, A§7.4).
// Declared here, never inferred per row:
//  - the rows of a decade file are raw stamps (a 15-minute grid in the 2020s, change-driven ones in the 1950s), the
//    series is on its `native_step`, so a slice is a STEP-HOLD: for each grid point g (a multiple of the step from the
//    UTC epoch) in the slice's window, the value of the last row with ts <= g, if that row is not `NA` and g - ts is
//    at most MAX_HOLD_MS; never interpolated. The last row before the window seeds the first grid points (the file
//    is parsed whole, the window only cuts the grid), and a grid point before the file's first row stays empty (the
//    previous decade file is not read: a known gap);
//  - `NA` ends a hold and is never stored. A decade file of IBV carries an `NA` row at 1 January of each year before
//    the station's data starts: those years have no value;
//  - every row of this archive is verified data: qc VALIDATED (bit 2), no range bit;
//  - the stage is relative to the gauge zero of its time and `Nullpunkt` has no validity date, so an absolute height
//    of old history may be off (the gauge-zero history is P7, a known gap);
//  - the selection is the registry's: the DE-7 W series with `tier` 1. A raw row that never becomes a value is
//    counted in `raw_dropped` (rows, by code), a separate counter: `provider_values` is the grid points of the selected
//    stations present, so the ledger's identities (provider_values = kept + dropped) stay about grid points.

/**
 * How long a value holds. A change-driven logger writes a value only when it changes: the stamps of 1950-1959 have gaps
 * p50 88-115 min, p99 1,053-1,426 min and a few above a day (Rhedebrügge, Bilk), and the 2020s grid's largest gap
 * is 11 h (Stah). A value is valid until the next change, so PT2H (the live staleness) would cut flat periods that
 * are real into gaps: the bound is the measured heartbeat, at most PT24H.
 */
export const MAX_HOLD_MS = 24 * 3_600_000;
/** No grid point before this (the spec's floor; nothing older is published). */
export const BACKFILL_FLOOR_MS = Date.UTC(1950, 0, 1);

/** The rows of the selected stations present in a file (by station number) and the row count of every other member. */
export type BackfillRows = {
  rows: ReadonlyMap<string, Held>;
  counted: ReadonlyMap<string, number>;
};
export type BackfillContext = { registry: Registry; window: { from: number; to: number } };

/** `Backfilled` of load/adapters.ts, which an adapter may not import. */
export type BackfillResult = Normalised & {
  provider_values: number;
  unknown_values: number;
  raw_dropped: Record<string, number>;
};

const bump = (to: Record<string, number>, code: string, n: number) => {
  if (n > 0) to[code] = (to[code] ?? 0) + n;
};

/** Index of the last row with ts <= g, or -1. */
function lastAtOrBefore(ts: readonly number[], g: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((ts[mid] as number) <= g) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function normaliseBackfill(input: BackfillRows, ctx: BackfillContext): BackfillResult {
  const out: BackfillResult = { ...emptyNormalised(), provider_values: 0, unknown_values: 0, raw_dropped: {} };
  const from = Math.max(ctx.window.from, BACKFILL_FLOOR_MS);
  const stations = [...new Set([...input.rows.keys(), ...input.counted.keys()])].sort();
  for (const no of stations) {
    const held = input.rows.get(no);
    const n = held?.ts.length ?? input.counted.get(no) ?? 0;
    if (PLACEHOLDERS.has(no)) {
      bump(out.raw_dropped, 'placeholder', n);
      continue;
    }
    // The WSV gauges of NRW's own files (site suffix 102) are DE-1's, never DE-7's (catalogue §2.3).
    if (no.endsWith('102')) {
      bump(out.raw_dropped, 'wsv_duplicate', n);
      continue;
    }
    const decl = ctx.registry.get(keyOf(no));
    if (decl === undefined) {
      bump(out.raw_dropped, 'unregistered', n);
      continue;
    }
    if (decl.tier !== 1) {
      bump(out.raw_dropped, 'unselected', n);
      continue;
    }
    // A selected station is parsed by the loader; a count alone would be a wiring fault, never a silent empty slice.
    if (held === undefined) throw new SchemaDrift('not_parsed');
    const step = decl.native_step_ms;
    const first = Math.ceil(from / step);
    const end = Math.ceil(ctx.window.to / step);
    let j = -1;
    for (let k = first; k < end; k += 1) {
      const g = k * step;
      if (k === first) j = lastAtOrBefore(held.ts, g);
      else while (j + 1 < held.ts.length && (held.ts[j + 1] as number) <= g) j += 1;
      out.provider_values += 1;
      const v = j < 0 ? Number.NaN : (held.value[j] as number);
      if (Number.isNaN(v) || g - (held.ts[j] as number) > MAX_HOLD_MS) {
        bump(out.dropped, 'no_value', 1);
        continue;
      }
      const value = scale(decl.to_canonical, v);
      // The live DE-7 rows' range check too (review C2): a glitch keeps its RANGE bit, whatever the archive says.
      out.obs.push({
        series: decl.key,
        ts: new Date(g).toISOString(),
        value,
        qc: QC.VALIDATED | rangeBit(decl.value_kind ?? 'stage', value),
      });
    }
  }
  return out;
}
