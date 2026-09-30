import type { Kysely } from 'kysely';
import { SOURCE_RE, SPEC_RE } from '../archive/manifest.ts';
import type { ArchiveReader } from '../archive/reader.ts';
import type { DB } from '../db/generated.ts';
import { LOAD_ADAPTERS, type LoadAdapter } from './adapters.ts';
import { type Alert, Loader, parseLine } from './pipeline.ts';
import { lock } from './store.ts';

// `replay --source X [--spec Y] --from YYYY-MM-DD[THH:MM:SSZ] --to YYYY-MM-DD [--dry-run]`
// (A§7.4 step 5): re-parses archived payloads through the loader's own code
// path. It never moves the load cursor and never touches the fetch health. A
// payload that loads exactly as before writes nothing; a quarantined one that
// now parses becomes `ok`. With an instant as `--from`, lines fetched before it
// are skipped (after a unit change, review R3-1: replay.md §3).

export type ReplayArgs = { source: string; spec: string | null; from: string; to: string; dryRun: boolean };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string) =>
  DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
/** A UTC instant to the second, `Z` only. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isInstant = (v: string) =>
  INSTANT.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === `${v.slice(0, 19)}.000Z`;

/** The arguments, or a usage error. Every value is checked against a fixed pattern AND the adapter table. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs | string {
  const out: { source?: string; spec?: string; from?: string; to?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return `replay: ${String(flag)} needs a value`;
    if (flag === '--source') out.source = value;
    else if (flag === '--spec') out.spec = value;
    else if (flag === '--from') out.from = value;
    else if (flag === '--to') out.to = value;
    else return 'replay: unknown argument';
  }
  const { source, spec, from, to } = out;
  if (source === undefined || from === undefined || to === undefined)
    return 'replay: --source, --from and --to are required';
  if (!SOURCE_RE.test(source) || !Object.hasOwn(LOAD_ADAPTERS, source)) return 'replay: --source has no load adapter';
  if (spec !== undefined && (!SPEC_RE.test(spec) || !Object.hasOwn(LOAD_ADAPTERS[source]?.specs ?? {}, spec))) {
    return 'replay: --spec is not a spec of that adapter';
  }
  if (!(isDay(from) || isInstant(from)) || !isDay(to) || from.slice(0, 10) > to) {
    return 'replay: --from is a UTC day (YYYY-MM-DD) or instant (YYYY-MM-DDTHH:MM:SSZ), --to a UTC day, from ≤ to';
  }
  return { source, spec: spec ?? null, from, to, dryRun: out.dryRun };
}

export type ReplayResult = {
  lines: number;
  loaded: number;
  quarantined: number;
  skipped: number;
  n_new: number;
  n_changed: number;
};

export async function replay(
  deps: {
    db: Kysely<DB>;
    reader: ArchiveReader;
    alert: Alert;
    now: () => Date;
    adapters?: Readonly<Record<string, LoadAdapter>>;
  },
  args: ReplayArgs,
): Promise<ReplayResult> {
  const loader = new Loader(deps);
  const result: ReplayResult = { lines: 0, loaded: 0, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 };
  // An instant is compared with the fetch time the batch records (the fetch's end); a line is filed under the day
  // its fetch started, so the file of the day before is read too.
  const since = isInstant(args.from) ? Date.parse(args.from) : null;
  const first = since === null ? args.from : new Date(since - 86_400_000).toISOString().slice(0, 10);
  for (const { file } of await deps.reader.manifests()) {
    const day = file.slice(0, 10);
    if (day < first || day > args.to) continue;
    let offset = 0;
    for (;;) {
      const chunk = await deps.reader.lines(file, offset);
      if (chunk.length === 0) break;
      offset = (chunk.at(-1) as { end: number }).end;
      for (const raw of chunk) {
        const line = parseLine(raw.text);
        if (line === null || line.source !== args.source || line.key === null) continue;
        if (args.spec !== null && line.spec !== args.spec) continue;
        if (line.error !== null || (line.status !== null && line.status >= 400)) continue;
        const spec = loader.specOf(line.source, line.spec);
        if (spec === undefined) continue;
        const fetchedAt = new Date(line.fetched_at.end ?? line.fetched_at.start);
        if (since !== null && fetchedAt.getTime() < since) continue;
        result.lines += 1;
        if (args.dryRun) continue;
        const outcome = await loader.payload(line, spec, fetchedAt, (work) =>
          deps.db.transaction().execute(async (tx) => {
            await lock(tx);
            await work(tx);
          }),
        );
        if (outcome.kind === 'loaded') {
          result.loaded += 1;
          result.n_new += outcome.n_new;
          result.n_changed += outcome.n_changed;
        } else if (outcome.kind === 'quarantined') result.quarantined += 1;
        else result.skipped += 1;
      }
    }
  }
  return result;
}
