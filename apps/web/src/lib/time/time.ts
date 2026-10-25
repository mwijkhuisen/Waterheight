import { BUCKET_MS, floorBucket } from '@rws/contracts';
import type { Locale } from '../../paraglide/runtime.js';
import { intlLocale, perLocale } from '../intl.ts';

// Instants are UTC milliseconds everywhere (A§10: `t` is always UTC in the URL);
// only display turns them into Europe/Amsterdam wall-clock time. Call
// ensureTemporal() (temporal.ts) before any of these run.

export const ZONE = 'Europe/Amsterdam';
/** The slider step and the API's grid (D11). */
export const STEP_MS = BUCKET_MS;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** The whole UTC hour at or before / at or after an instant (P11b: playback moves in whole UTC hours). */
export const floorHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const ceilHour = (ms: number): number => Math.ceil(ms / HOUR_MS) * HOUR_MS;

/** The 10-minute UTC bucket of an instant, exactly as the API floors `t`. */
export const quantise = (ms: number): number => floorBucket(ms);

/** The `?t=` form: UTC to the minute with `Z`, e.g. `2026-11-20T14:00Z`. */
export const toUrlT = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

const URL_T = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

/** A `?t=` value as a quantised instant; undefined for anything else (never thrown, never shown). */
export function parseUrlT(text: string | null): number | undefined {
  if (text === null || !URL_T.test(text)) return undefined;
  const ms = Date.parse(`${text.slice(0, 16)}:00Z`);
  // The round trip refuses a day or hour that does not exist (2026-02-30, 24:00).
  return Number.isFinite(ms) && toUrlT(ms) === text ? quantise(ms) : undefined;
}

/** CET or CEST from the offset itself, never from a locale's zone names (A§10). */
export const zoneLabel = (offset: string): string =>
  offset === '+01:00' ? 'CET' : offset === '+02:00' ? 'CEST' : `UTC${offset}`;

export interface Local {
  /** YYYY-MM-DD, the value of an `<input type=date>`. */
  date: string;
  /** HH:MM, the value of an `<input type=time>`. */
  time: string;
  offset: string;
  label: string;
}

export function amsterdam(ms: number): Local {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(ZONE);
  return {
    date: z.toPlainDate().toString(),
    time: z.toPlainTime().toString({ smallestUnit: 'minute' }),
    offset: z.offset,
    label: zoneLabel(z.offset),
  };
}

/**
 * Every instant at which Amsterdam's clocks show `date` `time`: one, two in the
 * hour repeated when summer time ends (2026-10-25 02:30 is 00:30Z and 01:30Z),
 * none in the hour skipped when it starts.
 */
export function localInstants(date: string, time: string): number[] {
  let wall: Temporal.PlainDateTime;
  try {
    wall = Temporal.PlainDateTime.from(`${date}T${time}`);
  } catch {
    return [];
  }
  const found = new Set<number>();
  for (const disambiguation of ['earlier', 'later'] as const) {
    const z = wall.toZonedDateTime(ZONE, { disambiguation });
    // In the skipped hour both answers move off the wall time asked for.
    if (Temporal.PlainDateTime.compare(z.toPlainDateTime(), wall) === 0) found.add(z.epochMilliseconds);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The instant a typed date and time name: `near` itself when it is one of them;
 * in the repeated hour the one with `near`'s offset (from 02:30 CET, 02:40 is
 * 02:40 CET), else the first; 'missing' in the skipped hour; undefined while an
 * entry is incomplete.
 */
export function wallInstant(date: string, time: string, near: number): number | 'missing' | undefined {
  try {
    Temporal.PlainDateTime.from(`${date}T${time}`);
  } catch {
    return undefined;
  }
  const found = localInstants(date, time);
  if (found.length === 0) return 'missing';
  const offset = amsterdam(near).offset;
  return (
    found.find((ms) => quantise(ms) === quantise(near)) ??
    found.find((ms) => amsterdam(ms).offset === offset) ??
    found[0]
  );
}

// O3 (#219): one formatter per language and use (lib/intl.ts), in Amsterdam time; the same output as Temporal's
// `ZonedDateTime#toLocaleString` with these options, which formats through such a formatter. Temporal still gives the
// offset of the zone label.
const LOCAL = perLocale(
  (l) =>
    new Intl.DateTimeFormat(intlLocale(l), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: ZONE,
    }),
);
const SHORT = perLocale(
  (l) =>
    new Intl.DateTimeFormat(intlLocale(l), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: ZONE,
    }),
);
const TICK = perLocale(
  (l) => new Intl.DateTimeFormat(intlLocale(l), { day: 'numeric', month: 'short', timeZone: ZONE }),
);
const day = (timeZone: string) =>
  perLocale(
    (l) => new Intl.DateTimeFormat(intlLocale(l), { day: 'numeric', month: 'long', year: 'numeric', timeZone }),
  );
const DAY = { UTC: day('UTC'), [ZONE]: day(ZONE) } as const;
const MINUTES = perLocale(
  (l) => new Intl.NumberFormat(intlLocale(l), { style: 'unit', unit: 'minute', unitDisplay: 'short' }),
);
const HOURS = perLocale(
  (l) =>
    new Intl.NumberFormat(intlLocale(l), {
      style: 'unit',
      unit: 'hour',
      unitDisplay: 'long',
      maximumFractionDigits: 1,
    }),
);

/** "zo 25 okt 2026, 02:30 CET": Amsterdam time with the label of its own offset. */
export function formatLocal(ms: number, locale: Locale): string {
  const offset = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(ZONE).offset;
  return `${LOCAL(locale).format(ms)} ${zoneLabel(offset)}`;
}

/** "25 okt 02:30": a short Amsterdam label for chart axes. */
export const formatShort = (ms: number, locale: Locale): string => SHORT(locale).format(ms);

/** "25 okt": a day label for the timebar's track. */
export const formatTick = (ms: number, locale: Locale): string => TICK(locale).format(ms);

/** A UTC day (a `dataSince`) as a date; with `ZONE`, the Amsterdam day of an instant (the attribution date). */
export const formatDay = (ms: number, locale: Locale, timeZone: keyof typeof DAY = 'UTC'): string =>
  DAY[timeZone](locale).format(ms);

/** "12 min", "3 uur": how old a value is at t. */
export function formatAge(seconds: number, locale: Locale): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? MINUTES(locale).format(minutes) : HOURS(locale).format(minutes / 60);
}
