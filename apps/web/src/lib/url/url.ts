import { ApiStation } from '@rws/contracts';
import type { Locale } from '../../paraglide/runtime.js';
import { parseUrlT, toUrlT } from '../time/time.ts';

// The view lives in the URL (A§10): `?t=2026-11-20T14:00Z&s=nl.rws.lobith.bovenrijn.tolkamer&mode=delta&river=waal`.
// A value that does not parse is dropped (t falls back to now, s to no selection, mode to the default, river to
// none); it is never thrown and never rendered.

/** The map modes (P10a): the classified state, the 24-hour change, the discharge. */
export const MODES = ['state', 'delta', 'q'] as const;
export type Mode = (typeof MODES)[number];

export interface UrlState {
  /** A quantised UTC instant, or undefined for "now". */
  t: number | undefined;
  /** A station id in registry format (≤ 80 characters), or undefined. */
  s: string | undefined;
  /** The map mode; undefined for the default (status.json, D10). Written only when the user changes it. */
  mode?: Mode | undefined;
  /** A river id of reaches-<ver>.json to highlight; checked against that file once it has loaded (useReaches). */
  river?: string | undefined;
}

const stationId = ApiStation.shape.id;
/** The river slug of registry/rivers.yaml and ReachRiver.id. */
export const RIVER_ID = /^[a-z][a-z0-9-]{1,40}$/;
const isMode = (v: string | null): v is Mode => v !== null && (MODES as readonly string[]).includes(v);

export function readSearch(search: string): UrlState {
  const q = new URLSearchParams(search);
  const s = q.get('s');
  const mode = q.get('mode');
  const river = q.get('river');
  return {
    t: parseUrlT(q.get('t')),
    s: s !== null && stationId.safeParse(s).success ? s : undefined,
    mode: isMode(mode) ? mode : undefined,
    river: river !== null && RIVER_ID.test(river) ? river : undefined,
  };
}

/** `?t=…&s=…&mode=…&river=…`, with `t`'s colons left plain (valid in a query, and readable). */
export function searchOf({ t, s, mode, river }: UrlState): string {
  const parts: string[] = [];
  if (t !== undefined) parts.push(`t=${toUrlT(t)}`);
  if (s !== undefined) parts.push(`s=${encodeURIComponent(s)}`);
  if (mode !== undefined) parts.push(`mode=${mode}`);
  if (river !== undefined) parts.push(`river=${river}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** The page of the other language with the same view (a full load, so its `<html lang>` is right). */
export const otherLanguageHref = (locale: Locale, state: UrlState): string =>
  `${locale === 'nl' ? '/en/' : '/'}${searchOf(state)}`;
