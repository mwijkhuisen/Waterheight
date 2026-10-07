import type { SeriesMeta, StationRecent } from '@rws/contracts';
import { floorBucket } from '@rws/contracts';
import { useMemo } from 'react';
import { useDebounced, useForecastAsOf, useSeries } from '../../lib/data/api.ts';
import { historySource } from '../../lib/data/change.ts';
import {
  type ForecastView,
  forecastView,
  fromAsofRun,
  fromRecentRun,
  mergeHistory,
  observedPoints,
  type Pt,
  type Run,
} from './chartModel.ts';
import { nativeValue } from './value.ts';

// The data of one series over the panel's span (P10d): the chart and the table read the same points. Until P10d this
// sat inside Chart.tsx's effect.

export type RecentSeries = StationRecent['series'][number];

/** recent.json holds 7 days: a span that starts before its first point asks the API for the gap. */
const GAP_MS = 3_600_000;

export interface SeriesData {
  points: Pt[];
  run: Run | undefined;
  view: ForecastView | undefined;
  /** A request failed (history, the earlier part or recent.json). */
  failed: boolean;
  /** Nothing older than recent.json exists for this display-only series, and the t asks for it. */
  historyNone: boolean;
  /** A display-only series: the span reaches before recent.json's first point, which is all there is. */
  recentOnly: boolean;
  /** The series' unit conversion, canonical to native. */
  conv: (v: number) => number;
}

interface Input {
  /** stations.json's series carry `api` (the API's /stations does not: then every series is asked, as before). */
  series: SeriesMeta & { api?: boolean };
  t: number;
  span: { from: number; to: number };
  serverNow: number;
  /** This series' entry of recent.json (undefined while it loads or when the file failed). */
  recent: RecentSeries | undefined;
  recentFailed: boolean;
}

export function useSeriesData({ series, t, span, serverNow, recent, recentFailed }: Input): SeriesData {
  const api = series.api ?? true;
  const source = historySource(t, serverNow, api);
  // 'none': nothing older than recent.json for a display-only series, and no request for it.
  const older = useSeries(series.id, span.from, span.to, source === 'api');
  const firstRecent = recent === undefined || recent.ts.length === 0 ? undefined : Date.parse(recent.ts[0] as string);
  const gap = source === 'recent' && firstRecent !== undefined && firstRecent - span.from > GAP_MS;
  const earlier = useSeries(series.id, span.from, firstRecent ?? span.from, gap && api);
  // The now bucket and after: the run of recent.json (the one forecast/latest.json shows). An earlier t asks the API
  // for the run as of that t, once the slider has stopped (review round 1: a held key sent one request per step).
  const future = t >= floorBucket(serverNow);
  const settled = useDebounced(t, 150);
  const asof = useForecastAsOf(series.id, future || !api || settled !== t ? undefined : settled);
  const run: Run | undefined = useMemo(() => {
    if (future) return !recent?.run ? undefined : fromRecentRun(recent.run);
    return !asof.data?.run ? undefined : fromAsofRun(asof.data.run);
  }, [future, recent, asof.data]);

  const conv = useMemo(() => (v: number) => nativeValue(v, series), [series]);
  const points = useMemo(() => {
    const raw = (d: typeof older.data): Pt[] =>
      d?.res === 'raw'
        ? observedPoints(
            d.points.map((p) => p.ts),
            d.points.map((p) => p.value),
            conv,
            span.from,
            span.to,
          )
        : [];
    if (source === 'api') return raw(older.data);
    const own = recent === undefined ? [] : observedPoints(recent.ts, recent.value, conv, span.from, span.to);
    return gap && api ? mergeHistory(raw(earlier.data), own) : own;
  }, [source, older.data, earlier.data, recent, gap, api, conv, span.from, span.to]);
  const view = useMemo(
    () => (run === undefined ? undefined : forecastView(run, conv, future ? serverNow : t)),
    [run, conv, future, serverNow, t],
  );
  const failed = older.isError || (gap && api && earlier.isError) || recentFailed;
  const historyNone = source === 'none';
  const recentOnly = gap && !api;
  // One object per change, so the chart redraws only when its data did.
  return useMemo(
    () => ({ points, run, view, failed, historyNone, recentOnly, conv }),
    [points, run, view, failed, historyNone, recentOnly, conv],
  );
}
