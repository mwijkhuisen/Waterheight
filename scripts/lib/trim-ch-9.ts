// P14b: the trim rules of the CH-9 exports (whole records, in recorded order). A rule keeps or drops whole parts and never edits one; it reads the lead's
// recording from the git-ignored `.smoke/` (`<name>.raw` and its `.meta.json`) and writes the fixture with a meta
// (`from: 'trimmed'` or `trimmed: false`, `recorded_at`, `url`, `source_sha256`, the rule). Run by
// `node scripts/trim-fixtures.ts --p14b ch-9`; without the recording it writes nothing and says so.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The first records of the 30-day Rhine export (the normal golden) and its last (the month's end). */
export const HEAD_RECORDS = 2000;
export const TAIL_RECORDS = 300;

type Recording = { url: string; status: number; fetched_at: string };
type Rule = {
  from: string;
  name: string;
  spec: string;
  variant?: string;
  /** Keeps whole records: null is the whole body. */
  cut: ((records: string[]) => string[]) | null;
  text?: string;
};

const RULES: Rule[] = [
  {
    from: 'ch-9-export-100089-30d',
    name: 'ch-9-backfill-100089',
    spec: 'ch-9-backfill-bs',
    variant: '100089',
    cut: (r) => r.slice(0, HEAD_RECORDS),
    text: `the first ${HEAD_RECORDS} records of the 8,640 (2026-06-01 from 00:00Z, 5-minute points), each kept whole`,
  },
  {
    from: 'ch-9-export-100089-30d',
    name: 'ch-9-backfill-100089-tail',
    spec: 'ch-9-backfill-bs',
    variant: '100089',
    cut: (r) => r.slice(-TAIL_RECORDS),
    text: `the last ${TAIL_RECORDS} records of the 8,640 (up to 2026-06-30T23:55Z), each kept whole`,
  },
  {
    from: 'ch-9-export-100236-day',
    name: 'ch-9-backfill-100236',
    spec: 'ch-9-backfill-bs',
    variant: '100236',
    cut: null,
  },
  // The reachability probe's body (deploy/reachability.yaml): whole; it keeps `"results"` in its first 64 KB.
  { from: 'ch-9-records-100089', name: 'ch-9-records-100089', spec: 'ch-9-records', cut: null },
];

/** A body of `[{…},{…}]` as its records' texts, and back: records never contain `},{` (numbers, ISO stamps, keys). */
const split = (text: string): string[] => {
  if (!text.startsWith('[{') || !text.endsWith('}]')) throw new Error('not an array of objects');
  return text.slice(2, -2).split('},{');
};
const join_ = (records: string[]) => (records.length === 0 ? '[]' : `[{${records.join('},{')}}]`);

/** `smoke`: the `.smoke/` directory; `fixtures`: the adapter's fixtures directory. */
export function trim(smoke: string, fixtures: string): void {
  for (const rule of RULES) {
    const raw = join(smoke, `${rule.from}.raw`);
    if (!existsSync(raw)) {
      console.log(`ch-9: no recording ${rule.from} in .smoke/, ${rule.name} not written`);
      continue;
    }
    const source = readFileSync(raw);
    const rec = JSON.parse(readFileSync(join(smoke, `${rule.from}.meta.json`), 'utf8')) as Recording;
    const text = source.toString('utf8');
    const body = rule.cut === null ? source : Buffer.from(join_(rule.cut(split(text))), 'utf8');
    const sha = createHash('sha256').update(source).digest('hex');
    const meta = {
      spec: rule.spec,
      ...(rule.variant === undefined ? {} : { variant: rule.variant }),
      source: 'CH-9',
      synthetic: false,
      ...(rule.cut === null ? {} : { from: 'trimmed' }),
      recorded_at: rec.fetched_at,
      status: rec.status,
      url: rec.url,
      bytes: body.length,
      source_sha256: sha,
      trimmed: rule.cut === null ? false : (rule.text as string),
    };
    writeFileSync(join(fixtures, `${rule.name}.raw`), body);
    writeFileSync(join(fixtures, `${rule.name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`ch-9: ${rule.name}.raw (${body.length} bytes)`);
  }
}
