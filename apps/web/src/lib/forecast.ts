import { FORECAST_AHEAD_MS, type Meta, type SeriesForecast } from '@rws/contracts';
import { quantise } from './time/time.ts';

// The forecast part of the timeline (P8b, D8). Pure: the slider's end, the page's t, a station's horizon.
// Instants are UTC milliseconds, as everywhere in the page.

const HOUR_MS = 3_600_000;

/**
 * The slider's end while no station is selected, or while a station's horizon is not known yet: now plus the
 * largest provider horizon of /meta (each already capped at 48 h); now when no source forecasts.
 */
export const globalEnd = (now: number, horizons: Meta['forecastHorizons']): number =>
  now + Math.min(FORECAST_AHEAD_MS, Math.max(0, ...horizons.map((h) => h.hours * HOUR_MS)));

/**
 * The slider's end: now + min(48 h, the selected station's horizon). `station` is that horizon as an instant,
 * `null` for a station none of whose series has a run (the slider ends at now), `undefined` when there is no
 * selection or the horizon is not known (yet): the global end.
 */
export const sliderEnd = (now: number, global: number, station: number | null | undefined): number =>
  station === undefined
    ? global
    : station === null
      ? now
      : quantise(Math.min(now + FORECAST_AHEAD_MS, Math.max(now, station)));

/**
 * The page's t for a `?t=`: a missing one, one before the first day or one more than 48 h after now is no `t`
 * (now, as a value that does not parse is); one after the slider's end is clamped to it.
 */
export const pageT = (urlT: number | undefined, start: number, now: number, end: number): number =>
  urlT === undefined || urlT < start || urlT > now + FORECAST_AHEAD_MS ? now : Math.min(urlT, end);

/**
 * A station's horizon from the answers of /series/{id}/forecast of its series: the latest `horizonEnd` of a run;
 * null when none has a run.
 */
export function stationHorizon(answers: readonly (SeriesForecast | null)[]): number | null {
  const ends = answers.flatMap((a) => (a?.run ? [Date.parse(a.run.horizonEnd)] : []));
  return ends.length === 0 ? null : Math.max(...ends);
}
