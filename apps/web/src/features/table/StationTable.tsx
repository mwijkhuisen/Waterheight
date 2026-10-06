import type { ApiStation, Snapshot } from '@rws/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { Change } from '../../lib/data/change.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { formatAge, formatLocal } from '../../lib/time/time.ts';
import type { Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { dhGlyph } from '../legend/items.ts';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { forecastDetail, forecastValue } from '../station/forecast.ts';
import { quantityLabel } from '../station/StationPanel.tsx';
import { formatNumber, formatValue, unitLabel } from '../station/value.ts';
import { clampPage, dhCell, PAGE_SIZE, pageCount, pageOf, pageRange } from './page.ts';
import styles from './table.module.css';

// The table view (A§10 features/table): every series at t, one row each, the
// no-WebGL2 fallback and a view of its own. After now (P8b) the same rows carry the forecast at t: its value, or
// "no forecast", and who issued it when, an estimate and the band, all in words. The station name is a button that
// selects the station. No column is sortable: values with different zeros are
// not comparable (catalogue §4.7).

type Value = Snapshot['values'][number];

interface Props {
  locale: Locale;
  /** P10a: the mode column (state, Δh with ▲/▼ in words, Q or "geen afvoer"). */
  mode: Mode;
  stations: readonly ApiStation[];
  /** The feature-state record of every station at t: the section, owner, stale and suspect badges. */
  states: ReadonlyMap<string, StationState>;
  changes: ReadonlyMap<number, Change> | undefined;
  values: ReadonlyMap<number, Value>;
  /** After now: the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  t: number;
  selected: string | undefined;
  onSelect: (id: string) => void;
}

const trendWord = { rising: m.trend_rising, falling: m.trend_falling, steady: m.trend_steady } as const;
const stateWord = {
  no_ref: m.state_no_ref,
  low: m.state_low,
  normal: m.state_normal,
  elevated: m.state_elevated,
  high: m.state_high,
  extreme: m.state_extreme,
} as const;

export function StationTable({
  locale,
  mode,
  stations,
  states,
  changes,
  values,
  forecasts,
  t,
  selected,
  onSelect,
}: Props) {
  const o = { locale };
  const rows = useMemo(
    () => stations.flatMap((station) => station.series.map((series) => ({ station, series }))),
    [stations],
  );
  const [page, setPage] = useState(0);
  const signature = `${rows.length}:${rows[0]?.series.id}:${rows.at(-1)?.series.id}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new station set starts at page 1
  useEffect(() => setPage(0), [signature]);
  // A station chosen elsewhere (map, URL) brings its page into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the selection moves the page
  useEffect(() => {
    const i = rows.findIndex((r) => r.station.id === selected);
    if (i >= 0) setPage(pageOf(i));
  }, [selected]);
  const current = clampPage(page, rows.length);
  const range = pageRange(current, rows.length);
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const modeHeader = mode === 'state' ? m.col_state : mode === 'delta' ? m.col_dh : m.col_q;
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption>
          {(forecasts === undefined ? m.table_caption : m.table_caption_forecast)(
            { time: formatLocal(t, locale) },
            { locale },
          )}
          <span className={styles.note}>{m.not_comparable({}, { locale })}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">{m.col_station({}, { locale })}</th>
            <th scope="col">{m.col_water({}, { locale })}</th>
            <th scope="col">{m.col_source({}, { locale })}</th>
            <th scope="col">{m.col_quantity({}, { locale })}</th>
            <th scope="col">{modeHeader({}, o)}</th>
            <th scope="col">{m.col_value({}, { locale })}</th>
            {forecasts === undefined ? (
              <>
                <th scope="col">{m.col_measured({}, { locale })}</th>
                <th scope="col">{m.col_age({}, { locale })}</th>
              </>
            ) : (
              <th scope="col">{m.col_forecast({}, { locale })}</th>
            )}
            <th scope="col">{m.col_notes({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ station, series }) => {
            const state = states.get(station.id);
            const value = values.get(series.id);
            const forecast = forecasts?.get(series.id);
            const modeCell = () => {
              if (mode === 'state') {
                const st = forecasts === undefined ? value?.state : forecast?.state;
                return st == null ? '–' : stateWord[st]({}, o);
              }
              if (mode === 'delta') {
                const c = forecasts === undefined ? dhCell(changes?.get(series.id), series.quantity) : null;
                if (c === null) return '–';
                return (
                  <>
                    <span aria-hidden="true">{dhGlyph(c.bin)} </span>
                    {m.dh_value({ dh: formatNumber(c.dh, locale) }, o)}, {trendWord[c.trend]({}, o)}
                  </>
                );
              }
              if (series.quantity !== 'Q') return '–';
              const q = forecasts === undefined ? value?.value : forecast?.value;
              return q == null ? m.q_none({}, o) : `${formatValue(q, series, locale)} ${unitLabel(series, locale)}`;
            };
            return (
              <tr key={series.id}>
                <th scope="row">
                  <button type="button" aria-pressed={station.id === selected} onClick={() => onSelect(station.id)}>
                    {station.name}
                  </button>
                </th>
                <td>{station.waterName ?? ''}</td>
                <td>{series.source}</td>
                <td>{quantityLabel(series, locale)}</td>
                <td>{modeCell()}</td>
                {forecasts === undefined ? (
                  <>
                    <td>
                      {value === undefined
                        ? '–'
                        : `${formatValue(value.value, series, locale)} ${unitLabel(series, locale)}`}
                    </td>
                    <td>
                      {value === undefined ? (
                        '–'
                      ) : (
                        <time dateTime={value.ts}>{formatLocal(Date.parse(value.ts), locale)}</time>
                      )}
                    </td>
                    <td>{value === undefined ? '–' : formatAge(value.ageSeconds, locale)}</td>
                  </>
                ) : (
                  <>
                    <td>
                      {forecast === undefined
                        ? m.forecast_none({}, { locale })
                        : forecastValue(forecast, series, locale)}
                    </td>
                    <td>{forecast === undefined ? '–' : forecastDetail(forecast, series, locale)}</td>
                  </>
                )}
                <td>
                  {state?.section && <span>{m.section_badge({}, o)} </span>}
                  {state?.owner && <OwnerBadge locale={locale} />}
                  {state?.stale && <span>{m.stale_note({}, o)} </span>}
                  {state?.suspect && <span>{m.suspect_note({}, o)} </span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.pager}>
        <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
          {m.page_prev({}, o)}
        </button>
        <span aria-live="polite">{m.page_status({ from: range.from, to: range.to, total: rows.length }, o)}</span>
        <button type="button" disabled={current >= pageCount(rows.length) - 1} onClick={() => setPage(current + 1)}>
          {m.page_next({}, o)}
        </button>
      </div>
    </div>
  );
}
