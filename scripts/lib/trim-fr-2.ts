// P14b: the trim rules of the FR-2 obs_elab answers (whole records of `data`, `count` adjusted where the rule says so).
// A rule keeps or drops whole records and never edits one: the kept records are slices of the recording's own text,
// so every byte of a record is the provider's. It reads the lead's recording from the git-ignored `.smoke/`
// (`<name>.raw` and its `.meta.json`) and writes the fixture with a meta (`from: 'trimmed'` with the rule, or
// `trimmed: false` for a whole recording; `source_sha256`, `recorded_at`, `url`, `status`). Run by
// `node scripts/trim-fixtures.ts --p14b fr-2`; a missing recording is skipped and said so. Public data only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = 'fr-2-backfill-elab';
const DATA = '"data":[';

/** The text before the records and the records' own text (each `{…}`), cut on `},{` and checked to rejoin exactly. */
function records(text: string): { head: string; records: string[] } {
  const at = text.indexOf(DATA);
  if (at < 0 || !text.endsWith(']}')) throw new Error('fr-2 trim: not an obs_elab answer');
  const head = text.slice(0, at + DATA.length);
  const body = text.slice(at + DATA.length, -2);
  const parts =
    body === '' ? [] : body.split('},{').map((p, i, all) => `${i > 0 ? '{' : ''}${p}${i < all.length - 1 ? '}' : ''}`);
  if (parts.join(',') !== body) throw new Error('fr-2 trim: the records do not rejoin');
  for (const p of parts) JSON.parse(p);
  return { head, records: parts };
}

const answer = (head: string, kept: string[]) =>
  `${head.replace(/^\{"count":\d+/, `{"count":${kept.length}`)}${kept.join(',')}]}`;
const dayOf = (record: string): string => (JSON.parse(record) as { date_obs_elab: string }).date_obs_elab;

type Cut = { name: string; from: string; variant: string; rule: string | false; cut?: (all: string[]) => string[] };

const CUTS: readonly Cut[] = [
  {
    name: 'fr-2-elab-uckange-qmnj-1981',
    from: 'fr-2-uckange-qmnj-1981',
    variant: 'A850061001/QmnJ',
    rule: 'the first 400 records of data (1981-10-02 to 1982-11-06), count 400',
    cut: (all) => all.slice(0, 400),
  },
  {
    name: 'fr-2-elab-chooz-hixnj-cutover',
    from: 'fr-2-chooz-hixnj-2000',
    variant: 'B720000001/HIXnJ',
    rule: 'the records of data with date_obs_elab from 2007-03-01 to 2007-04-30, count adjusted (spans the 2007-03-23 cutover)',
    cut: (all) => all.filter((r) => dayOf(r) >= '2007-03-01' && dayOf(r) <= '2007-04-30'),
  },
  { name: 'fr-2-elab-uckange-qmnj-2026', from: 'fr-2-uckange-qmnj-2026', variant: 'A850061001/QmnJ', rule: false },
  { name: 'fr-2-elab-empty', from: 'fr-2-brevilly-hixnj-empty', variant: 'B466010101/HIXnJ', rule: false },
  { name: 'fr-2-elab-page', from: 'fr-2-uckange-qmnj-page', variant: 'A850061001/QmnJ', rule: false },
];

/** `smoke`: the `.smoke/` directory; `fixtures`: the adapter's fixtures directory. */
export function trim(smoke: string, fixtures: string): void {
  for (const c of CUTS) {
    const rawFile = join(smoke, `${c.from}.raw`);
    if (!existsSync(rawFile)) {
      console.log(`${c.name}: no recording ${c.from} in ${smoke}, skipped`);
      continue;
    }
    const raw = readFileSync(rawFile);
    const recording = JSON.parse(readFileSync(join(smoke, `${c.from}.meta.json`), 'utf8')) as Record<string, unknown>;
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (recording.sha256 !== sha256) throw new Error(`fr-2 trim: ${c.from} does not match its meta sha256`);
    let body = raw;
    if (c.cut !== undefined) {
      const { head, records: all } = records(raw.toString('utf8'));
      body = Buffer.from(answer(head, c.cut(all)));
    }
    const meta = {
      spec: SPEC,
      variant: c.variant,
      source: 'FR-2',
      synthetic: false,
      ...(c.rule === false ? {} : { from: 'trimmed' }),
      recorded_at: recording.fetched_at,
      status: recording.status,
      content_type: recording['content-type'],
      url: recording.url,
      bytes: raw.length,
      source_sha256: sha256,
      trimmed: c.rule,
    };
    writeFileSync(join(fixtures, `${c.name}.raw`), body);
    writeFileSync(join(fixtures, `${c.name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${c.name}: ${c.rule === false ? 'whole' : c.rule}`);
  }
}
