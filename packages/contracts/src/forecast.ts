import { z } from 'zod';

// The forecast contracts (P8a). This module imports only zod (and ./units.ts where it needs a unit): the web bundle
// takes it, and nothing of the registry, the health documents, the stations or the canaries may follow it there
// (`sideEffects: false`; apps/web/test/build.test.ts).

// --- /data/v1/forecast/latest.json (A§9.1; P9a writes the file, P8a builds and tests the document) -----------------

const iso = z.iso.datetime();
const SeriesId = z.number().int().min(1).max(2_147_483_647);

/** The forecast run kinds of the database (`forecast_run.kind`). */
export const FORECAST_RUN_KINDS = ['deterministic', 'quantiles', 'ensemble_summary'] as const;

/**
 * `flags` of a forecast point: a bitmask of its own, never the observation `qc` (whose maximum is 1023). The
 * names are the web's: `order` (a quantile crossed another), `censored`, `estimate` (beyond the provider's own
 * forecast segment, DE-2) and `below_floor` (a value below the provider's floor, shown as "below forecastable
 * range", never as a level: its numbers are null here).
 */
export const FORECAST_FLAG_BITS = { order: 16, censored: 128, estimate: 256, below_floor: 1024 } as const;
const FLAGS_ALL = 16 | 128 | 256 | 1024;
export const FORECAST_HORIZON_HOURS = 48;
/** Our label of a `below_floor` point (the provider states none); the page shows its own translation. */
export const BELOW_FLOOR_LABEL = 'below forecastable range';

/** The most points one run carries in the file: 48 hours at the 10-minute step, with the lead-in the run holds. */
export const FORECAST_MAX_POINTS = 2000;
const Numbers = z.array(z.number().nullable()).max(FORECAST_MAX_POINTS);

/**
 * The quantile band of a run: `kind` names the pair the band spans (p10/p90, else BAFU's p25/p75); a column is null
 * where the provider states none (`p30`/`p70`: AGE; `vmin`/`vmax`: BAFU's ensemble minimum and maximum).
 */
const Band = z.strictObject({
  kind: z.enum(['p10p90', 'p25p75']),
  p10: Numbers.nullable(),
  p90: Numbers.nullable(),
  p25: Numbers.nullable(),
  p75: Numbers.nullable(),
  p30: Numbers.nullable(),
  p70: Numbers.nullable(),
  vmin: Numbers.nullable(),
  vmax: Numbers.nullable(),
});
const BAND_COLUMNS = ['p10', 'p90', 'p25', 'p75', 'p30', 'p70', 'vmin', 'vmax'] as const;

/**
 * The latest run of one series from one source, in columns (one array per field, one entry per valid time, in
 * time order). The values are in the canonical unit of the series (H in cm, Q in m³/s). A value is held at its
 * time: the run's own steps are never interpolated.
 */
const forecastRun = (source: z.ZodString) =>
  z
    .strictObject({
      series: SeriesId,
      source,
      /** The agency that issues the run (our short name, not provider text). */
      agency: z.string().min(1).max(40),
      /** The time the provider states for the run, else the time we first fetched it (`issuedInferred`). */
      issuedAt: iso,
      issuedInferred: z.boolean(),
      fetchedAt: iso,
      /** Where the provider's own forecast ends and an estimate begins (DE-2); null when it has no such mark. */
      providerSegmentEnd: iso.nullable(),
      kind: z.enum(FORECAST_RUN_KINDS),
      /** The run's step in seconds; null when it has none. */
      stepSeconds: z.number().int().positive().nullable(),
      validTs: z.array(iso).min(1).max(FORECAST_MAX_POINTS),
      /** The central value; null at a `below_floor` point. */
      value: Numbers,
      /** Only for `quantiles` and `ensemble_summary` runs that state a band. */
      band: Band.nullable(),
      flags: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(FLAGS_ALL)
            .refine((f) => (f & ~FLAGS_ALL) === 0, 'unknown flag bit'),
        )
        .max(FORECAST_MAX_POINTS),
    })
    .superRefine((r, ctx) => {
      const n = r.validTs.length;
      const columns: [string, readonly unknown[] | null][] = [
        ['value', r.value],
        ['flags', r.flags],
        ...BAND_COLUMNS.map((c): [string, readonly unknown[] | null] => [`band.${c}`, r.band?.[c] ?? null]),
      ];
      const band = r.band;
      if (band !== null && (band.kind === 'p10p90' ? [band.p10, band.p90] : [band.p25, band.p75]).includes(null))
        ctx.addIssue({ code: 'custom', message: `a ${band.kind} band holds both of its columns` });
      for (const [name, col] of columns) {
        if (col !== null && col.length !== n)
          ctx.addIssue({ code: 'custom', message: `${name} must have ${n} entries` });
      }
      for (let i = 1; i < n; i++) {
        if (Date.parse(r.validTs[i] as string) <= Date.parse(r.validTs[i - 1] as string)) {
          ctx.addIssue({ code: 'custom', message: 'validTs must increase' });
          break;
        }
      }
      // A point below the provider's floor carries no number anywhere (never a level).
      for (let i = 0; i < n; i++) {
        if (((r.flags[i] ?? 0) & FORECAST_FLAG_BITS.below_floor) === 0) continue;
        const numbers = [r.value[i], ...BAND_COLUMNS.map((c) => r.band?.[c]?.[i])];
        if (numbers.some((x) => x !== null && x !== undefined)) {
          ctx.addIssue({ code: 'custom', message: 'a below_floor point must hold no number' });
          break;
        }
      }
    });

/** A catalogue source ID: the public file names no other spelling (a canary or any other id fails the contract). */
const CATALOGUE_SOURCE = z.string().regex(/^(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?$/);
/** The owner file also holds the owner canary's own run (A§9.3): the one spelling it adds. */
const OWNER_SOURCE = z.string().regex(/^(?:(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?|CANARY-[A-Z]+)$/);

const forecastLatest = (source: z.ZodString) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    /** The instant the runs are current at: every run reaches it, and no value is later than it plus 48 hours. */
    now: iso,
    /** At most one run per series and source, ordered by series then source. */
    runs: z.array(forecastRun(source)).max(5000),
  });
/** The public document (and the owner's, minus the canary run): the schema every public answer is checked with. */
export const ForecastLatest = forecastLatest(CATALOGUE_SOURCE);
/** The owner document: the same shape, and the owner canary's source may appear. */
export const OwnerForecastLatest = forecastLatest(OWNER_SOURCE);
export type ForecastLatest = z.infer<typeof ForecastLatest>;
export type ForecastRun = ForecastLatest['runs'][number];

// --- Display rules (P8b) -------------------------------------------------------------------------------------------

/**
 * Which forecast source a series shows when several forecast it (never blended: one source per series and t). The
 * registry order of sources.yaml (a test holds them equal), in which DE-2 (BfG `WV`, the official forecast) comes
 * before DE-3 (BfG 14-day quantiles) where both forecast DE-1's stage at Emmerich.
 */
export const FORECAST_PRECEDENCE = ['NL-1', 'DE-2', 'DE-3', 'FR-4', 'LU-3', 'CH-4'] as const;

/**
 * The one run a series shows: of the candidate runs (at most one per source), the first by FORECAST_PRECEDENCE that
 * `current` accepts (it reaches t, its source's schedule says it was not superseded, its display limit holds). A
 * source outside the list ranks after every listed one: the owner canary's own run (CANARY-OWNER, owner family only)
 * shows where no listed source forecasts its series. Undefined: "no forecast".
 */
export function pickRun<T extends { source: string }>(runs: readonly T[], current: (run: T) => boolean): T | undefined {
  const order = FORECAST_PRECEDENCE as readonly string[];
  const rank = (r: T) => (order.includes(r.source) ? order.indexOf(r.source) : order.length);
  return [...runs].sort((a, b) => rank(a) - rank(b)).find(current);
}

// --- The reach matrix and its coverage (P8a; catalogue §0.5) -------------------------------------------------------
// registry/forecast-reaches.yaml holds the 15 rows of the catalogue's "Forecast coverage per river" table; each
// first-release station falls into the first row whose `match` it satisfies (or into `other`). The coverage
// document is computed per audience family (apps/server/src/api/forecast.ts): the public one goes into
// /api/v1/health/sources and names public sources only, the owner one is served by the owner channel (P9a).

const REACH_COUNTRIES = ['NL', 'DE', 'BE', 'FR', 'LU', 'CH'] as const;
const Country = z.enum(REACH_COUNTRIES);
const RiverId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
const ReachId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
const ReachSourceId = z.string().regex(/^(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?$/);
/** An agency's short name as the catalogue writes it ("LfU RLP", "SPW"): words, never provider prose. */
const Agency = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .&/-]*$/u);
const ReachName = z
  .string()
  .min(1)
  .max(80)
  .refine((s) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s), 'a control, format or line separator character');
const Names = z.strictObject({ nl: ReachName, en: ReachName });
const Count = z.number().int().nonnegative();

/**
 * Which stations a row takes: `rivers` (the river ids of registry/rivers.yaml) and/or `countries`, and, with
 * `rivers`, `km_min` (inclusive) and `km_max` (exclusive) on the operator's km (`station.km_official`; a station
 * without one fails a km bound). One entry holds all its conditions; a row matches when any of its entries does.
 */
export const ReachMatch = z
  .strictObject({
    rivers: z.array(RiverId).min(1).max(12).optional(),
    countries: z.array(Country).min(1).max(6).optional(),
    km_min: z.number().min(-5000).max(5000).optional(),
    km_max: z.number().min(-5000).max(5000).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.rivers === undefined && m.countries === undefined)
      ctx.addIssue({ code: 'custom', message: 'a match names rivers or countries' });
    if ((m.km_min !== undefined || m.km_max !== undefined) && m.rivers === undefined)
      ctx.addIssue({ code: 'custom', message: 'a km bound belongs to a river' });
    if (m.km_min !== undefined && m.km_max !== undefined && !(m.km_min < m.km_max))
      ctx.addIssue({ code: 'custom', message: 'km_min must be below km_max' });
  });
export type ReachMatch = z.infer<typeof ReachMatch>;

/**
 * One row of catalogue §0.5. `sources`: the sources that fill the row without a permission, public or owner
 * audience (a family lists only those it can see); `after_permission`: the agencies whose permission would add
 * more; `none_publishes`: the agencies of the row's "Not available" column (they publish none, or none we may
 * use). No `stations` override (C14): a station belongs to a row by its river, country and km alone.
 */
export const ForecastReach = z.strictObject({
  id: ReachId,
  names: Names,
  match: z.array(ReachMatch).min(1).max(8),
  sources: z.array(ReachSourceId).max(8),
  after_permission: z.array(Agency).max(8),
  none_publishes: z.array(Agency).max(8),
});
export type ForecastReach = z.infer<typeof ForecastReach>;

export const ForecastReaches = z
  .strictObject({ version: z.literal(1), reaches: z.array(ForecastReach).min(1).max(40) })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const r of f.reaches) {
      if (seen.has(r.id)) ctx.addIssue({ code: 'custom', message: `duplicate reach id ${r.id}` });
      seen.add(r.id);
    }
  });
export type ForecastReaches = z.infer<typeof ForecastReaches>;

/** First-release stations and how many of them have a current run in the family (Q2 at asof = t = now). */
const Cover = { stations: Count, covered: Count };

/**
 * The forecast coverage of one audience family at `t`: the first-release stations (tier 1 with a public primary
 * series; the same denominator in every family) per country and per reach row, and the stations of no row
 * (`other`). A station is covered when one of its series has a current run in the family (DE-2 runs only while the
 * schedule says they were not superseded). A reach lists the sources its family can see and nothing else;
 * `no_official_forecast` is true exactly when it lists none, and then `after_permission` and `none_publishes` say
 * what could change it. The public report names no owner source and no owner-only agency.
 */
export const ForecastCoverage = z
  .strictObject({
    t: iso,
    total: z.strictObject(Cover),
    countries: z.array(z.strictObject({ country: Country, ...Cover })).max(6),
    reaches: z
      .array(
        z.strictObject({
          id: ReachId,
          names: Names,
          ...Cover,
          sources: z.array(ReachSourceId).max(8),
          no_official_forecast: z.boolean(),
          after_permission: z.array(Agency).max(8),
          none_publishes: z.array(Agency).max(8),
        }),
      )
      .max(40),
    other: z.strictObject(Cover),
  })
  .superRefine((c, ctx) => {
    const sum = (rows: readonly { stations: number; covered: number }[], key: 'stations' | 'covered') =>
      rows.reduce((n, r) => n + r[key], 0);
    for (const key of ['stations', 'covered'] as const) {
      if (c.total[key] !== sum(c.countries, key))
        ctx.addIssue({ code: 'custom', message: `total.${key} is not the sum over the countries` });
      if (c.total[key] !== sum(c.reaches, key) + c.other[key])
        ctx.addIssue({ code: 'custom', message: `total.${key} is not the sum over the reaches and other` });
    }
    for (const r of [c.total, c.other, ...c.countries, ...c.reaches])
      if (r.covered > r.stations) ctx.addIssue({ code: 'custom', message: 'covered exceeds stations' });
    for (const r of c.reaches)
      if (r.no_official_forecast !== (r.sources.length === 0))
        ctx.addIssue({ code: 'custom', message: `${r.id}: no_official_forecast must match an empty sources list` });
  });
export type ForecastCoverage = z.infer<typeof ForecastCoverage>;
