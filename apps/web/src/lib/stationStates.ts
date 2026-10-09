import type { ApiStation, Snapshot } from '@rws/contracts';
import { SUSPECT_BITS } from '@rws/core/qc';
import { type DhBin, dhBin, levelOf, type QSize, qSize } from '../features/legend/palette.ts';
import type { Change } from './data/change.ts';
import type { WebForecast } from './data/static.ts';

// The feature-state contract of the station markers (P10a T3): one plain record per station, computed once per t
// and mode, written with `setFeatureState` only (the source is never rebuilt). The table, popup and panel read the
// same record, so the map is never the only place a cue appears. Pure.

type Value = Snapshot['values'][number];

/** A series with no value at t is hidden once its newest value is older than this (A§10: hidden after 25 h). */
export const HIDE_AFTER_S = 25 * 3600;

/** A series with no value at t whose newest value is known (KG-233): stale past its limit, hidden after 25 h. */
export interface Lapse {
  hidden: boolean;
  /** The age of its newest value at t, in seconds. */
  ageSeconds: number;
}

/**
 * `lastAges`: latest.json's `lapsed`/`lapsedAge` by series (current bucket only; undefined elsewhere, where no series
 * is lapsed). A series that never had a value (null) or has one within its limit is not lapsed: it is just empty.
 */
export function lapses(
  stations: readonly ApiStation[],
  values: ReadonlyMap<number, Value>,
  lastAges: ReadonlyMap<number, number | null> | undefined,
): Map<number, Lapse> {
  const out = new Map<number, Lapse>();
  if (lastAges === undefined) return out;
  for (const st of stations)
    for (const s of st.series) {
      const age = lastAges.get(s.id);
      // The at-t functions keep a value only while ts > t − limit, so an age of exactly the limit is lapsed too.
      if (values.has(s.id) || age == null || age < s.stalenessLimitSeconds) continue;
      out.set(s.id, { hidden: age > HIDE_AFTER_S, ageSeconds: age });
    }
  return out;
}

/**
 * The ids of the hidden stations as one string: it changes only when the hidden set does, so the visible list can
 * be memoised on it (a new `states` every snapshot must not rebuild the map's source and popup).
 */
export const hiddenKey = (states: ReadonlyMap<string, StationState>): string =>
  [...states].flatMap(([id, s]) => (s.hidden ? [id] : [])).join('\n');

/** The stations not named in `hiddenKey`'s string. */
export function visibleStations<T extends { id: string }>(stations: readonly T[], key: string): readonly T[] {
  if (key === '') return stations;
  const hidden = new Set(key.split('\n'));
  return stations.filter((st) => !hidden.has(st.id));
}

export interface StationState {
  /** A value at t (up to now), or a forecast at t (after now). */
  has: boolean;
  /**
   * Every value at t is older than twice its series' step (the value is carried forward); or, with no value at t
   * (`has` false), a series' newest value is past its staleness limit and under 25 hours old (KG-233: a small
   * grey dot, "no value within the staleness limit").
   */
  stale: boolean;
  /** t is after now: `has` means a forecast, `level` is the forecast's state. */
  forecast: boolean;
  /** After now: every forecast of the station is an estimate. */
  estimate: boolean;
  /** The highest state among the station's values (or forecasts) at t: 0 no_ref … 5 extreme (palette LADDER). */
  level: number;
  /** That state comes from an area class (a section), not from the gauge: a badge. */
  section: boolean;
  /** Any value at t has a suspect QC bit (provider-suspect, range, spike, frozen): a dashed ring and an "!". */
  suspect: boolean;
  /** The 24-hour change of the station's H series (else its Q series' trend): null when not known or after now. */
  dhBin: DhBin | null;
  /** The discharge class of the station's Q series at t: null when the station has no Q series, 0 without a value. */
  qSize: QSize | null;
  /** The station has a series of an owner-audience source (owner site only): a ring and an "owner only" badge. */
  owner: boolean;
  /** No value at t, and every series' newest value is older than 25 hours (KG-233): not drawn, listed or found. */
  hidden: boolean;
}

export interface StatesInput {
  stations: readonly ApiStation[];
  values: ReadonlyMap<number, Value>;
  /** After now: the forecasts at t by series (undefined for a t up to now). */
  forecasts: ReadonlyMap<number, Pick<WebForecast, 'estimate' | 'state'>> | undefined;
  /** The 24-hour change by series (useChanges); undefined when not known. */
  changes: ReadonlyMap<number, Change> | undefined;
  /** The owner-audience source ids (useOwnerSources; empty on the public site). */
  ownerSources: ReadonlySet<string>;
  /** The lapsed series (see `lapses`); none when omitted. */
  lapsed?: ReadonlyMap<number, Lapse> | undefined;
}

export function stationStates({
  stations,
  values,
  forecasts,
  changes,
  ownerSources,
  lapsed,
}: StatesInput): Map<string, StationState> {
  const out = new Map<string, StationState>();
  for (const st of stations) {
    const owner = st.series.some((s) => ownerSources.has(s.source));
    const qSeries = st.series.find((s) => s.quantity === 'Q');
    if (forecasts !== undefined) {
      const found = st.series.flatMap((s) => forecasts.get(s.id) ?? []);
      out.set(st.id, {
        has: found.length > 0,
        stale: false,
        forecast: true,
        estimate: found.length > 0 && found.every((f) => f.estimate),
        level: Math.max(0, ...found.map((f) => (f.state === null ? 0 : levelOf(f.state)))),
        section: false,
        suspect: false,
        dhBin: null,
        qSize: null,
        owner,
        hidden: false,
      });
      continue;
    }
    let has = false;
    let fresh = false;
    let level = 0;
    let section = false;
    let suspect = false;
    for (const s of st.series) {
      const v = values.get(s.id);
      if (v === undefined) continue;
      has = true;
      if (v.ageSeconds <= 2 * s.expectedStepSeconds) fresh = true;
      if ((v.qc & SUSPECT_BITS) !== 0) suspect = true;
      const l = levelOf(v.state);
      if (l > level || (l === level && !v.section && section)) {
        level = l;
        section = v.section;
      }
    }
    const trendSeries = st.series.find((s) => s.quantity === 'H' && changes?.get(s.id)) ?? qSeries;
    const change = trendSeries === undefined ? undefined : changes?.get(trendSeries.id);
    const q = qSeries === undefined ? undefined : values.get(qSeries.id);
    out.set(st.id, {
      has,
      // A station with no value is stale when a series' newest value is past its limit (and under 25 h).
      stale: has ? !fresh : st.series.some((s) => lapsed?.get(s.id)?.hidden === false),
      forecast: false,
      estimate: false,
      level,
      section: level > 0 && section,
      suspect,
      dhBin: change == null || trendSeries === undefined ? null : dhBin(change, trendSeries.quantity),
      qSize: qSeries === undefined ? null : q === undefined ? 0 : qSize(q.value),
      owner,
      hidden: !has && st.series.length > 0 && st.series.every((s) => lapsed?.get(s.id)?.hidden === true),
    });
  }
  return out;
}
