import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { createChart } from './chart.ts';
import { runName } from './chartModel.ts';
import styles from './station.module.css';
import type { Marks } from './thresholds.ts';
import type { SeriesData } from './useSeriesData.ts';
import { formatNumber } from './value.ts';

type Handle = ReturnType<typeof createChart>;

interface Props {
  locale: Locale;
  /** The station name exactly as published: untrusted text, only ever drawn as canvas text. */
  name: string;
  /** The unit with its zero ("cm NAP"). */
  unit: string;
  t: number;
  serverNow: number;
  /** The span in days, for the chart's accessible name. */
  days: number;
  data: SeriesData;
  marks: Marks;
  showThresholds: boolean;
  ownerSources: ReadonlySet<string>;
  /** The chart's own failure (its chunk could not load) is reported up, to sit with the other notes. */
  onFailed: (failed: boolean) => void;
}

/** A run of an owner source (LU-3) carries the "owner only" words in its name: the chart's legend and tooltip (P10a T12). */
export const ownerTag = (source: string, owners: ReadonlySet<string>, locale: Locale): string =>
  owners.has(source) ? ` · ${m.owner_badge({}, { locale })}` : '';

/** One series of the panel over its chart span; ECharts loads on first use. */
export function Chart({
  locale,
  name,
  unit,
  t,
  serverNow,
  days,
  data,
  marks,
  showThresholds,
  ownerSources,
  onFailed,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Handle | null>(null);

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
      .catch(() => onFailed(true));
    return () => {
      gone = true;
      made?.dispose();
      setChart(null);
    };
  }, [onFailed]);

  useEffect(() => {
    if (chart === null) return;
    const { run, view } = data;
    const label = run === undefined ? '' : `${runName(run, locale)}${ownerTag(run.source, ownerSources, locale)}`;
    chart.update({
      locale,
      name,
      unit,
      t,
      now: serverNow,
      nowName: m.now_marker({}, { locale }),
      axisName: m.chart_axis_time({}, { locale }),
      showThresholds,
      points: data.points,
      marks,
      observedName: m.chart_observed({}, { locale }),
      forecast:
        run === undefined || view === undefined
          ? undefined
          : { view, name: label, estimateName: `${label} (${m.forecast_estimate({}, { locale })})` },
      xMax: view?.end,
      format: (v) => formatNumber(v, locale),
    });
  }, [chart, data, marks, showThresholds, serverNow, locale, name, unit, t, ownerSources]);

  return <div ref={ref} className={styles.chart} role="img" aria-label={m.chart_label({ unit, days }, { locale })} />;
}
