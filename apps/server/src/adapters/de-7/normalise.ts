import {
  emptyNormalised,
  isFuture,
  type Normalised,
  type ObsRow,
  parseInstant,
  QC,
  type ReferenceRow,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Readings, StationThresholds } from './parse.ts';

// DE-7 LANUK NRW → canonical rows (catalogue §2.3, §4.2, §4.4, §4.5). Declared here, never inferred per row:
//  - series: `<station_no>/W` (W only: NRW publishes no real-time Q); unit and factor from the registry
//    (cm above the gauge zero, ×1, value_kind stage);
//  - time: ISO 8601 at a fixed +01:00 (MEZ) all year; any other offset is drift;
//  - the placeholder station numbers 1234567, 123456 and 1234512345 (two Soestbach gauges merged into one
//    block) belong to no gauge: dropped as `placeholder`;
//  - WSV gauges (site_no 102) never load: messwerte.txt carries no site_no, so only registered series load,
//    and the registry generator refuses a station with a DE-1 number, within 300 m of a DE-1 station or with
//    its name on H (scripts/gen-de7-stations.ts; test/registry-precedence.test.ts holds the 300 m);
//  - `NA` is the provider's gap (`sentinel`); a point twice with the same value is one, with two values
//    both are withheld (`conflict`);
//  - qc raw (unvalidated raw data, LANUK); our range bit for an implausible stage, the value is kept;
//  - window: rows older than `since` (the loader's window, from the previous loaded payload of the spec) are
//    `outside_window`, rows older than 45 days `too_old`, rows more than 15 minutes ahead `future`.
// The result is chunked (obsChunks): a seed has about two million rows.

export const SOURCE = 'DE-7';
export const TIME: TimeConvention = { kind: 'fixed-offset', offset: '+01:00' };

/** Station numbers that name no gauge (catalogue §2.3). */
export const PLACEHOLDERS: ReadonlySet<string> = new Set(['1234567', '123456', '1234512345']);

const MAX_AGE_MS = 45 * 86_400_000;

/** Rows per upsert: a seed is cut into chunks of whole series of at most this many rows (one series is ≤ 17,280). */
export const CHUNK = 50_000;

export const keyOf = (station: string): string => `${station}/W`;

export type Context = { registry: Registry; fetchedAt: number; since?: number };

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

/** One series' kept points, in time order. */
type Kept = { key: string; ts: number[]; value: number[]; qc: number[] };

export function normalise(r: Readings, ctx: Context): Normalised {
  const out = emptyNormalised();
  const ms = r.times.map(instant);
  // Row indices per station, in file order.
  const rows: number[][] = r.stations.map(() => []);
  for (let i = 0; i < r.station.length; i += 1) (rows[r.station[i] as number] as number[]).push(i);

  const kept: Kept[] = [];
  const unknown = new Set<string>();
  r.stations.forEach((no, s) => {
    const idx = rows[s] as number[];
    if (PLACEHOLDERS.has(no)) {
      count(out, 'placeholder', idx.length);
      return;
    }
    const key = keyOf(no);
    const decl = ctx.registry.get(key);
    if (decl === undefined) {
      unknown.add(key);
      return;
    }
    const at = new Map<number, number>();
    const clash = new Set<number>();
    for (const i of idx) {
      const v = r.value[i] as number;
      const ts = ms[r.time[i] as number] as number;
      if (Number.isNaN(v)) {
        count(out, 'sentinel');
        continue;
      }
      if (isFuture(ts, ctx.fetchedAt)) {
        count(out, 'future');
        continue;
      }
      if (ts < ctx.fetchedAt - MAX_AGE_MS) {
        count(out, 'too_old');
        continue;
      }
      if (ctx.since !== undefined && ts < ctx.since) {
        count(out, 'outside_window');
        continue;
      }
      const seen = at.get(ts);
      if (seen === undefined) at.set(ts, v);
      else if (seen !== v) clash.add(ts);
      else count(out, 'duplicate');
    }
    // Two values for one point: neither is stored (both counted, as CH-1 does).
    for (const ts of clash) at.delete(ts);
    if (clash.size > 0) count(out, 'conflict', 2 * clash.size);
    const points = [...at].sort((a, b) => a[0] - b[0]);
    const series: Kept = { key, ts: [], value: [], qc: [] };
    for (const [ts, raw] of points) {
      const value = scale(decl.to_canonical, raw);
      series.ts.push(ts);
      series.value.push(value);
      series.qc.push(QC.RAW | rangeBit('stage', value));
    }
    if (series.ts.length > 0) kept.push(series);
  });
  out.unknown = unknown.size;

  // Chunks of whole series, materialised only when the loader asks for them.
  const groups: Kept[][] = [];
  let size = CHUNK;
  for (const s of kept) {
    if (size + s.ts.length > CHUNK) {
      groups.push([]);
      size = 0;
    }
    (groups.at(-1) as Kept[]).push(s);
    size += s.ts.length;
  }
  out.obsChunks = function* () {
    for (const group of groups) {
      const chunk: ObsRow[] = [];
      for (const s of group) {
        for (let i = 0; i < s.ts.length; i += 1) {
          chunk.push({
            series: s.key,
            ts: toIso(s.ts[i] as number),
            value: s.value[i] as number,
            qc: s.qc[i] as number,
          });
        }
      }
      yield chunk;
    }
  };
  return out;
}

const THRESHOLDS: readonly [(t: StationThresholds) => number, string, ReferenceRow['semantics'], string][] = [
  [(t) => t.mnw, 'LANUV_MNW', 'statistical', 'LANUK MNW'],
  [(t) => t.mw, 'LANUV_MW', 'statistical', 'LANUK MW'],
  [(t) => t.mhw, 'LANUV_MHW', 'statistical', 'LANUK MHW'],
  [(t) => t.info[0], 'LANUV_INFO_1', 'operational', 'LANUK Informationsstufe 1'],
  [(t) => t.info[1], 'LANUV_INFO_2', 'operational', 'LANUK Informationsstufe 2'],
  [(t) => t.info[2], 'LANUV_INFO_3', 'operational', 'LANUK Informationsstufe 3'],
];

/**
 * `pegel_stationen.txt` → reference rows (P7a): the LANUK thresholds (cm above the gauge zero) of every registered
 * station; an empty cell is no row. Every registered station of the file is in `refScope`, so a threshold LANUK
 * withdraws is closed. A station the registry lacks is `unknown`, a placeholder number `placeholder`, a number
 * listed twice `conflict` (its rows are withheld).
 */
export function normaliseThresholds(rows: readonly StationThresholds[], ctx: Pick<Context, 'registry'>): Normalised {
  const out = emptyNormalised();
  out.references = [];
  out.refScope = [];
  const seen = new Set<string>();
  const clash = new Set<string>();
  for (const t of rows) (seen.has(t.station) ? clash : seen).add(t.station);
  const unknown = new Set<string>();
  for (const t of rows) {
    if (PLACEHOLDERS.has(t.station)) {
      count(out, 'placeholder');
      continue;
    }
    if (clash.has(t.station)) {
      count(out, 'conflict');
      continue;
    }
    const decl = ctx.registry.get(keyOf(t.station));
    if (decl === undefined) {
      unknown.add(t.station);
      continue;
    }
    out.refScope.push({ series: decl.key });
    for (const [pick, kind, semantics, label] of THRESHOLDS) {
      const raw = pick(t);
      if (Number.isNaN(raw)) continue;
      out.references.push({
        series: decl.key,
        kind,
        value: scale(decl.to_canonical, raw),
        unit: 'cm',
        semantics,
        convention: null,
        period: null,
        season_from_md: 101,
        season_to_md: 1231,
        priority: 0,
        basis_label: label,
        valid_from: null,
      });
    }
  }
  out.unknown = unknown.size;
  return out;
}
