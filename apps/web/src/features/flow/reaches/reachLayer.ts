import type { ApiStation, Snapshot } from '@rws/contracts';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Change } from '../../../lib/data/change.ts';
import type { ReachGraph } from '../../../lib/data/contracts.ts';
import type { Mode } from '../../../lib/url/url.ts';

// The reach colouring on the map (P11b, issue #26): four line layers over the `rivers` source (promoteId
// `reach_id`): `rivers-reach` (the interpolated colour), `rivers-reach-nodata` (grey, dashed), `rivers-reach-impounded`
// (neutral) and `rivers-reach-tidal` (a hatch pattern on the tile's `tidal` flag, static). Each reach's paint is
// feature-state `{k, c, w}`, written only for the reaches whose paint changed. A lazy chunk, loaded with the flow
// layer once the river layer exists (StationsMap). No HTML, no provider text.

type Value = Snapshot['values'][number];

/** What the paints are computed from; the spans are cached per graph and set of known stations. */
export interface ReachInput {
  /** The site's reaches file graph (the public file, or the owner variant on the owner site). */
  graph: ReachGraph;
  mode: Mode;
  /** Every station of the site's stations.json (hidden ones included: they still end a span). */
  stations: readonly ApiStation[];
  values: ReadonlyMap<number, Value>;
  changes: ReadonlyMap<number, Change> | undefined;
}

export interface ReachHandle {
  /** Recomputes the paints and writes the feature-states that changed. */
  update(input: ReachInput): void;
  /** Removes the layers and the hatch image. */
  dispose(): void;
}

/** Adds the four layers before `beforeId` (when it exists). */
export function addReaches(_map: MapLibreMap, _beforeId: string): ReachHandle {
  // L0 stub (W3 builds it).
  return { update: () => undefined, dispose: () => undefined };
}
