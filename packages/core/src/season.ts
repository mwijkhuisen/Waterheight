// The NL-4 season calendar (#99): the classifier and the web's station chart read a season the same way. Call
// sites in the browser load Temporal first (apps/web lib/time ensureTemporal).

/** The MMDD of an instant in Europe/Amsterdam, the calendar of the NL-4 seasons. */
export function monthDay(t: number): number {
  const z = Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO('Europe/Amsterdam');
  return z.month * 100 + z.day;
}

/** A season `from`–`to` (MMDD, both inclusive; wraps the year when from > to) contains `md`. */
export const inSeason = (md: number, from: number, to: number) =>
  from <= to ? md >= from && md <= to : md >= from || md <= to;
