import type { z } from 'zod';
import { ReachesFile } from './reaches.ts';

// Server only (P11a, D-C): the owner variant of reaches-<ver>.json, the public release's reaches split at the owner
// stations (publish-owner). Parts are `<river>.<seq>-<k>` with `part_of`. Like static-owner, the web never imports
// this module (`@rws/contracts/reaches-owner`, not re-exported from the index), so no owner shape reaches the public
// bundle. STUB (L0): W3 implements it.

export const OwnerReachesFile = ReachesFile;
export type OwnerReachesFile = z.infer<typeof OwnerReachesFile>;

/** The cross-checks of an owner reaches file (references resolve, parts conserve their reach): problems, or none. */
export function checkOwnerReaches(file: OwnerReachesFile): string[] {
  void file;
  return [];
}
