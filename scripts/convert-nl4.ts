// Converts the archived NL-4 workbook (Rijkswaterstaat "grenswaarden en
// legendakleuren zoals gebruikt op Waterinfo", edition 15-4-2026) into
// registry/thresholds/nl-4.csv: the Waterinfo display classes, one row per
// class (catalogue §2.1 NL-4 parser specification). Offline and pinned: it
// reads only the archived fixture, and only when its sha256 matches SHA256.
// Deterministic: the same input gives the same bytes. The workbook goes
// through the XLSX guard (ZIP and XML rules, the exact member list below),
// then the NL-4 parser and normaliser; nothing is extracted to disk.
//
//   node scripts/convert-nl4.ts
//
// A new edition: archive it, review it, then change SHA256, EDITION and ALLOW.
// Workbook text is data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverage, dedupe, H_DESCRIPTION, Q_DESCRIPTION, toCsv } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { parse, READ } from '../apps/server/src/adapters/nl-4/parse.ts';
import { REGISTRY_DIR, readSeed } from '../apps/server/src/capture/specs.ts';
import { readXlsx } from '../apps/server/src/http/guards.ts';

const root = join(import.meta.dirname, '..');
export const FIXTURE = join(root, 'apps/server/src/adapters/nl-4/fixtures/nl-4-xlsx.raw');
export const OUTPUT = join(root, 'registry/thresholds/nl-4.csv');

/** The archived workbook (495,060 bytes, recorded 2026-09-29 from the registry URL of spec nl-4-xlsx). */
export const SHA256 = '9c3cdbc996befccd906726b9ba94bd22516db18c9c68329556b08aa4baa12909';
export const EDITION = '2026-04-15';
/** Its 14 members, exactly: any other member fails the guard. */
export const ALLOW = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
  'xl/theme/theme1.xml',
  'xl/styles.xml',
  'xl/sharedStrings.xml',
  'xl/worksheets/_rels/sheet1.xml.rels',
  'xl/printerSettings/printerSettings1.bin',
  'docMetadata/LabelInfo.xml',
  'docProps/core.xml',
  'docProps/app.xml',
] as const;

export const readInput = (file = FIXTURE): Buffer => readFileSync(file);

/**
 * The CSV text for the workbook bytes, with the sheet rows read and the classes
 * written. Refuses bytes whose sha256 is not `pin` before anything is parsed.
 */
export async function generate(buf: Buffer, pin: string = SHA256) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (sha256 !== pin) throw new Error(`convert-nl4: the workbook's sha256 ${sha256} is not the pinned ${pin}`);
  const sheet = parse(await readXlsx(buf, { allow: ALLOW, read: READ }));
  const rows = dedupe(sheet);
  return { text: toCsv(rows, { sha256, edition: EDITION }), sheetRows: sheet.length, rows };
}

if (import.meta.main) {
  const { text, sheetRows, rows } = await generate(readInput());
  writeFileSync(OUTPUT, text);
  const codes = (description: string) =>
    new Set(rows.filter((r) => r.description === description && r.code !== 'alle*').map((r) => r.code)).size;
  // The curated NL-1 series (tiers key and other; the twin is the same gauge in another datum).
  const seed = readSeed(REGISTRY_DIR, 'nl-1').filter((r) => r.tier === 'key' || r.tier === 'other');
  const cover = coverage(
    rows,
    seed.map((r) => ({ code: r.code ?? '', quantity: r.quantity ?? '' })),
  );
  console.error(
    [
      `wrote ${OUTPUT}: ${sheetRows} sheet rows → ${rows.length} classes`,
      `  location codes with classes: H ${codes(H_DESCRIPTION)}, Q ${codes(Q_DESCRIPTION)} (alle* not counted)`,
      `  NL-1 series with classes: H ${cover.h.covered}/${cover.h.total}, Q ${cover.q.covered}/${cover.q.total}`,
      `  without: H ${cover.h.missing.join(' ')}; Q ${cover.q.missing.join(' ')}`,
    ].join('\n'),
  );
}
