import { discover } from './normalise.ts';
import type { Collection } from './parse.ts';

// Registry drift report (issue #17) of the NL-1 registry against an NL-2
// snapshot: live series of our stations that the registry does not know,
// registered series the snapshot no longer lists, and stations that moved. It
// only reports; a series enters or leaves registry/stations/nl-1.yaml by a
// reviewed change to its generator's inputs. Our keys and numbers only, never a
// station name.

export type Drift = {
  /** Live series of a registered station that the registry does not know. */
  unregistered: string[];
  /**
   * Registered NAP and NVT series the snapshot does not list. The capture's CQL
   * filter keeps the series measured in the last 12 hours, so this means "no
   * value for 12 hours, or gone". A registered TAW twin is outside the
   * snapshot's datums (normalise.ts), so it is never reported.
   */
  vanished: string[];
  /** Registered series whose station the snapshot places elsewhere (`"<lon>,<lat>"`). */
  changed: { key: string; field: 'position'; declared: string; published: string }[];
};

/** A registered NL-1 series (the loader passes its SeriesRow map). */
type Registered = { key: string; lon: number | null; lat: number | null };

const LIMIT = 200;
/** Degrees in lon or lat (about 7 and 11 m): a moved gauge, not the rounding of two RWS services. */
const TOLERANCE = 1e-4;
const DATUMS: ReadonlySet<string> = new Set(['NAP', 'NVT']);

const stationOf = (key: string) => key.split('/', 1)[0] as string;
const position = (lon: number, lat: number) => `${lon.toFixed(6)},${lat.toFixed(6)}`;
const capped = (keys: Iterable<string>) => [...new Set(keys)].sort().slice(0, LIMIT);

export function driftReport(registry: ReadonlyMap<string, Registered>, collection: Collection): Drift {
  const { series } = discover(collection);
  const live = new Set(series.map((s) => s.key));
  // The layer lists hundreds of stations we do not track: only ours are news.
  const stations = new Set([...registry.keys()].map(stationOf));
  const changed: Drift['changed'] = [];
  for (const s of series) {
    const decl = registry.get(s.key);
    if (decl === undefined || decl.lon === null || decl.lat === null) continue;
    if (Math.abs(s.lon - decl.lon) > TOLERANCE || Math.abs(s.lat - decl.lat) > TOLERANCE) {
      changed.push({
        key: s.key,
        field: 'position',
        declared: position(decl.lon, decl.lat),
        published: position(s.lon, s.lat),
      });
    }
  }
  return {
    unregistered: capped(
      series.filter((s) => !registry.has(s.key) && stations.has(stationOf(s.key))).map((s) => s.key),
    ),
    vanished: capped([...registry.keys()].filter((k) => DATUMS.has(k.split('/')[2] ?? '') && !live.has(k))),
    // `series` is sorted by key and holds each key once.
    changed: changed.slice(0, LIMIT),
  };
}
