import type { ApiStation, Snapshot } from '@rws/contracts';
import { formatAge, formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { quantityLabel } from '../station/StationPanel.tsx';
import { formatValue, unitLabel } from '../station/value.ts';
import styles from './table.module.css';

// The table view (A§10 features/table): every series at t, one row each, the
// no-WebGL2 fallback and a view of its own. The station name is a button that
// selects the station. No column is sortable: values with different zeros are
// not comparable (catalogue §4.7).

type Value = Snapshot['values'][number];

interface Props {
  locale: Locale;
  stations: readonly ApiStation[];
  values: ReadonlyMap<number, Value>;
  t: number;
  selected: string | undefined;
  onSelect: (id: string) => void;
}

export function StationTable({ locale, stations, values, t, selected, onSelect }: Props) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption>
          {m.table_caption({ time: formatLocal(t, locale) }, { locale })}
          <span className={styles.note}>{m.not_comparable({}, { locale })}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">{m.col_station({}, { locale })}</th>
            <th scope="col">{m.col_water({}, { locale })}</th>
            <th scope="col">{m.col_source({}, { locale })}</th>
            <th scope="col">{m.col_quantity({}, { locale })}</th>
            <th scope="col">{m.col_value({}, { locale })}</th>
            <th scope="col">{m.col_measured({}, { locale })}</th>
            <th scope="col">{m.col_age({}, { locale })}</th>
          </tr>
        </thead>
        <tbody>
          {stations.flatMap((station) =>
            station.series.map((series) => {
              const value = values.get(series.id);
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
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
