import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Parses tables of the committed source catalogue for the registry tests.
// Each parse checks its row count, so a changed table fails loudly instead of
// letting a test pass on nothing.

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const catalogue = readFileSync(`${repoRoot}docs/sources/SOURCE-CATALOGUE.md`, 'utf8');

/** Markdown stripped the way the registry quotes the catalogue: no emphasis, no code marks. */
export const strip = (s: string) => s.replace(/[*`]/g, '').trim();

function section(start: string, end: string): string {
  const i = catalogue.indexOf(start);
  const j = catalogue.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`catalogue section "${start}" not found`);
  return catalogue.slice(i, j);
}

function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .map((line) =>
      line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|')),
    );
}

const ID_CELL = /^\*{0,2}((?:NL|DE|BE|FR|LU|CH)-\d+)\*{0,2}$/;

function idRows(text: string, expected: number): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const cells of tableRows(text)) {
    const id = ID_CELL.exec(cells[0] ?? '')?.[1];
    if (id === undefined) continue;
    if (rows.has(id)) throw new Error(`catalogue: ${id} appears twice`);
    rows.set(id, cells);
  }
  if (rows.size !== expected) throw new Error(`catalogue: expected ${expected} rows, parsed ${rows.size}`);
  return rows;
}

/** §1a: ID → [id, country, provider – service, …]. */
export const table1a = idRows(section('### 1a. Technical characteristics', '### 1b.'), 52);
/** §1b: ID → [id, licence, attribution, effort, release, risks]. */
export const table1b = idRows(section('### 1b. Licence, attribution', '\n---\n'), 52);

/** §0.8: one entry per source ID named in a row: [source, terms, clause, verdict, audience]. */
export const table08 = (() => {
  // Separator lines start with "|-" and are already dropped; skip the header row.
  const rows = tableRows(section('### 0.8 Private (owner-only) use', '\nNotes:')).slice(1);
  if (rows.length !== 9) throw new Error(`catalogue §0.8: expected 9 rows, parsed ${rows.length}`);
  const byId = new Map<string, string[]>();
  for (const cells of rows) {
    for (const [id] of (cells[0] ?? '').matchAll(/(?:NL|DE|BE|FR|LU|CH)-\d+/g)) byId.set(id, cells);
  }
  return byId;
})();

/**
 * The §1b attribution cell for an ID, following "As X" references; for
 * "As quoted" it adds the licence cell, which holds the quote. Nothing else of
 * the row counts, so a text found only in another column fails.
 */
export function attributionCellText(id: string, depth = 0): string {
  const cells = table1b.get(id);
  if (cells === undefined || depth > 3) throw new Error(`catalogue §1b: no row for ${id}`);
  const cell = strip(cells[2] ?? '');
  const ref = /^As ((?:NL|DE|BE|FR|LU|CH)-\d+)/.exec(cell)?.[1];
  if (ref !== undefined) return `${cell} | ${attributionCellText(ref, depth + 1)}`;
  if (cell.startsWith('As quoted')) return `${cell} | ${strip(cells[1] ?? '')}`;
  return cell;
}

/** The YAML front matter of each registry/permissions/<ID>.md (null when a file has none). */
export function readPermissionRecords(parse: (text: string) => unknown): Map<string, unknown> {
  const dir = `${repoRoot}registry/permissions`;
  const records = new Map<string, unknown>();
  if (!existsSync(dir)) return records;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(`${dir}/${file}`, 'utf8');
    const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
    records.set(file.slice(0, -3), front === undefined ? null : parse(front));
  }
  return records;
}

/** §0.1a "First production slice": [stream, endpoint, interval, change gate] per row (13 rows). */
export const table01a = (() => {
  const rows = tableRows(section('#### 0.1a First production slice', '#### 0.1b')).slice(1);
  if (rows.length !== 13) throw new Error(`catalogue §0.1a: expected 13 rows, parsed ${rows.length}`);
  return rows;
})();
