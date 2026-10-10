import type { ApiStation } from '@rws/contracts';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { chartSpan, useRecent, useSources } from '../../lib/data/api.ts';
import type { Change } from '../../lib/data/change.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import type { WarningsAt } from '../../lib/data/warnings.ts';
import type { Lapse, StationState } from '../../lib/stationStates.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { Nearby } from './Nearby.tsx';
import { SeriesSection } from './SeriesSection.tsx';
import styles from './station.module.css';

// P11a: the upstream chain is a lazy chunk (its walk and texts load with the first panel, never with the page).
const UpstreamChain = lazy(() => import('../flow/UpstreamChain.tsx').then((c) => ({ default: c.UpstreamChain })));

// The station panel (A§10 features/station), after the waterinfo layout (P10d, issue #96): a header with the name as
// published (text) and a close button; the controls for all series (Grafiek or Tabel, the period, the thresholds);
// per series its last measurement, chart or table, legends and facts; the nearest stations up and down the river;
// the upstream chain (P11a).
// After now (P8b) a series shows its forecast at t instead. The state of the controls is the panel's own (no URL key)
// and returns to its defaults when another station is opened.

type Value = PlayedValue;

/** The periods of the select (days back from the chart's end), 7 being today's. */
const PERIODS = [2, 7, 14] as const;

interface Props {
  locale: Locale;
  station: ApiStation;
  /** Every station of the page (the neighbours' names and values). */
  stations: readonly ApiStation[];
  values: ReadonlyMap<number, Value>;
  /** P11a: the feature-state record of every station at t (the upstream chain's state words). */
  states: ReadonlyMap<string, StationState>;
  /** After now: the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  /** P10a: the 24-hour change by series. */
  changes: ReadonlyMap<number, Change> | undefined;
  /** KG-233: the series with no value whose newest value is past its limit (or over 25 hours old). */
  lapsed: ReadonlyMap<number, Lapse>;
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
  /** The first day the page has data for. */
  displayStart: number;
  /** The settled t the chart's span is cut from (t itself while it moves: see App). */
  chartAt: number;
  /** Move the focus to the heading when the panel opens. */
  focus: boolean;
  onClose: () => void;
  /** Open another station (a neighbour). */
  onSelect: (id: string) => void;
  /** P11b: the values are played-back hourly frames (no state, basis or class). */
  played?: boolean;
}

export function StationPanel({
  locale,
  station,
  stations,
  values,
  states,
  forecasts,
  changes,
  lapsed,
  warnings,
  ownerSources,
  live,
  serverNow,
  t,
  dataEpoch,
  displayStart,
  chartAt,
  played = false,
  focus,
  onClose,
  onSelect,
}: Props) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const recent = useRecent(station.id, live);
  const sourceDocs = useSources().data?.sources;
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const [showThresholds, setShowThresholds] = useState(true);
  const span = chartSpan(chartAt, displayStart, serverNow, days);
  // The panel mounts anew for each station (keyed by it); opened from the map or the table, it takes the focus.
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  const sourceIds = [...new Set(station.series.map((s) => s.source))];
  const o = { locale };

  return (
    <aside className={styles.panel} aria-labelledby={`${id}-h`}>
      <div className={styles.head}>
        <h2 id={`${id}-h`} ref={heading} tabIndex={-1}>
          {station.name}
        </h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label={m.panel_close({}, o)}>
          {/* An icon, not a one-character text: axe cannot judge the contrast of a lone glyph (review round 2). */}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      <div className={styles.body}>
        <dl className={styles.facts}>
          {station.waterName !== null && (
            <>
              <dt>{m.panel_water({}, o)}</dt>
              <dd>{station.waterName}</dd>
            </>
          )}
          <dt>{m.panel_source({}, o)}</dt>
          <dd>{sourceIds.join(', ')}</dd>
        </dl>
        {(station.flags.tidal === true || station.flags.impounded === true) && (
          <ul className={styles.notes}>
            {station.flags.tidal === true && <li>{m.tidal_note({}, o)}</li>}
            {station.flags.impounded === true && <li>{m.impounded_note({}, o)}</li>}
          </ul>
        )}
        <div className={styles.controls}>
          <fieldset className={styles.segment}>
            <legend>{m.panel_view_label({}, o)}</legend>
            {(['chart', 'table'] as const).map((v) => (
              <label key={v}>
                <input type="radio" name={`${id}-view`} checked={view === v} onChange={() => setView(v)} />
                <span>{v === 'chart' ? m.panel_view_chart({}, o) : m.panel_view_table({}, o)}</span>
              </label>
            ))}
          </fieldset>
          <label className={styles.period}>
            {m.panel_range_label({}, o)}
            <select value={days} onChange={(e) => setDays(Number(e.currentTarget.value) as (typeof PERIODS)[number])}>
              {PERIODS.map((d) => (
                <option key={d} value={d}>
                  {m.panel_range_days({ days: d }, o)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={showThresholds}
              onChange={(e) => setShowThresholds(e.currentTarget.checked)}
            />
            {m.thresholds_show({}, o)}
          </label>
        </div>
        {station.series.map((series) => (
          <SeriesSection
            key={series.id}
            locale={locale}
            station={station}
            headingId={`${id}-${series.id}`}
            series={series}
            values={values}
            forecasts={forecasts}
            changes={changes}
            lapse={lapsed.get(series.id)}
            warnings={warnings}
            ownerSources={ownerSources}
            sourceDocs={sourceDocs}
            recent={recent.data?.series.find((s) => s.id === series.id)}
            recentFailed={recent.isError}
            t={t}
            serverNow={serverNow}
            dataEpoch={dataEpoch}
            span={span}
            days={days}
            view={view}
            showThresholds={showThresholds}
            played={played}
          />
        ))}
        <Nearby
          locale={locale}
          station={station}
          stations={stations}
          values={values}
          forecasts={forecasts}
          onSelect={onSelect}
        />
        <Suspense fallback={null}>
          <UpstreamChain
            locale={locale}
            station={station}
            stations={stations}
            states={states}
            values={values}
            ownerSources={ownerSources}
            played={played}
            onSelect={onSelect}
          />
        </Suspense>
        <p className={styles.note}>{m.not_comparable({}, o)}</p>
      </div>
    </aside>
  );
}
