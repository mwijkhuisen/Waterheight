import { TimeError } from './errors.ts';

// Time conventions (A§7.4 step 2; catalogue §4.4). Every adapter declares one;
// nothing here guesses a zone or an offset. All results are UTC epoch
// milliseconds.

/**
 * What to do with an offset-less local time at a DST transition. It is a
 * required declaration: there is no default, because a silent choice would
 * shift or drop an hour of data once a year without anyone noticing.
 */
export type DstRule = {
  /** A wall-clock time that does not exist (spring forward). */
  gap: 'reject' | 'shift-forward';
  /**
   * A wall-clock time that occurs twice (fall back): take the first (summer
   * time) or the second occurrence, refuse it, or take the latest occurrence
   * that is not after a trusted UTC instant (e.g. a collection timestamp).
   */
  overlap: 'earlier' | 'later' | 'reject' | { notAfter: number };
};

export type TimeConvention =
  /** ISO 8601 with an explicit offset or Z (PEGELONLINE JSON, LU-2, CH-2). */
  | { kind: 'iso-offset' }
  /** ISO 8601 whose offset must be the declared one all year (RWS REST +01:00, LINDAS). */
  | { kind: 'fixed-offset'; offset: string }
  /** Wall-clock time of `zone` mislabelled with Z (RWS WFS). */
  | { kind: 'local-labelled-z'; zone: string; dst: DstRule }
  /** Wall-clock time of `zone` without any offset (LU-1 CSV, LHP feature timestamps). */
  | { kind: 'naive-local'; zone: string; dst: DstRule }
  /** UTC epoch milliseconds (Vigicrues). */
  | { kind: 'epoch-ms' }
  /** `/Date(ms)/`, where ms is UTC epoch milliseconds (NLWKN DatumUTC). */
  | { kind: 'dotnet-date' }
  /** A naive timestamp at a fixed offset that labels the start of its interval (BfG "GMT+1"). */
  | { kind: 'start-of-interval'; offset: string };

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;
const DMY_NAIVE = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;
const DOTNET = /^\/Date\((-?\d{1,15})(?:[+-]\d{4})?\)\/$/;

/** Instants we accept: 1900 … 2200. Anything else is a parsing accident, not a measurement. */
const MIN_MS = Date.UTC(1900, 0, 1);
const MAX_MS = Date.UTC(2200, 0, 1);

function inRange(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < MIN_MS || ms > MAX_MS) throw new TimeError('out_of_range');
  return ms;
}

function isoWithOffset(raw: string): { ms: number; offset: string } {
  const m = ISO_OFFSET.exec(raw);
  if (!m) throw new TimeError('bad_format');
  let instant: Temporal.Instant;
  try {
    instant = Temporal.Instant.from(raw);
  } catch {
    throw new TimeError('bad_format');
  }
  return { ms: inRange(instant.epochMilliseconds), offset: m[1] === 'Z' ? '+00:00' : (m[1] as string) };
}

function naive(raw: string): Temporal.PlainDateTime {
  const iso = ISO_NAIVE.exec(raw);
  const dmy = iso ? null : DMY_NAIVE.exec(raw);
  const [year, month, day, hour, minute, second] = iso
    ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]]
    : dmy
      ? [dmy[3], dmy[2], dmy[1], dmy[4], dmy[5], dmy[6]]
      : [];
  if (year === undefined) throw new TimeError('bad_format');
  try {
    return Temporal.PlainDateTime.from(
      {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second ?? 0),
      },
      { overflow: 'reject' },
    );
  } catch {
    throw new TimeError('bad_format');
  }
}

function atOffset(local: Temporal.PlainDateTime, offset: string): number {
  if (!OFFSET.test(offset)) throw new TimeError('bad_format');
  try {
    return inRange(Temporal.Instant.from(`${local.toString()}${offset}`).epochMilliseconds);
  } catch (err) {
    if (err instanceof TimeError) throw err;
    throw new TimeError('bad_format');
  }
}

function inZone(local: Temporal.PlainDateTime, zone: string, dst: DstRule): number {
  const resolve = (disambiguation: 'earlier' | 'later' | 'reject') => local.toZonedDateTime(zone, { disambiguation });
  try {
    return inRange(resolve('reject').epochMilliseconds);
  } catch (err) {
    if (err instanceof TimeError) throw err;
    // Not unique: either the time does not exist, or it occurs twice.
  }
  const earlier = resolve('earlier');
  const later = resolve('later');
  const exists = earlier.toPlainDateTime().equals(local);
  if (!exists) {
    if (dst.gap === 'reject') throw new TimeError('dst_gap');
    return inRange(later.epochMilliseconds);
  }
  if (dst.overlap === 'reject') throw new TimeError('dst_overlap');
  if (dst.overlap === 'earlier') return inRange(earlier.epochMilliseconds);
  if (dst.overlap === 'later') return inRange(later.epochMilliseconds);
  const limit = dst.overlap.notAfter;
  if (later.epochMilliseconds <= limit) return inRange(later.epochMilliseconds);
  if (earlier.epochMilliseconds <= limit) return inRange(earlier.epochMilliseconds);
  throw new TimeError('dst_overlap');
}

/** One provider timestamp under its declared convention → UTC epoch milliseconds. Throws `TimeError`. */
export function parseInstant(convention: TimeConvention, raw: string | number): number {
  switch (convention.kind) {
    case 'iso-offset': {
      if (typeof raw !== 'string') throw new TimeError('bad_format');
      return isoWithOffset(raw).ms;
    }
    case 'fixed-offset': {
      if (typeof raw !== 'string' || !OFFSET.test(convention.offset)) throw new TimeError('bad_format');
      const { ms, offset } = isoWithOffset(raw);
      if (offset !== convention.offset) throw new TimeError('offset_mismatch');
      return ms;
    }
    case 'local-labelled-z': {
      if (typeof raw !== 'string' || !raw.endsWith('Z')) throw new TimeError('bad_format');
      return inZone(naive(raw.slice(0, -1)), convention.zone, convention.dst);
    }
    case 'naive-local': {
      if (typeof raw !== 'string') throw new TimeError('bad_format');
      return inZone(naive(raw), convention.zone, convention.dst);
    }
    case 'epoch-ms': {
      const ms = typeof raw === 'number' ? raw : /^-?\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
      return inRange(ms);
    }
    case 'dotnet-date': {
      const m = typeof raw === 'string' ? DOTNET.exec(raw) : null;
      if (!m) throw new TimeError('bad_format');
      return inRange(Number(m[1]));
    }
    case 'start-of-interval': {
      if (typeof raw !== 'string') throw new TimeError('bad_format');
      return atOffset(naive(raw), convention.offset);
    }
  }
}

/** Invariant 4: a timestamp more than 15 minutes ahead of the fetch is rejected. */
export const FUTURE_SLACK_MS = 15 * 60_000;

export function isFuture(tsMs: number, fetchedAtMs: number, slackMs = FUTURE_SLACK_MS): boolean {
  return tsMs > fetchedAtMs + slackMs;
}

/** `2026-09-23T19:50:00.000Z`: the one spelling of an instant in canonical rows and golden files. */
export function toIso(ms: number): string {
  return new Date(inRange(ms)).toISOString();
}

/** An ISO 8601 duration made of days, hours, minutes and seconds only (registry steps and limits) → milliseconds. */
export function durationMs(iso: string): number {
  const m = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?)?$/.exec(iso);
  if (!m || iso === 'P' || iso.endsWith('T')) throw new TimeError('bad_format');
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
  if (ms <= 0) throw new TimeError('bad_format');
  return ms;
}
