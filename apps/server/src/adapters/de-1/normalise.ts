import {
  type Datum,
  emptyNormalised,
  isFuture,
  isSentinel,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  type SeriesDecl,
  scale,
  type TimeConvention,
  TimeError,
  thin,
  toIso,
} from '@rws/core';
import type { Measurement, Station } from './parse.ts';

// DE-1 PEGELONLINE → canonical rows (catalogue §2.2, §4.2, §4.5). Declared here,
// never inferred per row:
//  - time: ISO 8601 with the provider's true local offset (+02:00 / +01:00);
//  - sentinel: 99999 (dropped before conversion); negative W and Q are valid;
//  - unit, factor and steps: from the series' registry row. A payload unit that
//    differs from the declared one drops that series' values (and is reported);
//  - everything is ROHDATEN: qc bit "raw";
//  - only the W and Q timeseries; a series the registry does not know is
//    counted, never registered.

export const SOURCE = 'DE-1';
export const TIME: TimeConvention = { kind: 'iso-offset' };

/** PEGELONLINE serves 31 days; an older "current" value belongs to a dead series. */
const MAX_AGE_MS = 45 * 86_400_000;

export type Context = {
  registry: Registry;
  /** When the payload was fetched (UTC ms): the reference for "future" and "too old". */
  fetchedAt: number;
  /** The manifest line's variant; `<station uuid>/<W|Q>` for a measurements payload. */
  variant: string;
};

const QUANTITY = new Set(['W', 'Q']);

const GAUGE_ZERO_DATUM: Readonly<Record<string, Datum>> = {
  'm. ü. NHN': 'NHN',
  'm. ü. NN': 'NN',
  // Basel-Rheinhalle: the Swiss datum.
  'mü.M.': 'LN02',
};

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

/** One provider value → a canonical row, or the reason it is dropped. */
function row(decl: SeriesDecl, ts: number, raw: number, ctx: Context, out: Normalised): void {
  const reason = isSentinel(SOURCE, raw)
    ? 'sentinel'
    : isFuture(ts, ctx.fetchedAt)
      ? 'future'
      : ts < ctx.fetchedAt - MAX_AGE_MS
        ? 'too_old'
        : null;
  if (reason !== null) {
    count(out, reason);
    return;
  }
  const value = scale(decl.to_canonical, raw);
  const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'stage');
  out.obs.push({ series: decl.key, ts: toIso(ts), value, qc: QC.RAW | rangeBit(kind, value) });
}

/** The basin `stations.json`: the current value of every registered W and Q series, stored as published. */
export function normaliseBasin(stations: readonly Station[], ctx: Context): Normalised {
  const out = emptyNormalised();
  for (const station of stations) {
    for (const series of station.timeseries) {
      if (!QUANTITY.has(series.shortname)) continue;
      const decl = ctx.registry.get(`${station.uuid}/${series.shortname}`);
      if (decl === undefined) {
        out.unknown += 1;
        continue;
      }
      if (series.currentMeasurement === undefined) continue;
      if (series.unit !== decl.native_unit) {
        count(out, 'unit_mismatch');
        continue;
      }
      row(decl, instant(series.currentMeasurement.timestamp), series.currentMeasurement.value, ctx, out);
    }
  }
  return out;
}

/**
 * `stations/{uuid}/{W|Q}/measurements.json`: the series is named by the
 * manifest line, because the body holds only timestamps and values. Windows
 * overlap (both ends are inclusive); a repeated timestamp keeps its last
 * value. A series published more often than we store it is thinned by the
 * declared rule (packages/core `thin`).
 */
export function normaliseSeries(points: readonly Measurement[], ctx: Context): Normalised {
  const out = emptyNormalised();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[WQ]$/.test(ctx.variant)) throw new SchemaDrift('bad_variant');
  const decl = ctx.registry.get(ctx.variant);
  if (decl === undefined) {
    out.unknown = 1;
    return out;
  }
  const byTime = new Map<number, number>();
  for (const p of points) {
    const ts = instant(p.timestamp);
    if (byTime.has(ts)) count(out, 'duplicate');
    byTime.set(ts, p.value);
  }
  let samples = [...byTime].map(([ts, value]) => ({ ts, value })).sort((a, b) => a.ts - b.ts);
  const valid = samples.filter((s) => !isSentinel(SOURCE, s.value));
  count(out, 'sentinel', samples.length - valid.length);
  samples = valid;
  if (decl.native_step_ms < decl.expected_step_ms) {
    const kept = thin(samples, decl.expected_step_ms);
    count(out, 'thinned', samples.length - kept.length);
    samples = kept;
  }
  for (const s of samples) row(decl, s.ts, s.value, ctx, out);
  for (const code of ['sentinel', 'thinned']) if (out.dropped[code] === 0) delete out.dropped[code];
  return out;
}

/** The daily metadata `stations.json`: the current gauge zero (PNP) of every registered series that has one. */
export function normaliseMeta(stations: readonly Station[], ctx: Context): Normalised {
  const out = emptyNormalised();
  for (const station of stations) {
    for (const series of station.timeseries) {
      if (!QUANTITY.has(series.shortname) || series.gaugeZero === undefined) continue;
      const decl = ctx.registry.get(`${station.uuid}/${series.shortname}`);
      if (decl === undefined) continue;
      const datum = GAUGE_ZERO_DATUM[series.gaugeZero.unit];
      if (datum === undefined) {
        count(out, 'unknown_zero_unit');
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(series.gaugeZero.validFrom)) throw new SchemaDrift('bad_valid_from');
      out.gaugeZeros.push({
        series: decl.key,
        value_m: series.gaugeZero.value,
        datum,
        valid_from: series.gaugeZero.validFrom,
      });
    }
  }
  return out;
}
