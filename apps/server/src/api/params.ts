import {
  type ApiErrorCode,
  FORECAST_AHEAD_MS,
  FRAMES_MAX_HOURS,
  FramesQuery,
  floorBucket,
  INSTANT_MAX_LENGTH,
  instantMs,
  RESOLUTIONS,
  type Resolution,
  SERIES_ID_MAX,
  SeriesForecastQuery,
  SeriesPath,
  SeriesQuery,
  SnapshotQuery,
  SPAN_CAP_MS,
} from '@rws/contracts';
import type { z } from 'zod';

// Request validation of the public API (A§9.2). Pure: it never asks the
// database (displayStart comes from the in-process DisplayWindow), so a
// refused request costs no query. Every refusal is a fixed code; nothing of the
// request is echoed.

/** A request the API refuses with a fixed code. */
export class Refused extends Error {
  readonly status: 400 | 404;
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, status: 400 | 404 = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** How far ahead of the server's clock `t` may be: a client clock that runs a little fast still works. */
export const SKEW_MS = 5 * 60_000;
/** `to` may reach this far past now, so the current bucket is in the key space and nothing later is. */
export const TO_AHEAD_MS = 10 * 60_000;
const H48_MS = 48 * 3_600_000;

/**
 * The query string as an object. A repeated key and a value longer than any
 * parameter may be are refused here, before anything is parsed.
 */
export function queryOf(url: string): Record<string, string> {
  const seen = new Map<string, string>();
  for (const [key, value] of new URL(url).searchParams) {
    if (seen.has(key)) throw new Refused('repeated_parameter');
    if (value.length > INSTANT_MAX_LENGTH) throw new Refused('bad_parameter');
    seen.set(key, value);
  }
  return Object.fromEntries(seen);
}

/** A strict schema: an unknown key is `unknown_parameter`, anything else that fails is `bad_parameter`. */
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new Refused(r.error.issues.some((i) => i.code === 'unrecognized_keys') ? 'unknown_parameter' : 'bad_parameter');
}

/** For the routes that take no parameter at all. */
export function noQuery(url: string): void {
  if (Object.keys(queryOf(url)).length > 0) throw new Refused('unknown_parameter');
}

function instant(text: string): number {
  const ms = instantMs(text);
  if (ms === undefined) throw new Refused('bad_parameter');
  return ms;
}

/**
 * /snapshot: `t` floored to its 10-minute bucket, within [displayStart, now + 48 h] (P8b, D8: after now the snapshot
 * holds forecasts only). Beyond is `out_of_range` before any query.
 */
export function snapshotParams(url: string, nowMs: number, displayStartMs: number): number {
  const ms = instant(parsed(SnapshotQuery, queryOf(url)).t);
  const t = floorBucket(ms);
  if (ms > nowMs + FORECAST_AHEAD_MS || t < displayStartMs) throw new Refused('out_of_range');
  return t;
}

/**
 * /series/{id}/forecast (P8b): an int4 id; `asof` with the rules of `t`, floored to the grid, within [displayStart,
 * now + skew]; absent, now floored.
 */
export function seriesForecastParams(
  rawId: string,
  url: string,
  nowMs: number,
  displayStartMs: number,
): { id: number; asof: number } {
  const q = parsed(SeriesForecastQuery, queryOf(url));
  const id = Number(parsed(SeriesPath, { id: rawId }).id);
  if (id > SERIES_ID_MAX) throw new Refused('bad_parameter');
  const ms = q.asof === undefined ? nowMs : instant(q.asof);
  const asof = floorBucket(ms);
  if (ms > nowMs + SKEW_MS || asof < displayStartMs) throw new Refused('out_of_range');
  return { id, asof };
}

export type SeriesParams = { id: number; from: number; to: number; res: Resolution };

/**
 * /series/{id}: an int4 id; `from` and `to` floored to the grid, from ≥
 * displayStart, to ≤ now + 10 min, from < to; the span within the cap of
 * `res`, which defaults to the finest resolution whose cap holds it.
 */
export function seriesParams(rawId: string, url: string, nowMs: number, displayStartMs: number): SeriesParams {
  const q = parsed(SeriesQuery, queryOf(url));
  const id = Number(parsed(SeriesPath, { id: rawId }).id);
  if (id > SERIES_ID_MAX) throw new Refused('bad_parameter');
  const fromMs = instant(q.from);
  const toMs = instant(q.to);
  const from = floorBucket(fromMs);
  const to = floorBucket(toMs);
  if (from < displayStartMs || toMs > nowMs + TO_AHEAD_MS) throw new Refused('out_of_range');
  if (from >= to) throw new Refused('bad_parameter');
  const span = to - from;
  const res = q.res ?? RESOLUTIONS.find((r) => span <= SPAN_CAP_MS[r]);
  if (res === undefined || span > SPAN_CAP_MS[res]) throw new Refused('span_too_long');
  return { id, from, to, res };
}

const HOUR_MS = 3_600_000;

/**
 * /frames (P11b): `from` and `to` whole UTC hours (an offset is fine), from < to, step `1h`; a span over 14 days is
 * `span_too_long`; from ≥ ceilHour(displayStart) and to ≤ now (the partial bucket of now is never served), else
 * `out_of_range`. All before any query.
 */
export function framesParams(url: string, nowMs: number, displayStartMs: number): { from: number; to: number } {
  const q = parsed(FramesQuery, queryOf(url));
  const from = instant(q.from);
  const to = instant(q.to);
  if (from % HOUR_MS !== 0 || to % HOUR_MS !== 0 || from >= to) throw new Refused('bad_parameter');
  if (to - from > FRAMES_MAX_HOURS * HOUR_MS) throw new Refused('span_too_long');
  if (from < Math.ceil(displayStartMs / HOUR_MS) * HOUR_MS || to > nowMs) throw new Refused('out_of_range');
  return { from, to };
}

export type CachePolicy = { header: string; ttlMs: number };

/**
 * Cache-Control by the age of an instant (A§9.2): the current bucket 60 s with
 * stale-while-revalidate, younger than 48 h 600 s, older one day. Never
 * `immutable` before versioned URLs (P9b). The in-process cache keeps an answer
 * for the same time.
 */
export function agePolicy(instantMs: number, nowMs: number): CachePolicy {
  if (instantMs >= floorBucket(nowMs))
    return { header: 'public, max-age=60, stale-while-revalidate=300', ttlMs: 60_000 };
  if (nowMs - instantMs < H48_MS) return { header: 'public, max-age=600', ttlMs: 600_000 };
  return { header: 'public, max-age=86400', ttlMs: 86_400_000 };
}

/** The longest raw query string (`?` included) any route takes; longer is a 400 before anything is parsed (P9b). */
export const QUERY_MAX_BYTES = 256;

/** `v` of /snapshot and /series/{id}, once the route's own parse has validated it (VERSION_RE); else undefined. */
export function versionParam(url: string): number | undefined {
  const v = new URL(url).searchParams.get('v');
  return v === null ? undefined : Number(v);
}
