import type { ReachesFile, RivernetFile } from '@rws/contracts';
import type { OwnerReachesFile } from '@rws/contracts/reaches-owner';

// P11a (D-C): the owner variant of the installed river release, pure. Each owner station (owner stations.json ∩
// rivernet.yaml, placed with a river and a km_graph, not already in the release) splits the release reach it falls
// on, at its km_graph calibrated per river against the public stations both files place. STUB (L0): W3 implements it.

/** Why an owner station got no place in the variant (fixed codes only: never provider text). */
export type OwnerSkipCode = 'owner_reach_ambiguous' | 'owner_reach_unplaced';

export interface SplitResult {
  file: OwnerReachesFile;
  skipped: { id: string; code: OwnerSkipCode }[];
}

export function splitReaches(
  release: ReachesFile,
  owner: ReadonlySet<string>,
  rivernet: Pick<RivernetFile, 'stations'>,
): SplitResult {
  void owner;
  void rivernet;
  return { file: release, skipped: [] };
}
