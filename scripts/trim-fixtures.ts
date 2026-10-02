// Cuts small real fixtures out of recordings that are already in the repository
// (P5a: the sources have no second real payload to import):
//
//   node scripts/trim-fixtures.ts
//
//  - CH-2, from `ch-2-pq.raw`:
//    - `ch-2-pq-relative`: only the features whose key is in `KEYS` (the relative
//      gauges 2384, 2283 and 2282 and the stale 2269) or whose metric is
//      `discharge_ls` (the six stations that publish l/s), in the recording's
//      order, every other field as recorded;
//    - `ch-2-pq-empty`: the same document with `features: []`;
//  - CH-3, from `ch-3-40d.raw` (Rheinfelden, 2091, 11,404 points a trace):
//    `ch-3-40d-2091`, the last 600 points of every trace (the rule of
//    scripts/import-fixtures.ts for the archived CH-3 plots, its own code).
//
// Each gets a .meta.json (`from: 'trimmed'`, the sha256 of the recording it was
// cut from, the rule): the rule is the only way a body is cut, never by hand.
// The adapter tests read the metas back and check every kept feature or point
// against the recording. Public sources only (invariant 11).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRIM } from './import-fixtures.ts';

const adapters = join(import.meta.dirname, '..', 'apps/server/src/adapters');

type Doc = Record<string, unknown>;
type Ch2 = { features: { properties: { key: string; metric: string } }[] } & Doc;

const KEYS: readonly string[] = ['2384', '2283', '2282', '2269'];
const RELATIVE = `features of keys ${KEYS.join(', ')} and of every station with metric discharge_ls, in recorded order`;
const EMPTY = 'features: []';

const keep = (f: Ch2['features'][number]): boolean =>
  KEYS.includes(f.properties.key) || f.properties.metric === 'discharge_ls';

/** One recording, the fixtures cut from it: [name, body, rule, extra meta keys placed after `spec`]. */
function cut<T>(source: 'ch-2' | 'ch-3', recording: string, cuts: (doc: T) => [string, Doc, string, Doc?][]): void {
  const dir = join(adapters, source, 'fixtures');
  const raw = readFileSync(join(dir, `${recording}.raw`));
  const from = JSON.parse(readFileSync(join(dir, `${recording}.meta.json`), 'utf8')) as Record<string, unknown>;
  const sha256 = createHash('sha256').update(raw).digest('hex');
  for (const [name, body, trimmed, extra] of cuts(JSON.parse(raw.toString('utf8')) as T)) {
    const meta = {
      spec: from.spec,
      ...extra,
      source: from.source,
      synthetic: false,
      from: 'trimmed',
      recorded_at: from.recorded_at,
      status: from.status,
      content_type: from.content_type,
      url: from.url,
      bytes: raw.length,
      source_sha256: sha256,
      trimmed,
    };
    writeFileSync(join(dir, `${name}.raw`), JSON.stringify(body));
    writeFileSync(join(dir, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${name}: ${trimmed}`);
  }
}

function main(): void {
  cut('ch-2', 'ch-2-pq', (doc: Ch2) => [
    ['ch-2-pq-relative', { ...doc, features: doc.features.filter(keep) }, RELATIVE],
    ['ch-2-pq-empty', { ...doc, features: [] }, EMPTY],
  ]);
  cut('ch-3', 'ch-3-40d', (doc: Doc) => {
    const trimmed = TRIM['CH-3'](doc, 600, false);
    return [['ch-3-40d-2091', doc, trimmed, { variant: '2091' }]];
  });
}

if (import.meta.main) main();
