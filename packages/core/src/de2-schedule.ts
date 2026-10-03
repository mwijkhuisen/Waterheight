import type { CurrentRun } from './forecast.ts';

// The DE-2 (BfG `WV`) run schedule (catalogue §2.2 [D], BfG "Vorhersagen", re-read 2026-09-23): "Die Vorhersage
// erfolgt werktäglich für die sieben Rheinpegel …"; "Fällt der Wasserstand am Pegel Ruhrort unter die Marke von 4
// Metern, wird die Vorhersage auch an Wochenenden und Feiertagen berechnet." A run (seen at 07:00 local) is due by
// 12:00 Europe/Berlin on every due day; a run that a due day's deadline has passed is superseded and shows as "no
// forecast", never as the held run. Pure: the caller passes Ruhrort's latest stage.

/**
 * German public holidays for BfG in Koblenz (Rhineland-Palatinate): the nationwide ones plus Corpus Christi and All
 * Saints' Day, as Europe/Berlin dates, through DE2_HOLIDAYS_UNTIL (KG: extend the list by 2027-12). After it every
 * Monday to Friday counts as a working day.
 */
export const DE2_HOLIDAYS: readonly string[] = [
  '2026-01-01',
  '2026-04-03',
  '2026-04-06',
  '2026-05-01',
  '2026-05-14',
  '2026-05-25',
  '2026-06-04',
  '2026-10-03',
  '2026-11-01',
  '2026-12-25',
  '2026-12-26',
  '2027-01-01',
  '2027-03-26',
  '2027-03-29',
  '2027-05-01',
  '2027-05-06',
  '2027-05-17',
  '2027-05-27',
  '2027-10-03',
  '2027-11-01',
  '2027-12-25',
  '2027-12-26',
];
export const DE2_HOLIDAYS_UNTIL = '2027-12-31';

/** DE-1 Duisburg-Ruhrort W (de.wsv.2770010): its stage decides whether a weekend or holiday is a due day. */
export const RUHRORT_W = 'c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1/W';
export const RUHRORT_LOW_CM = 400;

const ZONE = 'Europe/Berlin';
const DEADLINE = Temporal.PlainTime.from('12:00');
/** A run older than this many days is superseded whatever the calendar says (any such span holds a working day). */
const LOOK_DAYS = 15;

/** The Europe/Berlin date of an instant. */
export const berlinDate = (ms: number): string =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(ZONE).toPlainDate().toString();

/** 12:00 Europe/Berlin on a date (UTC ms). */
export const de2Deadline = (date: string): number =>
  Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: ZONE, plainTime: DEADLINE }).epochMilliseconds;

/**
 * Whether a run is due on a Europe/Berlin date: a working day (Monday to Friday, not a holiday), or any day while
 * Ruhrort is below 4 m. An unknown Ruhrort stage (null) makes a weekend or holiday not due: silence, not a false alarm.
 */
export function de2Due(date: string, ruhrortCm: number | null, holidays: readonly string[] = DE2_HOLIDAYS): boolean {
  const workday = Temporal.PlainDate.from(date).dayOfWeek <= 5 && !holidays.includes(date);
  return workday || (ruhrortCm !== null && ruhrortCm < RUHRORT_LOW_CM);
}

/**
 * The latest due day whose deadline is at or before `now`, walking back from today to the day after the date of
 * `issued`, or to LOOK_DAYS before today when that is later, or null. It never names a capped day (review F1), so
 * after weeks without a run each newly missed due day is still named.
 */
function lastMissed(issued: number, now: number, ruhrortCm: number | null, holidays: readonly string[]): string | null {
  const today = Temporal.PlainDate.from(berlinDate(now));
  const after = Temporal.PlainDate.from(berlinDate(issued)).add({ days: 1 });
  const floor = today.subtract({ days: LOOK_DAYS });
  const stop = Temporal.PlainDate.compare(after, floor) > 0 ? after : floor;
  for (let d = today; Temporal.PlainDate.compare(d, stop) >= 0; d = d.subtract({ days: 1 }))
    if (de2Due(d.toString(), ruhrortCm, holidays) && de2Deadline(d.toString()) <= now) return d.toString();
  return null;
}

/** The latest due day whose deadline passed without a newer run than `latestIssued`, or null (the alert's day). */
export function de2Late(
  now: number,
  latestIssued: number,
  ruhrortCm: number | null,
  holidays: readonly string[] = DE2_HOLIDAYS,
): string | null {
  return lastMissed(latestIssued, now, ruhrortCm, holidays);
}

/**
 * For `isCurrent`: a DE-2 run is superseded once a due day after its own day has passed its deadline, and always once
 * its own day is more than LOOK_DAYS before today.
 */
export function de2Superseded(
  run: CurrentRun,
  now: number,
  ruhrortCm: number | null,
  holidays: readonly string[] = DE2_HOLIDAYS,
): boolean {
  const stale = Temporal.PlainDate.from(berlinDate(run.issued)).add({ days: LOOK_DAYS });
  if (Temporal.PlainDate.compare(stale, Temporal.PlainDate.from(berlinDate(now))) < 0) return true;
  return lastMissed(run.issued, now, ruhrortCm, holidays) !== null;
}
