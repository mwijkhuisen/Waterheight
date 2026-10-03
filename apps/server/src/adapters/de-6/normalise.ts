import {
  type ClassRow,
  emptyNormalised,
  isFuture,
  levelOf,
  type Normalised,
  parseInstant,
  SchemaDrift,
  type TimeConvention,
  TimeError,
  toIso,
  type WarningRow,
} from '@rws/core';
import type { Alerts, StationFeature, Stations } from './parse.ts';

// DE-6 LHP → station classes and regional alerts (catalogue §2.3, §4.9). DE-6 states no value, only a flood class
// per gauge (`lhpClass` -1…4) and, on a separate scale, regional alerts. Declared here, never inferred per row:
//  - classes: only features of the registry table (registry/classes/de-6.yaml, handed in by the loader: our
//    stations and the LHP features that are them); another feature is counted `not_registered`, not unknown;
//  - duplicates (catalogue §4.9): several features of one station form a group; its class is the operating
//    state's, else the WORST (highest) class 0…4 of the others, with the state as provenance in the code
//    (`RP:0`, `SL:0`); the operator's own -1 / none only when no other state has a class;
//  - code `<STATE>:<class>`, class `-1`…`4` or `none` (key absent or null: "Ohne Hochwasser-Einstufung", not an
//    error); level from the crosswalk (scale `station`), never from the alert scale;
//  - time: TIME below for a feature's `timestamp`; `updated` (true UTC, fixed +01:00) for a feature without one.
//    The class is stamped with the instant of the reading the state classified, not with `updated` (review CR-1):
//    it lines up with that station's values, a stale gauge does not look current, and the loader lets a newer
//    payload's class replace an older one's at the same instant (newest fetch wins), so a state that re-classifies
//    without a new reading still lands; the replaced class stays in the archive (DE-6 is kept forever);
//  - a feature id twice is a `conflict` (each copy counted, RETAINED): which copy is meant is unknown, so neither
//    is read, and a station with such a feature takes no class from that payload; an alert area twice likewise;
//  - alerts: every area of the payload is a snapshot at `updated` (scale `alert`: "1", "2", "4", "5", "6"); an area
//    whose row is withheld (`conflict`, `unmapped_class`) is `kept`, so its stored range stays as it is.

export const SOURCE = 'DE-6';

/**
 * A feature `timestamp` is Europe/Berlin wall-clock time without an offset (catalogue §2.3: Sannerz 16:30 in LHP,
 * 15:30+01:00 in HLNUG). A wall-clock time in the spring-forward gap does not exist, so the feature is dropped
 * (`dst_gap`), it is not drift. In the repeated fall-back hour a feature is at the latest occurrence that is not
 * after the collection's `updated`, because a state cannot be newer than the answer that lists it: `later` is
 * tried first, and the earlier occurrence is taken when the later one is after `updated` (then the future rule
 * judges it).
 */
export const TIME: TimeConvention = {
  kind: 'naive-local',
  zone: 'Europe/Berlin',
  dst: { gap: 'reject', overlap: 'later' },
};
const EARLIER: TimeConvention = {
  kind: 'naive-local',
  zone: 'Europe/Berlin',
  dst: { gap: 'reject', overlap: 'earlier' },
};
const UTC: TimeConvention = { kind: 'iso-offset' };

/** The shape of registry/classes/de-6.yaml that this adapter reads (an adapter imports no contract package). */
export type LhpTable = {
  stations: readonly { lhp: string; station: string; state: string; operator: boolean }[];
};

const drift = (err: unknown, path: string) =>
  err instanceof TimeError ? new SchemaDrift(`time_${err.code}`, path) : err;

/** `updated` as UTC ms. */
function updatedOf(raw: string): number {
  try {
    return parseInstant(UTC, raw);
  } catch (err) {
    throw drift(err, 'updated');
  }
}

/** A feature's instant (UTC ms), or null for a wall-clock time that does not exist. */
function instant(raw: string, notAfter: number, path: string): number | null {
  try {
    const later = parseInstant(TIME, raw);
    // Outside the repeated hour both readings are the same instant.
    return later <= notAfter ? later : parseInstant(EARLIER, raw);
  } catch (err) {
    if (err instanceof TimeError && err.code === 'dst_gap') return null;
    throw drift(err, path);
  }
}

const counter = (dropped: Record<string, number>) => (code: string) => {
  dropped[code] = (dropped[code] ?? 0) + 1;
};

/** The class of a feature as the crosswalk's code: `-1`…`4`, or `none` for a key that is absent or null. */
const codeOf = (f: StationFeature) => (f.properties.lhpClass == null ? 'none' : String(f.properties.lhpClass));
/** The class as a number for comparing; -1 (no data) and none rank below every stated class. */
const rank = (f: StationFeature) => f.properties.lhpClass ?? -1;
/** A class that states a flood situation (0…4), as opposed to -1 (no data) and none. */
const stated = (f: StationFeature) => {
  const c = f.properties.lhpClass;
  return c != null && c >= 0 && c <= 4;
};

/**
 * The station classes of one `/data/stations` answer: one row per table station that the answer lists, at the
 * feature's own instant (see TIME). `fetchedAt` (UTC ms) is the reference of the future rule.
 */
export function normaliseStations(doc: Stations, table: LhpTable, fetchedAt: number): Normalised {
  const dropped: Record<string, number> = {};
  const count = counter(dropped);
  const updated = updatedOf(doc.updated);
  const entries = new Map(table.stations.map((e) => [e.lhp, e]));
  const copies = new Map<string, number>();
  for (const f of doc.features) copies.set(f.id, (copies.get(f.id) ?? 0) + 1);
  const twice = (id: string) => (copies.get(id) ?? 0) > 1;
  const seen = new Map<string, StationFeature>();
  for (const f of doc.features) {
    if (!entries.has(f.id)) count('not_registered');
    else if (twice(f.id)) count('conflict');
    else seen.set(f.id, f);
  }
  // The table's order is the output's order: one group per station, its members in the table's order; a station
  // with a feature in conflict is withheld (null).
  const groups = new Map<string, { feature: StationFeature; state: string; operator: boolean }[] | null>();
  for (const e of table.stations) {
    if (twice(e.lhp)) groups.set(e.station, null);
    const feature = seen.get(e.lhp);
    const group = groups.get(e.station);
    if (feature === undefined || group === null) continue;
    groups.set(e.station, [...(group ?? []), { feature, state: e.state, operator: e.operator }]);
  }
  const classes: ClassRow[] = [];
  for (const [station, group] of groups) {
    if (group === null) continue;
    // The operating state's own feature, else (it is not in this answer) the first one.
    const base = group.find((g) => g.operator) ?? (group[0] as (typeof group)[number]);
    let chosen = base;
    if (!stated(base.feature)) {
      // The worst class 0…4 of the others; the first of equals, in the table's order.
      for (const g of group) if (stated(g.feature) && rank(g.feature) > rank(chosen.feature)) chosen = g;
    }
    const f = chosen.feature;
    const raw = codeOf(f);
    const level = levelOf(SOURCE, 'station', raw);
    if (level === undefined) {
      count('unmapped_class');
      continue;
    }
    const ms =
      f.properties.timestamp === undefined
        ? updated
        : instant(f.properties.timestamp, updated, `features.${f.id}.properties.timestamp`);
    if (ms === null) {
      count('dst_gap');
      continue;
    }
    if (isFuture(ms, fetchedAt)) {
      count('future');
      continue;
    }
    classes.push({
      station,
      ts: toIso(ms),
      code: `${chosen.state}:${raw}`,
      label: f.properties.stateClassName ?? null,
      level,
    });
  }
  return { ...emptyNormalised(), dropped, classes };
}

/**
 * The alerts of one `/data/alerts` answer: a snapshot at `updated` that states every alerted area (an empty one
 * closes them all). An area is its feature id; the alert carries no time of its own (catalogue §0.4), so its
 * validity starts at `updated` and has no end. A class the alert scale does not know ("3" has no meaning) is
 * dropped `unmapped_class` (alerted, kept for a replay); a feature id twice is `conflict` (neither copy stands).
 * Either way the area is `kept`: the payload lists it, so its stored range is not closed.
 * A snapshot more than 15 minutes ahead of the fetch states nothing (`future`).
 */
export function normaliseAlerts(doc: Alerts, fetchedAt: number): Normalised {
  const dropped: Record<string, number> = {};
  const count = counter(dropped);
  const updated = updatedOf(doc.updated);
  if (isFuture(updated, fetchedAt)) {
    dropped.future = Math.max(1, doc.features.length);
    return { ...emptyNormalised(), dropped };
  }
  const at = toIso(updated);
  const copies = new Map<string, number>();
  for (const f of doc.features) copies.set(f.id, (copies.get(f.id) ?? 0) + 1);
  const rows: WarningRow[] = [];
  const kept = new Set<string>();
  for (const f of doc.features) {
    if ((copies.get(f.id) ?? 0) > 1) {
      count('conflict');
      kept.add(f.id);
      continue;
    }
    const level = levelOf(SOURCE, 'alert', f.properties.lhpClass);
    if (level === undefined) {
      count('unmapped_class');
      kept.add(f.id);
      continue;
    }
    rows.push({
      area_key: f.id,
      name: f.properties.areaDesc,
      geometry: JSON.stringify(f.geometry),
      level,
      level_raw: f.properties.lhpClass,
      label_raw: f.properties.lhpClassName,
      texts: { de: { headline: f.properties.alertHeadline } },
      valid_from: at,
      valid_to: null,
      issued_at: null,
    });
  }
  return {
    ...emptyNormalised(),
    dropped,
    warnings: { mode: 'snapshot', at, rows, ...(kept.size > 0 ? { kept: [...kept] } : {}) },
  };
}
