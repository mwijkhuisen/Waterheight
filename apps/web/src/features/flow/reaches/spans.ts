import type { ReachGraph } from '../../../lib/data/contracts.ts';

// The spans of the reach colouring (P11b, issue #26): a span is the run of reaches from a station to the next
// station downstream on the same river (reaches-<ver>.json; a reach itself starts and ends at a confluence, a
// bifurcation, a change of river or a station). Each tile feature (one public reach) is coloured at its own chainage
// midpoint on its span. Pure; the walk reuses P11a's index, co-location and sink rules (station/neighbours.ts).
// On the owner variant (`part_of`), a public reach takes the span of the owner part that holds its midpoint (D-2).

/** The closed span a reach lies on: a station group at each end. */
export interface Span {
  /** The up end's station group: co-located stations in file order, only ids of `known`. */
  up: readonly string[];
  /** The down end's station group, likewise. */
  down: readonly string[];
  /** The span's length in km; null when a reach on its path has no length (never interpolated). */
  lengthKm: number | null;
  /** Where the reach's chainage midpoint lies along the span, 0 (up end) … 1 (down end); null when unknown. */
  pos: number | null;
  /** A reach on the span's path is tidal, or has unknown flags: no reach of the span is interpolated. */
  tidal: boolean;
}

/** One public tile reach. */
export interface FeatureSpan {
  /** The reach's own flags; null when the file has none (unknown: never interpolated). */
  tidal: boolean | null;
  impounded: boolean | null;
  /** Its closed span, or null when it lies only on open paths (a river head, a tributary's last stretch). */
  span: Span | null;
}

/**
 * Every public tile reach of `graph` (public file or owner variant) by its public id. `known` is the site's
 * stations.json ids: only those end a span.
 */
export function spansOf(_graph: ReachGraph, _known: ReadonlySet<string>): Map<string, FeatureSpan> {
  // L0 stub (W2 builds it).
  return new Map();
}
