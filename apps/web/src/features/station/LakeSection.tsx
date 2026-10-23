import type { ApiStation, State, StationRecent } from '@rws/contracts';
import { inSeason, monthDay } from '@rws/core/season';
import { useMemo } from 'react';
import { useOwnerSources, useRecent } from '../../lib/data/api.ts';
import type { WebWaterbody } from '../../lib/data/chain.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import type { WebForecast } from '../../lib/data/static.ts';
import { basisLabel } from '../../lib/labels/labels.ts';
import { lakeView } from '../../lib/lakes.ts';
import { lakeGauges } from '../../lib/water.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { BasisLabel } from './BasisLabel.tsx';
import styles from './lake.module.css';
import { stateWord } from './state.ts';
import near from './station.module.css';
import { formatNumber, formatValue, unitLabel } from './value.ts';

// The lake section of the panel of a station in a lake or the closed Haringvliet (P19b T2, issue #67, O-5): a lazy
// chunk of StationPanel. The body's name, the reference gauge (the lake's state is its own, D27: never the worst or an
// average), the other gauges, the spread (information, never a state), the season's level classes of the reference
// gauge (NL-4, valid at t) and the wind set-up note. Every name is a text node (invariant 3).

export interface LakeSectionProps {
  locale: Locale;
  /** The open station. */
  station: ApiStation;
  /** Its water body, of kind `lake` or `closed_estuary` (reaches file; names as text only). */
  body: WebWaterbody;
  /**
   * Every station of the page, the hidden (stale) ones too, as the map's lake popup reads them: a stale reference is
   * still the reference (its state "geen klasse"), never "no reference" (review CR-2).
   */
  stations: readonly ApiStation[];
  /** The values at t by series (lakeGauges, lakeView). */
  values: ReadonlyMap<number, PlayedValue>;
  /** After now: the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, WebForecast> | undefined;
  t: number;
  /** Live mode: the reference gauge's recent.json is asked again every minute. */
  live: boolean;
  /** The values are played-back hourly frames. */
  played: boolean;
  /** Open another station's panel. */
  onOpen: (id: string) => void;
}

type Ref = StationRecent['series'][number]['references'][number];

interface LevelClass {
  key: string;
  label: string;
  from: number | null;
  to: number | null;
  season: { from: number; to: number } | undefined;
}

/** The NL-4 stem of a workbook label: cut at the first `(` (no regex: labels run to 700 characters). */
const stemOf = (label: string) => (label.includes('(') ? label.slice(0, label.indexOf('(')) : label).trim();

/**
 * The NL-4 classes valid at `t`: the From and To rows of one priority and season are one class (only the seasons that
 * hold at t, #99). A bound is open where its row is missing. Values are canonical cm = native cm NAP.
 */
function levelClasses(refs: readonly Ref[], t: number, locale: Locale): LevelClass[] {
  const md = monthDay(t);
  const rows = refs.filter(
    (r) =>
      r.source === 'NL-4' &&
      (r.kind === 'NL4_FROM' || r.kind === 'NL4_TO') &&
      r.unit === 'cm' &&
      (r.season === undefined || inSeason(md, r.season.from, r.season.to)),
  );
  const groups = new Map<string, Ref[]>();
  for (const r of rows) {
    const key = `${r.priority}|${r.season?.from ?? ''}|${r.season?.to ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].flatMap(([key, g]) => {
    const raw = g.find((r) => r.label !== null)?.label;
    if (raw == null) return [];
    const stem = stemOf(raw);
    return [
      {
        key,
        label: basisLabel({ source: 'NL-4', kind: 'provider_class', ref: stem }, locale) ?? stem,
        from: g.find((r) => r.kind === 'NL4_FROM')?.value ?? null,
        to: g.find((r) => r.kind === 'NL4_TO')?.value ?? null,
        season: g[0]?.season,
      },
    ];
  });
}

/** "12 mei": an MMDD of the NL-4 calendar as a day and month (a leap year, so 29 February exists). */
const monthDayText = (md: number, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(Date.UTC(2000, Math.floor(md / 100) - 1, md % 100));

function rangeText(c: LevelClass, locale: Locale): string {
  const f = (v: number) => formatNumber(v, locale);
  if (c.from !== null && c.to !== null) return m.lake_class_range({ from: f(c.from), to: f(c.to) }, { locale });
  if (c.from !== null) return m.threshold_at_least({ value: f(c.from), unit: 'cm NAP' }, { locale });
  if (c.to !== null) return m.threshold_at_most({ value: f(c.to), unit: 'cm NAP' }, { locale });
  return '';
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false" className={near.chevron}>
      <path d="M4 1.5L8.5 6 4 10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function LakeSection({
  locale,
  station,
  body,
  stations,
  values,
  forecasts,
  t,
  live,
  played,
  onOpen,
}: LakeSectionProps) {
  const o = { locale };
  const ownerSources = useOwnerSources();
  const inBody = useMemo(() => stations.filter((st) => body.stations.includes(st.id)), [stations, body.stations]);
  const gauges = useMemo(() => lakeGauges(inBody, values, forecasts), [inBody, values, forecasts]);
  const view = useMemo(() => lakeView(body, gauges), [body, gauges]);
  const ref = inBody.find((st) => st.id === view.reference);
  const refH = ref?.series.find((s) => s.quantity === 'H');
  const recent = useRecent(refH === undefined ? undefined : ref?.id, live);
  const refRecent = recent.data?.series.find((s) => s.id === refH?.id);
  const classes = useMemo(
    () => (refH?.datum === 'NAP' ? levelClasses(refRecent?.references ?? [], t, locale) : []),
    [refH?.datum, refRecent, t, locale],
  );
  // A played value from a version 1 frame has no state (#112): "no data", never a class.
  const noState = (st: ApiStation) => {
    const h = st.series.find((s) => s.quantity === 'H');
    return played && forecasts === undefined && h !== undefined && values.get(h.id)?.stateUnknown === true;
  };
  const classWord = (st: ApiStation, state: State | null): string =>
    noState(st)
      ? m.reach_nodata({}, o)
      : state === null || state === 'no_ref'
        ? m.lake_no_class({}, o)
        : stateWord(state, locale);
  const headingId = `${station.id}-lake`;
  const others = inBody.filter((st) => st.id !== station.id && st.id !== view.reference);
  return (
    <section className={styles.lake} aria-labelledby={headingId}>
      <h3 id={headingId}>{locale === 'nl' ? body.name_nl : body.name_en}</h3>
      {ref === undefined ? (
        <p>{m.lake_no_reference({}, o)}</p>
      ) : (
        <>
          <p className={styles.reference}>
            <span className={styles.label}>{m.lake_reference_label({}, o)}: </span>
            {ref.id === station.id ? (
              <>
                {ref.name} ({m.lake_this_station({}, o)})
              </>
            ) : (
              <button type="button" className={styles.link} onClick={() => onOpen(ref.id)}>
                {ref.name}
              </button>
            )}
            {': '}
            <strong>{classWord(ref, view.state)}</strong>
          </p>
          {view.basis !== null && !noState(ref) && (
            <p className={styles.basis}>
              <BasisLabel locale={locale} basis={view.basis} warnings={undefined} ownerSources={ownerSources} />
            </p>
          )}
        </>
      )}
      {view.spread !== null && (
        <p className={styles.spread}>{m.lake_spread({ cm: formatNumber(view.spread.cm, locale) }, o)}</p>
      )}
      {others.length > 0 && (
        <>
          <h4>{m.lake_others({}, o)}</h4>
          <ul className={near.nearList}>
            {others.map((st) => {
              const series = st.series.find((s) => s.quantity === 'H');
              const g = gauges.get(st.id);
              return (
                <li key={st.id}>
                  <button type="button" className={near.nearRow} onClick={() => onOpen(st.id)}>
                    <span className={near.nearText}>
                      <span>{st.name}</span>
                      <span>
                        {series === undefined || g === undefined || g.value === null ? (
                          m.legend_no_value({}, o)
                        ) : (
                          <>
                            <span className={near.nearValue}>
                              {formatValue(g.value, series, locale)} {unitLabel(series, locale)}
                            </span>
                            {`, ${classWord(st, g.state)}`}
                          </>
                        )}
                      </span>
                    </span>
                    <Chevron />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {ref !== undefined && (
        <>
          <h4>{m.lake_classes_heading({}, o)}</h4>
          {classes.length === 0 ? (
            <p>{m.lake_no_classes({}, o)}</p>
          ) : (
            <ul className={styles.classes}>
              {classes.map((c) => (
                <li key={c.key}>
                  <span className={styles.label}>{c.label}</span>: {rangeText(c, locale)}
                  {c.season !== undefined &&
                    ` (${m.lake_class_season({ from: monthDayText(c.season.from, locale), to: monthDayText(c.season.to, locale) }, o)})`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className={near.note}>{m.lake_wind_setup({}, o)}</p>
    </section>
  );
}
