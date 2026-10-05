import { FORECAST_FLAG_BITS, type ForecastRun, pickRun } from '@rws/contracts';

// The forecast of every series at a future t from the runs of /data/v1/forecast/latest.json (P9a): the web's
// fallback when the API cannot answer a future snapshot, and the publisher's tests. The same rules as A§8 Q2 and the
// API's future snapshot over the runs the file holds: per series the first source of FORECAST_PRECEDENCE whose run
// reaches t, its value held at the greatest valid time ≤ t (never interpolated), nothing past the run's last point
// and never two providers blended. It imports only the forecast contract, so the web bundle may take it
// (`@rws/core/forecast-hold`).

export type HeldValue = {
  series: number;
  source: string;
  agency: string;
  /** The valid time held at t. */
  ts: string;
  /** null at a below-floor point (never a level). */
  value: number | null;
  flags: number;
  /** The point is flagged an estimate, or t is past the provider's own segment. */
  estimate: boolean;
  issuedAt: string;
  issuedInferred: boolean;
  providerSegmentEnd: string | null;
  band: { kind: 'p10p90' | 'p25p75'; lo: number; hi: number } | null;
  /** The run's last point in the file: its end, the 48-hour cap or the LU-3 display limit, whichever came first. */
  horizonEnd: string;
};

/** The greatest index whose valid time is ≤ t, or -1. */
function heldIndex(validTs: readonly string[], t: number): number {
  let lo = 0;
  let hi = validTs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(validTs[mid] as string) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Pure: the held forecast of each series at `t` (UTC ms), ordered by series. */
export function holdForecasts(runs: readonly ForecastRun[], t: number): HeldValue[] {
  const reaches = (r: ForecastRun) =>
    r.validTs.length > 0 && Date.parse(r.validTs[0] as string) <= t && t <= Date.parse(r.validTs.at(-1) as string);
  const bySeries = new Map<number, ForecastRun[]>();
  for (const r of runs) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r]);
  return [...bySeries]
    .sort(([a], [b]) => a - b)
    .flatMap(([series, list]) => {
      const r = pickRun(list, reaches);
      if (r === undefined) return [];
      const i = heldIndex(r.validTs, t);
      const ts = r.validTs[i] as string;
      const flags = r.flags[i] ?? 0;
      const below = (flags & FORECAST_FLAG_BITS.below_floor) !== 0;
      const pair: [number | null | undefined, number | null | undefined] | null =
        r.band === null
          ? null
          : r.band.kind === 'p10p90'
            ? [r.band.p10?.[i], r.band.p90?.[i]]
            : [r.band.p25?.[i], r.band.p75?.[i]];
      const lo = pair?.[0];
      const hi = pair?.[1];
      const segmentEnd = r.providerSegmentEnd === null ? null : Date.parse(r.providerSegmentEnd);
      return [
        {
          series,
          source: r.source,
          agency: r.agency,
          ts,
          value: below ? null : (r.value[i] ?? null),
          flags,
          estimate:
            (flags & FORECAST_FLAG_BITS.estimate) !== 0 ||
            (segmentEnd !== null && Math.max(Date.parse(ts), t) > segmentEnd),
          issuedAt: r.issuedAt,
          issuedInferred: r.issuedInferred,
          providerSegmentEnd: r.providerSegmentEnd,
          band:
            below || r.band === null || lo === null || lo === undefined || hi === null || hi === undefined
              ? null
              : { kind: r.band.kind, lo, hi },
          horizonEnd: r.validTs.at(-1) as string,
        },
      ];
    });
}
