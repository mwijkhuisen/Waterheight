import { DAY_MS, dayOf, dayStartMs, isSettled } from '@rws/contracts';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { type ChannelAudience, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';

// `v` and immutability (P9b, A§9.2). The settled-day versions of the family (the true versions of its day-version
// view, not meta.json's sparse map: a day without a row is version 1) are held in memory and refreshed every 10 s;
// an answer is `immutable` only when the request's `v` equals the current version of every UTC day it spans, the
// versions read inside the answer's own transaction agree (the entry's tag), and every one of those days is settled.
// The cache key holds the in-memory versions of the spanned days, so a bump makes a new key; the raw `v` is never in
// a key, so a stale `v` cannot multiply keys.

export const VERSIONS_REFRESH_MS = 10_000;
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The UTC days a half-open span [fromMs, toMs) touches (a snapshot at t: [t, t + 1)). */
export function spannedDays(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let d = dayStartMs(dayOf(fromMs)); d < toMs; d += DAY_MS) out.push(dayOf(d));
  return out;
}

/** The versions of `days`, as the key part and the tag: `day:v,day:v`. */
export const versionTag = (days: readonly string[], versionOf: (day: string) => number): string =>
  days.map((d) => `${d}:${versionOf(d)}`).join(',');

/** The day versions of `days` as stored now, inside the caller's transaction (the answer's tag). */
export async function readVersionTag(
  tx: Kysely<DB>,
  family: ChannelAudience,
  days: readonly string[],
): Promise<string> {
  const { rows } = await sql<{ day: string; version: number }>`
    SELECT day::text AS day, version FROM ${sql.table(VIEWS[family].dayVersion)}
    WHERE day = ANY(${days}::date[])`.execute(tx);
  const map = new Map(rows.map((r) => [r.day, r.version]));
  return versionTag(days, (d) => map.get(d) ?? 1);
}

/**
 * immutable iff `v` was sent, every spanned day is settled at `nowMs`, `v` is the in-memory version of each, and the
 * tag of the answer (its own transaction's versions) equals the in-memory tag.
 */
export function isImmutable(
  v: number | undefined,
  days: readonly string[],
  versions: DayVersions | undefined,
  tag: string,
  nowMs: number,
): boolean {
  if (v === undefined || versions?.loaded !== true || days.length === 0) return false;
  if (!days.every((d) => isSettled(d, nowMs) && versions.versionOf(d) === v)) return false;
  return tag === versionTag(days, (d) => versions.versionOf(d));
}

/** The family's settled-day versions in memory; a failed refresh keeps the last value. */
export class DayVersions {
  #map = new Map<string, number>();
  #loaded = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #db: Kysely<DB>;
  readonly #family: ChannelAudience;
  readonly #log: Pick<Logger, 'error'> | undefined;

  constructor(db: Kysely<DB>, family: ChannelAudience, log?: Pick<Logger, 'error'>) {
    this.#db = db;
    this.#family = family;
    this.#log = log;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  versionOf(day: string): number {
    return this.#map.get(day) ?? 1;
  }

  /** Test seam and the refresh: replaces the map. */
  set(map: ReadonlyMap<string, number>): void {
    this.#map = new Map(map);
    this.#loaded = true;
  }

  async refresh(): Promise<boolean> {
    try {
      const { rows } = await sql<{ day: string; version: number }>`
        SELECT day::text AS day, version FROM ${sql.table(VIEWS[this.#family].dayVersion)}`.execute(this.#db);
      this.set(new Map(rows.map((r) => [r.day, r.version])));
      return true;
    } catch (err) {
      this.#log?.error({ code: errorCode(err) }, 'day versions not loaded');
      return false;
    }
  }

  /** Refreshes every VERSIONS_REFRESH_MS on a timer that does not keep the process alive. */
  start(): void {
    if (this.#timer !== undefined) return;
    const next = () => {
      const timer = setTimeout(
        () =>
          void this.refresh().then(() => {
            if (this.#timer === timer) next();
          }),
        VERSIONS_REFRESH_MS,
      );
      timer.unref();
      this.#timer = timer;
    };
    next();
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
