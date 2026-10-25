import type { ApiStation, Snapshot, WATERBODY_KINDS } from '@rws/contracts';
import { SUSPECT_BITS } from '@rws/core/qc';
import { levelOf } from '../features/legend/palette.ts';
import type { WebForecast } from './data/static.ts';
import { type LakeBody, type LakeGauge, type LakeView, lakeView } from './lakes.ts';
import type { Group } from './url/url.ts';

// The lakes, coast and sea (P19a T1, issue #67): pure and DOM-free, eager (StationsMap's hide logic and the station
// states read it; the lake and canal layers themselves are the lazy features/map/waterLayer.ts, which takes its ids
// from here). A station's group comes from the reaches file's water bodies (owner decision O-3). Honest display: a
// coast station is coloured by its surge only and is hollow without one, so a measured MSL level never meets a NAP
// scale or an NL-4 class; a lake is the colour of its D27 reference gauge's own state, never an average.

export type { Group } from './url/url.ts';

/** The water layers (features/map/waterLayer.ts): the lake fill, its tidal hatch and outline, and the canal lines. */
export const WATER_LAKES = 'water-lakes';
export const WATER_LAKES_TIDAL = 'water-lakes-tidal';
export const WATER_LAKES_LINE = 'water-lakes-line';
export const WATER_CANALS = 'water-canals';

/**
 * WATERBODY_KINDS (packages/contracts reaches.ts), copied: a value import from here would split the contracts module
 * into a chunk of its own, shared with the lazy water chunk. The type holds the copy to the same kinds in the same order.
 */
const KINDS: typeof WATERBODY_KINDS = ['lake', 'closed_estuary', 'estuary', 'sea'];
type WaterbodyKind = (typeof KINDS)[number];
/** A reaches-file water body (the fields used; lib/data/contracts.ts reads them leniently). */
export type WaterBody = LakeBody & { id: string; kind: WaterbodyKind };

const GROUP: Readonly<Record<WaterbodyKind, Group>> = {
  lake: 'lakes',
  closed_estuary: 'lakes',
  estuary: 'coast',
  sea: 'coast',
};
const isLake = (b: WaterBody) => GROUP[b.kind] === 'lakes';

/**
 * P19b: the water body a station lies in, by the order of groupsOf: a lake, then a closed estuary, an estuary, a sea;
 * undefined for a river station. Here, not in the lazy tide chunk: the lazy StationPanel reads it.
 */
export function bodyOf<B extends { kind: string; stations: readonly string[] }>(
  stationId: string,
  bodies: readonly B[],
): B | undefined {
  const rank = (b: B) => KINDS.indexOf(b.kind as WaterbodyKind);
  return bodies.filter((b) => b.stations.includes(stationId)).sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The group of every station in a water body: a lake or the closed Haringvliet → lakes, a sea or estuary → coast. A
 * station in no body is absent (rivers). A station listed in two bodies takes the first by WATERBODY_KINDS order.
 */
export function groupsOf(bodies: readonly WaterBody[]): Map<string, Group> {
  const out = new Map<string, Group>();
  const rank = (b: WaterBody) => KINDS.indexOf(b.kind);
  for (const body of [...bodies].sort((a, b) => rank(a) - rank(b)))
    for (const id of body.stations) if (!out.has(id)) out.set(id, GROUP[body.kind]);
  return out;
}

/**
 * The map layer's group for `?hide=`, or undefined for a layer no toggle touches: every `rivers…` layer (base,
 * highlight, the reach colouring, the flow) and the canals are rivers, the lake layers lakes. The flow layers are
 * set again by their own handle (FlowHandle.setHidden) right after, whose clock decides which of them show.
 */
export function layerGroup(id: string): Group | undefined {
  if (id === WATER_CANALS || id.startsWith('rivers')) return 'rivers';
  if (id.startsWith(WATER_LAKES)) return 'lakes';
  return undefined;
}

type Value = Snapshot['values'][number];

/**
 * A station's primary H series: its first H series. The public files list primary series only (the `pub_*` views
 * take `role = 'primary'`), in series id order, so this is one fixed series per station.
 */
const hSeries = (st: ApiStation) => st.series.find((s) => s.quantity === 'H');

/** The primary H series is in MSL (the North Sea platforms): never on a NAP scale. */
export const isMsl = (st: ApiStation): boolean => hSeries(st)?.datum === 'MSL';

/**
 * Each station's gauge at t from its primary H series, for `lakeView`: up to now (and during play, whose values come
 * from the frames) the values at t; after now (`forecasts` defined) the forecast's value and state only. A station
 * without an H series, or without a value at t, is absent.
 */
export function lakeGauges(
  stations: readonly ApiStation[],
  values: ReadonlyMap<number, Value>,
  forecasts: ReadonlyMap<number, Pick<WebForecast, 'value' | 'state' | 'basis'>> | undefined,
): Map<string, LakeGauge> {
  const out = new Map<string, LakeGauge>();
  for (const st of stations) {
    const h = hSeries(st);
    if (h === undefined) continue;
    const tidal = st.flags.tidal === true;
    if (forecasts !== undefined) {
      const f = forecasts.get(h.id);
      // A forecast without a state (the static fallback) has no class: no_ref, so the lake shows "geen klasse".
      if (f !== undefined)
        out.set(st.id, {
          quantity: 'H',
          datum: h.datum,
          value: f.value,
          state: f.state ?? 'no_ref',
          basis: f.basis,
          tidal,
          suspect: false,
        });
      continue;
    }
    const v = values.get(h.id);
    if (v !== undefined)
      out.set(st.id, {
        quantity: 'H',
        datum: h.datum,
        value: v.value,
        state: v.state,
        basis: v.basis,
        tidal,
        suspect: (v.qc & SUSPECT_BITS) !== 0,
      });
  }
  return out;
}

export interface LakeLevel {
  /** The reference gauge's state as a LADDER index (1 low … 5 extreme), null for "geen klasse" (none, or no_ref). */
  level: number | null;
  view: LakeView;
}

/** The level of every lake and the Haringvliet (D27): the reference gauge's own state through `lakeView`, never averaged. */
export function lakeLevels(
  bodies: readonly WaterBody[],
  byStation: ReadonlyMap<string, LakeGauge>,
): Map<string, LakeLevel> {
  const out = new Map<string, LakeLevel>();
  for (const body of bodies) {
    if (!isLake(body)) continue;
    const view = lakeView(body, byStation);
    out.set(body.id, { level: view.state === null || view.state === 'no_ref' ? null : levelOf(view.state), view });
  }
  return out;
}

/**
 * The surge (cm) of a station's primary H series at t: the value's `tide.surge` up to now, the forecast's after now;
 * null without one. Played values carry no `tide`, so a coast point is hollow while frames play (owner decision O-1).
 */
export function surgeAt(
  st: ApiStation,
  values: ReadonlyMap<number, Value>,
  forecasts: ReadonlyMap<number, Pick<WebForecast, 'tide'>> | undefined,
): number | null {
  const h = hSeries(st);
  if (h === undefined) return null;
  const tide = forecasts === undefined ? values.get(h.id)?.tide : forecasts.get(h.id)?.tide;
  return tide?.surge ?? null;
}
