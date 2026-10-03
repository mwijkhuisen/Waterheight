import {
  emptyNormalised,
  FORECAST_FLAGS,
  FORECAST_SOURCES,
  type ForecastPoint,
  type Normalised,
  parseInstant,
  SchemaDrift,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Point } from './parse.ts';

// DE-2 BfG water-level forecast → one forecast run per station and capture (catalogue §2.2, A§6, A§7.4 item 9).
// Declared here, never inferred per row:
//  - time: every `initialized` and `timestamp` carries its own offset (`iso-offset`, `+02:00` / `+01:00`); a forecast's
//    valid times are ahead of the fetch by design, so the future-time rule of invariant 4 (observations) is not
//    applied; the loader refuses an issue time more than 15 minutes ahead of the fetch (`future_issue`);
//  - run: the points of one document are one run, which must share one `initialized` (the same instant), else
//    drift (`run_mismatch`). `initialized` is the provider's issue time (`issuedAt`, not inferred), so the key of
//    a run is (series, first valid time, content hash) and a re-fetch of the same run is a confirmation;
//  - series: the manifest variant is the PEGELONLINE station uuid and the run is that station's DE-1 stage series
//    `<uuid>/W` (`target: 'DE-1'`; the spec lists DE-1 in `refTarget`). The registry is not consulted here: a uuid
//    DE-1 does not register is counted `unknown` by the loader, never guessed;
//  - unit: the payload states none. The unit is the forecast source's own declaration (centimetres of stage,
//    packages/core FORECAST_SOURCES), never borrowed from the DE-1 series' row;
//  - sentinel: 99999 (PEGELONLINE's missing value) is dropped (`sentinel`); a null value is a gap (`gap`), never 0;
//  - estimate: BfG states 0–48 h as `forecast` and 48–96 h as `estimate`. A point is flagged ESTIMATE when its
//    `type` is `estimate` or it lies more than 48 h after `initialized`; when the two disagree the point is still
//    stored, flagged, and counted (`estimate_mismatch`). `providerSegmentEnd` is the last point that BfG
//    calls a `forecast`;
//  - a run that ends early (the level is above the forecastable range) is stored as it is, never extended.

export const SOURCE = 'DE-2';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const DECL = FORECAST_SOURCES['DE-2'];
const [, TO_CM] = DECL.units.cm;
/** PEGELONLINE's missing value. */
const SENTINEL = 99999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Context = {
  /** The manifest line's variant: the PEGELONLINE station uuid. */
  variant: string;
};

const count = (dropped: Record<string, number>, code: string) => {
  dropped[code] = (dropped[code] ?? 0) + 1;
};

export function normalise(points: readonly Point[], ctx: Context): Normalised {
  const out = emptyNormalised();
  if (!UUID.test(ctx.variant)) throw new SchemaDrift('bad_variant');
  const when = (raw: string, i: number, field: string): number => {
    try {
      return parseInstant(TIME, raw);
    } catch (err) {
      if (!(err instanceof TimeError)) throw err;
      throw new SchemaDrift(`time_${err.code}`, `${i}.${field}`);
    }
  };
  const first = points[0];
  if (first === undefined) {
    count(out.dropped, 'empty_run');
    return out;
  }
  const initialized = when(first.initialized, 0, 'initialized');
  const kept: ForecastPoint[] = [];
  let segmentEnd: number | null = null;
  for (const [i, p] of points.entries()) {
    if (when(p.initialized, i, 'initialized') !== initialized)
      throw new SchemaDrift('run_mismatch', `${i}.initialized`);
    const ms = when(p.timestamp, i, 'timestamp');
    if (p.value === null) count(out.dropped, 'gap');
    else if (p.value === SENTINEL) count(out.dropped, 'sentinel');
    else {
      const late = ms - initialized > DECL.segmentMs;
      const estimate = p.type === 'estimate';
      if (late !== estimate) count(out.dropped, 'estimate_mismatch');
      if (!estimate && (segmentEnd === null || ms > segmentEnd)) segmentEnd = ms;
      kept.push({ ts: toIso(ms), value: p.value * TO_CM, flags: late || estimate ? FORECAST_FLAGS.ESTIMATE : 0 });
    }
  }
  if (kept.length === 0) {
    count(out.dropped, 'empty_run');
    return out;
  }
  out.forecasts = [
    {
      target: 'DE-1',
      series: `${ctx.variant}/W`,
      kind: DECL.kind,
      stepMs: DECL.stepMs,
      issuedAt: toIso(initialized),
      providerSegmentEnd: segmentEnd === null ? null : toIso(segmentEnd),
      points: kept,
    },
  ];
  return out;
}
