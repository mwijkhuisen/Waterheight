import type { Registry } from '@rws/core';
import type { Station } from './parse.ts';

// Registry drift report (issue #17): what a harvested PEGELONLINE stations.json
// says that registry/stations/de-1.yaml does not. It only reports; a series
// enters or leaves the registry by a reviewed change to the generated file.

export type Drift = {
  /** W or Q series in the payload that the registry does not know (`<uuid>/<W|Q>`). */
  unregistered: string[];
  /** Registered series that the payload no longer has. */
  vanished: string[];
  /** Registered series whose unit or step differs from the declaration. */
  changed: { key: string; field: 'unit' | 'step'; declared: string; published: string }[];
};

const LIMIT = 200;

export function driftReport(registry: Registry, stations: readonly Station[]): Drift {
  const seen = new Set<string>();
  const drift: Drift = { unregistered: [], vanished: [], changed: [] };
  for (const station of stations) {
    for (const series of station.timeseries) {
      if (series.shortname !== 'W' && series.shortname !== 'Q') continue;
      const key = `${station.uuid}/${series.shortname}`;
      seen.add(key);
      const decl = registry.get(key);
      if (decl === undefined) {
        drift.unregistered.push(key);
        continue;
      }
      if (series.unit !== decl.native_unit) {
        drift.changed.push({ key, field: 'unit', declared: decl.native_unit, published: series.unit.slice(0, 20) });
      }
      if (series.equidistance * 60_000 !== decl.native_step_ms) {
        drift.changed.push({
          key,
          field: 'step',
          declared: `${decl.native_step_ms / 60_000} min`,
          published: `${series.equidistance} min`,
        });
      }
    }
  }
  for (const key of registry.keys()) if (!seen.has(key)) drift.vanished.push(key);
  drift.unregistered = drift.unregistered.sort().slice(0, LIMIT);
  drift.vanished = drift.vanished.sort().slice(0, LIMIT);
  drift.changed = drift.changed.slice(0, LIMIT);
  return drift;
}

export const driftCount = (d: Drift) => d.unregistered.length + d.vanished.length + d.changed.length;
