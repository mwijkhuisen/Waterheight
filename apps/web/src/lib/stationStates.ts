import type { ApiStation, Snapshot } from '@rws/contracts';
import { SUSPECT_BITS } from '@rws/core/qc';
import { type DhBin, dhBin, levelOf, type QSize, qSize } from '../features/legend/palette.ts';
import type { Change } from './data/change.ts';
import type { WebForecast } from './data/static.ts';

// The feature-state contract of the station markers (P10a T3): one plain record per station, computed once per t
// and mode, written with `setFeatureState` only (the source is never rebuilt). The table, popup and panel read the
// same record, so the map is never the only place a cue appears. Pure.

type Value = Snapshot['values'][number];

export interface StationState {
  /** A value at t (up to now), or a forecast at t (after now). */
  has: boolean;
  /** Every value at t is older than twice its series' step (the value is carried forward). */
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
}

export function stationStates({
  stations,
  values,
  forecasts,
  changes,
  ownerSources,
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
      if (l > level || (l === level && v.section && !section)) {
        level = l;
        section = v.section;
      }
    }
    const trendSeries = st.series.find((s) => s.quantity === 'H' && changes?.get(s.id)) ?? qSeries;
    const change = trendSeries === undefined ? undefined : changes?.get(trendSeries.id);
    const q = qSeries === undefined ? undefined : values.get(qSeries.id);
    out.set(st.id, {
      has,
      stale: has && !fresh,
      forecast: false,
      estimate: false,
      level,
      section: level > 0 && section,
      suspect,
      dhBin: change == null || trendSeries === undefined ? null : dhBin(change, trendSeries.quantity),
      qSize: qSeries === undefined ? null : q === undefined ? 0 : qSize(q.value),
      owner,
    });
  }
  return out;
}
