import type { SeriesMeta, SnapshotForecast } from '@rws/contracts';
import { formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { basisKind, stateWord } from './state.ts';
import { formatValue, unitLabel } from './value.ts';

// The words of a forecast (P8b): every cue is text, so nothing rests on colour. A value is as the source publishes
// it, back in its native unit; the agency is ours, the basis label is provider text (callers use text nodes).

type Unit = Pick<SeriesMeta, 'nativeUnit' | 'valueKind' | 'datum' | 'source'>;

/** packages/core FORECAST_FLAGS: the web bundle imports no module of core but the tiles manifest. */
const CENSORED = 128;
const BELOW_FLOOR = 1024;

/** "340 cm NAP"; a value the source did not publish says why instead of a number. */
export function forecastValue(f: SnapshotForecast, series: Unit, locale: Locale): string {
  if (f.value !== null) return `${formatValue(f.value, series, locale)} ${unitLabel(series, locale)}`;
  if ((f.flags & BELOW_FLOOR) !== 0) return m.forecast_below_floor({}, { locale });
  return (f.flags & CENSORED) !== 0 ? m.forecast_censored({}, { locale }) : m.value_none({}, { locale });
}

/** "RWS, uitgegeven za 24 okt 2026, 12:00 CET", or "RWS, opgehaald …" when the issue time is our own fetch time. */
export const issueText = (
  f: Pick<SnapshotForecast, 'agency' | 'issuedAt' | 'issuedInferred'>,
  locale: Locale,
): string =>
  (f.issuedInferred ? m.forecast_fetched : m.forecast_issued)(
    { agency: f.agency, time: formatLocal(Date.parse(f.issuedAt), locale) },
    { locale },
  );

/** "10–90 %: 320–365 cm NAP" (BAFU: "25–75 %"); null without a band. */
export function bandText(f: Pick<SnapshotForecast, 'band'>, series: Unit, locale: Locale): string | null {
  if (f.band === null) return null;
  const text = f.band.kind === 'p10p90' ? m.forecast_band_p10p90 : m.forecast_band_p25p75;
  return text(
    {
      lo: formatValue(f.band.lo, series, locale),
      hi: formatValue(f.band.hi, series, locale),
      unit: unitLabel(series, locale),
    },
    { locale },
  );
}

/** One line for the map popup: "Waterstand: 340 cm NAP, verwachting, RWS, opgehaald …, verhoogd, <kind>: <label>". */
export function forecastLine(quantity: string, f: SnapshotForecast | undefined, series: Unit, locale: Locale): string {
  if (f === undefined) return `${quantity}: ${m.forecast_none({}, { locale })}`;
  const parts = [
    `${quantity}: ${forecastValue(f, series, locale)}`,
    f.estimate ? m.forecast_estimate({}, { locale }) : m.forecast_word({}, { locale }),
    issueText(f, locale),
    stateWord(f.state, locale),
  ];
  if (f.basis !== null) parts.push(`${basisKind(f.basis, locale)}: ${f.basis.label}`);
  return parts.join(', ');
}

/** The forecast column of the table: "schatting; RWS, opgehaald …; 10–90 %: 320–365 cm NAP". */
export function forecastDetail(f: SnapshotForecast, series: Unit, locale: Locale): string {
  return [f.estimate ? m.forecast_estimate({}, { locale }) : null, issueText(f, locale), bandText(f, series, locale)]
    .filter((part) => part !== null)
    .join('; ');
}
