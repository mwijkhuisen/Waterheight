import {
  type ApiStation,
  type AttributionEntry,
  DAY_MS,
  dayOf,
  FRAMES_MAX_HOURS,
  framesPath,
  isSettled,
  type Snapshot,
} from '@rws/contracts';

// The hourly frames of playback (P11b, issue #26; A§9.1 frames/, A§9.2 /api/v1/frames). Pure. A public range is
// read as one file per settled UTC day (`frames/<day>/v<n>.json`, an absent day is v1), the unsettled days together
// as `frames/recent.json`, and a day with version 0 or a failed file through /api/v1/frames, one call per contiguous
// range of ≤ 14 days. The owner host has no static frames: API ranges only. URLs come only from the regex-checked
// day, the integer version and whole UTC hours. Every series id must be one of the site's stations.json; an unknown
// id is never mapped, it is dropped and counted (frames carry no series hash, R2).

type Value = Snapshot['values'][number];

const HOUR_MS = 3_600_000;
/** The longest API range one call asks for: the contract's 336 hours. */
const API_DAYS = FRAMES_MAX_HOURS / 24;
/**
 * A frames body is refused above this many bytes, before it is parsed. The biggest honest answer is a 14-day API
 * range: 336 hours × ~1 500 series × ~8 characters ≈ 4 MB, so 16 MiB leaves 4× headroom and still bounds the parse.
 */
export const MAX_FRAMES_BYTES = 16 * 1024 * 1024;

/**
 * The text of a frames response, refused (`too_big`) above MAX_FRAMES_BYTES by its declared size and, while it is read,
 * by its decoded bytes: a compressed or chunked body has no usable length, so it is never buffered past the cap.
 */
export async function readFramesBody(res: Response): Promise<string> {
  if (Number(res.headers.get('content-length')) > MAX_FRAMES_BYTES) throw new Error('too_big');
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAMES_BYTES) throw new Error('too_big');
      parts.push(value);
    }
  } catch (e) {
    // Past the cap, or a read that failed mid-stream: the rest of the body is never read.
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

const hourIso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;

/** What one request covers. */
export type FramesUnit =
  | { kind: 'day'; day: string; v: number }
  | { kind: 'recent' }
  | { kind: 'api'; from: number; to: number };

/** The fields of meta the plan needs (WebMeta, or the owner's meta.json). */
export interface FramesMeta {
  now: string;
  displayStart: string;
  dayVersions: Readonly<Record<string, number>>;
}

/**
 * The requests that cover the whole hours [from, to) for `audience`. `failed` holds the days whose file failed (404,
 * schema; for an unsettled day: recent.json failed): they join the API ranges.
 */
export function framesPlan(
  from: number,
  to: number,
  meta: FramesMeta,
  audience: 'public' | 'owner',
  failed: ReadonlySet<string> = new Set(),
): FramesUnit[] {
  const now = Date.parse(meta.now);
  const start = Math.floor(from / HOUR_MS) * HOUR_MS;
  const end = Math.ceil(to / HOUR_MS) * HOUR_MS;
  if (!(end > start) || !Number.isFinite(now)) return [];
  const units: FramesUnit[] = [];
  const apiDays: number[] = [];
  let recent = false;
  for (let d = Math.floor(start / DAY_MS) * DAY_MS; d < end; d += DAY_MS) {
    const day = dayOf(d);
    const settled = isSettled(day, now);
    // An own key only: a prototype key is never a version (plan C18). Unsettled days have no version.
    const v = settled && Object.hasOwn(meta.dayVersions, day) ? (meta.dayVersions[day] as number) : 1;
    if (audience === 'owner' || failed.has(day) || (settled && v === 0)) apiDays.push(d);
    else if (settled) units.push({ kind: 'day', day, v });
    else recent = true;
  }
  if (recent) units.push({ kind: 'recent' });
  // One call per contiguous run of days, at most API_DAYS days long.
  for (let i = 0; i < apiDays.length; ) {
    let j = i + 1;
    while (j < apiDays.length && j - i < API_DAYS && (apiDays[j] as number) === (apiDays[j - 1] as number) + DAY_MS)
      j += 1;
    units.push({
      kind: 'api',
      from: Math.max(start, apiDays[i] as number),
      to: Math.min(end, (apiDays[j - 1] as number) + DAY_MS),
    });
    i = j;
  }
  return units;
}

/** The relative URL of a unit (same origin). */
export function framesUrl(unit: FramesUnit): string {
  if (unit.kind === 'day') return `/data/v1/${framesPath(unit.day, unit.v)}`;
  if (unit.kind === 'recent') return '/data/v1/frames/recent.json';
  const q = new URLSearchParams({ from: hourIso(unit.from), to: hourIso(unit.to), step: '1h' });
  return `/api/v1/frames?${q.toString()}`;
}

/** One parsed answer (a file or the API), before the series check. */
export interface FramesChunk {
  from: string;
  to: string;
  series: readonly number[];
  vlast: readonly (readonly (number | null)[])[];
  attribution: readonly AttributionEntry[];
}

export interface FrameStore {
  /** The bucket that the hour `t` shows (t − 1 h, R12) has answered: loaded, or known to have no data. */
  ready(t: number): boolean;
  /**
   * The values at the whole hour `t` in the Snapshot's shape: the value of bucket t − 1 h, else the last non-null
   * bucket before it, while younger than the series' stalenessLimitSeconds (ageSeconds from t); `ts` is the end of
   * the bucket it came from; `state` 'no_ref', `basis` null, `qc` 0, `section` false. An absent series has no entry.
   */
  valuesAt(t: number): Map<number, Value>;
  /** The union of the loaded answers' attribution rows. */
  attribution(): readonly AttributionEntry[];
  /** Series ids dropped by the check (unknown ids, misaligned rows). */
  readonly dropped: number;
}

/**
 * A store over the chunks loaded so far. `answered` lists the hour ranges [from, to) that have answered, with or
 * without data; `stations` are the site's stations.json (the known ids and their staleness limits).
 */
export function buildFrameStore(
  chunks: readonly FramesChunk[],
  answered: readonly { from: number; to: number }[],
  stations: readonly ApiStation[],
): FrameStore {
  const limit = new Map<number, number>();
  for (const st of stations) for (const s of st.series) limit.set(s.id, s.stalenessLimitSeconds);
  const buckets = new Map<number, Map<number, number>>();
  const first = new Map<number, number>();
  const credits = new Map<string, AttributionEntry>();
  let dropped = 0;
  for (const c of chunks) {
    const from = Date.parse(c.from);
    const hours = (Date.parse(c.to) - from) / HOUR_MS;
    // Misaligned: a row that is not one entry per hour, or a row count that is not the series count. Dropped whole.
    if (
      !Number.isInteger(hours) ||
      hours < 0 ||
      from % HOUR_MS !== 0 ||
      c.vlast.length !== c.series.length ||
      c.vlast.some((r) => r.length !== hours)
    ) {
      dropped += c.series.length;
      continue;
    }
    c.series.forEach((id, i) => {
      // Only a series of this site's stations.json is ever mapped (R2); anything else is counted and left out.
      if (!limit.has(id)) {
        dropped += 1;
        return;
      }
      const m = buckets.get(id) ?? new Map<number, number>();
      (c.vlast[i] as readonly (number | null)[]).forEach((v, h) => {
        if (v === null || !Number.isFinite(v)) return;
        const at = from + h * HOUR_MS;
        m.set(at, v);
        first.set(id, Math.min(first.get(id) ?? at, at));
      });
      buckets.set(id, m);
    });
    for (const a of c.attribution) credits.set(JSON.stringify(a), a);
  }
  const ready = (t: number) => {
    const b = Math.floor(t / HOUR_MS) * HOUR_MS - HOUR_MS;
    return answered.some((r) => r.from <= b && b < r.to);
  };
  const valuesAt = (t: number) => {
    const out = new Map<number, Value>();
    const newest = Math.floor(t / HOUR_MS) * HOUR_MS - HOUR_MS;
    for (const [series, m] of buckets) {
      const limitMs = (limit.get(series) as number) * 1000;
      const oldest = first.get(series) as number;
      for (let b = newest; b >= oldest; b -= HOUR_MS) {
        const ageMs = t - (b + HOUR_MS);
        // The same rule as `lapses`: an age of exactly the limit is lapsed too.
        if (ageMs >= limitMs) break;
        const value = m.get(b);
        if (value === undefined) continue;
        out.set(series, {
          series,
          ts: new Date(b + HOUR_MS).toISOString(),
          value,
          qc: 0,
          ageSeconds: Math.round(ageMs / 1000),
          state: 'no_ref',
          basis: null,
          section: false,
        });
        break;
      }
    }
    return out;
  };
  return { ready, valuesAt, attribution: () => [...credits.values()], dropped };
}
