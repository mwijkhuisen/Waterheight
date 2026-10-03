import {
  FORECAST_FLAGS,
  type ForecastRunIn,
  parseInstant,
  parseStrict,
  SchemaDrift,
  type StagedPart,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import { z } from 'zod';
import type { Percentile } from './parse.ts';

// LU-3 AGE percentile forecasts → one forecast run per station (catalogue §2.6, A§6). Declared here, never
// inferred per row:
//  - time: every step carries its own offset (`iso-offset`, `2026-09-23T20:00:00.000+02:00`); the future-time
//    rule of invariant 4 is for observations, a forecast's valid times are ahead by design. Steps must be strictly
//    increasing, else drift (`time_order`);
//  - series: the capture manifest variant of a file is `<slug>/<p>` (`diekirch/50`); the slug names an LU-1
//    station (`lu.age.<slug>`), `keyOf` gives its LU-1 provider_key, and a slug it does not know is counted
//    (`unknown`), never guessed. The Moselle runs of Perl, Stadtbredimus and Wasserbillig are LfU RLP's and are not
//    fetched until C4/C11 (catalogue §0.8); their floors below are tested on synthetic files only;
//  - unit: cm above the gauge zero, kept as published (no rounding, no conversion); a null value is a gap
//    (`gap`), never 0;
//  - no issue time: a file states none and AGE keeps no archive. The run states no `issuedAt`, so the loader infers it
//    from the earliest of its five files (`issued_inferred`); a run is the five percentile files of one station,
//    which must agree on the series, the first step and every valid time (`incomplete_run`, `run_mismatch`;
//    `step_mismatch` when the steps are not one hour apart). The loader keys it by (series, first valid time, hash);
//  - one run is a `quantiles` run of the LU-1 series (`target` LU-1) with p10, p30, p50, p70 and p90 per step, the
//    `value` column holding p50. Percentiles that cross (NOT p10 ≤ p30 ≤ p50 ≤ p70 ≤ p90) get the forecast flag
//    ORDER, never reordered or relabelled;
//  - Moselle floor (§2.6): below a set level the model draws a flat line (Perl's p10 = p50 = p90 = 250.0 while the
//    river stood near 212 cm). A step where any percentile is at or below the station's floor gets the forecast
//    flag BELOW_FLOOR ("below forecastable range"); the values stay as published;
//  - display limit: the site shows only the first 24 or 48 hours per station (LU-4 `forecastsLimit`). The run keeps
//    every step; the limit is display metadata (registry/seed/lu-3.csv `limit_h`) that the forecast builder applies.

export const SOURCE = 'LU-3';
export const TIME: TimeConvention = { kind: 'iso-offset' };

export const PERCENTILES = [10, 30, 50, 70, 90] as const;
export type Level = (typeof PERCENTILES)[number];

/** The Moselle floors in cm (catalogue §2.6), by LU-1 slug: Mondorf on the Gander is `mondorf-les-bains` there. */
export const FLOORS: Readonly<Record<string, number>> = {
  perl: 250,
  stadtbredimus: 260,
  wasserbillig: 220,
  'mondorf-les-bains': 250,
};

const HOUR_MS = 3_600_000;
const VARIANT = /^([a-z]+(?:-[a-z]+)*)\/(10|30|50|70|90)$/;

export type Part = {
  /** The LU-1 provider_key of the station. */
  series: string;
  slug: string;
  percentile: Level;
  /** The first published step, UTC. */
  first_valid: string;
  values: { ts: string; value: number }[];
};

const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/**
 * A staged part as it comes back from the loader's app_meta JSON: strict, because the staging row is data a bug or a
 * hand edit could have changed, and `combineStaged` must refuse it (SchemaDrift, counted `combine_drift`).
 */
export const PartData = z.strictObject({
  series: z.string().min(1).max(200),
  slug: z.string().min(1).max(100),
  percentile: z.union([z.literal(10), z.literal(30), z.literal(50), z.literal(70), z.literal(90)]),
  first_valid: Iso,
  values: z
    .array(z.strictObject({ ts: Iso, value: z.number() }))
    .min(1)
    .max(500),
});

export type PartContext = { variant: string; keyOf: (slug: string) => string | undefined };
export type PartResult = { part: Part | null; dropped: Record<string, number>; unknown: number };
export type RunResult = { run: ForecastRunIn | null; dropped: Record<string, number> };

const count = (dropped: Record<string, number>, code: string, n = 1) => {
  dropped[code] = (dropped[code] ?? 0) + n;
};

/** The slug and percentile of a manifest variant `<slug>/<p>`; drift otherwise (the variant is ours, never provider text). */
export function variantOf(variant: string): { slug: string; percentile: Level } {
  const m = VARIANT.exec(variant);
  if (!m) throw new SchemaDrift('bad_variant');
  return { slug: m[1] as string, percentile: Number(m[2]) as Level };
}

export function normalisePart(file: Percentile, ctx: PartContext): PartResult {
  const { slug, percentile } = variantOf(ctx.variant);
  const out: PartResult = { part: null, dropped: {}, unknown: 0 };
  const series = ctx.keyOf(slug);
  if (series === undefined) {
    out.unknown = 1;
    return out;
  }
  const values: Part['values'] = [];
  let first = 0;
  let prev = Number.NEGATIVE_INFINITY;
  for (const [i, [raw, value]] of file.data.entries()) {
    let ms: number;
    try {
      ms = parseInstant(TIME, raw);
    } catch (err) {
      if (!(err instanceof TimeError)) throw err;
      throw new SchemaDrift(`time_${err.code}`, `data.${i}`);
    }
    if (ms <= prev) throw new SchemaDrift('time_order', `data.${i}`);
    prev = ms;
    if (i === 0) first = ms;
    if (value === null) count(out.dropped, 'gap');
    else values.push({ ts: toIso(ms), value });
  }
  if (values.length === 0) {
    count(out.dropped, 'empty');
    return out;
  }
  out.part = { series, slug, percentile, first_valid: toIso(first), values };
  return out;
}

/** The five percentile parts of one station → one run; null (counted) when they are not one run. */
export function combineRun(parts: readonly Part[]): RunResult {
  const out: RunResult = { run: null, dropped: {} };
  const five = PERCENTILES.map((p) => parts.find((x) => x.percentile === p)).filter((x): x is Part => x !== undefined);
  if (parts.length !== PERCENTILES.length || five.length !== PERCENTILES.length) {
    count(out.dropped, 'incomplete_run');
    return out;
  }
  const head = five[0] as Part;
  const same = five.every(
    (p) =>
      p.series === head.series &&
      p.slug === head.slug &&
      p.first_valid === head.first_valid &&
      p.values.length === head.values.length &&
      p.values.every((v, i) => v.ts === head.values[i]?.ts),
  );
  if (!same) {
    count(out.dropped, 'run_mismatch');
    return out;
  }
  const times = head.values.map((v) => Date.parse(v.ts));
  if (times.some((t, i) => i > 0 && t - (times[i - 1] as number) !== HOUR_MS)) {
    count(out.dropped, 'step_mismatch');
    return out;
  }
  const floor = Object.hasOwn(FLOORS, head.slug) ? FLOORS[head.slug] : undefined;
  const points = head.values.map((v, i) => {
    const [p10, p30, p50, p70, p90] = five.map((p) => (p.values[i] as { value: number }).value) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const all = [p10, p30, p50, p70, p90];
    let flags = 0;
    if (all.some((x, j) => j > 0 && x < (all[j - 1] as number))) flags |= FORECAST_FLAGS.ORDER;
    if (floor !== undefined && all.some((x) => x <= floor)) flags |= FORECAST_FLAGS.BELOW_FLOOR;
    return { ts: v.ts, value: p50, p10, p30, p50, p70, p90, flags };
  });
  out.run = {
    target: 'LU-1',
    series: head.series,
    kind: 'quantiles',
    stepMs: HOUR_MS,
    issuedAt: null,
    providerSegmentEnd: null,
    points,
  };
  return out;
}

/**
 * The loader's staged files of one group (`SpecLoader.combine`): each `data` is checked as a `Part` (a mismatch is
 * SchemaDrift) and must name the percentile of its slot, then `combineRun`. At most one run.
 */
export function combineStaged(staged: readonly StagedPart[]): {
  runs: ForecastRunIn[];
  dropped: Record<string, number>;
} {
  const parts = staged.map((s) => {
    const part = parseStrict(PartData, s.data, [s.part]);
    if (String(part.percentile) !== s.part) throw new SchemaDrift('part_mismatch', s.part);
    return part;
  });
  const { run, dropped } = combineRun(parts);
  return { runs: run === null ? [] : [run], dropped };
}
