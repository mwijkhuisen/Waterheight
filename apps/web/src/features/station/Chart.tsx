import type { SeriesMeta } from '@rws/contracts';
import { useEffect, useRef, useState } from 'react';
import { useSeries } from '../../lib/data/api.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { createChart } from './chart.ts';
import styles from './station.module.css';
import { formatNumber, nativeValue, unitLabel } from './value.ts';

type Handle = ReturnType<typeof createChart>;

interface Props {
  locale: Locale;
  series: SeriesMeta;
  name: string;
  t: number;
  span: { from: number; to: number };
}

/** One series of the panel over its chart span; ECharts loads on first use. */
export function Chart({ locale, series, name, t, span }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Handle | null>(null);
  const [failed, setFailed] = useState(false);
  const data = useSeries(series.id, span.from, span.to);
  const unit = unitLabel(series, locale);

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
    if (chart === null || data.data?.res !== 'raw') return;
    chart.update({
      locale,
      name,
      unit,
      t,
      points: data.data.points.map((p) => [Date.parse(p.ts), nativeValue(p.value, series)]),
      format: (v) => formatNumber(v, locale),
    });
  }, [chart, data.data, locale, name, unit, t, series]);

  return (
    <>
      {(failed || data.isError) && <p className={styles.note}>{m.chart_unavailable({}, { locale })}</p>}
      <div ref={ref} className={styles.chart} role="img" aria-label={m.chart_label({ unit }, { locale })} />
    </>
  );
}
