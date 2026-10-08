import {
  emptyNormalised,
  FORECAST_SOURCES,
  type ForecastPoint,
  type Normalised,
  parseInstant,
  SchemaDrift,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Trace } from './parse.ts';

// CH-4 BAFU forecast plot → one forecast run per station and capture (catalogue §2.7, A§6, A§7.4 item 9).
// Declared here, never inferred per row:
//  - time: every x value carries its own offset (`2026-09-30T11:00:00.000+02:00`, `iso-offset`); a forecast's valid
//    times are ahead of the fetch by design, so the future-time rule of invariant 4 (observations) is not applied;
//    the loader bounds them by the source's horizon (packages/core FORECAST_SOURCES, 120 h);
//  - run: the figure states no issue time (its title carries a clock time of the day only), so `issuedAt` is null and
//    the loader infers it from the fetch (`issued_inferred`). The key of a run is (series, first valid time, content
//    hash): the hourly captures of one run carry byte-identical forecast traces and are one run, whose fetched_at is
//    the earliest capture. The capture gate (`lastmod-runstart`) already stores one body per Last-Modified and run
//    start. `providerSegmentEnd` is null (BAFU draws no estimate segment);
//  - series: the manifest variant is the BAFU station id (four digits) and the run is that station's CH-1 series,
//    `<id>/Q` for a discharge forecast and `<id>/W` for a lake level (`target: 'CH-1'`, the spec lists CH-1 in
//    `refTarget`). The registry is not consulted here: an id CH-1 does not register is counted `unknown` by the
//    loader, never guessed;
//  - unit: the median's own `meta.unit`, looked up in the forecast source's declaration (FORECAST_SOURCES['CH-4']:
//    `m³/s` and `m3/s` Q × 1, `l/s` Q × 0.001, `m ü. M.` and `m ü.M.` H × 100 to centimetres). The two traces of the
//    envelope must state the same unit, the band none or the same; an unknown unit is drift, never a guess.
//    #78, the lake figure (`p_forecast`, spec `ch-4-forecast-lake`): BAFU states its traces in `m³/s` although the
//    values are lake levels in metres (Zürichsee 405.27 on 2026-10-08); its y-axis label says `m ü.M.`. For that
//    figure the wire passes the label (`axisUnit`, parse `parseAxisLabel`) and it is the unit: it must be a declared
//    H unit (else `unknown_unit` at `layout`), and the median must state the label or `m³/s` (`LAKE_TRACE_UNITS`,
//    else `unit_mismatch`); the envelope and band rules stay. A discharge figure never reads the label;
//  - kind: `ensemble_summary` (median, 25–75 % band and the extremes of the ensemble, `stepMs` one hour);
//  - values are the published ones (one decimal) times the declared factor, cleaned of float noise at 1e-6, never
//    reordered or clamped: if the provider's order does not hold the core flags the point `ORDER`.
//
// Layout of the figure, by position AND by name (the names are language-specific, and the maximum and the minimum
// carry the same name; `LAYOUT_DE` is what production fetches, the other languages exist only in tests). A missing,
// extra, reordered or renamed trace is drift (`ch4_layout`, quarantined by the loader), never a mislabelled run:
//
//   pos  name                  role
//   0    `Min. / Max.`         vmax: the upper edge of the ensemble (at or above the median at every point)
//   1    `Min. / Max.`         vmin: the lower edge (`showlegend: false`)
//   2    `25.-75. Perzentil`   band: a closed polygon of 2n + 1 points: the 25 % values at the median's x in order,
//                              then the 75 % values at the median's x in reverse order, then the first point again
//   3    `Median`              p50 and `value`
//   4    `Gemessen`            the measured trace: read and ignored, never stored (it starts a day before the run)
//
// Traces 0, 1 and 3 share their x values exactly (else `ch4_axis`); any other length, x or closing point of the band
// is `ch4_band`. A point with no value at all is a gap (counted, not stored); a run left with no point is none.
//
// Never stored: the measured trace, the layout (title, day lines, threshold bands: `parseBands` reads the bands for
// the flood test only) and every styling key.

export const SOURCE = 'CH-4';
export const TIME: TimeConvention = { kind: 'iso-offset' };

/** The names of the five traces, by position: maximum, minimum, 25–75 % band, median, measured. */
export type Layout = readonly [max: string, min: string, band: string, median: string, measured: string];

/** The German figure, the only one production fetches (`_de`). */
export const LAYOUT_DE: Layout = ['Min. / Max.', 'Min. / Max.', '25.-75. Perzentil', 'Median', 'Gemessen'];

const DECL = FORECAST_SOURCES['CH-4'];
const UNITS: Readonly<Record<string, readonly ['H' | 'Q', number]>> = DECL.units;
const VARIANT = /^\d{4}$/;

export type Context = {
  /** The manifest line's variant: the BAFU station id. */
  variant: string;
  /** #78, the lake figure only (`p_forecast`): its y-axis label (`parseAxisLabel`), which is then the unit. */
  axisUnit?: string;
};

/** #78: the trace unit BAFU states on its lake figures (whose values are lake levels in metres, not discharge). */
const LAKE_TRACE_UNITS: readonly string[] = ['m³/s'];

const count = (dropped: Record<string, number>, code: string) => {
  dropped[code] = (dropped[code] ?? 0) + 1;
};

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** `layout` is a parameter only for the language tests; production passes none. */
export function normalise(traces: readonly Trace[], ctx: Context, layout: Layout = LAYOUT_DE): Normalised {
  const out = emptyNormalised();
  if (!VARIANT.test(ctx.variant)) throw new SchemaDrift('bad_variant');
  if (traces.length !== layout.length) throw new SchemaDrift('ch4_layout', 'data');
  for (const [i, name] of layout.entries())
    if ((traces[i] as Trace).name !== name) throw new SchemaDrift('ch4_layout', `data.${i}`);
  const [vmaxT, vminT, bandT, median] = [0, 1, 2, 3].map((i) => traces[i] as Trace) as [Trace, Trace, Trace, Trace];

  const n = median.x.length;
  if (!same(vmaxT.x, median.x)) throw new SchemaDrift('ch4_axis', 'data.0');
  if (!same(vminT.x, median.x)) throw new SchemaDrift('ch4_axis', 'data.1');

  const unit = median.meta.unit;
  const label = ctx.axisUnit ?? unit;
  const decl = Object.hasOwn(UNITS, label) ? UNITS[label] : undefined;
  if (decl === undefined) throw new SchemaDrift('unknown_unit', ctx.axisUnit === undefined ? 'data.3' : 'layout');
  const [quantity, factor] = decl;
  // A lake figure is a level in a declared H unit whose traces state that unit or BAFU's mislabel, nothing else.
  if (ctx.axisUnit !== undefined) {
    if (quantity !== 'H') throw new SchemaDrift('unknown_unit', 'layout');
    if (unit !== label && !LAKE_TRACE_UNITS.includes(unit)) throw new SchemaDrift('unit_mismatch', 'data.3');
  }
  if (vmaxT.meta.unit !== unit) throw new SchemaDrift('unit_mismatch', 'data.0');
  if (vminT.meta.unit !== unit) throw new SchemaDrift('unit_mismatch', 'data.1');
  if (bandT.meta.unit !== '' && bandT.meta.unit !== unit) throw new SchemaDrift('unit_mismatch', 'data.2');

  if (n === 0) {
    count(out.dropped, 'empty_run');
    return out;
  }
  // The band polygon: 25 % forward, 75 % backward, closed on its first point.
  const closed = bandT.x.length === 2 * n + 1 && bandT.y.length === 2 * n + 1;
  const bandOk =
    closed &&
    median.x.every((x, i) => bandT.x[i] === x && bandT.x[2 * n - 1 - i] === x) &&
    bandT.x[2 * n] === bandT.x[0] &&
    bandT.y[2 * n] === bandT.y[0];
  if (!bandOk) throw new SchemaDrift('ch4_band', 'data.2');

  const when = (raw: string, i: number): number => {
    try {
      return parseInstant(TIME, raw);
    } catch (err) {
      if (!(err instanceof TimeError)) throw err;
      throw new SchemaDrift(`time_${err.code}`, `data.3.x.${i}`);
    }
  };
  const scale = (v: number | null | undefined): number | null =>
    v === null || v === undefined ? null : Math.round(v * factor * 1e6) / 1e6;

  const points: ForecastPoint[] = [];
  for (const [i, raw] of median.x.entries()) {
    const ms = when(raw, i);
    const p50 = scale(median.y[i]);
    const p25 = scale(bandT.y[i]);
    const p75 = scale(bandT.y[2 * n - 1 - i]);
    const vmax = scale(vmaxT.y[i]);
    const vmin = scale(vminT.y[i]);
    if ([p50, p25, p75, vmax, vmin].every((v) => v === null)) count(out.dropped, 'gap');
    else points.push({ ts: toIso(ms), flags: 0, value: p50, p25, p50, p75, vmin, vmax });
  }
  if (points.length === 0) {
    count(out.dropped, 'empty_run');
    return out;
  }
  out.forecasts = [
    {
      target: 'CH-1',
      series: `${ctx.variant}/${quantity === 'H' ? 'W' : 'Q'}`,
      kind: DECL.kind,
      stepMs: DECL.stepMs,
      issuedAt: null,
      providerSegmentEnd: null,
      points,
    },
  ];
  return out;
}
