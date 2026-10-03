import { unlink } from 'node:fs/promises';
import { type Kysely, sql } from 'kysely';
import { ArchiveError, type ArchiveReader, KEY_RE } from '../archive/reader.ts';
import type { DB } from '../db/generated.ts';
import { parseLine } from './pipeline.ts';

// Retention of the raw archive (A§7.2; ADR-0003). The archive is the source of
// truth, so the pruner deletes as little as the policy allows and nothing it is
// not sure about. DRY-RUN IS THE DEFAULT: it deletes only when the loader runs
// with RWS_PRUNE_APPLY=1.
//
// An object may go only if ALL of this holds:
//  - its manifest line says retention `obs` (a `forever` class is never pruned);
//  - its source is not kept whole: CH-1 and CH-2 payloads carry class and
//    threshold state (dangerLevel, wl_1..wl_4) and are kept until P7 parses it;
//  - it is not the daily promoted copy: the first object of each spec and UTC
//    day of a mixed source stays forever;
//  - P7a: it did not open a class row or a reference range, unless 24 payloads
//    of its spec and UTC day that did come before it (PROMOTE_PER_DAY);
//  - the loader parsed it successfully and stored everything a registry change
//    could still add (an ingest_batch row with status ok and n_skipped 0);
//  - its own line and every `dup_of` line that points at it are older than the
//    hot window: while the recorder still reports "same body as this object",
//    the object is that day's data;
//  - its key matches the key pattern and resolves to a regular file inside raw/.
//
// Memory stays bounded as the archive grows: candidates come only from the
// manifest files older than the hot window, one file at a time (and their `ok`
// batches are looked up per file); the newer files are only scanned for lines
// that still refer to an object older than the window.

export const HOT_WINDOW_DAYS = 90;
/** Mixed payloads (obs plus class or threshold state): one copy per UTC day is promoted to forever. */
export const MIXED_SOURCES: ReadonlySet<string> = new Set(['CH-1', 'CH-2']);
/**
 * Kept whole until the phase that parses their class and threshold fields. Empty since P7a, which parses CH-1's
 * dangerLevel and CH-2's wl_1..wl_4: a payload whose batch opened a class or threshold row is promoted instead
 * (parsedOkIn), beside the daily copy of MIXED_SOURCES.
 */
export const KEEP_UNTIL_PARSED: ReadonlySet<string> = new Set();
/**
 * Of the payloads of one source, spec and UTC day that opened a class row or a reference range, the first this many
 * (by archive key, which sorts by fetch time) are promoted; the others follow the obs policy, so a class or a
 * threshold that flaps (a provider bug) cannot keep every payload forever (P7a review SR-1).
 */
export const PROMOTE_PER_DAY = 24;

const DAY_MS = 86_400_000;

export type PruneOptions = {
  apply?: boolean;
  now: Date;
  /** Test seam for the policy constants. */
  keepWhole?: ReadonlySet<string>;
};

/** Which of `keys` the loader parsed `ok` and stored whole: the database in production, a set in tests. */
export type ParsedOk = (keys: readonly string[]) => Promise<ReadonlySet<string>>;

export type PruneReport = { applied: boolean; candidates: number; deleted: number; refused: number };

/** The UTC day in an archive key: raw/{source}/{spec}/{yyyy}/{mm}/{dd}/… */
const keyDay = (key: string) => Date.parse(`${key.split('/').slice(3, 6).join('-')}T00:00:00Z`);

async function* linesOf(reader: ArchiveReader, file: string) {
  let offset = 0;
  for (;;) {
    const chunk = await reader.lines(file, offset);
    if (chunk.length === 0) return;
    offset = (chunk.at(-1) as { end: number }).end;
    for (const raw of chunk) {
      const line = parseLine(raw.text);
      if (line !== null) yield line;
    }
  }
}

/** The keys the policy allows to delete, one old manifest file at a time. Reads the manifest only. */
export async function* prunePlan(
  reader: ArchiveReader,
  parsedOk: ParsedOk,
  opts: PruneOptions,
): AsyncGenerator<string[]> {
  const cutoff = opts.now.getTime() - HOT_WINDOW_DAYS * DAY_MS;
  const keepWhole = opts.keepWhole ?? KEEP_UNTIL_PARSED;
  // A file holds lines whose fetch started on its day: past the window only when the day after it is.
  const isOld = (file: string) => Date.parse(`${file.slice(0, 10)}T00:00:00Z`) + 2 * DAY_MS <= cutoff;
  const files = (await reader.manifests()).map((m) => m.file);

  // Objects older than the window that a line inside the window still names (its own line, or dup_of).
  const referenced = new Set<string>();
  for (const file of files.filter((f) => !isOld(f))) {
    for await (const line of linesOf(reader, file)) {
      if (Date.parse(line.fetched_at.end ?? line.fetched_at.start) < cutoff) continue;
      for (const key of [line.key, line.dup_of]) {
        if (key !== null && KEY_RE.test(key) && keyDay(key) < cutoff) referenced.add(key);
      }
    }
  }

  // The first object of a spec and day is its promoted copy. A fetch that started before midnight files the
  // next day's first object under the day before, so the earliest keys of the next day carry over one file.
  let carried = new Map<string, string>();
  for (const file of files.filter(isOld)) {
    type Seen = { retention: string; source: string; spec: string; lastRef: number };
    const objects = new Map<string, Seen>();
    const promoted = new Map(carried);
    for await (const line of linesOf(reader, file)) {
      const at = Date.parse(line.fetched_at.end ?? line.fetched_at.start);
      if (line.key !== null && KEY_RE.test(line.key)) {
        const known = objects.get(line.key);
        if (known) known.lastRef = Math.max(known.lastRef, at);
        else objects.set(line.key, { retention: line.retention, source: line.source, spec: line.spec, lastRef: at });
        if (MIXED_SOURCES.has(line.source)) {
          const day = `${line.spec}/${line.key.split('/').slice(3, 6).join('-')}`;
          const first = promoted.get(day);
          if (first === undefined || line.key < first) promoted.set(day, line.key);
        }
      }
      if (line.dup_of !== null) {
        const target = objects.get(line.dup_of);
        if (target) target.lastRef = Math.max(target.lastRef, at);
      }
    }
    const keepDaily = new Set(promoted.values());
    carried = new Map([...promoted].filter(([day]) => day.slice(-10) > file.slice(0, 10)));
    const policy = [...objects].filter(
      ([key, o]) =>
        o.retention === 'obs' &&
        !keepWhole.has(o.source) &&
        !keepDaily.has(key) &&
        !referenced.has(key) &&
        o.lastRef < cutoff,
    );
    if (policy.length === 0) continue;
    const ok = await parsedOk(policy.map(([key]) => key));
    const out = policy.map(([key]) => key).filter((key) => ok.has(key));
    if (out.length > 0) yield out.sort();
  }
}

/**
 * The archive keys among `keys` whose batch loaded `ok` and stored every value it carried. A batch that opened a
 * class row or a reference range (P7a: a CH-1 payload whose dangerLevel changed, a CH-2 payload whose wl_*
 * changed) is among them only past the first PROMOTE_PER_DAY such batches of its source, spec and UTC day among
 * `keys`: those are promoted to the forever class (A§7.2). `batch_id` of a reference range is its opener (a
 * confirmation moves only `seen_*`), of a class row the newest payload that stated it at its instant (load/refs.ts).
 */
export function parsedOkIn(db: Kysely<DB>): ParsedOk {
  return async (keys) => {
    const { rows } = await sql<{ archive_key: string }>`
      SELECT archive_key FROM (
        SELECT b.archive_key, o.opener,
               count(*) FILTER (WHERE o.opener) OVER (
                 PARTITION BY b.source_id, b.spec_id, substring(b.archive_key FROM '^raw/[^/]+/[^/]+/([0-9/]{10})/')
                 ORDER BY b.archive_key) AS nth
        FROM ingest_batch b
        CROSS JOIN LATERAL (
          SELECT EXISTS (SELECT 1 FROM class_obs c WHERE c.batch_id = b.id)
                 OR EXISTS (SELECT 1 FROM reference_value r WHERE r.batch_id = b.id) AS opener) o
        WHERE b.archive_key = ANY(${keys}::text[]) AND b.parse_status = 'ok' AND b.n_skipped = 0) x
      WHERE NOT opener OR nth > ${PROMOTE_PER_DAY}`.execute(db);
    return new Set(rows.map((r) => r.archive_key));
  };
}

/** Plans, and deletes only with `apply`. Every path is resolved inside the archive root before it is unlinked. */
export async function prune(reader: ArchiveReader, parsedOk: ParsedOk, opts: PruneOptions): Promise<PruneReport> {
  const report: PruneReport = { applied: opts.apply === true, candidates: 0, deleted: 0, refused: 0 };
  for await (const keys of prunePlan(reader, parsedOk, opts)) {
    for (const key of keys) {
      report.candidates += 1;
      let path: string;
      try {
        path = await reader.resolve(key);
      } catch (err) {
        if (!(err instanceof ArchiveError)) throw err;
        // Already gone is fine; anything else (a link out of raw/, not a file) is refused and counted.
        if (err.code !== 'missing') report.refused += 1;
        continue;
      }
      if (report.applied) {
        await unlink(path);
        report.deleted += 1;
      }
    }
  }
  return report;
}
