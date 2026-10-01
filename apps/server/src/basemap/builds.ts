import { boundedJson } from '@rws/core';
import { BasemapError } from './errors.ts';

// The Protomaps build list (registry `protomaps.builds_url`): a JSON array of
// objects, one per daily build. Provider text is data: only entries that match
// our filters count, and nothing of an entry beyond its date and version is read.

export type Build = { build: string; version: string };

const BUILD_FILE_RE = /^([0-9]{8})\.pmtiles$/;
const DAY_MS = 86_400_000;
/** The list is about 12 KB (1 MiB at most); this many values is far above any real list. */
const CAPS = { maxNodes: 50_000, maxDepth: 4 };

/** `YYYYMMDD` that names a real calendar date. */
export function isCalendarDate(build: string): boolean {
  if (!/^[0-9]{8}$/.test(build)) return false;
  const [y, m, d] = [Number(build.slice(0, 4)), Number(build.slice(4, 6)), Number(build.slice(6, 8))];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/**
 * The builds we may extract, oldest first: a key `<YYYYMMDD>.pmtiles` with a real
 * date that is not after tomorrow in UTC (a day of slack for clock skew), and a
 * `version` of the registry's tiles major. A date listed twice with two versions
 * is ambiguous and dropped. Throws `builds_invalid` for text that is not a
 * bounded JSON array.
 */
export function parseBuilds(text: string, major: number, now: Date): Build[] {
  let doc: unknown;
  try {
    doc = boundedJson(text, CAPS);
  } catch {
    throw new BasemapError('builds_invalid');
  }
  if (!Array.isArray(doc)) throw new BasemapError('builds_invalid');
  const version = new RegExp(`^${major}\\.[0-9]{1,4}\\.[0-9]{1,4}$`);
  const latest = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10).replaceAll('-', '');
  const found = new Map<string, string | null>();
  for (const item of doc as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const { key: file, version: v } = item as Record<string, unknown>;
    if (typeof file !== 'string' || typeof v !== 'string' || !version.test(v)) continue;
    const date = BUILD_FILE_RE.exec(file)?.[1];
    if (date === undefined || date > latest || !isCalendarDate(date)) continue;
    found.set(date, found.has(date) && found.get(date) !== v ? null : v);
  }
  return [...found]
    .flatMap(([build, v]) => (v === null ? [] : [{ build, version: v }]))
    .sort((a, b) => (a.build < b.build ? -1 : 1));
}
