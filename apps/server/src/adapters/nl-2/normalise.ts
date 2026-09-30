import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  SchemaDrift,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Collection } from './parse.ts';

// NL-2 RWS WFS snapshot → discovery (catalogue §2.1 "WFS", §4.4). NL-2 stores
// no observation, ever: the layer can show a stale value under a fresh
// timestamp (driel.boven Q, pitfall 2), so REST (NL-1) is the one source of
// values. The snapshot says which series RWS publishes live and where their
// stations are: `discover` lists them, drift.ts compares them with the NL-1
// registry. Declared here, never inferred per row:
//  - series: `<CODE>/<GROOTHEIDCODE>/<HOEDANIGHEIDCODE>/<WAARDEBEPALINGSMETHODECODE>`,
//    all four verbatim: the NL-1 registry's provider_key;
//  - quantities WATHTE in NAP and Q in NVT; another quantity or datum (TAW,
//    MSL: duplicates of a NAP series) is dropped and counted;
//  - time: TIME below; an instant more than 15 minutes after the collection's
//    `timeStamp` is dropped (invariant 4);
//  - position: GeoJSON `[lon, lat]` in EPSG:4258 (the schema refuses any other CRS);
//  - a key listed twice (RWS repeats some features under another id) is one
//    series, at its newest instant.

export const SOURCE = 'NL-2';

/**
 * `TIJDSTIP_LAATSTE_METING` is Europe/Amsterdam wall-clock time labelled Z
 * (pitfall 1); the collection's `timeStamp` is true UTC. A wall-clock time in
 * the spring-forward gap does not exist, so no value was measured at it: the
 * feature is dropped (`dst_gap`), it is not drift. In the repeated fall-back
 * hour a feature is at the latest occurrence that is not after `timeStamp`,
 * because a value cannot be newer than the snapshot that lists it: `later` is
 * tried first, and the earlier occurrence is taken when the later one is after
 * `timeStamp` (then the future rule judges it).
 */
export const TIME: TimeConvention = {
  kind: 'local-labelled-z',
  zone: 'Europe/Amsterdam',
  dst: { gap: 'reject', overlap: 'later' },
};
const EARLIER: TimeConvention = {
  kind: 'local-labelled-z',
  zone: 'Europe/Amsterdam',
  dst: { gap: 'reject', overlap: 'earlier' },
};
const UTC: TimeConvention = { kind: 'iso-offset' };

// A Map, not an object: a provider string such as `constructor` must not find an inherited property.
/** GROOTHEIDCODE → the one HOEDANIGHEIDCODE we keep. */
const DATUM: ReadonlyMap<string, string> = new Map([
  ['WATHTE', 'NAP'],
  ['Q', 'NVT'],
]);

/** A series RWS publishes live: our key, its latest instant (UTC) and its station's position. */
export type Discovered = { key: string; ts: string; lon: number; lat: number };

const drift = (err: unknown, path: string) =>
  err instanceof TimeError ? new SchemaDrift(`time_${err.code}`, path) : err;

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

/** Every live WATHTE (NAP) and Q series of a snapshot, sorted by key, and what was dropped. */
export function discover(collection: Collection): { series: Discovered[]; dropped: Record<string, number> } {
  let stamp: number;
  try {
    stamp = parseInstant(UTC, collection.timeStamp);
  } catch (err) {
    throw drift(err, 'timeStamp');
  }
  const dropped: Record<string, number> = {};
  const count = (code: string) => {
    dropped[code] = (dropped[code] ?? 0) + 1;
  };
  const found = new Map<string, { ms: number; lon: number; lat: number }>();
  for (const [i, { properties: p, geometry }] of collection.features.entries()) {
    const datum = DATUM.get(p.GROOTHEIDCODE);
    if (datum === undefined) {
      count('quantity');
      continue;
    }
    if (p.HOEDANIGHEIDCODE !== datum) {
      count('datum');
      continue;
    }
    const ms = instant(p.TIJDSTIP_LAATSTE_METING, stamp, `features.${i}.properties.TIJDSTIP_LAATSTE_METING`);
    if (ms === null) {
      count('dst_gap');
      continue;
    }
    if (isFuture(ms, stamp)) {
      count('future');
      continue;
    }
    const key = `${p.CODE}/${p.GROOTHEIDCODE}/${p.HOEDANIGHEIDCODE}/${p.WAARDEBEPALINGSMETHODECODE}`;
    const before = found.get(key);
    if (before !== undefined) {
      count('duplicate');
      if (before.ms >= ms) continue;
    }
    const [lon, lat] = geometry.coordinates;
    found.set(key, { ms, lon, lat });
  }
  const series = [...found]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, s]) => ({ key, ts: toIso(s.ms), lon: s.lon, lat: s.lat }));
  return { series, dropped };
}

/**
 * The loader's view of a snapshot: no observation and no gauge zero, ever
 * (REST wins, pitfall 2), only the counts of what discovery dropped. The
 * payload is still parsed and read in full, so a changed layer is quarantined
 * like any other drift; the drift report (drift.ts) is the snapshot's use.
 */
export function normalise(collection: Collection): Normalised {
  return { ...emptyNormalised(), dropped: discover(collection).dropped };
}
