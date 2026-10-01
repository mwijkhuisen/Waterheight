import { ApiStation } from '@rws/contracts';
import type { Locale } from '../../paraglide/runtime.js';
import { parseUrlT, toUrlT } from '../time/time.ts';

// The view lives in the URL (A§10): `?t=2026-11-20T14:00Z&s=nl.rws.lobith.bovenrijn.tolkamer`.
// A value that does not parse is dropped (t falls back to now, s to no
// selection); it is never thrown and never rendered.

export interface UrlState {
  /** A quantised UTC instant, or undefined for "now". */
  t: number | undefined;
  /** A station id in registry format (≤ 80 characters), or undefined. */
  s: string | undefined;
}

const stationId = ApiStation.shape.id;

export function readSearch(search: string): UrlState {
  const q = new URLSearchParams(search);
  const s = q.get('s');
  return { t: parseUrlT(q.get('t')), s: s !== null && stationId.safeParse(s).success ? s : undefined };
}

/** `?t=…&s=…`, with `t`'s colons left plain (valid in a query, and readable). */
export function searchOf({ t, s }: UrlState): string {
  const parts: string[] = [];
  if (t !== undefined) parts.push(`t=${toUrlT(t)}`);
  if (s !== undefined) parts.push(`s=${encodeURIComponent(s)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** The page of the other language with the same view (a full load, so its `<html lang>` is right). */
export const otherLanguageHref = (locale: Locale, state: UrlState): string =>
  `${locale === 'nl' ? '/en/' : '/'}${searchOf(state)}`;
