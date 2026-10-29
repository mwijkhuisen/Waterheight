import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  thin,
  toIso,
} from '@rws/core';
import type { Trace } from './parse.ts';

// CH-3 hydrodaten 40-day plot → gap-fill rows of the CH-1 series (catalogue
// §2.7, A§7.2). CH-3 has no series of its own: every row goes to the CH-1
// series of the same station as a fill row, which the loader stores only where
// CH-1 states no value (backfilled bit, never a revision). Declared here, never
// inferred per row:
//  - the station: the manifest line's variant (the seed row's `id`); the body
//    does not name it;
//  - the `_de` file's traces are a prefix of `Wasserstand` (m ü.M.) then
//    `Abfluss` (m³/s): both, or `Wasserstand` alone (the level-only stations
//    2032, 2043 and 2615, #235). Names, units and order are checked, because
//    the other languages translate them (catalogue §2.7, CH-4). A plot without
//    `Abfluss` at a station whose CH-1 series include a discharge counts one
//    `missing_trace`, which the pipeline alerts (#235 review CR-1);
//  - time: ISO 8601 with the provider's local offset;
//  - unit and factor from the CH-1 series' registry row; a level never fills a
//    series that CH-1 declares as a relative stage (`datum_mismatch`);
//  - 5-minute points map to the CH-1 step (10 minutes) by keeping the on-grid
//    samples only, never an average: the same rule as every series whose
//    provider publishes more often than we store (packages/core `thin`);
//  - an exact 0 at a level is BAFU's "no value", dropped as `sentinel` (the
//    CH-1 rule, KG-131); a discharge of 0 is a reading;
//  - qc "raw".

export const SOURCE = 'CH-3';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const MAX_AGE_MS = 45 * 86_400_000;

const TRACES = [
  { name: 'Wasserstand', unit: 'm ü.M.', quantity: 'W' },
  { name: 'Abfluss', unit: 'm³/s', quantity: 'Q' },
] as const;

export type Context = {
  /** The CH-1 registry: the series the rows fill. */
  fillRegistry?: Registry;
  fetchedAt: number;
  variant: string;
};

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

export function normalisePlot(traces: readonly Trace[], ctx: Context): Normalised {
  const out = emptyNormalised();
  out.fill = [];
  if (!/^\d{1,6}$/.test(ctx.variant)) throw new SchemaDrift('bad_variant');
  if (
    traces.length === 0 ||
    traces.length > TRACES.length ||
    traces.some((t, i) => t.name !== TRACES[i]?.name || t.meta.unit !== TRACES[i]?.unit)
  ) {
    throw new SchemaDrift('trace_order');
  }
  for (const want of TRACES.slice(traces.length)) {
    if (ctx.fillRegistry?.has(`${ctx.variant}/${want.quantity}`)) count(out, 'missing_trace');
  }
  traces.forEach((trace, i) => {
    const want = TRACES[i] as (typeof TRACES)[number];
    const decl = ctx.fillRegistry?.get(`${ctx.variant}/${want.quantity}`);
    if (decl === undefined) {
      out.unknown += 1;
      return;
    }
    if (decl.quantity === 'H' && decl.value_kind !== 'level') {
      count(out, 'datum_mismatch', trace.y.length);
      return;
    }
    const samples: { ts: number; value: number }[] = [];
    const times = new Set<number>();
    trace.x.forEach((raw, j) => {
      let ts: number;
      try {
        ts = parseInstant(TIME, raw);
      } catch (err) {
        if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
        throw err;
      }
      if (times.has(ts)) throw new SchemaDrift('duplicate_time', `plot.data.${i}.x`);
      times.add(ts);
      const value = trace.y[j];
      if (value === null || value === undefined) count(out, 'gap');
      else samples.push({ ts, value });
    });
    const kept = thin(samples, decl.expected_step_ms);
    count(out, 'thinned', samples.length - kept.length);
    for (const s of kept.sort((a, b) => a.ts - b.ts)) {
      if (decl.quantity === 'H' && s.value === 0) count(out, 'sentinel');
      else if (isFuture(s.ts, ctx.fetchedAt)) count(out, 'future');
      else if (s.ts < ctx.fetchedAt - MAX_AGE_MS) count(out, 'too_old');
      else {
        const value = scale(decl.to_canonical, s.value);
        const kind = decl.quantity === 'Q' ? 'Q' : 'level';
        out.fill?.push({ series: decl.key, ts: toIso(s.ts), value, qc: QC.RAW | rangeBit(kind, value) });
      }
    }
  });
  if (out.dropped.thinned === 0) delete out.dropped.thinned;
  return out;
}
