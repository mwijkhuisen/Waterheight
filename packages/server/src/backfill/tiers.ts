/**
 * Backfill tiering — the single place this is configured.
 *
 * Nothing else in the codebase should decide what gets backfilled eagerly;
 * everything reads from here.
 *
 * The split is driven by the Phase 1 volume measurements (see
 * spike/PHASE1-FINDINGS.md), not by guesswork:
 *
 *   - The brief's Tier 1 (WATHTE + Q alone) is only 18.7% of volume. Q barely
 *     registers because discharge is measured at a handful of river stations
 *     rather than across the coastal network.
 *   - Current direction, current speed and echo sounding are ~31% of volume
 *     between them and are near-useless in a general-purpose map panel, so
 *     they are the ones worth deferring.
 *   - Chemistry and low-frequency series are a rounding error in volume, which
 *     the brief guessed and the counts confirmed, so they are eager.
 *
 * Hence: eager by default, with an explicit deferred list. That gets a useful
 * product in roughly a third of the download time, with everything else one
 * lazy fetch away.
 */

/**
 * Quantities deferred to lazy fetching: backfilled on first request for that
 * location+quantity, then kept. High-volume and rarely the reason someone
 * opens the map.
 */
const DEFERRED_QUANTITIES = new Set([
  'STROOMRTG', // current direction  — 11.5% of sampled volume
  'STROOMSHD', // current speed      — 10.3%
  'ECHO',      // echo sounding      —  8.9%
]);

/**
 * Runs before everything else in its tier. These are what the detail panel
 * actually plots, so they should be usable while the rest is still downloading.
 */
const PRIORITY_QUANTITIES: Record<string, number> = {
  WATHTE: 10, // water level
  Q: 10,      // discharge
  T: 20,      // temperature
  Hm0: 30,    // significant wave height
  'H1/3': 30,
  WINDSHD: 40, // wind speed
  WINDRTG: 40, // wind direction
};

export type Tier = 'eager' | 'deferred';

export interface TierDecision {
  tier: Tier;
  /** Lower runs first. */
  priority: number;
}

/**
 * Parse a comma-separated override, e.g. BACKFILL_DEFERRED="ECHO,STROOMSHD".
 * An explicitly empty value means "defer nothing", which is how you ask for a
 * full eager backfill without editing code.
 */
function envSet(name: string): Set<string> | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  return new Set(
    raw.split(',').map((s) => s.trim()).filter((s) => s !== ''),
  );
}

export function tierFor(grootheid: string): TierDecision {
  const deferred = envSet('BACKFILL_DEFERRED') ?? DEFERRED_QUANTITIES;
  const tier: Tier = deferred.has(grootheid) ? 'deferred' : 'eager';
  // Deferred work still gets queued so it is visible and can be run
  // explicitly; it simply sorts after everything eager.
  const base = tier === 'deferred' ? 1000 : 100;
  return { tier, priority: PRIORITY_QUANTITIES[grootheid] ?? base };
}

export function isDeferred(grootheid: string): boolean {
  return tierFor(grootheid).tier === 'deferred';
}

/**
 * Average points per series-month, measured in Phase 1 (24,654 points per
 * series-year across a 15-location sample). Used only for `--dry-run`
 * projections, never for control flow.
 */
export const ESTIMATED_POINTS_PER_SERIES_MONTH = Math.round(24_654 / 12);

/**
 * Measured mean for one month of OphalenWaarnemingen (~1.0 s live). Used for
 * the dry-run wall-clock estimate.
 */
export const ESTIMATED_SECONDS_PER_REQUEST = 1.0;
