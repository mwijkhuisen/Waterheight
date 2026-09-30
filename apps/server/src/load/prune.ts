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
//  - the loader parsed it successfully (an ingest_batch row with status ok);
//  - its own line and every `dup_of` line that points at it are older than the
//    hot window: while the recorder still reports "same body as this object",
//    the object is that day's data;
//  - its key matches the key pattern and resolves to a regular file inside raw/.

export const HOT_WINDOW_DAYS = 90;
/** Mixed payloads (obs plus class or threshold state): one copy per UTC day is promoted to forever. */
export const MIXED_SOURCES: ReadonlySet<string> = new Set(['CH-1', 'CH-2']);
/** Kept whole until the phase that parses their class and threshold fields. */
export const KEEP_UNTIL_PARSED: ReadonlySet<string> = new Set(['CH-1', 'CH-2']);

export type PruneOptions = {
  apply?: boolean;
  now: Date;
  /** Test seam for the policy constants. */
  keepWhole?: ReadonlySet<string>;
};

export type PruneReport = { applied: boolean; candidates: string[]; deleted: number; refused: number; bytes: number };

/** The keys the policy allows to delete. Pure apart from reading the manifest. */
export async function prunePlan(
  reader: ArchiveReader,
  parsedOk: ReadonlySet<string>,
  opts: PruneOptions,
): Promise<string[]> {
  const cutoff = opts.now.getTime() - HOT_WINDOW_DAYS * 86_400_000;
  const keepWhole = opts.keepWhole ?? KEEP_UNTIL_PARSED;
  type Seen = { retention: string; source: string; spec: string; lastRef: number };
  const objects = new Map<string, Seen>();
  const promoted = new Map<string, string>();
  for (const { file } of await reader.manifests()) {
    let offset = 0;
    for (;;) {
      const chunk = await reader.lines(file, offset);
      if (chunk.length === 0) break;
      offset = (chunk.at(-1) as { end: number }).end;
      for (const raw of chunk) {
        const line = parseLine(raw.text);
        if (line === null) continue;
        const at = Date.parse(line.fetched_at.end ?? line.fetched_at.start);
        if (line.key !== null && KEY_RE.test(line.key)) {
          const known = objects.get(line.key);
          if (known) known.lastRef = Math.max(known.lastRef, at);
          else objects.set(line.key, { retention: line.retention, source: line.source, spec: line.spec, lastRef: at });
          if (MIXED_SOURCES.has(line.source)) {
            // The day of the object is in its key: raw/{source}/{spec}/{yyyy}/{mm}/{dd}/…
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
    }
  }
  const keepDaily = new Set(promoted.values());
  const out: string[] = [];
  for (const [key, o] of objects) {
    if (o.retention !== 'obs') continue;
    if (keepWhole.has(o.source)) continue;
    if (keepDaily.has(key)) continue;
    if (!parsedOk.has(key)) continue;
    if (o.lastRef >= cutoff) continue;
    out.push(key);
  }
  return out.sort();
}

export async function parsedOkKeys(db: Kysely<DB>): Promise<Set<string>> {
  const { rows } = await sql<{ archive_key: string }>`
    SELECT archive_key FROM ingest_batch WHERE parse_status = 'ok'`.execute(db);
  return new Set(rows.map((r) => r.archive_key));
}

/** Plans, and deletes only with `apply`. Every path is resolved inside the archive root before it is unlinked. */
export async function prune(
  reader: ArchiveReader,
  parsedOk: ReadonlySet<string>,
  opts: PruneOptions,
): Promise<PruneReport> {
  const candidates = await prunePlan(reader, parsedOk, opts);
  const report: PruneReport = { applied: opts.apply === true, candidates, deleted: 0, refused: 0, bytes: 0 };
  for (const key of candidates) {
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
  return report;
}
