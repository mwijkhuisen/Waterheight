import { deltaH } from '@rws/core/trend';

// The 24-hour change at t (P10a T1; datum-free, canonical units: cm for H, m³/s for Q). At now the publisher's own
// `dh24` of latest.json; at any other t up to now value(t) − value(t − 24 h) from the two snapshots. Without both
// values there is none (null), never a guess. After now there is no change at all: the page says "not applicable".

export type Trend = 'rising' | 'falling' | 'steady';
export type Change = { dh: number; trend: Trend } | null;

type Value = { series: number; value: number };

/**
 * Per series of `values`: its change over 24 hours and the trend with core's dead band (H ± 2 cm, Q ± max(1 m³/s,
 * 2 %)). `dh24` (latest.json) wins; otherwise `before` holds the snapshot at t − 24 h.
 */
export function changesAt(
  quantity: ReadonlyMap<number, 'H' | 'Q'>,
  values: readonly Value[],
  before: readonly Value[] | undefined,
  dh24?: ReadonlyMap<number, number | null>,
): Map<number, Change> {
  const then = new Map((before ?? []).map((v) => [v.series, v.value]));
  const out = new Map<number, Change>();
  for (const v of values) {
    const q = quantity.get(v.series);
    if (q === undefined) continue;
    let start: number | null;
    if (dh24 !== undefined) {
      const d = dh24.get(v.series);
      start = d === undefined || d === null ? null : v.value - d;
    } else start = then.get(v.series) ?? null;
    out.set(v.series, deltaH(v.value, start, q));
  }
  return out;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * Where the chart's history comes from (P10a T6): the static recent.json for a t within its 7 days (or after now),
 * else /api/v1/series when the series is in the api channel (stations.json `api`), else nothing older ("not
 * available for this source": no API request).
 */
export function historySource(t: number, now: number, api: boolean): 'recent' | 'api' | 'none' {
  if (t >= now - WEEK_MS) return 'recent';
  return api ? 'api' : 'none';
}
