/**
 * Marker colour encodes how recently a location reported, not its value.
 *
 * Values are not comparable across quantities -- a water level in cm and a
 * wind speed in m/s share no scale -- so colouring by value would invent a
 * meaning that is not there. Freshness is the one property every marker has in
 * common, and it is what tells you whether a station is actually reporting.
 */
/**
 * Everything on the map is "active" (reported within ACTIVE_WINDOW_DAYS), so
 * this splits that set by whether a station is currently keeping up. The main
 * quantities publish on a ~10-minute cadence, so a few hours of silence is a
 * meaningful signal; slower chemistry series will sit in `delayed` by nature.
 */
export declare const FRESH_THRESHOLD_HOURS = 3;
export type Freshness = 'fresh' | 'delayed';
/**
 * Status palette, taken from the reserved status colours rather than the
 * categorical slots, because this encodes state rather than identity.
 *
 * The pair passes CVD separation (worst ΔE 11.3, protan) and the
 * normal-vision floor (27.6). `delayed` sits below 3:1 against a light
 * surface, so it never carries meaning alone: every marker gets a dark ring,
 * the legend spells out both states, and the detail panel shows the actual
 * timestamp.
 */
export declare const FRESHNESS_COLOR: Record<Freshness, string>;
export declare const FRESHNESS_LABEL: Record<Freshness, string>;
export declare function freshnessOf(lastSeenAt: string | null, now?: number): Freshness;
/** Compact relative age, e.g. "12 min ago". */
export declare function formatAge(timestamp: string | null, now?: number): string;
/** Absolute timestamp for the panel, so nothing depends on colour alone. */
export declare function formatTimestamp(timestamp: string | null): string;
//# sourceMappingURL=freshness.d.ts.map