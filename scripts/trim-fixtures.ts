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
//  - P5b, text and ZIP recordings (the rule keeps whole lines or blocks, never edits one):
//    - LU-1, from `lu-1-csv.raw`: `lu-1-csv-day`, the rows of `LU1_ROWS` and the last 96 labels (one day) with
//      every row's trailing field; `lu-1-csv-empty`, the header of the same 96 labels and no row;
//    - DE-7, from `de-7-messwerte.raw`: `de-7-messwerte-blocks`, the whole station blocks (data lines and the
//      block's terminator line) of `DE7_BLOCKS`, re-zipped (one member, the recorded name and DOS time,
//      deflate); `de-7-messwerte-empty`, the header line alone;
//    - DE-8, from `de-8-stations.raw`: `de-8-stations-subset`, the header and the rows of `DE7_BLOCKS`;
//      from `de-8-hydro.raw`: `de-8-hydro-subset`, the header, the rows of `DE7_BLOCKS` and the `NA` rows;
//    - LU-6, from `lu-6-geo.raw`: `lu-6-geo-subset`, the features of `LU6_CODES` (both Kautenbach and both
//      Niederfeulen among them), and `lu-6-geo-empty` (`features: []`, the counts 0).
//
// Each gets a .meta.json (`from: 'trimmed'`, the sha256 of the recording it was
// cut from, the rule): the rule is the only way a body is cut, never by hand.
// The adapter tests read the metas back and check every kept feature or point
// against the recording. Public sources only (invariant 11).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DE7_BLOCKS,
  de7Blocks,
  join_,
  LU1_LABELS,
  LU1_ROWS,
  LU6_CODES,
  lines,
  lu1Cut,
  TRIM,
  unzip,
  type ZipEntry,
  zip,
} from './import-fixtures.ts';

const adapters = join(import.meta.dirname, '..', 'apps/server/src/adapters');

type Doc = Record<string, unknown>;
type Ch2 = { features: { properties: { key: string; metric: string } }[] } & Doc;

const KEYS: readonly string[] = ['2384', '2283', '2282', '2269'];
const RELATIVE = `features of keys ${KEYS.join(', ')} and of every station with metric discharge_ls, in recorded order`;
const EMPTY = 'features: []';

const keep = (f: Ch2['features'][number]): boolean =>
  KEYS.includes(f.properties.key) || f.properties.metric === 'discharge_ls';

/** One recording, the fixtures cut from it: [name, body, rule, extra meta keys placed after `spec`]. */
function cut<T>(source: string, recording: string, cuts: (doc: T) => [string, Doc, string, Doc?][]): void {
  cutBytes(source, recording, (raw) =>
    cuts(JSON.parse(raw.toString('utf8')) as T).map(([name, doc, rule, extra]): [string, Buffer, string, Doc?] => {
      const body = Buffer.from(JSON.stringify(doc));
      return extra === undefined ? [name, body, rule] : [name, body, rule, extra];
    }),
  );
}

/** The byte form of `cut`: a text or ZIP recording, the bodies cut from it. */
function cutBytes(source: string, recording: string, cuts: (raw: Buffer) => [string, Buffer, string, Doc?][]): void {
  const dir = join(adapters, source, 'fixtures');
  const raw = readFileSync(join(dir, `${recording}.raw`));
  const from = JSON.parse(readFileSync(join(dir, `${recording}.meta.json`), 'utf8')) as Record<string, unknown>;
  const sha256 = createHash('sha256').update(raw).digest('hex');
  for (const [name, body, trimmed, extra] of cuts(raw)) {
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
    writeFileSync(join(dir, `${name}.raw`), body);
    writeFileSync(join(dir, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${name}: ${trimmed}`);
  }
}

// ---------------------------------------------------------------- P5b: text and ZIP rules

function main(): void {
  cut('ch-2', 'ch-2-pq', (doc: Ch2) => [
    ['ch-2-pq-relative', { ...doc, features: doc.features.filter(keep) }, RELATIVE],
    ['ch-2-pq-empty', { ...doc, features: [] }, EMPTY],
  ]);
  cut('ch-3', 'ch-3-40d', (doc: Doc) => {
    const trimmed = TRIM['CH-3'](doc, 600, false);
    return [['ch-3-40d-2091', doc, trimmed, { variant: '2091' }]];
  });
  cutBytes('lu-1', 'lu-1-csv', (raw) => [
    [
      'lu-1-csv-day',
      Buffer.from(lu1Cut(raw.toString('utf8'), LU1_ROWS, LU1_LABELS)),
      `rows ${LU1_ROWS.join(', ')} and the last ${LU1_LABELS} labels, each row's trailing field kept`,
    ],
    [
      'lu-1-csv-empty',
      Buffer.from(lu1Cut(raw.toString('utf8'), null, LU1_LABELS)),
      `the header of the last ${LU1_LABELS} labels, no row`,
    ],
  ]);
  cutBytes('de-7', 'de-7-messwerte', (raw) => {
    const [member] = unzip(raw) as [ZipEntry];
    const text = member.data.toString('latin1');
    const rezip = (body: string) => zip([{ ...member, data: Buffer.from(body, 'latin1') }]);
    return [
      [
        'de-7-messwerte-blocks',
        rezip(de7Blocks(text, DE7_BLOCKS)),
        `the whole blocks of ${DE7_BLOCKS.join(', ')} (data and terminator lines), re-zipped with the recorded member name and time`,
      ],
      [
        'de-7-messwerte-empty',
        rezip(de7Blocks(text, [])),
        'the header line alone, re-zipped with the recorded member name and time',
      ],
    ];
  });
  cutBytes('de-8', 'de-8-stations', (raw) => {
    const { lines: all, eol } = lines(raw.toString('utf8'));
    const rows = all.slice(1).filter((l) => DE7_BLOCKS.includes(l.split(';')[3] as string));
    return [
      [
        'de-8-stations-subset',
        Buffer.from(join_([all[0] as string, ...rows], eol)),
        `the rows of ${DE7_BLOCKS.join(', ')}`,
      ],
    ];
  });
  cutBytes('de-8', 'de-8-hydro', (raw) => {
    const [member] = unzip(raw) as [ZipEntry];
    const { lines: all, eol } = lines(member.data.toString('latin1'));
    const rows = all.slice(1).filter((l) => {
      const id = l.split(';')[1] as string;
      return id === 'NA' || DE7_BLOCKS.includes(id);
    });
    const body = Buffer.from(join_([all[0] as string, ...rows], eol), 'latin1');
    return [
      [
        'de-8-hydro-subset',
        zip([{ ...member, data: body }]),
        `the rows of ${DE7_BLOCKS.join(', ')} and the NA rows, re-zipped with the recorded member name and time`,
      ],
    ];
  });
  cut('lu-6', 'lu-6-geo', (doc: { features: { properties: { Hyperlinks: string | null } }[] } & Doc) => {
    const code = (f: (typeof doc.features)[number]) =>
      /\/FichesStations\/(\d{1,10})-/.exec(f.properties.Hyperlinks ?? '')?.[1];
    const features = doc.features.filter((f) => LU6_CODES.includes(code(f) ?? ''));
    return [
      [
        'lu-6-geo-subset',
        { ...doc, features, numberReturned: features.length, numberMatched: features.length },
        `the features of the fiche numbers ${LU6_CODES.join(', ')}, counts adjusted`,
      ],
      ['lu-6-geo-empty', { ...doc, features: [], numberReturned: 0, numberMatched: 0 }, 'features: [], counts 0'],
    ];
  });
}

if (import.meta.main) main();
