/**
 * Number and duration formatting for the metadata panels.
 *
 * npm's sidebar leans on compact figures ("2,481,003 weekly downloads",
 * "3 years ago"); these are the equivalents for stored measurements and
 * coverage windows.
 */

const LOCALE = 'en-GB';

export function formatCount(value: number): string {
  return value.toLocaleString(LOCALE);
}

/** Compact form for headline figures, e.g. 12_483 -> "12.5k". */
export function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Reading with its unit, rendered the way the chart rounds. */
export function formatReading(value: number | null): string {
  if (value === null) return '—';
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(decimals).replace(/\.0+$/, '');
}

/** Date only, for coverage endpoints where the time of day is noise. */
export function formatDate(timestamp: string | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Human span between two timestamps, e.g. "about 2 years". */
export function formatSpan(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms <= 0) return '—';

  const days = ms / 86_400_000;
  if (days < 1) return `${Math.max(1, Math.round(ms / 3_600_000))} hours`;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30.44)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/** "1 type" / "4 types" without a stray plural at every call site. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}
