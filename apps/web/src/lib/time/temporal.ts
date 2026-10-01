/**
 * Temporal, native where the browser has it, otherwise temporal-polyfill
 * (A§3, A§10 lib/time). The polyfill is a lazy chunk that only a browser
 * without Temporal ever requests (Safari before Temporal shipped). Call
 * `ensureTemporal()` before the first use of `Temporal`.
 */
export async function ensureTemporal(): Promise<'native' | 'polyfill'> {
  if ('Temporal' in globalThis) return 'native';
  await import('temporal-polyfill/global');
  return 'polyfill';
}

/** An instant shown in the Netherlands' local time with its CET/CEST label (A§10). */
export function formatAmsterdam(instant: string, locale: 'nl' | 'en'): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO('Europe/Amsterdam')
    .toLocaleString(locale === 'nl' ? 'nl-NL' : 'en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
}
