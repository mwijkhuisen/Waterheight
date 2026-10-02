import {
  emptyNormalised,
  isFuture,
  type Normalised,
  type ObsRow,
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
import type { Readings } from './parse.ts';

// DE-7 LANUK NRW → canonical rows (catalogue §2.3, §4.2, §4.4, §4.5). Declared here, never inferred per row:
//  - series: `<station_no>/W` (W only: NRW publishes no real-time Q); unit and factor from the registry
//    (cm above the gauge zero, ×1, value_kind stage);
//  - time: ISO 8601 at a fixed +01:00 (MEZ) all year; any other offset is drift;
//  - the placeholder station numbers 1234567, 123456 and 1234512345 (two Soestbach gauges merged into one
//    block) belong to no gauge: dropped as `placeholder`;
//  - WSV gauges (site_no 102) never load: messwerte.txt carries no site_no, so only registered series load
//    and the registry generator refuses any number that DE-1 registers (scripts/gen-de7-stations.ts);
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
