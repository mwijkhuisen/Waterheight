import type { ApiStation, SeriesMeta, Snapshot } from '@rws/contracts';
import { SUSPECT_BITS } from '@rws/core/qc';
import { useEffect, useId, useRef } from 'react';
import { useRecent, useSources } from '../../lib/data/api.ts';
import type { Change } from '../../lib/data/change.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import type { WarningsAt } from '../../lib/data/warnings.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { formatAge, formatDay, formatLocal } from '../../lib/time/time.ts';
import type { Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { DhMark } from '../legend/DhMark.tsx';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { BasisLabel } from './BasisLabel.tsx';
import { Chart } from './Chart.tsx';
import { bandText, forecastValue, issueText } from './forecast.ts';
import { creditLines, dhValue, trendGlyph } from './provenance.ts';
import { heightText, stateWord } from './state.ts';
import styles from './station.module.css';
import { formatValue, unitLabel } from './value.ts';

// The station panel (A§10 features/station): names exactly as published (as
// text), the source per series, each value as published with its unit and
// zero, its age at t and "data since" (D9), and a 7-day chart. After now (P8b) a series shows its forecast at t
// instead: the value, the agency and the issue time, an estimate said in words, the band, the state, the horizon;
// or "no forecast". P10a: the 24-hour change, the translated basis, notes, credit lines and the history source.

type Value = Snapshot['values'][number];

interface Props {
  locale: Locale;
  station: ApiStation;
  values: ReadonlyMap<number, Value>;
  /** After now: the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  /** P10a: the map mode, the station's feature-state record, the 24-hour change by series. */
  mode: Mode;
  state: StationState | undefined;
  changes: ReadonlyMap<number, Change> | undefined;
  /** The warning areas valid at t: an area basis's raw level code comes from its feature (label lookup, V2). */
  warnings: WarningsAt | undefined;
  /** Owner-audience source ids (empty on the public site): owner badges on series, bands and thresholds. */
  ownerSources: ReadonlySet<string>;
  /** Live mode: recent.json is asked again every minute. */
  live: boolean;
  /** meta.now: picks the history source (recent.json within 7 days, else the API when `api`). */
  serverNow: number;
  t: number;
  dataEpoch: number;
  chartSpan: { from: number; to: number };
  /** Move the focus to the heading when the panel opens. */
  focus: boolean;
  onClose: () => void;
}

export const quantityLabel = (series: SeriesMeta, locale: Locale): string =>
  series.quantity === 'H' ? m.quantity_H({}, { locale }) : m.quantity_Q({}, { locale });

export function StationPanel({
  locale,
  station,
  values,
  forecasts,
  changes,
  warnings,
  ownerSources,
  live,
  serverNow,
  t,
  dataEpoch,
  chartSpan,
  focus,
  onClose,
}: Props) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const recent = useRecent(station.id, live);
  const sourceDocs = useSources().data?.sources;
  // The panel mounts anew for each station (keyed by it); opened from the map or the table, it takes the focus.
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  const sourceIds = [...new Set(station.series.map((s) => s.source))];

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
        <dd>{sourceIds.join(', ')}</dd>
      </dl>
      {(station.flags.tidal === true || station.flags.impounded === true) && (
        <ul className={styles.notes}>
          {station.flags.tidal === true && <li>{m.tidal_note({}, { locale })}</li>}
          {station.flags.impounded === true && <li>{m.impounded_note({}, { locale })}</li>}
        </ul>
      )}
      {station.series.map((series) => {
        const value = values.get(series.id);
        const forecast = forecasts?.get(series.id);
        const since = series.dataSince === null ? undefined : Date.parse(series.dataSince);
        const change = changes?.get(series.id);
        const credit = sourceDocs?.find((s) => s.id === series.source);
        const suspect = value !== undefined && (value.qc & SUSPECT_BITS) !== 0;
        const stale = value !== undefined && value.ageSeconds > 2 * series.expectedStepSeconds;
        return (
          <section key={series.id} className={styles.series} aria-labelledby={`${id}-${series.id}`}>
            <h3 id={`${id}-${series.id}`}>
              {quantityLabel(series, locale)}
              {ownerSources.has(series.source) && (
                <>
                  {' '}
                  <OwnerBadge locale={locale} />
                </>
              )}
            </h3>
            {forecasts !== undefined ? (
              forecast === undefined ? (
                <p className={styles.value}>{m.forecast_none({}, { locale })}</p>
              ) : (
                <>
                  <p className={styles.value}>
                    {forecast.value === null ? (
                      forecastValue(forecast, series, locale)
                    ) : (
                      <>
                        <strong>{formatValue(forecast.value, series, locale)}</strong> {unitLabel(series, locale)}
                      </>
                    )}
                  </p>
                  {forecast.estimate && <p className={styles.estimate}>{m.forecast_estimate_note({}, { locale })}</p>}
                  {/* BAFU recommends explaining how its forecasts read (catalogue §2.7; review SEC-2). */}
                  {forecast.source === 'CH-4' && (
                    <p className={styles.estimate}>{m.forecast_bafu_note({}, { locale })}</p>
                  )}
                </>
              )
            ) : value === undefined ? (
              <p className={styles.value}>{m.value_none({}, { locale })}</p>
            ) : (
              <p className={styles.value}>
                <strong>{formatValue(value.value, series, locale)}</strong> {unitLabel(series, locale)}
                {value.section && <span className={styles.badge}>{m.section_badge({}, { locale })}</span>}
              </p>
            )}
            {(suspect || stale) && (
              <ul className={styles.notes}>
                {suspect && <li>{m.suspect_note({}, { locale })}</li>}
                {stale && <li>{m.stale_note({}, { locale })}</li>}
              </ul>
            )}
            <dl className={styles.facts}>
              {forecast !== undefined && (
                <ForecastFacts
                  forecast={forecast}
                  series={series}
                  locale={locale}
                  warnings={warnings}
                  ownerSources={ownerSources}
                />
              )}
              {forecasts === undefined && value !== undefined && (
                <>
                  <dt>{m.measured_at({}, { locale })}</dt>
                  <dd>
                    <time dateTime={value.ts}>{formatLocal(Date.parse(value.ts), locale)}</time>
                  </dd>
                  <dt>{m.age({}, { locale })}</dt>
                  <dd>{formatAge(value.ageSeconds, locale)}</dd>
                </>
              )}
              {forecasts === undefined && value !== undefined && (
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
                        <BasisLabel
                          locale={locale}
                          basis={value.basis}
                          warnings={warnings}
                          ownerSources={ownerSources}
                        />
                      </dd>
                    </>
                  )}
                  {value.area !== undefined && (
                    <>
                      <dt>{m.panel_area({}, { locale })}</dt>
                      <dd>
                        {stateWord(value.area.state, locale)}:{' '}
                        <BasisLabel
                          locale={locale}
                          basis={value.area.basis}
                          warnings={warnings}
                          ownerSources={ownerSources}
                        />
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
              <dt>{m.panel_dh({}, { locale })}</dt>
              <dd>
                {forecasts !== undefined || change === undefined || change === null ? (
                  m.dh_na({}, { locale })
                ) : (
                  <>
                    <DhMark glyph={trendGlyph(change.trend)} />{' '}
                    {m.dh_value({ dh: dhValue(change.dh, series.quantity, locale) }, { locale })},{' '}
                    {/* By name, never `m[key]`: indexing the namespace would bundle every message. */}
                    {{ rising: m.trend_rising, falling: m.trend_falling, steady: m.trend_steady }[change.trend](
                      {},
                      { locale },
                    )}
                  </>
                )}
              </dd>
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
              <dt>{m.panel_credit({}, { locale })}</dt>
              <dd>
                {series.source}
                {credit !== undefined && (
                  <ul className={styles.credit}>
                    {creditLines(credit, locale).map((c) => (
                      <li key={`${c.lang}|${c.text}`} lang={c.lang ?? undefined}>
                        {c.href === undefined ? (
                          c.text
                        ) : (
                          <a href={c.href} rel="noopener noreferrer">
                            {c.text}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
            <Chart
              locale={locale}
              series={series}
              name={station.name}
              t={t}
              span={chartSpan}
              serverNow={serverNow}
              recent={recent.data?.series.find((s) => s.id === series.id)}
              recentFailed={recent.isError}
              ownerSources={ownerSources}
            />
          </section>
        );
      })}
      <p className={styles.note}>{m.not_comparable({}, { locale })}</p>
    </aside>
  );
}

/** The rows of a forecast: the instant it holds for, who issued it and when, the band, its state, how far it reaches. */
function ForecastFacts({
  forecast,
  series,
  locale,
  warnings,
  ownerSources,
}: {
  forecast: SnapshotForecast;
  series: SeriesMeta;
  locale: Locale;
  warnings: WarningsAt | undefined;
  ownerSources: ReadonlySet<string>;
}) {
  const band = bandText(forecast, series, locale);
  return (
    <>
      <dt>{m.forecast_valid_for({}, { locale })}</dt>
      <dd>
        <time dateTime={forecast.ts}>{formatLocal(Date.parse(forecast.ts), locale)}</time>
      </dd>
      <dt>{m.forecast_origin({}, { locale })}</dt>
      <dd>
        {issueText(forecast, locale)}
        {/* The band of an owner source (LU-3) says so, in words (P10a T12). */}
        {ownerSources.has(forecast.source) && (
          <>
            {' '}
            <OwnerBadge locale={locale} />
          </>
        )}
      </dd>
      {band !== null && (
        <>
          <dt>{m.forecast_band_label({}, { locale })}</dt>
          <dd>{band}</dd>
        </>
      )}
      {forecast.state !== null && (
        <>
          <dt>{m.panel_forecast_state({}, { locale })}</dt>
          <dd>{stateWord(forecast.state, locale)}</dd>
        </>
      )}
      {forecast.basis !== null && (
        <>
          <dt>{m.panel_basis({}, { locale })}</dt>
          <dd>
            <BasisLabel locale={locale} basis={forecast.basis} warnings={warnings} ownerSources={ownerSources} />
          </dd>
        </>
      )}
      <dt>{m.forecast_until({}, { locale })}</dt>
      <dd>
        <time dateTime={forecast.horizonEnd}>{formatLocal(Date.parse(forecast.horizonEnd), locale)}</time>
      </dd>
    </>
  );
}
