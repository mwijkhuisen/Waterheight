import { statSync } from 'node:fs';
import { join } from 'node:path';

// The brownout flag (P12a, A§9.2). The host script deploy/bin/rws-brownout (root) keeps /srv/rws/brownout/: `mode`
// (on|off|auto) and `active`, a file that exists exactly while the brownout is on (manual on, or auto armed by the
// evaluator timer). api, publish and caddy mount the directory read-only at RWS_BROWNOUT_DIR; only `active` matters
// here. Its existence is checked at most once per CACHE_MS, so a request never costs a stat. No directory (the
// default without the mount, every test) means off.

export const CACHE_MS = 2_000;
export const BROWNOUT_DIR_DEFAULT = '/run/rws-brownout';

export type BrownoutFlag = () => boolean;

/** A cached reader of `<dir>/active`; `now` is a test seam. */
export function brownoutFlag(dir: string, now: () => number = Date.now): BrownoutFlag {
  const file = join(dir, 'active');
  let at = Number.NEGATIVE_INFINITY;
  let on = false;
  return () => {
    const t = now();
    if (t - at >= CACHE_MS) {
      at = t;
      try {
        on = statSync(file).isFile();
      } catch {
        on = false;
      }
    }
    return on;
  };
}

/** The process-wide flag of RWS_BROWNOUT_DIR (default BROWNOUT_DIR_DEFAULT). */
export const brownoutActive: BrownoutFlag = brownoutFlag(process.env.RWS_BROWNOUT_DIR || BROWNOUT_DIR_DEFAULT);
