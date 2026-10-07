import { useMemo, useState } from 'react';
import { formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { clampPage, PAGE_SIZE, pageCount, pageRange } from '../table/page.ts';
import { type SeriesRow, seriesRows } from './seriesRows.ts';
import styles from './station.module.css';
import type { SeriesData } from './useSeriesData.ts';
import { formatNumber } from './value.ts';

// The "Tabel" view of one series (P10d): the points of the chart as rows, newest first, 100 to a page. No scroll
// wrapper (a clipped table cannot be judged by axe), its own pager; every cell is a text node.

interface Props {
  locale: Locale;
  /** The quantity as the panel's heading says it. */
  quantity: string;
  /** The unit with its zero. */
  unit: string;
  data: Pick<SeriesData, 'points' | 'view'>;
}

const EMPTY = '–';

export function SeriesTable({ locale, quantity, unit, data }: Props) {
  const rows = useMemo(() => seriesRows(data.points, data.view), [data.points, data.view]);
  const [page, setPage] = useState(0);
  const current = clampPage(page, rows.length);
  const range = pageRange(current, rows.length);
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const forecast = data.view !== undefined;
  const o = { locale };
  const cell = (r: SeriesRow) =>
    r.forecast === null
      ? EMPTY
      : r.band === null
        ? formatNumber(r.forecast, locale)
        : `${formatNumber(r.forecast, locale)} (${formatNumber(r.band[0], locale)}–${formatNumber(r.band[1], locale)})`;
  return (
    <div>
      <table className={styles.seriesTable}>
        <caption>{m.series_table_caption({ quantity }, o)}</caption>
        <thead>
          <tr>
            <th scope="col">{m.series_table_time({}, o)}</th>
            <th scope="col">
              {m.series_table_measured({}, o)} ({unit})
            </th>
            {forecast && (
              <th scope="col">
                {m.series_table_forecast({}, o)} ({unit})
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.ts}>
              <td>
                <time dateTime={new Date(r.ts).toISOString()}>{formatLocal(r.ts, locale)}</time>
              </td>
              <td>{r.measured === null ? EMPTY : formatNumber(r.measured, locale)}</td>
              {forecast && <td>{cell(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.pager}>
        <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
          {m.series_table_later({}, o)}
        </button>
        <span aria-live="polite">{m.series_table_rows({ from: range.from, to: range.to, total: rows.length }, o)}</span>
        <button type="button" disabled={current >= pageCount(rows.length) - 1} onClick={() => setPage(current + 1)}>
          {m.series_table_earlier({}, o)}
        </button>
      </div>
    </div>
  );
}
