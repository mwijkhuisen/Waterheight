import type { Req } from '../../../http/types.ts';

// Request builders of the KiWIS client (catalogue §2.4), shared by SPW (BE-3) and, from P13, HIC and VMM. The host,
// path and `datasource` come from the registry URL the caller hands in (invariant 1); the series are `ts_id`s the
// provider's own list returned, refused unless they are digits; nothing else of a payload reaches a URL.
//
// Limits: a call names at most 100 `ts_id`s and asks for at most 250,000 values (beyond it KiWIS answers
// `TooManyResults`, an error, never a partial result). The value count of a call is bounded for the densest step a
// series may have (one minute), so a window is sized without knowing each series' step. Always `timezone=UTC` and
// explicit `Z` bounds (how offset-less inputs are read is unverified). Data calls get the 60 s timeout, list calls
// the 120 s one. P13's seam: each request carries its theoretical value count (HIC charges about one credit per
// 10,000 values) and the caller's headers (where its bearer token goes).

export const MAX_IDS = 100;
export const MAX_VALUES = 250_000;
/** The densest step a KiWIS series may have: the bound of every window. */
export const MIN_STEP_MS = 60_000;
/** The most calls one plan may hold: a window or series list beyond it is a caller's bug, never a request plan. */
export const MAX_CALLS = 10_000;
const DAY_MS = 86_400_000;
const TS_ID = /^\d{1,12}$/;

export type ValuesRequest = Req & { values: number; seen_id: string };

export type Window = { from: Date; to: Date };

/** `2026-08-24T00:00:00Z`: second precision, explicit Z. */
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** encodeURIComponent, keeping the commas of a list and the colons of a time as KiWIS documents them. */
const enc = (v: string) => encodeURIComponent(v).replaceAll('%2C', ',').replaceAll('%3A', ':');

/**
 * The longest window a call of `ids` series may span: whole days while a day fits (100 series: 1 day, 144,100
 * values), else whole minutes; each series yields at most span / step + 1 values (both bounds may be inclusive).
 */
export function spanMs(ids: number, maxValues = MAX_VALUES, minStepMs = MIN_STEP_MS): number {
  const steps = Math.floor(maxValues / ids) - 1;
  if (steps < 1) throw new RangeError('a call of this many series cannot hold one value each');
  const span = steps * minStepMs;
  return span >= DAY_MS ? Math.floor(span / DAY_MS) * DAY_MS : span;
}

/**
 * The getTimeseriesValues calls that cover `window` for `tsIds`: batches of at most `maxIds` (in the order given),
 * each split into windows of `spanMs`, every call within `maxValues`. `variant` names each call (its seen id too,
 * so a resumed seed skips what it already fetched). The limits must be whole numbers of at least 1 (a 0 or a
 * negative one would never end the plan), and a plan of more than `MAX_CALLS` calls is refused before it is built.
 */
export function valuesRequests(
  base: string,
  tsIds: readonly string[],
  window: Window,
  opts: {
    /** The call's name and seen id, from its window start, batch index and the batch's ts_ids. */
    variant: (from: Date, batch: number, ids: readonly string[]) => string;
    maxIds?: number;
    maxValues?: number;
    minStepMs?: number;
    headers?: Readonly<Record<string, string>>;
  },
): ValuesRequest[] {
  for (const v of [opts.maxIds, opts.maxValues, opts.minStepMs]) {
    if (v !== undefined && !(Number.isInteger(v) && v >= 1)) throw new RangeError('a limit is not a whole number ≥ 1');
  }
  const maxIds = Math.min(opts.maxIds ?? MAX_IDS, MAX_IDS);
  const maxValues = Math.min(opts.maxValues ?? MAX_VALUES, MAX_VALUES);
  const minStepMs = Math.min(opts.minStepMs ?? MIN_STEP_MS, MIN_STEP_MS);
  for (const id of tsIds) if (!TS_ID.test(id)) throw new RangeError('a ts_id is not a number');
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!(from < to)) return [];
  const src = new URL(base);
  const datasource = src.searchParams.get('datasource');
  if (datasource === null || !/^\d{1,3}$/.test(datasource)) throw new RangeError('the base URL names no datasource');
  let calls = 0;
  for (let b = 0; b * maxIds < tsIds.length; b += 1) {
    const n = Math.min(maxIds, tsIds.length - b * maxIds);
    calls += Math.ceil((to - from) / spanMs(n, maxValues, minStepMs));
    if (calls > MAX_CALLS) throw new RangeError('the plan holds too many calls');
  }
  const out: ValuesRequest[] = [];
  for (let b = 0; b * maxIds < tsIds.length; b += 1) {
    const ids = tsIds.slice(b * maxIds, (b + 1) * maxIds);
    const span = spanMs(ids.length, maxValues, minStepMs);
    for (let t = from; t < to; t += span) {
      const end = Math.min(t + span, to);
      const query = [
        ['service', 'kisters'],
        ['type', 'queryServices'],
        ['datasource', datasource],
        ['request', 'getTimeseriesValues'],
        ['format', 'json'],
        ['ts_id', ids.join(',')],
        ['from', utc(new Date(t))],
        ['to', utc(new Date(end))],
        ['timezone', 'UTC'],
        ['returnfields', 'Timestamp,Value,Quality Code'],
        ['metadata', 'true'],
        ['md_returnfields', 'ts_id,ts_path,station_no,stationparameter_no,ts_unitsymbol'],
      ]
        .map(([k, v]) => `${k}=${enc(v as string)}`)
        .join('&');
      const variant = opts.variant(new Date(t), b, ids);
      out.push({
        url: `${src.origin}${src.pathname}?${query}`,
        method: 'GET',
        variant,
        seen_id: variant,
        timeout: 'normal',
        ...(opts.headers ? { headers: { ...opts.headers } } : {}),
        values: ids.length * (Math.ceil((end - t) / minStepMs) + 1),
      });
    }
  }
  return out;
}

/** The span a reference call asks (P7a: a percentile or flood list covers a whole period of record). */
const REFERENCE_SPAN = { from: '1900-01-01T00:00:00Z', to: '2028-01-01T00:00:00Z' } as const;

/**
 * P7a: getTimeseriesValues over the whole period of record for reference series (one value per percentile, a few per
 * flood list), batches of at most `MAX_IDS` ts_ids in the order given, every call within the value limit (a series
 * states at most `perSeries` values). The metadata names the series by station, parameter, shortname and unit, so a
 * value never depends on the order of an answer. `variant` names each call by its ts_ids.
 */
export function referenceRequests(
  base: string,
  tsIds: readonly string[],
  opts: { variant: (ids: readonly string[]) => string; perSeries?: number },
): Req[] {
  for (const id of tsIds) if (!TS_ID.test(id)) throw new RangeError('a ts_id is not a number');
  const perSeries = opts.perSeries ?? 3;
  if (!(Number.isInteger(perSeries) && perSeries >= 1 && perSeries * MAX_IDS <= MAX_VALUES)) {
    throw new RangeError('perSeries is out of range');
  }
  const src = new URL(base);
  const datasource = src.searchParams.get('datasource');
  if (datasource === null || !/^\d{1,3}$/.test(datasource)) throw new RangeError('the base URL names no datasource');
  const out: Req[] = [];
  for (let b = 0; b < tsIds.length; b += MAX_IDS) {
    const ids = tsIds.slice(b, b + MAX_IDS);
    const query = [
      ['service', 'kisters'],
      ['type', 'queryServices'],
      ['datasource', datasource],
      ['request', 'getTimeseriesValues'],
      ['format', 'json'],
      ['ts_id', ids.join(',')],
      ['from', REFERENCE_SPAN.from],
      ['to', REFERENCE_SPAN.to],
      ['timezone', 'UTC'],
      ['returnfields', 'Timestamp,Value'],
      ['metadata', 'true'],
      ['md_returnfields', 'station_no,stationparameter_no,ts_shortname,ts_unitsymbol'],
    ]
      .map(([k, v]) => `${k}=${enc(v as string)}`)
      .join('&');
    out.push({
      url: `${src.origin}${src.pathname}?${query}`,
      method: 'GET',
      variant: opts.variant(ids),
      timeout: 'normal',
    });
  }
  return out;
}

/**
 * What a KiWIS URL of ours must never do (catalogue §2.4): use the frontend's `/services/kiwcp/`, list with a
 * wildcard, ask for values in any time zone but UTC, or name `river_name` as a returnfield (HTTP 500 there).
 */
export function kiwisUrlProblems(url: string): string[] {
  const u = new URL(url);
  const q = u.searchParams;
  const problems: string[] = [];
  if (u.pathname.includes('/kiwcp/')) problems.push('kiwcp');
  if (!u.pathname.endsWith('/KiWIS/KiWIS')) problems.push('path');
  try {
    if (decodeURIComponent(u.search).includes('*')) problems.push('wildcard');
  } catch {
    problems.push('encoding');
  }
  if (q.get('format') !== 'json') problems.push('format');
  const request = q.get('request') ?? '';
  if (/^getTimeseriesValue/.test(request) && q.get('timezone') !== 'UTC') problems.push('timezone');
  if ((q.get('returnfields') ?? '').split(',').includes('river_name') && request !== 'getStationList') {
    problems.push('river_name');
  }
  for (const k of ['from', 'to']) {
    const v = q.get(k);
    if (v !== null && !/Z$/.test(v)) problems.push(`${k}_offset`);
  }
  return problems;
}
