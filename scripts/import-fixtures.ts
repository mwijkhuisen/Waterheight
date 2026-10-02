// Turns payloads the owner exported from the production raw archive (Action D2;
// the read-only export command is in the P5a PR) into adapter fixtures:
//
//   node scripts/import-fixtures.ts <export dir>
//
// The export holds `<name>.raw` (the archived body) and `<name>.line.json` (its
// manifest line). Each payload listed below is copied to
// apps/server/src/adapters/<source>/fixtures/<fixture>.raw with a .meta.json
// that records where it came from: the archive key, the manifest's fetch time,
// status and request URL (secret parameters are already redacted in the
// manifest; FR and CH send none), and the sha256 of the exported body. A body
// is trimmed only by the rules written here (`TRIM`), never by hand: an FR-1
// page keeps its first or its last n rows of `data` (results come newest first,
// so the last rows of a page are the ones next to its following page), an FR-3
// series and each trace of a CH-3 plot keep their last n points (the newest);
// every other field stays as archived. Public sources only: an owner-audience payload never
// becomes a fixture (invariant 11).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

type Doc = Record<string, unknown>;
type Import = {
  name: string;
  source: 'FR-1' | 'FR-3' | 'CH-1' | 'CH-3';
  fixture: string;
  keep?: number;
  /** FR-1 only: keep the last n rows instead of the first. */
  last?: true;
};

/** The trim rule of each source: cuts the document to `n` in place and says what it kept. */
export const TRIM: Readonly<Record<Import['source'], (doc: Doc, n: number, last: boolean) => string>> = {
  'FR-1': (doc, n, last) => {
    doc.data = last ? (doc.data as unknown[]).slice(-n) : (doc.data as unknown[]).slice(0, n);
    return `${last ? 'last' : 'first'} ${n} rows of data`;
  },
  'FR-3': (doc, n) => {
    const serie = doc.Serie as Doc;
    serie.ObssHydro = (serie.ObssHydro as unknown[]).slice(-n);
    return `last ${n} points of Serie.ObssHydro`;
  },
  'CH-1': () => {
    throw new Error('CH-1 bodies are imported whole');
  },
  'CH-3': (doc, n) => {
    for (const trace of (doc.plot as Doc).data as Doc[]) {
      trace.x = (trace.x as unknown[]).slice(-n);
      trace.y = (trace.y as unknown[]).slice(-n);
    }
    return `last ${n} points of every trace`;
  },
};

/** The exported payloads that P5a uses, and the fixture each becomes. */
export const IMPORTS: readonly Import[] = [
  // The first two pages of one FR-1 seed walk (both HTTP 206 with a `next`): the end of page 1 and the start of
  // page 2, which meet at 2026-09-01T08:30Z (page 1's cursor is its last row).
  { name: 'fr-1-page1', source: 'FR-1', fixture: 'fr-1-obs-page1', keep: 400, last: true },
  { name: 'fr-1-page2', source: 'FR-1', fixture: 'fr-1-obs-page2', keep: 400 },
  // The empty last page of a seed day walk (`count` is the walk's total, `data` empty, no `next`).
  { name: 'fr-1-empty', source: 'FR-1', fixture: 'fr-1-obs-empty' },
  // About two days of 5-minute values each (the whole series is ~72 days, 0.2–0.3 MB).
  { name: 'fr-3-uckange-q', source: 'FR-3', fixture: 'fr-3-obs-uckange-q', keep: 600 },
  { name: 'fr-3-lauterbourg-h', source: 'FR-3', fixture: 'fr-3-obs-lauterbourg-h', keep: 600 },
  // Strasbourg Q: a station Vigicrues lists without discharge (an empty series; it failed capture validity).
  { name: 'fr-3-invalid', source: 'FR-3', fixture: 'fr-3-obs-empty' },
  { name: 'ch-1-lake', source: 'CH-1', fixture: 'ch-1-lindas-lake' },
  // A river query that answered with the header alone (it failed capture validity).
  { name: 'ch-1-invalid', source: 'CH-1', fixture: 'ch-1-lindas-empty' },
  { name: 'ch-3-2289', source: 'CH-3', fixture: 'ch-3-40d-2289', keep: 600 },
  { name: 'ch-3-2473', source: 'CH-3', fixture: 'ch-3-40d-2473', keep: 600 },
];

type Line = {
  spec: string;
  variant: string;
  seed?: true;
  request: { url: string } | null;
  fetched_at: { start: string };
  status: number | null;
  key: string;
  sha256: string;
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The body as the fixture holds it, and the trim it took (false: the archived bytes unchanged). */
export function cut(
  source: Import['source'],
  raw: Buffer,
  keep?: number,
  last = false,
): { body: Buffer; trimmed: string | false } {
  if (keep === undefined) return { body: raw, trimmed: false };
  const doc = JSON.parse(raw.toString('utf8')) as Doc;
  const trimmed = TRIM[source](doc, keep, last);
  return { body: Buffer.from(JSON.stringify(doc)), trimmed };
}

function main(dir: string): void {
  for (const { name, source, fixture, keep, last } of IMPORTS) {
    const raw = readFileSync(join(dir, `${name}.raw`));
    const line = JSON.parse(readFileSync(join(dir, `${name}.line.json`), 'utf8')) as Line;
    if (sha256(raw) !== line.sha256) throw new Error(`${name}: the body is not the archived object (sha256)`);
    const { body, trimmed } = cut(source, raw, keep, last === true);
    const meta = {
      spec: line.spec,
      variant: line.variant,
      source,
      synthetic: false,
      from: 'archive',
      archive_key: line.key,
      recorded_at: line.fetched_at.start.replace(/\.\d{3}Z$/, 'Z'),
      ...(line.seed === true ? { seed: true } : {}),
      status: line.status,
      url: line.request?.url ?? null,
      bytes: raw.length,
      source_sha256: line.sha256,
      trimmed,
    };
    const out = join(root, 'apps/server/src/adapters', source.toLowerCase(), 'fixtures');
    writeFileSync(join(out, `${fixture}.raw`), body);
    writeFileSync(join(out, `${fixture}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${fixture}: ${body.length} B${trimmed === false ? '' : ` (${trimmed})`} ← ${line.key}`);
  }
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: node scripts/import-fixtures.ts <export dir>');
    process.exitCode = 64;
  } else main(dir);
}
