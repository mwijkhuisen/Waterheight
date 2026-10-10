import type { ApiStation } from '@rws/contracts';
import type { Change } from '../../lib/data/change.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import type { StationState } from '../../lib/stationStates.ts';
import type { Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { popupLine } from '../station/state.ts';
import { formatNumber, formatValue, unitLabel } from '../station/value.ts';

// The popup's lines (P10a T3, T5): one per series for the map mode, then one line of badges in words, so a ring, a
// hollow marker or an icon is never the only cue. Everything is plain text for text nodes (invariant 3).

type Series = ApiStation['series'][number];

const trendWord = (trend: NonNullable<Change>['trend'], locale: Locale): string =>
  ({ rising: m.trend_rising, falling: m.trend_falling, steady: m.trend_steady })[trend]({}, { locale });

/** "+12 cm over 24 hours, rising"; the change is canonical (cm for H, m³/s for Q). */
export function changeLine(quantity: string, series: Pick<Series, 'quantity'>, change: Change, locale: Locale): string {
  if (change === null) return `${quantity}: ${m.dh_na({}, { locale })}`;
  const sign = change.dh > 0 ? '+' : '';
  const unit = series.quantity === 'H' ? 'cm' : 'm³/s';
  const dh = m.dh_value({ dh: `${sign}${formatNumber(change.dh, locale)} ${unit}` }, { locale });
  return `${quantity}: ${dh}, ${trendWord(change.trend, locale)}`;
}

export interface BadgeInput {
  state: StationState | undefined;
  tidal: boolean;
  impounded: boolean;
}

/** The badge words of a station, joined; empty when it has none. */
export function badgeLine({ state, tidal, impounded }: BadgeInput, locale: Locale): string {
  const words = [
    state?.section ? m.section_badge({}, { locale }) : '',
    state?.owner ? m.owner_badge({}, { locale }) : '',
    state?.suspect ? m.suspect_note({}, { locale }) : '',
    // KG-233: stale without a value is a lapsed station (its newest value is past the staleness limit).
    state?.stale ? (state.has ? m.stale_note : m.lapsed_note)({}, { locale }) : '',
    tidal ? m.legend_tidal({}, { locale }) : '',
    impounded ? m.legend_impounded({}, { locale }) : '',
  ];
  return words.filter((w) => w !== '').join(' · ');
}

export interface ModeLinesInput {
  mode: Mode;
  series: readonly Series[];
  values: ReadonlyMap<number, PlayedValue>;
  changes: ReadonlyMap<number, Change> | undefined;
  locale: Locale;
  /** The quantity word of a series ("water level", "discharge"). */
  quantityWord: (series: Series) => string;
}

/** Up to now: the lines of the map mode (state and basis, the 24-hour change, or the discharge). */
export function modeLines({ mode, series, values, changes, locale, quantityWord }: ModeLinesInput): string[] {
  if (mode === 'state')
    return series.flatMap((s) => {
      const v = values.get(s.id);
      return v === undefined ? [] : [popupLine(quantityWord(s), v, locale)];
    });
  if (mode === 'delta')
    return series.flatMap((s) =>
      values.has(s.id) ? [changeLine(quantityWord(s), s, changes?.get(s.id) ?? null, locale)] : [],
    );
  const q = series.flatMap((s) => {
    const v = values.get(s.id);
    return s.quantity === 'Q' && v !== undefined
      ? [`${quantityWord(s)}: ${formatValue(v.value, s, locale)} ${unitLabel(s, locale)}`]
      : [];
  });
  return q.length > 0 ? q : [m.q_none({}, { locale })];
}
