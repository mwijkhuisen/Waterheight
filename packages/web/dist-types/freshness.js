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
export const FRESH_THRESHOLD_HOURS = 3;
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
export const FRESHNESS_COLOR = {
    fresh: '#0ca30c',
    delayed: '#fab219',
};
export const FRESHNESS_LABEL = {
    fresh: `Reporting (last ${FRESH_THRESHOLD_HOURS} h)`,
    delayed: `Delayed (over ${FRESH_THRESHOLD_HOURS} h)`,
};
export function freshnessOf(lastSeenAt, now = Date.now()) {
    if (!lastSeenAt)
        return 'delayed';
    const ageMs = now - Date.parse(lastSeenAt);
    return ageMs <= FRESH_THRESHOLD_HOURS * 3_600_000 ? 'fresh' : 'delayed';
}
/** Compact relative age, e.g. "12 min ago". */
export function formatAge(timestamp, now = Date.now()) {
    if (!timestamp)
        return 'never';
    const ms = now - Date.parse(timestamp);
    if (Number.isNaN(ms))
        return 'unknown';
    if (ms < 60_000)
        return 'just now';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60)
        return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}
/** Absolute timestamp for the panel, so nothing depends on colour alone. */
export function formatTimestamp(timestamp) {
    if (!timestamp)
        return '—';
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime()))
        return '—';
    return d.toLocaleString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
}
//# sourceMappingURL=freshness.js.map