import {
  type ApiStation,
  type AttributionEntry,
  DAY_MS,
  dayOf,
  FRAMES_MAX_HOURS,
  framesPath,
  isSettled,
  type Snapshot,
  stateOf,
} from '@rws/contracts';

// The hourly frames of playback (P11b, issue #26; A§9.1 frames/, A§9.2 /api/v1/frames). Pure. A public range is
// read as one file per settled UTC day (`frames/<day>/v<n>.json`, an absent day is v1), the unsettled days together
// as `frames/recent.json`, and a day with version 0 or a failed file through /api/v1/frames, one call per contiguous
// range of ≤ 14 days. The owner host has no static frames: API ranges only. URLs come only from the regex-checked
// day, the integer version and whole UTC hours. Every series id must be one of the site's stations.json; an unknown
// id is never mapped, it is dropped and counted (frames carry no series hash, R2).

type Value = Snapshot['values'][number];
/**
 * A played value (#112): the Snapshot's shape with the state of its own hour, or, from a chunk written before #112
 * (frames version 1, no `state`), `stateUnknown`: its `state` is then a placeholder that the State mode must show as
 * no data, never as no_ref; Δh and Q use the value as always.
 */
export type PlayedValue = Value & { stateUnknown?: true };

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

/** One parsed answer (a file or the API), before the series check; `state` is absent in a version 1 file. */
export interface FramesChunk {
  from: string;
  to: string;
  series: readonly number[];
  vlast: readonly (readonly (number | null)[])[];
  state?: readonly (readonly (number | null)[])[];
  attribution: readonly AttributionEntry[];
}

export interface FrameStore {
  /** The bucket that the hour `t` shows (t − 1 h, R12) has answered: loaded, or known to have no data. */
  ready(t: number): boolean;
  /**
   * The values at the whole hour `t` in the Snapshot's shape: the value of bucket t − 1 h, else the last non-null
   * bucket before it, while younger than the series' stalenessLimitSeconds (ageSeconds from t); `ts` is the end of
   * the bucket it came from; `state` and `section` those of that bucket's hour (#112: a carried value shows the state
   * of its own hour), `stateUnknown` from a version 1 chunk; `basis` null, `qc` 0. An absent series has no entry;
   * `only` limits the walk to those series (#112: the shifted ends).
   */
  valuesAt(t: number, only?: ReadonlySet<number>): Map<number, PlayedValue>;
  /** The union of the loaded answers' attribution rows. */
  attribution(): readonly AttributionEntry[];
  /** Series ids dropped by the check (unknown ids, misaligned rows). */
  readonly dropped: number;
}

/** One query's result as the frames readers see it (TanStack's, reduced). */
export type FramesRead = { isError: boolean; isSuccess: boolean; data: FramesChunk | null | undefined };
type FileUnit = Exclude<FramesUnit, { kind: 'api' }>;
type ApiUnit = Extract<FramesUnit, { kind: 'api' }>;

/**
 * What the queries of one stage have given so far: a chunk slot per unit (null: none yet, failed, or no data), the hour
 * ranges answered, and (files only) the days whose file failed as a sorted list. O3 (#219): no `Set` and no compacted
 * list, so TanStack's structural sharing keeps the whole result while only a fetch status flips, and keeps each chunk
 * object itself when another arrives (useFrames builds no new store then, and the chunk cache below still knows it).
 */
export interface StageRead {
  chunks: (FramesChunk | null)[];
  answered: { from: number; to: number }[];
  /** The failed days, sorted and comma-joined ('' for none). */
  failed: string;
}

/** The `combine` of the file queries (settled days, recent.json): a file that fails moves its days into `failed`. */
export function readFileUnits(files: readonly FileUnit[], from: number, to: number, nowMs: number) {
  return (rs: readonly FramesRead[]): StageRead => {
    const out: StageRead = { chunks: [], answered: [], failed: '' };
    const failed = new Set<string>();
    rs.forEach((r, i) => {
      const u = files[i] as FileUnit;
      out.chunks.push(!r.isError && r.data ? r.data : null);
      if (r.isError) {
        if (u.kind === 'day') failed.add(u.day);
        else
          for (let d = Math.floor(from / DAY_MS) * DAY_MS; d < to; d += DAY_MS)
            if (!isSettled(dayOf(d), nowMs)) failed.add(dayOf(d));
      } else if (r.data) out.answered.push({ from: Date.parse(r.data.from), to: Date.parse(r.data.to) });
    });
    out.failed = [...failed].sort().join();
    return out;
  };
}

/** The `combine` of the API queries: a range that failed was answered with no data (null), so it is never asked again. */
export function readApiUnits(calls: readonly ApiUnit[]) {
  return (rs: readonly FramesRead[]): StageRead => {
    const out: StageRead = { chunks: [], answered: [], failed: '' };
    rs.forEach((r, i) => {
      out.chunks.push(r.isSuccess && r.data ? r.data : null);
      if (!r.isSuccess) return;
      out.answered.push({ from: (calls[i] as ApiUnit).from, to: (calls[i] as ApiUnit).to });
    });
    return out;
  };
}

/**
 * O3 (#219): per chunk, once, its check and index: null when it is misaligned (a row that is not one entry per hour,
 * or a row count that is not the series count: dropped whole), else for each row the hour of its first finite value
 * (−1: none). Keyed by the chunk object: another day, version, range or site is another fetch, another object.
 */
const indexed = new WeakMap<FramesChunk, number[] | null>();

function indexOf(c: FramesChunk): number[] | null {
  const known = indexed.get(c);
  if (known !== undefined) return known;
  const from = Date.parse(c.from);
  const hours = (Date.parse(c.to) - from) / HOUR_MS;
  const index =
    !Number.isInteger(hours) ||
    hours < 0 ||
    from % HOUR_MS !== 0 ||
    c.vlast.length !== c.series.length ||
    c.vlast.some((r) => r.length !== hours) ||
    (c.state !== undefined && (c.state.length !== c.series.length || c.state.some((r) => r.length !== hours)))
      ? null
      : c.vlast.map((r) => r.findIndex((v) => v !== null && Number.isFinite(v)));
  indexed.set(c, index);
  return index;
}

/** One series' row of one chunk. */
interface Row {
  from: number;
  vlast: readonly (number | null)[];
  state: readonly (number | null)[] | undefined;
}

/**
 * A store over the chunks loaded so far (null slots are skipped). `answered` lists the hour ranges [from, to) that
 * have answered, with or without data; `stations` are the site's stations.json (the known ids and their staleness
 * limits). O3 (#219): the store keeps each series' rows of the chunks, in chunk order, instead of copying every value
 * into maps, so a store over the same chunks plus a new one costs that chunk's index and one entry per series row.
 */
export function buildFrameStore(
  chunks: readonly (FramesChunk | null)[],
  answered: readonly { from: number; to: number }[],
  stations: readonly ApiStation[],
): FrameStore {
  const limit = new Map<number, number>();
  for (const st of stations) for (const s of st.series) limit.set(s.id, s.stalenessLimitSeconds);
  const rows = new Map<number, Row[]>();
  const first = new Map<number, number>();
  const credits = new Map<string, AttributionEntry>();
  let dropped = 0;
  for (const c of chunks) {
    if (c === null) continue;
    const index = indexOf(c);
    if (index === null) {
      dropped += c.series.length;
      continue;
    }
    const from = Date.parse(c.from);
    c.series.forEach((id, i) => {
      // Only a series of this site's stations.json is ever mapped (R2); anything else is counted and left out.
      if (!limit.has(id)) {
        dropped += 1;
        return;
      }
      const list = rows.get(id) ?? [];
      list.push({ from, vlast: c.vlast[i] as readonly (number | null)[], state: c.state?.[i] });
      rows.set(id, list);
      const h = index[i] as number;
      if (h >= 0) first.set(id, Math.min(first.get(id) ?? Number.POSITIVE_INFINITY, from + h * HOUR_MS));
    });
    for (const a of c.attribution) credits.set(JSON.stringify(a), a);
  }
  const ready = (t: number) => {
    const b = Math.floor(t / HOUR_MS) * HOUR_MS - HOUR_MS;
    return answered.some((r) => r.from <= b && b < r.to);
  };
  const valuesAt = (t: number, only?: ReadonlySet<number>) => {
    const out = new Map<number, PlayedValue>();
    const newest = Math.floor(t / HOUR_MS) * HOUR_MS - HOUR_MS;
    for (const [series, list] of rows) {
      if (only !== undefined && !only.has(series)) continue;
      const limitMs = (limit.get(series) as number) * 1000;
      const oldest = first.get(series) as number;
      for (let b = newest; b >= oldest; b -= HOUR_MS) {
        const ageMs = t - (b + HOUR_MS);
        // The same rule as `lapses`: an age of exactly the limit is lapsed too.
        if (ageMs >= limitMs) break;
        // The latest row with a value at b wins (a later chunk, or a later row of the same series), with its own state.
        let value: number | undefined;
        let code: number | null | undefined;
        for (let j = list.length - 1; j >= 0; j--) {
          const row = list[j] as Row;
          const v = row.vlast[(b - row.from) / HOUR_MS];
          if (v === undefined || v === null || !Number.isFinite(v)) continue;
          value = v;
          code = row.state?.[(b - row.from) / HOUR_MS];
          break;
        }
        if (value === undefined) continue;
        const decoded = code == null ? undefined : stateOf(code);
        out.set(series, {
          series,
          ts: new Date(b + HOUR_MS).toISOString(),
          value,
          qc: 0,
          ageSeconds: Math.round(ageMs / 1000),
          state: decoded?.state ?? 'no_ref',
          basis: null,
          section: decoded?.section ?? false,
          ...(decoded === undefined ? { stateUnknown: true as const } : {}),
        });
        break;
      }
    }
    return out;
  };
  return { ready, valuesAt, attribution: () => [...credits.values()], dropped };
}
