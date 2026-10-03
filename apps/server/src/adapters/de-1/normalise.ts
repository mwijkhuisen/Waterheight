import {
  type Datum,
  emptyNormalised,
  isFuture,
  isSentinel,
  type Normalised,
  parseInstant,
  QC,
  type ReferenceRow,
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
//    measurements.json carries no unit, so a series whose unit the newest basin
//    payload showed changed is dropped there too (the loader passes that list);
//  - a gauge zero's validFrom: local midnight in Europe/Berlin;
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
  /** Series whose unit the newest basin payload showed changed: a measurements payload carries no unit. */
  unitMismatch?: ReadonlySet<string>;
};

const QUANTITY = new Set(['W', 'Q']);

// A Map, not an object: a provider string such as `constructor` must not find an inherited property.
const GAUGE_ZERO_DATUM: ReadonlyMap<string, Datum> = new Map([
  ['m. ü. NHN', 'NHN'],
  ['m. ü. NN', 'NN'],
  // Basel-Rheinhalle: the Swiss datum.
  ['mü.M.', 'LN02'],
]);

/**
 * A gauge zero's `validFrom` is a German calendar date: it starts at local
 * midnight in Berlin. Midnight is never inside a DST transition there; the
 * rule is declared anyway, because nothing is inferred.
 */
const VALID_FROM: TimeConvention = {
  kind: 'naive-local',
  zone: 'Europe/Berlin',
  dst: { gap: 'shift-forward', overlap: 'earlier' },
};

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

function validFrom(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new SchemaDrift('bad_valid_from');
  try {
    return toIso(parseInstant(VALID_FROM, `${raw}T00:00:00`));
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift('bad_valid_from');
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
  const mismatch: string[] = [];
  for (const station of stations) {
    for (const series of station.timeseries) {
      if (!QUANTITY.has(series.shortname)) continue;
      const decl = ctx.registry.get(`${station.uuid}/${series.shortname}`);
      if (decl === undefined) {
        out.unknown += 1;
        continue;
      }
      // Every series of the basin call states its unit: the loader keeps this list for the series payloads.
      if (series.unit !== decl.native_unit) mismatch.push(decl.key);
      if (series.currentMeasurement === undefined) continue;
      if (series.unit !== decl.native_unit) {
        count(out, 'unit_mismatch');
        continue;
      }
      row(decl, instant(series.currentMeasurement.timestamp), series.currentMeasurement.value, ctx, out);
    }
  }
  out.unitMismatch = mismatch.sort();
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
  // The newest basin payload shows another unit for this series: its values would be stored mis-scaled.
  if (ctx.unitMismatch?.has(decl.key)) {
    if (points.length > 0) count(out, 'unit_mismatch', points.length);
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

type RefKind = { kind: string; semantics: ReferenceRow['semantics']; dated: 'period' | 'valid_from' | 'occurrence' };

// PEGELONLINE characteristic values (catalogue §2.2, C22): `NW` and `HW` are extremes of the statistical period
// (Kaub NW 25, HW 719), never NNW or HHW. `TuGLW` is a fairway depth, not a level. Declared, never inferred.
const REF_KINDS: ReadonlyMap<string, RefKind> = new Map([
  ['MNW', { kind: 'MNW', semantics: 'statistical', dated: 'period' }],
  ['MW', { kind: 'MW', semantics: 'statistical', dated: 'period' }],
  ['MHW', { kind: 'MHW', semantics: 'statistical', dated: 'period' }],
  ['NW', { kind: 'NW', semantics: 'historical', dated: 'period' }],
  ['HW', { kind: 'HW', semantics: 'historical', dated: 'period' }],
  ['NNW', { kind: 'NNW', semantics: 'historical', dated: 'occurrence' }],
  ['HHW', { kind: 'HHW', semantics: 'historical', dated: 'occurrence' }],
  ['HSW', { kind: 'HSW', semantics: 'operational', dated: 'valid_from' }],
  ['M_I', { kind: 'MARKE_I', semantics: 'operational', dated: 'valid_from' }],
  ['M_II', { kind: 'MARKE_II', semantics: 'operational', dated: 'valid_from' }],
  ['M_III', { kind: 'MARKE_III', semantics: 'operational', dated: 'valid_from' }],
  ['GlW', { kind: 'GLW', semantics: 'statistical', dated: 'valid_from' }],
]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (raw: string): string => {
  if (!DAY.test(raw) || Number.isNaN(Date.parse(raw))) throw new SchemaDrift('bad_period');
  return raw;
};

/** The reference rows of one W series' characteristic values; stage values only, in cm. */
function references(decl: SeriesDecl, series: Station['timeseries'][number], out: Normalised): void {
  for (const cv of series.characteristicValues ?? []) {
    if (cv.shortname === 'TuGLW') {
      count(out, 'not_a_level');
      continue;
    }
    const k = REF_KINDS.get(cv.shortname);
    if (k === undefined) {
      count(out, 'unknown_kind');
      continue;
    }
    if (cv.unit !== 'cm' || decl.native_unit !== 'cm') {
      count(out, 'unit_mismatch');
      continue;
    }
    const period =
      cv.timespanStart !== undefined && cv.timespanEnd !== undefined
        ? ([day(cv.timespanStart), day(cv.timespanEnd)] as [string, string])
        : null;
    // The provider has typos (a validFrom in the year 0007): that is a value without a stated start, not drift.
    let from: string | null = null;
    if (cv.validFrom !== undefined) {
      try {
        from = validFrom(cv.validFrom);
      } catch (err) {
        if (!(err instanceof SchemaDrift)) throw err;
        count(out, 'bad_valid_from');
      }
    }
    const occ = cv.occurrences?.length ? ` (${cv.occurrences.join(', ')})` : '';
    out.references?.push({
      series: decl.key,
      kind: k.kind,
      value: cv.value,
      unit: 'cm',
      semantics: k.semantics,
      convention: null,
      period,
      season_from_md: 101,
      season_to_md: 1231,
      priority: 0,
      basis_label: `${cv.longname.trim()}${occ}`.slice(0, 500),
      valid_from: from,
    });
  }
}

/**
 * The daily metadata `stations.json`: the current gauge zero (PNP) of every registered series that has one, and
 * the reference values (characteristic values) of every registered W series; every W series of the payload is
 * in `refScope`, so a kind the provider drops is closed.
 */
export function normaliseMeta(stations: readonly Station[], ctx: Context): Normalised {
  const out = emptyNormalised();
  out.references = [];
  out.refScope = [];
  for (const station of stations) {
    for (const series of station.timeseries) {
      if (series.shortname === 'W') {
        const w = ctx.registry.get(`${station.uuid}/W`);
        if (w !== undefined) {
          out.refScope.push({ series: w.key });
          references(w, series, out);
        }
      }
      if (!QUANTITY.has(series.shortname) || series.gaugeZero === undefined) continue;
      const decl = ctx.registry.get(`${station.uuid}/${series.shortname}`);
      if (decl === undefined) continue;
      const datum = GAUGE_ZERO_DATUM.get(series.gaugeZero.unit);
      if (datum === undefined) {
        count(out, 'unknown_zero_unit');
        continue;
      }
      out.gaugeZeros.push({
        series: decl.key,
        value_m: series.gaugeZero.value,
        datum,
        valid_from: validFrom(series.gaugeZero.validFrom),
      });
    }
  }
  if (out.references?.length === 0) delete out.references;
  if (out.refScope?.length === 0) delete out.refScope;
  return out;
}
