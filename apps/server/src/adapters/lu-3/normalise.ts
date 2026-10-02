import { createHash } from 'node:crypto';
import { parseInstant, SchemaDrift, type TimeConvention, TimeError, toIso } from '@rws/core';
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
//  - no issue time: a file states none and AGE keeps no archive. The run is keyed by (series, first_valid,
//    content_hash), the issue time is the fetch time and says so (`issued_inferred: true`); a run is the five
//    percentile files of one station, which must agree on the series, the first step and every valid time
//    (`incomplete_run`, `run_mismatch`; `step_mismatch` when the steps are not one hour apart);
//  - p30 and p70 keep their names: P8a loads a run into forecast_run, which has no p30/p70 columns yet. Percentiles
//    that cross (NOT p10 ≤ p30 ≤ p50 ≤ p70 ≤ p90) are flagged `order`, never reordered or relabelled;
//  - Moselle floor (§2.6): below a set level the model draws a flat line (Perl's p10 = p50 = p90 = 250.0 while the
//    river stood near 212 cm). A step where any percentile is at or below the station's floor is flagged
//    `below_floor` ("below forecastable range");
//  - display limit: the site shows only the first 24 or 48 hours per station (LU-4 `forecastsLimit`); the run
//    keeps every step and carries the limit for the owner view to respect (`display_limit_h`, null when unknown).

export const SOURCE = 'LU-3';
export const TIME: TimeConvention = { kind: 'iso-offset' };

export const PERCENTILES = [10, 30, 50, 70, 90] as const;
export type Level = (typeof PERCENTILES)[number];

/** The Moselle floors in cm (catalogue §2.6; Mondorf has none of its own file). */
export const FLOORS: Readonly<Record<string, number>> = { perl: 250, stadtbredimus: 260, wasserbillig: 220 };

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

const Flag = z.enum(['order', 'below_floor']);
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const num = z.number();

export const ForecastRun = z.strictObject({
  series: z.string().min(1).max(200),
  slug: z.string().min(1).max(100),
  first_valid: Iso,
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  issued_at: Iso,
  issued_inferred: z.literal(true),
  step: z.literal('PT1H'),
  display_limit_h: z.union([z.literal(24), z.literal(48)]).nullable(),
  values: z
    .array(z.strictObject({ ts: Iso, p10: num, p30: num, p50: num, p70: num, p90: num, flags: z.array(Flag).max(2) }))
    .min(1)
    .max(500),
});
export type ForecastRun = z.infer<typeof ForecastRun>;

export type PartContext = { variant: string; keyOf: (slug: string) => string | undefined };
export type PartResult = { part: Part | null; dropped: Record<string, number>; unknown: number };
export type RunContext = { fetchedAt: number; displayLimitH: 24 | 48 | null };
export type RunResult = { run: ForecastRun | null; dropped: Record<string, number> };

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
export function combineRun(parts: readonly Part[], ctx: RunContext): RunResult {
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
  const values = head.values.map((v, i) => {
    const [p10, p30, p50, p70, p90] = five.map((p) => (p.values[i] as { value: number }).value) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const all = [p10, p30, p50, p70, p90];
    const flags: ('order' | 'below_floor')[] = [];
    if (all.some((x, j) => j > 0 && x < (all[j - 1] as number))) flags.push('order');
    if (floor !== undefined && all.some((x) => x <= floor)) flags.push('below_floor');
    return { ts: v.ts, p10, p30, p50, p70, p90, flags };
  });
  const content_hash = createHash('sha256')
    .update(JSON.stringify(five.map((p) => p.values.map((v) => v.value))))
    .digest('hex');
  out.run = {
    series: head.series,
    slug: head.slug,
    first_valid: head.first_valid,
    content_hash,
    issued_at: toIso(ctx.fetchedAt),
    issued_inferred: true,
    step: 'PT1H',
    display_limit_h: ctx.displayLimitH,
    values,
  };
  return out;
}
