import type { WebRiver } from '../../lib/data/chain.ts';
import type { ReachGraph } from '../../lib/data/contracts.ts';

// The upstream chain of a station (P11a, issue #26 C3): every station upstream of it, in walk order, on the graph of
// reaches-<ver>.json (public, or the owner variant on the owner site). Audience-agnostic: `known` (the station ids
// of the site's stations.json) decides which rows exist. Pure. STUB (L0): W1 implements it.

export type ChainNode =
  /** A row: co-located stations share one (`ids`, the first is the one the file names); `distKm` is upstream of the target. */
  | { kind: 'station'; ids: readonly string[]; riverId: string; distKm: number }
  /** A tributary collapsed at its confluence with the main stem; `count` station rows inside, recursively. */
  | { kind: 'group'; riverId: string; children: readonly ChainNode[]; count: number }
  /** More than GAP_KM of main stem without a station row. */
  | { kind: 'gap'; riverId: string; km: number };

/** The upstream chain of `targetId`, nearest first; empty for a station the file does not place. */
export function chain(
  graph: ReachGraph,
  rivers: readonly WebRiver[],
  targetId: string,
  known: ReadonlySet<string>,
): ChainNode[] {
  void graph;
  void rivers;
  void targetId;
  void known;
  return [];
}
