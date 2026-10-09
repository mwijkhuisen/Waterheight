import type { ApiStation } from '@rws/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { attributionText } from '../../../lib/attribution.ts';
import { useFrames, useReachGraph, useRivers } from '../../../lib/data/api.ts';
import type { WebMeta } from '../../../lib/data/chain.ts';
import { riverName } from '../../../lib/labels/labels.ts';
import { floorHour, formatDay, formatLocal, HOUR_MS, ZONE } from '../../../lib/time/time.ts';
import { HOV_PATHS, type HovPathId } from '../../../lib/url/url.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import type { Playback } from '../playback/usePlayback.ts';
import type { HovChart, HovData } from './chart.ts';
import { buildGrid, hoursOf, hovFetch, hovRows } from './grid.ts';
import { changeText, gapText, HovTable, hourLabel } from './HovTable.tsx';
import styles from './hovmoller.module.css';
import { buildPath, type Column } from './path.ts';

// "Langs de rivier / Along the river" (P11c, issue #26, a lazy chunk of the viewer): x = river km (upstream left, the
// NL entry at 0), y = hourly time, colour = the map's 24-hour change (Δ; the State has no per-hour value, D-2 and
// KG-270). The panel asks the hourly frames itself (the page's own frames exist only while playing) for the 7-day
// page that holds t. A click on a cell (or its table twin) pauses playback, moves t to that hour and opens the
// station. ECharts loads on first use, in its own chunk.

export interface HovmollerPanelProps {
  locale: Locale;
  meta: WebMeta | undefined;
  /** Every station of this site (the full list, not the map's: a lapsed station is still a column, with grey cells). */
  stations: readonly ApiStation[];
  ownerSources: ReadonlySet<string>;
  playback: Playback;
  /** The page's t. */
  t: number;
  setT: (t: number) => void;
  /** The selected station (`?s=`): its column is outlined. */
  selected: string | undefined;
  open: (id: string) => void;
  path: HovPathId;
  onPath: (path: HovPathId) => void;
  onClose: () => void;
}

const NONE: readonly Column[] = [];

function pathName(id: HovPathId, locale: Locale): string {
  const o = { locale };
  switch (id) {
    case 'rhine-waal':
      return m.hov_path_rhine_waal({}, o);
    case 'rhine-lek':
      return m.hov_path_rhine_lek({}, o);
    case 'rhine-ijssel':
      return m.hov_path_rhine_ijssel({}, o);
    case 'meuse':
      return m.hov_path_meuse({}, o);
  }
}

export function HovmollerPanel({
  locale,
  meta,
  stations,
  ownerSources,
  playback,
  t,
  setT,
  selected,
  open,
  path,
  onPath,
  onClose,
}: HovmollerPanelProps) {
  const o = { locale };
  const id = useId();
  const graph = useReachGraph();
  const rivers = useRivers().data?.rivers;
  const [table, setTable] = useState(false);
  const [all, setAll] = useState(false);
  const [failed, setFailed] = useState(false);

  const built = useMemo(
    () => (graph.data === undefined ? undefined : buildPath(path, graph.data, stations, ownerSources)),
    [graph.data, path, stations, ownerSources],
  );
  const columns = built?.columns ?? NONE;

  // The page of rows that holds t (primitives, so a playback tick inside the page changes nothing here).
  const displayStart = meta === undefined ? 0 : Date.parse(meta.displayStart);
  const rows = hovRows(t, playback.range);
  const from = rows?.from;
  const to = rows?.to;
  const span = useMemo(() => (from === undefined || to === undefined ? null : { from, to }), [from, to]);
  const hours = useMemo(() => (span === null ? [] : hoursOf(span)), [span]);
  const win = span === null ? undefined : hovFetch(span, displayStart);
  const frames = useFrames(win, meta, stations);
  // A row whose bucket (h − 1 h) is before the display range is never asked: it is grey, not loading.
  const complete =
    frames !== undefined && win !== undefined && hours.every((h) => h - HOUR_MS < win.from || frames.ready(h));
  const cells = useMemo(
    () => (built === undefined || frames === undefined ? undefined : buildGrid(built.columns, stations, hours, frames)),
    [built, stations, hours, frames],
  );

  // Provider text (names, rivers) is only ever data: strings for the canvas and text nodes for the table.
  const riverText = useCallback(
    (riverId: string): string => {
      const r = rivers?.find((x) => x.id === riverId);
      return riverName(riverId, locale) ?? (r === undefined ? riverId : locale === 'nl' ? r.name_nl : r.name_en);
    },
    [rivers, locale],
  );
  const data = useMemo((): HovData | undefined => {
    if (built === undefined || cells === undefined || built.columns.length === 0) return undefined;
    const badge = m.owner_badge({}, { locale });
    return {
      columns: built.columns,
      gaps: built.gaps,
      cells,
      rowLabels: hours.map((h) => hourLabel(h, locale)),
      colLabels: built.columns.map((c) => (c.owner ? `${c.name} · ${badge}` : c.name)),
      gapTexts: built.gaps.map((g) => gapText(g, locale)),
      tip: (ci, ri) => {
        const c = built.columns[ci];
        const cell = cells[ri]?.[ci];
        const h = hours[ri];
        if (c === undefined || cell === undefined || h === undefined) return '';
        return [
          c.owner ? `${c.name} · ${badge}` : c.name,
          riverText(c.riverId),
          formatLocal(h, locale),
          `${m.dh_label({}, { locale })}: ${changeText(cell, locale)}`,
        ].join('\n');
      },
    };
    // `columns` is derived from `built`.
  }, [built, cells, hours, locale, riverText]);

  const { pause } = playback;
  const pickHour = useCallback(
    (hour: number) => {
      pause();
      setT(hour);
    },
    [pause, setT],
  );
  const pick = useRef<(column: number, row: number) => void>(() => {});
  pick.current = (ci, ri) => {
    const c = columns[ci];
    const h = hours[ri];
    if (c === undefined || h === undefined) return;
    pickHour(h);
    open(c.id);
  };

  // The chart, only in the chart view; its chunk loads on first use.
  const box = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<HovChart | null>(null);
  const drawn = !table && columns.length > 0;
  useEffect(() => {
    const el = box.current;
    if (!drawn || el === null) return;
    setFailed(false);
    let gone = false;
    let made: HovChart | undefined;
    import('./chart.ts')
      .then(({ createHovChart }) => {
        if (gone) return;
        made = createHovChart(el, (ci, ri) => pick.current(ci, ri));
        setChart(made);
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      made?.dispose();
      setChart(null);
    };
  }, [drawn]);
  useEffect(() => {
    if (chart !== null && data !== undefined) chart.update(data);
  }, [chart, data]);

  // The t line (when t is on a row) and the selected station's column move on their own small series.
  const row = hours.indexOf(floorHour(t));
  const column = columns.findIndex((c) => c.id === selected);
  useEffect(() => {
    chart?.mark({ row: row < 0 ? undefined : row, column: column < 0 ? undefined : column });
  }, [chart, row, column]);

  // The e2e hook (build-time constant: the production bundle holds no trace of it).
  useEffect(() => {
    if (import.meta.env.MODE !== 'e2e' || built === undefined) return;
    const cellIndex = (cid: string, iso: string): [number, number] => [
      columns.findIndex((c) => c.id === cid),
      hours.indexOf(Date.parse(iso)),
    ];
    window.__rwsHov = {
      chart: chart?.instance ?? null,
      path,
      columns: columns.map((c) => ({ id: c.id, x: c.x })),
      rows: hours.map((h) => new Date(h).toISOString()),
      cellAt(cid, iso) {
        const [ci, ri] = cellIndex(cid, iso);
        return ci < 0 || ri < 0 ? undefined : cells?.[ri]?.[ci];
      },
      pixelOf(cid, iso) {
        const [ci, ri] = cellIndex(cid, iso);
        return ci < 0 || ri < 0 ? undefined : chart?.pixelOf(ci, ri);
      },
    };
    return () => {
      window.__rwsHov = undefined;
    };
  }, [built, columns, hours, cells, chart, path]);

  const name = pathName(path, locale);
  const credits = useMemo(() => {
    const date = formatDay(Math.min(t, hours.at(-1) ?? t), locale, ZONE);
    return [...new Set((frames?.attribution() ?? []).map((a) => attributionText(a.text, a.dateKind !== null, date)))];
  }, [frames, t, hours, locale]);
  const hint = `${id}-state`;

  return (
    <section className={styles.panel} aria-label={m.hov_region({}, o)}>
      <div className={styles.head}>
        <label className={styles.field}>
          {m.hov_path_label({}, o)}
          <select
            value={path}
            onChange={(e) => {
              const next = HOV_PATHS.find((p) => p === e.target.value);
              if (next !== undefined) onPath(next);
            }}
          >
            {HOV_PATHS.map((p) => (
              <option key={p} value={p}>
                {pathName(p, locale)}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.colour}>{m.hov_colour({}, o)}</span>
        <button type="button" disabled aria-describedby={hint} title={m.hov_state_hint({}, o)}>
          {m.mode_state({}, o)}
        </button>
        <span id={hint} className={styles.note}>
          {m.hov_state_hint({}, o)}
        </span>
        <button type="button" aria-pressed={table} onClick={() => setTable((v) => !v)}>
          {m.hov_table_toggle({}, o)}
        </button>
        <button type="button" className={styles.close} aria-label={m.hov_close({}, o)} onClick={onClose}>
          {/* An icon, not a one-character text: axe cannot judge the contrast of a lone glyph (StationPanel). */}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      {built !== undefined && columns.length === 0 && <p className={styles.status}>{m.hov_empty({}, o)}</p>}
      {graph.isError && <p className={styles.status}>{m.hov_empty({}, o)}</p>}
      {failed && <p role="alert">{m.data_unavailable({}, o)}</p>}
      {!complete && !graph.isError && (built === undefined || columns.length > 0) && (
        <p role="status" className={styles.status}>
          {m.hov_loading({}, o)}
        </p>
      )}
      {drawn && <div ref={box} className={styles.chart} role="img" aria-label={m.hov_chart_label({ path: name }, o)} />}
      {table && built !== undefined && columns.length > 0 && cells !== undefined && (
        <HovTable
          locale={locale}
          pathName={name}
          path={built}
          hours={hours}
          cells={cells}
          t={t}
          selected={selected}
          all={all}
          onAll={() => setAll(true)}
          onHour={pickHour}
          onStation={open}
        />
      )}
      {credits.length > 0 && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard
        <p className={styles.sources} tabIndex={0}>
          {m.hov_sources({ sources: credits.join(' · ') }, o)}
        </p>
      )}
    </section>
  );
}
