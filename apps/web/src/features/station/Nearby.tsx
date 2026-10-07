import type { ApiStation, Snapshot } from '@rws/contracts';
import { useMemo } from 'react';
import { useReachGraph } from '../../lib/data/api.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import { riverName } from '../../lib/labels/labels.ts';
import { formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { type Neighbour, neighbours } from './neighbours.ts';
import styles from './station.module.css';
import { formatValue, quantityLabel, unitLabel } from './value.ts';

// "Nabij gelegen metingen" (P10d): the nearest public station upstream and downstream, from the reach graph of the
// installed river release, each with its value at t from the snapshot already loaded (no new request). Every string
// that came from data (a station name) is a text node. A click opens that station like the map does.

type Value = Snapshot['values'][number];

interface Props {
  locale: Locale;
  station: ApiStation;
  /** Every station of the page: the neighbours' names and series, and the set the walk may stop at. */
  stations: readonly ApiStation[];
  values: ReadonlyMap<number, Value>;
  /** After now: the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  onSelect: (id: string) => void;
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false" className={styles.chevron}>
      <path d="M4 1.5L8.5 6 4 10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Nearby({ locale, station, stations, values, forecasts, onSelect }: Props) {
  const graph = useReachGraph().data;
  const byId = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const found = useMemo(
    () => (graph === undefined ? {} : neighbours(station.id, graph, new Set(byId.keys()))),
    [graph, station.id, byId],
  );
  const wanted = station.series[0]?.quantity;
  const rows = (
    [
      ['up', m.neighbour_upstream],
      ['down', m.neighbour_downstream],
    ] as const
  ).flatMap(([side, word]) => {
    const n: Neighbour | undefined = found[side];
    const other = n === undefined ? undefined : byId.get(n.id);
    if (n === undefined || other === undefined) return [];
    // The neighbour's series of the same quantity as the panel's first, else its first.
    const series = other.series.find((s) => s.quantity === wanted) ?? other.series[0];
    const value = series === undefined ? undefined : values.get(series.id);
    const forecast = series === undefined ? undefined : forecasts?.get(series.id);
    const shown = forecasts === undefined ? value : forecast;
    const direction = word({}, { locale });
    // Another river is always named, by our label or else in general words (owner decision 2).
    const river = n.crossRiver ? (riverName(n.riverId, locale) ?? m.neighbour_other_river({}, { locale })) : undefined;
    return [
      {
        side,
        id: other.id,
        where: river === undefined ? direction : m.neighbour_river({ direction, river }, { locale }),
        name: other.name,
        quantity: series === undefined ? '' : quantityLabel(series, locale),
        value:
          series === undefined || shown === undefined || shown.value === null
            ? undefined
            : `${formatValue(shown.value, series, locale)} ${unitLabel(series, locale)}`,
        time: shown === undefined ? undefined : formatLocal(Date.parse(shown.ts), locale),
      },
    ];
  });
  if (rows.length === 0) return null;
  const headingId = `${station.id}-near`;
  return (
    <section className={styles.nearby} aria-labelledby={headingId}>
      <h3 id={headingId}>{m.neighbours_heading({}, { locale })}</h3>
      <ul className={styles.nearList}>
        {rows.map((r) => (
          // By side: on a braided river the same station can be both.
          <li key={r.side}>
            <button type="button" className={styles.nearRow} onClick={() => onSelect(r.id)}>
              <span className={styles.nearText}>
                <span className={styles.nearWhere}>{r.where}</span>
                <span>{r.name}</span>
                <span>
                  {r.quantity}
                  {r.quantity === '' ? '' : ': '}
                  {r.value === undefined ? (
                    m.legend_no_value({}, { locale })
                  ) : (
                    <span className={styles.nearValue}>{r.value}</span>
                  )}
                </span>
                {r.time !== undefined && <span className={styles.nearWhere}>{r.time}</span>}
              </span>
              <Chevron />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
