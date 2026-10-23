import type { ApiStation, SnapshotTide } from '@rws/contracts';
import { useId } from 'react';
import { useSeries } from '../../lib/data/api.ts';
import type { WebWaterbody } from '../../lib/data/chain.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import type { WebForecast } from '../../lib/data/static.ts';
import { httpsHref } from '../../lib/href.ts';
import { amsterdam, formatDay, formatLocal, ZONE } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { STORM_SURGE_WARNING } from '../pages/official.ts';
import styles from './station.module.css';
import { dayExtremes, daySpan } from './tide.ts';
import { formatNumber, formatValue, nativeValue, unitLabel } from './value.ts';

// The tide section of a tidal station's panel (P19b T1, issue #67): a lazy chunk of StationPanel, after the series
// sections. The astronomical tide and the derived surge at t, the forecast surge after now, the day's high and low
// waters (tide.ts dayExtremes over a daySpan request) and the storm-surge link. Every value is a React text node.

export interface TideSectionProps {
  locale: Locale;
  station: ApiStation;
  /** The station's primary H series: its unit and datum label every value (nothing converted, MSL never meets NAP). */
  series: ApiStation['series'][number];
  /** Its value at t (up to now): `tide` holds astro and surge at the value's own ts; undefined without one. */
  value: PlayedValue | undefined;
  /** Its forecast at t (after now): `tide` holds astro at the valid ts and the forecast surge; undefined up to now. */
  forecast: WebForecast | undefined;
  t: number;
  /** meta.now: the end of the day request (the API's limit is now + 10 minutes). */
  serverNow: number;
  /** The first day the page has data for (the start of the day request). */
  displayStart: number;
  /** The values are played-back frames (no tide, KG-444): no tide facts. */
  played: boolean;
  /** meta.brownout: the API refuses raw, so no day request. */
  brownout: boolean;
  /** stations.json's `api` flag of the series: false means no request to the API at all. */
  api: boolean;
  /** The station's water body (bodyOf); the storm-surge link only for an estuary or sea body. */
  body: WebWaterbody | undefined;
}

export function TideSection({
  locale,
  series,
  value,
  forecast,
  t,
  serverNow,
  displayStart,
  played,
  brownout,
  api,
  body,
}: TideSectionProps) {
  const id = useId();
  const o = { locale };
  // After now the snapshot holds forecasts instead of values (P8b): the forecast's tide, astro at its valid ts.
  const tide: SnapshotTide | undefined = forecast !== undefined ? forecast.tide : value?.tide;
  const at = forecast !== undefined ? forecast.ts : value?.ts;
  // C8: the raw /series of the local day of t carries the day's measured extremes (the snapshot has one per kind).
  const day = played ? undefined : daySpan(t, displayStart, serverNow);
  const dayAnswer = useSeries(
    series.id,
    day?.from ?? 0,
    day?.to ?? 0,
    api && !brownout && !played && tide !== undefined && day !== undefined,
    brownout,
  );
  if (played)
    return (
      <section className={styles.series} aria-labelledby={id}>
        <h3 id={id}>{m.tide_heading({}, o)}</h3>
        <p className={styles.note}>{m.tide_played({}, o)}</p>
      </section>
    );
  if (tide === undefined || at === undefined) return null;

  const unit = unitLabel(series, locale);
  const signed = (v: number) => `${v > 0 ? '+' : ''}${formatNumber(nativeValue(v, series), locale)}`;
  const time = formatLocal(Date.parse(at), locale);
  const rows = dayExtremes(t, dayAnswer.data?.res === 'raw' ? dayAnswer.data.tide?.extremes : undefined, tide.extremes);
  const link =
    body !== undefined && Object.hasOwn(STORM_SURGE_WARNING, body.id)
      ? httpsHref(STORM_SURGE_WARNING[body.id as keyof typeof STORM_SURGE_WARNING])
      : undefined;

  return (
    <section className={styles.series} aria-labelledby={id}>
      <h3 id={id}>{m.tide_heading({}, o)}</h3>
      {tide.astro === null ? (
        <p className={styles.note}>{m.tide_no_astro({}, o)}</p>
      ) : (
        <>
          <dl className={styles.facts}>
            <dt>{m.tide_astro({}, o)}</dt>
            <dd>
              {formatValue(tide.astro, series, locale)} {unit}
            </dd>
            <dt>{(forecast !== undefined ? m.tide_surge_forecast : m.tide_surge)({}, o)}</dt>
            <dd>{tide.surge === null ? '–' : `${signed(tide.surge)} ${series.nativeUnit}`}</dd>
          </dl>
          <p className={styles.note}>
            {(forecast !== undefined ? m.tide_at_forecast : m.tide_at_measurement)({ time }, o)}
          </p>
        </>
      )}
      {rows.length === 0 ? (
        dayAnswer.isError ? (
          <p className={styles.note}>{m.tide_extremes_failed({}, o)}</p>
        ) : dayAnswer.fetchStatus === 'fetching' ? null : (
          <p className={styles.note}>{m.tide_no_extremes({}, o)}</p>
        )
      ) : (
        <table className={styles.seriesTable}>
          <caption>{m.tide_extremes_caption({ day: formatDay(t, locale, ZONE) }, o)}</caption>
          <thead>
            <tr>
              <th scope="col">{m.tide_col_time({}, o)}</th>
              <th scope="col">{m.tide_col_hilo({}, o)}</th>
              <th scope="col">{m.tide_col_kind({}, o)}</th>
              <th scope="col">
                {m.tide_col_value({}, o)} ({unit})
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const ms = Date.parse(e.ts);
              const local = amsterdam(ms);
              return (
                <tr key={`${e.kind}|${e.hilo}|${e.ts}`}>
                  <td>
                    <time dateTime={new Date(ms).toISOString()}>
                      {local.time} {local.label}
                    </time>
                  </td>
                  <td>{e.hilo === 'high' ? m.tide_high({}, o) : m.tide_low({}, o)}</td>
                  <td>{e.kind === 'astro' ? m.tide_kind_astro({}, o) : m.tide_kind_measured({}, o)}</td>
                  <td>{formatValue(e.value, series, locale)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {link !== undefined && (
        <p>
          <a href={link} rel="noopener noreferrer">
            {m.storm_surge_link({}, o)}
          </a>
        </p>
      )}
    </section>
  );
}
