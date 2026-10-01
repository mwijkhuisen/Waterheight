import { z } from 'zod';
import { HealthSourceId } from './health.ts';
import { DATUMS, NATIVE_UNITS } from './stations.ts';

// The public read API (A§9.2; PHASES P4a): /api/v1/meta, /stations, /snapshot
// and /series/{id}. Field names follow the static files of A§9.1 (camelCase).
// Every object is strict and every array bounded: the API checks each answer
// against these schemas before it caches or sends it, so a field added by
// mistake is a 503, never a leak. The OpenAPI document (openapi.ts) is built
// from the same schemas.

const iso = z.iso.datetime();
const count = z.number().int().nonnegative();

/** The stable error codes of every 4xx and 5xx body; nothing of the request is echoed. */
export const API_ERROR_CODES = [
  'unknown_parameter',
  'repeated_parameter',
  'bad_parameter',
  'out_of_range',
  'span_too_long',
  'not_found',
  'method_not_allowed',
  'busy',
  'unavailable',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export const ApiError = z.strictObject({ error: z.enum(API_ERROR_CODES) });
export type ApiError = z.infer<typeof ApiError>;

// --- Parameters ---------------------------------------------------------------

/** Every query value is at most this long; longer is a 400 before anything is parsed. */
export const INSTANT_MAX_LENGTH = 32;
/**
 * RFC 3339 with an offset: uppercase `T` and `Z`, seconds optional (`2026-11-20T14:00Z`),
 * a fraction of at most 9 digits, years 1900–2099. In a query string a `+` must be
 * sent as `%2B` (a raw `+` decodes to a space).
 */
export const INSTANT_RE =
  /^((?:19|20)[0-9]{2})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:[0-9]{2})$/;
/** The time grid of `t`, `from` and `to` (D11): every instant is floored to it in UTC. */
export const BUCKET_MS = 10 * 60_000;
export const RESOLUTIONS = ['raw', '1h', '1d'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
const DAY_MS = 86_400_000;
/** The longest span `[from, to)` per resolution (A§9.2), finest first. */
export const SPAN_CAP_MS: Readonly<Record<Resolution, number>> = {
  raw: 14 * DAY_MS,
  '1h': 366 * DAY_MS,
  '1d': 3660 * DAY_MS,
};
/** At most this many points in one /series answer (A§8 Q4). */
export const MAX_POINTS = 20_000;
/** A series id: a positive int4. */
export const SERIES_ID_RE = /^[1-9][0-9]{0,9}$/;
export const SERIES_ID_MAX = 2_147_483_647;

const Instant = z.string().max(INSTANT_MAX_LENGTH).regex(INSTANT_RE);
export const SnapshotQuery = z.strictObject({ t: Instant });
export const SeriesQuery = z.strictObject({ from: Instant, to: Instant, res: z.enum(RESOLUTIONS).optional() });
export const SeriesPath = z.strictObject({ id: z.string().regex(SERIES_ID_RE) });

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The UTC epoch milliseconds of an instant in the format of `INSTANT_RE`, or
 * undefined: every field in range, a real calendar day, an offset of at most
 * 23:59, and not `-00:00` (RFC 3339 §4.3: the offset is unknown).
 */
export function instantMs(text: string): number | undefined {
  if (text.length > INSTANT_MAX_LENGTH) return undefined;
  const m = INSTANT_RE.exec(text);
  if (m === null) return undefined;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const zone = m[7] as string;
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) return undefined;
  let offsetMin = 0;
  if (zone !== 'Z') {
    if (zone === '-00:00') return undefined;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return undefined;
    offsetMin = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  // The fraction only ever moves an instant within its second; the 10-minute floor drops it.
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMin * 60_000;
}

/** The start of the 10-minute UTC bucket that holds `ms`. */
export const floorBucket = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;

// --- Answers -------------------------------------------------------------------

const SeriesId = z.number().int().min(1).max(SERIES_ID_MAX);
const Text = (max: number) => z.string().min(1).max(max);

export const Attribution = z.strictObject({
  /** The language of the text, as the registry has it (null: not stated). */
  lang: z.enum(['nl', 'en', 'de', 'fr']).nullable(),
  /** The registry text verbatim. */
  text: Text(1000),
  url: z
    .string()
    .max(500)
    .regex(/^https:\/\/[^\s]+$/)
    .nullable(),
  required: z.boolean(),
  /** The licence asks for a date next to the text (P9b adds it). */
  needsDate: z.boolean(),
});
export type Attribution = z.infer<typeof Attribution>;

export const Meta = z.strictObject({
  /** When this answer was made. */
  now: iso,
  /** The first production capture (A§7.5, D9). */
  dataEpoch: iso,
  /** The earliest instant `t`, `from` may take (D9): app_meta `display_start` rounded up to the 10-minute grid. */
  displayStart: iso,
  /** The git commit of the server image, or `dev`. */
  build: z.string().regex(/^(?:[0-9a-f]{40}|dev)$/),
  /** The public sources whose series the display views hold, with their attribution rows. */
  sources: z.array(z.strictObject({ id: HealthSourceId, attribution: z.array(Attribution).max(20) })).max(100),
});
export type Meta = z.infer<typeof Meta>;

export const SeriesMeta = z.strictObject({
  id: SeriesId,
  source: HealthSourceId,
  quantity: z.enum(['H', 'Q']),
  /** H only: `stage` is relative to a gauge zero, `level` is absolute against `datum`. */
  valueKind: z.enum(['stage', 'level']).nullable(),
  /** The canonical unit every value is in: H in cm, Q in m³/s. */
  unit: z.enum(['cm', 'm³/s']),
  datum: z.enum(DATUMS).nullable(),
  /** The unit the provider publishes in. */
  nativeUnit: z.enum(NATIVE_UNITS),
  expectedStepSeconds: z.number().int().positive(),
  /** A value is carried forward at most this long (LOCF). */
  stalenessLimitSeconds: z.number().int().positive(),
  /** The first UTC day with data in the display channel; null when there is none yet. */
  dataSince: iso.nullable(),
});
export type SeriesMeta = z.infer<typeof SeriesMeta>;

export const ApiStation = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/)
    .max(80),
  /** Exactly as the operating agency publishes them: untrusted text, data only. */
  name: Text(200),
  waterName: Text(200).nullable(),
  country: z.enum(['NL', 'DE', 'BE', 'FR', 'LU', 'CH']),
  lon: z.number().min(-180).max(180).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  tier: z.union([z.literal(1), z.literal(2)]),
  flags: z.strictObject({ tidal: z.boolean().nullable(), impounded: z.boolean().nullable() }),
  series: z.array(SeriesMeta).min(1).max(20),
});
export type ApiStation = z.infer<typeof ApiStation>;

export const Stations = z.strictObject({ stations: z.array(ApiStation).max(10_000) });
export type Stations = z.infer<typeof Stations>;

export const SnapshotValue = z.strictObject({
  series: SeriesId,
  /** The observation carried forward to `t`: ts ≤ t and ts > t − stalenessLimit. */
  ts: iso,
  value: z.number(),
  /** The QC bitmask (A§6). */
  qc: z.number().int().min(0).max(1023),
  /** t − ts. */
  ageSeconds: count,
});
export const Snapshot = z.strictObject({
  /** The quantised instant (UTC, on the 10-minute grid). */
  t: iso,
  /** Only series with a value in their window; ordered by series. */
  values: z.array(SnapshotValue).max(MAX_POINTS),
});
export type Snapshot = z.infer<typeof Snapshot>;

const RawPoint = z.strictObject({ ts: iso, value: z.number(), qc: z.number().int().min(0).max(1023) });
const BucketPoint = z.strictObject({
  bucket: iso,
  vmin: z.number(),
  vmax: z.number(),
  vavg: z.number(),
  vlast: z.number(),
  n: z.number().int().positive(),
  qcOr: z.number().int().min(0).max(1023),
});
const span = { id: SeriesId, from: iso, to: iso, truncated: z.boolean() };
/** One series over the half-open span [from, to); `truncated` when it held more than MAX_POINTS points. */
export const Series = z.discriminatedUnion('res', [
  z.strictObject({ ...span, res: z.literal('raw'), points: z.array(RawPoint).max(MAX_POINTS) }),
  z.strictObject({ ...span, res: z.enum(['1h', '1d']), points: z.array(BucketPoint).max(MAX_POINTS) }),
]);
export type Series = z.infer<typeof Series>;
