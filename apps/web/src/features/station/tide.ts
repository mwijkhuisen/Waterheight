import type { TideExtreme } from '@rws/contracts';
import { amsterdam, localInstants, quantise, STEP_MS } from '../../lib/time/time.ts';
import type { Pt } from './chartModel.ts';

// The pure part of the tide section (P19b T1, issue #67): the high and low waters of the local day of t, the day's
// request span and the surge band of the chart (a station's water body is lib/water.ts bodyOf). DOM-free; the dates through lib/time
// (Europe/Amsterdam, so a 23- or 25-hour day needs nothing special). Call ensureTemporal() before dayExtremes and
// daySpan run (the panel's page already has).

/**
 * The high and low waters of the Amsterdam day of `t`: the raw /series answer's ∪ the snapshot value's (or forecast's)
 * extremes, which add the next astronomical ones after now. Once each by kind, high/low and instant, sorted by time.
 */
export function dayExtremes(
  t: number,
  seriesExtremes: readonly TideExtreme[] | undefined,
  snapshotExtremes: readonly TideExtreme[] | undefined,
): TideExtreme[] {
  const day = amsterdam(t).date;
  const out = new Map<string, { ms: number; e: TideExtreme }>();
  for (const e of [...(seriesExtremes ?? []), ...(snapshotExtremes ?? [])]) {
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms) || amsterdam(ms).date !== day) continue;
    const key = `${e.kind}|${e.hilo}|${ms}`;
    if (!out.has(key)) out.set(key, { ms, e });
  }
  return [...out.values()].sort((a, b) => a.ms - b.ms).map((x) => x.e);
}

/**
 * The span of the HW/LW table's raw request: the Amsterdam day of `t`, from the page's first day and up to the API's
 * limit (the server's now + 10 minutes, quantised as chartSpan does). Undefined when nothing of the day is askable.
 */
export function daySpan(t: number, displayStart: number, serverNow: number): { from: number; to: number } | undefined {
  const date = amsterdam(t).date;
  const next = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
  // Midnight exists on every Amsterdam day (the clocks change at 02:00 and 03:00).
  const start = localInstants(date, '00:00')[0];
  const end = localInstants(next, '00:00')[0];
  if (start === undefined || end === undefined) return undefined;
  const from = Math.max(displayStart, start);
  const to = Math.min(end, quantise(serverNow + STEP_MS));
  return from < to ? { from, to } : undefined;
}

/** The surge band (O-3): two stacked pairs (base, spread) per sign, so both spreads are non-negative. */
export interface SurgeBand {
  /** Surge ≥ 0: from the astronomical tide up to the measured level ([astro, surge]). */
  up: { base: Pt[]; spread: Pt[] };
  /** Surge < 0: from the measured level up to the astronomical tide ([astro + surge, −surge]). */
  down: { base: Pt[]; spread: Pt[] };
}

/**
 * The band from the API's `surge[]` (never obs − astro here) and `astro[]`, at each surge instant. Where the other
 * sign holds, or the astronomical tide has no value at exactly that instant, the point is null: a break, never
 * interpolated across.
 */
export function surgeBand(astro: readonly Pt[], surge: readonly Pt[]): SurgeBand {
  const at = new Map(astro.map(([ts, v]) => [ts, v]));
  const band: SurgeBand = { up: { base: [], spread: [] }, down: { base: [], spread: [] } };
  for (const [ts, s] of surge) {
    const a = at.get(ts) ?? null;
    let up: [number | null, number | null] = [null, null];
    let down: [number | null, number | null] = [null, null];
    if (a !== null && s !== null) {
      if (s >= 0) up = [a, s];
      else down = [a + s, -s];
    }
    band.up.base.push([ts, up[0]]);
    band.up.spread.push([ts, up[1]]);
    band.down.base.push([ts, down[0]]);
    band.down.spread.push([ts, down[1]]);
  }
  return band;
}
