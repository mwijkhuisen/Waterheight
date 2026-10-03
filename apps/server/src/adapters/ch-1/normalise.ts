import {
  emptyNormalised,
  isFuture,
  levelOf,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  type SeriesDecl,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Observation } from './parse.ts';

// CH-1 BAFU LINDAS → canonical rows (catalogue §2.7, §4.1, §4.4, §4.5).
// Declared here, never inferred per row:
//  - series: `<id>/W` and `<id>/Q`;
//  - time: ISO 8601 at a fixed +01:00 all year (any other offset is drift);
//    every value carries its own time, so a stale station (2269, 2283, 2356)
//    re-states an old value, which is judged by its age, not the cube's;
//  - a station that comes twice keeps its latest observation (the cube holds
//    an older one beside it: 520, 2283); two different values at the same
//    latest time are withheld (`conflict`);
//  - unit and factor from the registry row: W in m (×100), Q in m³/s (×1);
//    W is a level in m ü. M. on LN02, except the few relative gauges, which the
//    registry declares as stage on LOCAL. A value that contradicts its
//    station's declaration (a level below 150 m, a stage at 150 m or more) is
//    withheld as `datum_mismatch`: the declaration is never changed per row;
//  - sentinel: an exact 0 at a level series is BAFU's "no value" (2602
//    Domat/Ems froze at W = 0.0 on 2026-10-01), dropped as `sentinel` before
//    that guard; a relative gauge's 0 is a reading;
//  - qc "raw" (BAFU: raw, unverified data); the temperature is not stored;
//  - the danger level is a provider class of the station (P7a): code '1'..'5' or
//    'undefined' (the cube's Undefined IRI, parsed to null), level from the
//    crosswalk, stored per station of the registered series (W or Q).

export const SOURCE = 'CH-1';
export const TIME: TimeConvention = { kind: 'fixed-offset', offset: '+01:00' };

/** LINDAS holds no history; an older value belongs to a dead station (2269 since 2025-05-28). */
const MAX_AGE_MS = 45 * 86_400_000;

/** No Swiss water level is below 150 m ü. M. (Lago Maggiore: 193 m); no relative gauge reads 150 m. */
const LEVEL_FLOOR_M = 150;

export type Context = { registry: Registry; fetchedAt: number };

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

function row(decl: SeriesDecl | undefined, ts: number, raw: number | null, ctx: Context, out: Normalised): void {
  if (raw === null) return;
  if (decl === undefined) {
    out.unknown += 1;
    return;
  }
  if (decl.quantity === 'H' && decl.value_kind !== 'stage' && raw === 0) {
    count(out, 'sentinel');
    return;
  }
  if (decl.quantity === 'H' && (decl.value_kind === 'stage') !== raw < LEVEL_FLOOR_M) {
    count(out, 'datum_mismatch');
    return;
  }
  if (isFuture(ts, ctx.fetchedAt)) {
    count(out, 'future');
    return;
  }
  if (ts < ctx.fetchedAt - MAX_AGE_MS) {
    count(out, 'too_old');
    return;
  }
  const value = scale(decl.to_canonical, raw);
  const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'level');
  out.obs.push({ series: decl.key, ts: toIso(ts), value, qc: QC.RAW | rangeBit(kind, value) });
}

export function normaliseCube(observations: readonly Observation[], ctx: Context): Normalised {
  const out = emptyNormalised();
  out.classes = [];
  const latest = new Map<string, { ts: number; o: Observation | null }>();
  for (const o of observations) {
    const ts = instant(o.time);
    const before = latest.get(o.id);
    if (before === undefined || ts > before.ts) {
      if (before !== undefined) count(out, 'superseded');
      latest.set(o.id, { ts, o });
    } else if (ts < before.ts) count(out, 'superseded');
    else if (before.o !== null && before.o.q === o.q && before.o.w === o.w) count(out, 'duplicate');
    else {
      count(out, 'conflict', before.o === null ? 1 : 2);
      latest.set(o.id, { ts, o: null });
    }
  }
  for (const id of [...latest.keys()].sort()) {
    const { ts, o } = latest.get(id) as { ts: number; o: Observation | null };
    if (o === null) continue;
    row(ctx.registry.get(`${id}/W`), ts, o.w, ctx, out);
    row(ctx.registry.get(`${id}/Q`), ts, o.q, ctx, out);
    const station = (ctx.registry.get(`${id}/W`) ?? ctx.registry.get(`${id}/Q`))?.station;
    if (station !== undefined && !isFuture(ts, ctx.fetchedAt) && ts >= ctx.fetchedAt - MAX_AGE_MS) {
      const code = o.dangerLevel === null ? 'undefined' : String(o.dangerLevel);
      const level = levelOf(SOURCE, 'danger', code);
      // A code the crosswalk lacks is never stored as "no class" (review CR-6).
      if (level === undefined) count(out, 'unmapped_class');
      else out.classes.push({ station, ts: toIso(ts), code, label: null, level });
    }
  }
  if (out.classes?.length === 0) delete out.classes;
  return out;
}
