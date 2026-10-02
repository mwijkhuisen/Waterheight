import { emptyNormalised, type Normalised, type Registry } from '@rws/core';
import type { HydroRow, Station } from './parse.ts';

// DE-8 → the gauge zeros of the DE-7 series (catalogue §2.3, §4.1, §4.2). Declared here:
//  - a DE-7 W series is `<station_no>/W` (adapters/de-7/normalise.ts `keyOf`; adapters never import each
//    other, so the key is spelt out here and a test holds the two together);
//  - `Nullpunkt` is the gauge zero (PNP) in m on DHHN2016, i.e. datum NHN: m NHN = PNP + W/100;
//  - the file gives no validity date (`Errichtung` is when the gauge was built), so `valid_from` is null:
//    the loader never overwrites a stored zero without a date with another value (load/store.ts), it
//    withholds the new one and alerts (the history of zeros is P7);
//  - a station the DE-7 registry does not have is unknown (its zero loads once the registry has it).
// The station master (`de-8-stations`) stores nothing: it is registry input for scripts/gen-de7-stations.ts,
// and in the loader its daily payload only reports drift against the DE-7 registry (our keys, numbers).

export const SOURCE = 'DE-8';

export const keyOf = (station: string): string => `${station}/W`;

export type Context = { registry: Registry };

export function normaliseHydro(rows: readonly HydroRow[], ctx: Context): Normalised {
  const out = emptyNormalised();
  const unknown = new Set<string>();
  for (const r of rows) {
    const key = keyOf(r.id);
    if (!ctx.registry.has(key)) {
      unknown.add(key);
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
