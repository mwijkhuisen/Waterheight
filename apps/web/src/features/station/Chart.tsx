import type { SeriesMeta, StationRecent } from '@rws/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForecastAsOf, useSeries } from '../../lib/data/api.ts';
import { historySource } from '../../lib/data/change.ts';
import { referenceLabel, useOwnerLabels } from '../../lib/labels/labels.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { createChart } from './chart.ts';
import {
  forecastView,
  fromAsofRun,
  fromRecentRun,
  observedPoints,
  type Run,
  referenceMarks,
  runName,
} from './chartModel.ts';
import styles from './station.module.css';
import { formatNumber, nativeValue, unitLabel } from './value.ts';

type Handle = ReturnType<typeof createChart>;
export type RecentSeries = StationRecent['series'][number];

interface Props {
  locale: Locale;
  /** stations.json's series carry `api` (the API's /stations does not: then every series is asked, as before). */
  series: SeriesMeta & { api?: boolean };
  name: string;
  t: number;
  span: { from: number; to: number };
  serverNow: number;
  /** This series' entry of recent.json (undefined while it loads or when the file failed). */
  recent: RecentSeries | undefined;
  recentFailed: boolean;
  ownerSources: ReadonlySet<string>;
}

/** A run of an owner source (LU-3) carries the "owner only" words in its name: the chart's legend and tooltip (P10a T12). */
const ownerTag = (r: Pick<Run, 'source'>, owners: ReadonlySet<string>, locale: Locale): string =>
  owners.has(r.source) ? ` · ${m.owner_badge({}, { locale })}` : '';

/** One series of the panel over its chart span; ECharts loads on first use. */
export function Chart({ locale, series, name, t, span, serverNow, recent, recentFailed, ownerSources }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Handle | null>(null);
  const [failed, setFailed] = useState(false);
  const owner = useOwnerLabels();
  const api = series.api ?? true;
  const source = historySource(t, serverNow, api);
  // 'none': nothing older than recent.json for a display-only series, and no request for it.
  const older = useSeries(series.id, span.from, span.to, source === 'api');
  const future = t >= serverNow;
  const asof = useForecastAsOf(series.id, future || !api ? undefined : t);
  const unit = unitLabel(series, locale);
  const run: Run | undefined = useMemo(() => {
    if (future) return !recent?.run ? undefined : fromRecentRun(recent.run);
    return !asof.data?.run ? undefined : fromAsofRun(asof.data.run);
  }, [future, recent, asof.data]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let gone = false;
    let made: Handle | undefined;
    import('./chart.ts')
      .then(({ createChart }) => {
        if (gone) return;
        made = createChart(el);
        setChart(made);
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      made?.dispose();
      setChart(null);
    };
  }, []);

  useEffect(() => {
    if (chart === null) return;
    const conv = (v: number) => nativeValue(v, series);
    const points =
      source === 'api'
        ? older.data?.res === 'raw'
          ? observedPoints(
              older.data.points.map((p) => p.ts),
              older.data.points.map((p) => p.value),
              conv,
              span.from,
              span.to,
            )
          : []
        : recent === undefined
          ? []
          : observedPoints(recent.ts, recent.value, conv, span.from, span.to);
    const view = run === undefined ? undefined : forecastView(run, conv, future ? serverNow : t);
    const marks = referenceMarks(
      recent?.references ?? [],
      series.quantity,
      conv,
      (r) => referenceLabel(r.source, r.kind, locale, owner),
      (s) => ownerSources.has(s),
      locale,
    );
    chart.update({
      locale,
      name,
      unit,
      t,
      points,
      marks,
      observedName: m.chart_observed({}, { locale }),
      forecast:
        run === undefined || view === undefined
          ? undefined
          : {
              view,
              name: `${runName(run, locale)}${ownerTag(run, ownerSources, locale)}`,
              estimateName: `${runName(run, locale)}${ownerTag(run, ownerSources, locale)} (${m.forecast_estimate({}, { locale })})`,
            },
      xMax: view?.end,
      format: (v) => formatNumber(v, locale),
    });
  }, [
    chart,
    older.data,
    recent,
    run,
    source,
    future,
    serverNow,
    locale,
    name,
    unit,
    t,
    span.from,
    span.to,
    series,
    owner,
    ownerSources,
  ]);

  return (
    <>
      {(failed || older.isError || recentFailed) && (
        <p className={styles.note}>{m.chart_unavailable({}, { locale })}</p>
      )}
      {source === 'none' && <p className={styles.note}>{m.history_none({}, { locale })}</p>}
      <div ref={ref} className={styles.chart} role="img" aria-label={m.chart_label({ unit }, { locale })} />
      {run !== undefined && (
        <p className={styles.note}>
          {runName(run, locale)}
          {ownerTag(run, ownerSources, locale)}
        </p>
      )}
    </>
  );
}
