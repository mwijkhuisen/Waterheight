import { ApiStation } from '@rws/contracts';
import { SPEEDS, type Speed } from '../../features/flow/playback/engine.ts';
import type { Locale } from '../../paraglide/runtime.js';
import { pathOf, type RouteId } from '../routes.ts';
import { parseUrlT, toUrlT } from '../time/time.ts';

// The view lives in the URL (A§10): `?t=2026-11-20T14:00Z&s=nl.rws.lobith.bovenrijn.tolkamer&mode=delta&river=waal`.
// A value that does not parse is dropped (t falls back to now, s to no selection, mode to the default, river to
// none); it is never thrown and never rendered.

/** The map modes (P10a): the classified state, the 24-hour change, the discharge. */
export const MODES = ['state', 'delta', 'q'] as const;
export type Mode = (typeof MODES)[number];

/** P11c: the Hovmöller panel's paths (features/flow/hovmoller/path.ts); here so the URL never loads the lazy panel. */
export const HOV_PATHS = ['rhine-waal', 'rhine-lek', 'rhine-ijssel', 'meuse'] as const;
export type HovPathId = (typeof HOV_PATHS)[number];

/** P19a (O-3): the layer groups `?hide=` can switch off, in their canonical order; here so the URL loads no map chunk. */
export const LAYER_GROUPS = ['rivers', 'lakes', 'coast'] as const;
export type Group = (typeof LAYER_GROUPS)[number];

export interface UrlState {
  /** A quantised UTC instant, or undefined for "now". */
  t: number | undefined;
  /** A station id in registry format (≤ 80 characters), or undefined. */
  s: string | undefined;
  /** The map mode; undefined for the default (status.json, D10). Written only when the user changes it. */
  mode?: Mode | undefined;
  /** A river id of reaches-<ver>.json to highlight; checked against that file once it has loaded (useReaches). */
  river?: string | undefined;
  /**
   * P11b: the playback speed, written while playing and after a pause (live and the forecast drop it). A deep link
   * with `t` restores that hour and the speed, paused.
   */
  play?: Speed | undefined;
  /** P11c: the open "Langs de rivier" panel and its path; absent = closed. */
  hov?: HovPathId | undefined;
  /** P19a (O-3): the hidden layer groups, in canonical order; absent = every group shown. */
  hide?: readonly Group[] | undefined;
}

const stationId = ApiStation.shape.id;
/** The river slug of registry/rivers.yaml and ReachRiver.id. */
export const RIVER_ID = /^[a-z][a-z0-9-]{1,40}$/;
const isSpeed = (v: string | null): v is Speed => v !== null && (SPEEDS as readonly string[]).includes(v);
const isHov = (v: string | null): v is HovPathId => v !== null && (HOV_PATHS as readonly string[]).includes(v);
const isMode = (v: string | null): v is Mode => v !== null && (MODES as readonly string[]).includes(v);
const isGroup = (v: string): v is Group => (LAYER_GROUPS as readonly string[]).includes(v);

/** `?hide=`: at most 20 characters, 1 to 3 known groups, none twice; anything else drops the whole key (P19a T4). */
function readHide(raw: string | null): readonly Group[] | undefined {
  if (raw === null || raw.length > 20 || !/^[a-z]+(,[a-z]+){0,2}$/.test(raw)) return undefined;
  const tokens = raw.split(',');
  if (!tokens.every(isGroup) || new Set(tokens).size !== tokens.length) return undefined;
  return LAYER_GROUPS.filter((g) => tokens.includes(g));
}

export function readSearch(search: string): UrlState {
  const q = new URLSearchParams(search);
  const s = q.get('s');
  const mode = q.get('mode');
  const river = q.get('river');
  const play = q.get('play');
  const hov = q.get('hov');
  const hide = readHide(q.get('hide'));
  return {
    t: parseUrlT(q.get('t')),
    s: s !== null && stationId.safeParse(s).success ? s : undefined,
    mode: isMode(mode) ? mode : undefined,
    river: river !== null && RIVER_ID.test(river) ? river : undefined,
    play: isSpeed(play) ? play : undefined,
    hov: isHov(hov) ? hov : undefined,
    hide,
  };
}

/** `?t=…&s=…&mode=…&river=…&play=…&hov=…&hide=…`, with `t`'s colons left plain (valid in a query, and readable). */
export function searchOf({ t, s, mode, river, play, hov, hide }: UrlState): string {
  const parts: string[] = [];
  if (t !== undefined) parts.push(`t=${toUrlT(t)}`);
  if (s !== undefined) parts.push(`s=${encodeURIComponent(s)}`);
  if (mode !== undefined) parts.push(`mode=${mode}`);
  if (river !== undefined) parts.push(`river=${river}`);
  if (play !== undefined) parts.push(`play=${play}`);
  if (hov !== undefined) parts.push(`hov=${hov}`);
  const hidden = LAYER_GROUPS.filter((g) => hide?.includes(g));
  if (hidden.length > 0) parts.push(`hide=${hidden.join(',')}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * The same page in the other language with the same view (a full load, so its `<html lang>` is right); the map when
 * there is no page (the 404 page).
 */
export const otherLanguageHref = (locale: Locale, state: UrlState, id: RouteId = 'home'): string =>
  `${pathOf(id, locale === 'nl' ? 'en' : 'nl')}${searchOf(state)}`;
