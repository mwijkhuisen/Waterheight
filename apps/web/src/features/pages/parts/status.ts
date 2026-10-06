import type { ClassCoverage, ForecastCoverage, StatusPageData, StatusRow } from '../../../lib/data/contracts.ts';
import { formatAge, formatDay, formatLocal } from '../../../lib/time/time.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { COUNTRIES, type Country } from './country.ts';
import { fractionText, intlLocale, percentText } from './numbers.ts';

// The Status page's logic (P10b), pure: status.json rows and coverage blocks as the text the tables show. Every
// instant goes through lib/time/time.ts (Amsterdam time with its zone label), every number through Intl.

const na = (locale: Locale) => m.stat_na({}, { locale });

export function statusWord(status: StatusRow['status'], locale: Locale): string {
  const o = { locale };
  switch (status) {
    case 'ok':
      return m.stat_status_ok({}, o);
    case 'degraded':
      return m.stat_status_degraded({}, o);
    case 'down':
      return m.stat_status_down({}, o);
    case 'unknown':
      return m.stat_status_unknown({}, o);
  }
}

export const momentText = (iso: string | null, locale: Locale): string =>
  iso === null ? na(locale) : formatLocal(Date.parse(iso), locale);

/** The loader's lag in seconds up to two minutes, else minutes or hours. */
export function lagText(seconds: number | null, locale: Locale): string {
  if (seconds === null) return na(locale);
  if (seconds >= 120) return formatAge(seconds, locale);
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'short',
    maximumFractionDigits: 0,
  }).format(seconds);
}

/** "12 min old", and when a due run is missing, the day it was due. */
export function forecastText(f: StatusRow['forecast'], locale: Locale): string {
  if (f === null) return na(locale);
  const age = m.stat_forecast_age({ age: formatAge(f.runAgeS, locale) }, { locale });
  if (f.late === null) return age;
  // `late` is a plain date (Europe/Berlin day): read as UTC and shown as UTC, so it never moves a day.
  const day = formatDay(Date.parse(f.late), locale);
  return `${age}, ${m.stat_forecast_late({ day }, { locale })}`;
}

export interface StatusRowView {
  id: string;
  status: string;
  lastFetch: string;
  newest: string;
  lag: string;
  coverage: string;
  forecast: string;
}

export const statusRows = (sources: readonly StatusRow[], locale: Locale): StatusRowView[] =>
  sources.map((s) => ({
    id: s.id,
    status: statusWord(s.status, locale),
    lastFetch: momentText(s.lastFetchOk, locale),
    newest: momentText(s.newestTs, locale),
    lag: lagText(s.lagP95S, locale),
    coverage: s.coverage === null ? na(locale) : percentText(s.coverage, locale),
    forecast: forecastText(s.forecast, locale),
  }));

/** A coverage table: one row per country (those a family names) and a total row; the cells of each family in turn. */
export type Family = 'public' | 'owner';
export interface MatrixRow {
  /** null: the total row. */
  country: Country | null;
  cells: string[];
}
export interface Matrix {
  families: Family[];
  rows: MatrixRow[];
}

function buildMatrix<T extends { countries: readonly { country: Country }[] }, R>(
  sets: readonly (readonly [Family, T | null])[],
  total: (c: T) => R,
  row: (c: T, country: Country) => R | undefined,
  cells: (r: R | null | undefined) => string[],
): Matrix {
  const present = (country: Country) => sets.some(([, c]) => c?.countries.some((r) => r.country === country));
  const of = (pick: (c: T) => R | undefined) => sets.flatMap(([, c]) => cells(c === null ? null : pick(c)));
  return {
    families: sets.map(([family]) => family),
    rows: [
      ...COUNTRIES.filter(present).map((country) => ({ country, cells: of((c) => row(c, country)) })),
      { country: null, cells: of(total) },
    ],
  };
}

type Pair<T> = { public: T | null; owner: T | null | undefined };
const families = <T>(p: Pair<T>): (readonly [Family, T | null])[] =>
  p.owner === undefined
    ? [['public', p.public]]
    : [
        ['public', p.public],
        ['owner', p.owner],
      ];

/** Tier-1 and first-release stations with a state, per country: two cells per family. */
export function classMatrix(c: StatusPageData['classification'], locale: Locale): Matrix {
  type Row = Pick<ClassCoverage, 'tier1' | 'first_release'>;
  return buildMatrix<ClassCoverage, Row>(
    families(c),
    (x) => x,
    (x, country) => x.countries.find((r) => r.country === country),
    (r) =>
      r == null
        ? [na(locale), na(locale)]
        : [
            fractionText(r.tier1.classed, r.tier1.stations, locale),
            fractionText(r.first_release.classed, r.first_release.stations, locale),
          ],
  );
}

/** First-release stations with a current official forecast, per country: one cell per family. */
export function forecastMatrix(c: StatusPageData['forecastCoverage'], locale: Locale): Matrix {
  type Row = { stations: number; covered: number };
  return buildMatrix<ForecastCoverage, Row>(
    families(c),
    (x) => x.total,
    (x, country) => x.countries.find((r) => r.country === country),
    (r) => [r == null ? na(locale) : fractionText(r.covered, r.stations, locale)],
  );
}
