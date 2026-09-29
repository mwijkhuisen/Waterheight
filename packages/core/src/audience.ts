import { type Audience, audienceWithin, CHANNELS, type Channels, SeriesOverride, type Source } from '@rws/contracts';

export type Effective = { audience: Audience } & Channels;

/**
 * The effective audience and channels of a series: its source's values,
 * narrowed by the series override (public > owner > off; a channel stays on
 * only if both allow it). An override can never widen anything, and an
 * override with an unknown key is rejected, not ignored.
 */
export function effective(
  source: Pick<Source, 'audience' | 'display' | 'api' | 'bulk_export' | 'history_export'>,
  override?: unknown,
): Effective {
  const o = override === undefined ? undefined : SeriesOverride.parse(override);
  const audience =
    o?.audience !== undefined && audienceWithin(o.audience, source.audience) ? o.audience : source.audience;
  const result = { audience } as Effective;
  for (const c of CHANNELS) result[c] = source[c] && (o?.[c] ?? true);
  return result;
}
