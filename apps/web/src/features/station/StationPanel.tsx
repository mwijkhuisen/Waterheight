import type { ApiStation, SeriesMeta, Snapshot } from '@rws/contracts';
import { useEffect, useId, useRef } from 'react';
import { formatAge, formatDay, formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { Chart } from './Chart.tsx';
import { basisKind, heightText, stateWord } from './state.ts';
import styles from './station.module.css';
import { formatValue, unitLabel } from './value.ts';

// The station panel (A§10 features/station): names exactly as published (as
// text), the source per series, each value as published with its unit and
// zero, its age at t and "data since" (D9), and a 7-day chart.

type Value = Snapshot['values'][number];

interface Props {
  locale: Locale;
  station: ApiStation;
  values: ReadonlyMap<number, Value>;
  t: number;
  dataEpoch: number;
  chartSpan: { from: number; to: number };
  /** Move the focus to the heading when the panel opens. */
  focus: boolean;
  onClose: () => void;
}

export const quantityLabel = (series: SeriesMeta, locale: Locale): string =>
  series.quantity === 'H' ? m.quantity_H({}, { locale }) : m.quantity_Q({}, { locale });

export function StationPanel({ locale, station, values, t, dataEpoch, chartSpan, focus, onClose }: Props) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The panel mounts anew for each station (keyed by it); opened from the map or the table, it takes the focus.
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  const sources = [...new Set(station.series.map((s) => s.source))].join(', ');

  return (
    <aside className={styles.panel} aria-labelledby={`${id}-h`}>
      <div className={styles.head}>
        <h2 id={`${id}-h`} ref={heading} tabIndex={-1}>
          {station.name}
        </h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label={m.panel_close({}, { locale })}>
          {/* An icon, not a one-character text: axe cannot judge the contrast of a lone glyph (review round 2). */}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      <dl className={styles.facts}>
        {station.waterName !== null && (
          <>
            <dt>{m.panel_water({}, { locale })}</dt>
            <dd>{station.waterName}</dd>
          </>
        )}
        <dt>{m.panel_source({}, { locale })}</dt>
        <dd>{sources}</dd>
      </dl>
      {station.series.map((series) => {
        const value = values.get(series.id);
        const since = series.dataSince === null ? undefined : Date.parse(series.dataSince);
        return (
          <section key={series.id} className={styles.series} aria-labelledby={`${id}-${series.id}`}>
            <h3 id={`${id}-${series.id}`}>{quantityLabel(series, locale)}</h3>
            {value === undefined ? (
              <p className={styles.value}>{m.value_none({}, { locale })}</p>
            ) : (
              <p className={styles.value}>
                <strong>{formatValue(value.value, series, locale)}</strong> {unitLabel(series, locale)}
              </p>
            )}
            <dl className={styles.facts}>
              {value !== undefined && (
                <>
                  <dt>{m.measured_at({}, { locale })}</dt>
                  <dd>
                    <time dateTime={value.ts}>{formatLocal(Date.parse(value.ts), locale)}</time>
                  </dd>
                  <dt>{m.age({}, { locale })}</dt>
                  <dd>{formatAge(value.ageSeconds, locale)}</dd>
                </>
              )}
              {value !== undefined && (
                <>
                  <dt>{m.panel_state({}, { locale })}</dt>
                  <dd>
                    {stateWord(value.state, locale)}
                    {value.section && ` ${m.section_marker({}, { locale })}`}
                  </dd>
                  {value.basis !== null && (
                    <>
                      <dt>{m.panel_basis({}, { locale })}</dt>
                      <dd>
                        {basisKind(value.basis, locale)}: {value.basis.label}
                      </dd>
                    </>
                  )}
                  {value.area !== undefined && (
                    <>
                      <dt>{m.panel_area({}, { locale })}</dt>
                      <dd>
                        {stateWord(value.area.state, locale)}: {value.area.basis.label}
                      </dd>
                    </>
                  )}
                  {heightText(value, locale) !== null && (
                    <>
                      <dt>{m.panel_height({}, { locale })}</dt>
                      <dd>{heightText(value, locale)}</dd>
                    </>
                  )}
                </>
              )}
              <dt>{m.data_since({}, { locale })}</dt>
              <dd>
                {since === undefined
                  ? m.data_since_none({}, { locale })
                  : since < dataEpoch
                    ? m.data_since_seeded(
                        { date: formatDay(since, locale), epoch: formatDay(dataEpoch, locale) },
                        { locale },
                      )
                    : formatDay(since, locale)}
              </dd>
            </dl>
            <Chart locale={locale} series={series} name={station.name} t={t} span={chartSpan} />
          </section>
        );
      })}
      <p className={styles.note}>{m.not_comparable({}, { locale })}</p>
    </aside>
  );
}
