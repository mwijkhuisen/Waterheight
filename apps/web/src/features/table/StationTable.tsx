import type { ApiStation, Snapshot } from '@rws/contracts';
import type { Change } from '../../lib/data/change.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { formatAge, formatLocal } from '../../lib/time/time.ts';
import type { Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { forecastDetail, forecastValue } from '../station/forecast.ts';
import { quantityLabel } from '../station/StationPanel.tsx';
import { formatValue, unitLabel } from '../station/value.ts';
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

export function StationTable({ locale, stations, values, forecasts, t, selected, onSelect }: Props) {
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
            <th scope="col">{m.col_value({}, { locale })}</th>
            {forecasts === undefined ? (
              <>
                <th scope="col">{m.col_measured({}, { locale })}</th>
                <th scope="col">{m.col_age({}, { locale })}</th>
              </>
            ) : (
              <th scope="col">{m.col_forecast({}, { locale })}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {stations.flatMap((station) =>
            station.series.map((series) => {
              const value = values.get(series.id);
              const forecast = forecasts?.get(series.id);
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
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
