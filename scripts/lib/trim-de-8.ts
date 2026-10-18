// P14b: the trim rules of the DE-8 decade ZIPs of hydro/w (whole members and whole rows, re-zipped deterministically). A rule keeps or drops whole parts and never edits one; it reads the lead's
// recording from the git-ignored `.smoke/` (`<name>.raw` and its `.meta.json`) and writes the fixture with a meta
// (`from: 'trimmed'` or `trimmed: false`, `recorded_at`, `url`, `source_sha256`, the rule). Run by
// `node scripts/trim-fixtures.ts --p14b de-8`; without the recording it writes nothing and says so.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { join_, lines, unzip, zip } from '../import-fixtures.ts';

/** Rur 2020-2029: the tier-1 gauge Stah is cut to its rows from this stamp on (whole lines, the final `NA` kept). */
export const STAH_FROM = '2026-04-01T00:00:00+01:00';
/** ... and the (not selected) Süsterseel member to its header and this many rows. */
export const SUESTERSEEL_ROWS = 200;

type Recording = { url: string; status: number; fetched_at: string; 'content-type'?: string };

/** A fixture: its recording, its name and the cut (null: the whole body). */
type Rule = {
  from: string;
  name: string;
  cut: ((raw: Buffer) => Buffer) | null;
  text?: string;
};

const stah = '2829100000100_Stah_2020-2025_Wasserstand_cm.csv';
const suesterseel = '2818100000200_Suesterseel_2020-2025_Wasserstand_cm.csv';

/** The members of the recording in recorded order, Stah from `STAH_FROM`, Süsterseel to its first rows, nothing else. */
function rurCut(raw: Buffer): Buffer {
  const members = unzip(raw).flatMap((m) => {
    if (m.name !== stah && m.name !== suesterseel) return [];
    const { lines: all, eol } = lines(m.data.toString('utf8'));
    const [header, ...rows] = all as [string, ...string[]];
    // Rows of one station are sorted and every stamp has the +01:00 offset, so the stamp is compared as text.
    const kept =
      m.name === stah ? rows.filter((l) => (l.split(';')[2] as string) >= STAH_FROM) : rows.slice(0, SUESTERSEEL_ROWS);
    return [{ ...m, data: Buffer.from(join_([header, ...kept], eol), 'utf8') }];
  });
  if (members.length !== 2) throw new Error('de-8: the recording lacks Stah or Süsterseel');
  return zip(members);
}

const RULES: Rule[] = [
  {
    from: 'de-8-w-rur-2020',
    name: 'de-8-backfill-w-rur-2020',
    cut: rurCut,
    text: `the member of Stah (2829100000100, tier 1) cut to its header and its rows from ${STAH_FROM} on (whole lines, the final NA row kept), the member of Süsterseel (2818100000200) cut to its header and its first ${SUESTERSEEL_ROWS} rows, every other member dropped; re-zipped with the recorded member names and times`,
  },
  { from: 'de-8-w-ibv-1950', name: 'de-8-backfill-w-ibv-1950', cut: null },
  // A discharge (Q) file under the W spec: the W loader refuses it (the member name is not a W member).
  { from: 'de-8-q-erft-1930', name: 'de-8-backfill-q-erft-1930', cut: null },
];

/** `smoke`: the `.smoke/` directory; `fixtures`: the adapter's fixtures directory. */
export function trim(smoke: string, fixtures: string): void {
  for (const rule of RULES) {
    const file = join(smoke, `${rule.from}.raw`);
    if (!existsSync(file)) {
      console.log(`${rule.name}: no recording ${rule.from} in .smoke/, nothing written`);
      continue;
    }
    const raw = readFileSync(file);
    const from = JSON.parse(readFileSync(join(smoke, `${rule.from}.meta.json`), 'utf8')) as Recording;
    const body = rule.cut === null ? raw : rule.cut(raw);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const meta = {
      spec: 'de-8-backfill-w',
      source: 'DE-8',
      synthetic: false,
      ...(rule.text === undefined ? {} : { from: 'trimmed' }),
      recorded_at: from.fetched_at,
      status: from.status,
      content_type: from['content-type'] ?? null,
      url: from.url,
      bytes: raw.length,
      source_sha256: sha256,
      trimmed: rule.text ?? false,
    };
    writeFileSync(join(fixtures, `${rule.name}.raw`), body);
    writeFileSync(join(fixtures, `${rule.name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${rule.name}: ${rule.text ?? 'whole'}`);
  }
}
