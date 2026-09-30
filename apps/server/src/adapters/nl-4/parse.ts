import { SchemaDrift, xmlOverCaps } from '@rws/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

// NL-4 Rijkswaterstaat workbook of Waterinfo display classes (catalogue §2.1,
// "NL-4 … parser specification"): the rows of the sheet `ParameterLimits`,
// found through xl/workbook.xml and its relationships, never by file name. The
// member texts come from the XLSX guard (http/guards.ts readXlsx); this module
// is pure and checks the XML again, because it is never told where its input
// came from. Anything it does not know is a SchemaDrift with a fixed code.
// Workbook text is data: codes, labels and periods are kept verbatim (a text
// with a control, bidi or format character is drift), entity references are
// decoded by hand (fast-xml-parser runs with entities, trimming and number
// coercion off), and nothing is interpreted here.

export const WORKBOOK = 'xl/workbook.xml';
export const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';
/** Every member parse may read: the workbook, its relationships, the shared strings and both worksheets. */
export const READ = [
  WORKBOOK,
  WORKBOOK_RELS,
  'xl/sharedStrings.xml',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
] as const;

export const SHEET = 'ParameterLimits';
export const HEADER = [
  'Code',
  'Name',
  'Slug',
  'Description',
  'Period',
  'FromMonth',
  'FromDay',
  'ToMonth',
  'ToDay',
  'Label',
  'From',
  'To',
  'Order',
  'Priority',
  'Color',
  'HardColor',
  'SoftColor',
] as const;

// Caps, about 3× the 15-4-2026 edition (in brackets).
/** Data rows of the sheet (6,245). */
export const MAX_ROWS = 20_000;
/** Shared strings (3,204 unique). */
export const MAX_SHARED_STRINGS = 10_000;
/** Characters of one shared string (241, an Uitleg note; the longest ParameterLimits cell has 109). Under the CSV field cap of 1 KB. */
export const MAX_TEXT = 512;
/**
 * Tags plus attributes of one member before it is parsed (669,675 in the sheet: 437,247 tags and 232,428
 * attributes), counted as the XML guard counts them (xmlOverCaps): they bound the nodes of the tree
 * fast-xml-parser builds, a count of tags alone does not. About 2×, not 3×: an attribute flood of 1.5 M items
 * still parsed inside a 256 MB heap, one of 2 M did not (measured, review S1 of P2b). It binds before
 * MAX_ROWS: about 14,000 rows of today's shape.
 */
export const MAX_ITEMS = 1_500_000;
/** Characters of one tag, from `<` to `>` (643: the workbook's root with its namespaces); the guard's cap too. */
export const MAX_TAG = 16 * 1024;
// Columns: exactly the 17 of the header; a cell right of column Q is drift.

/**
 * A character no text of ours may hold (review S2 of P2b), decoded or raw: one XML 1.0 does not allow (a
 * lone surrogate, U+FFFE, U+FFFF), a C0 or C1 control or DEL other than tab and line feed, and the
 * bidirectional and format controls that reorder or hide text (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069,
 * U+FEFF). Workbook text reaches a public reference view.
 */
export const FORBIDDEN_TEXT = /[[\p{Cc}--[\t\n]]\p{Cs}\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uFFFE\uFFFF]/v;

const WORKSHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const SHARED_STRINGS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings';

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name, _path, _leaf, isAttribute) =>
    !isAttribute && ['sheet', 'Relationship', 'si', 'r', 'row', 'c'].includes(name),
});

type Node = Record<string, unknown>;

const drift = (code: string, path = ''): never => {
  throw new SchemaDrift(code, path);
};

/**
 * One member as a tree: refused before parsing when it declares a DTD, holds CDATA, has a tag over MAX_TAG
 * characters or more tags plus attributes than MAX_ITEMS, or is not well-formed.
 */
function tree(members: ReadonlyMap<string, string>, path: string): Node {
  const raw = members.get(path);
  if (raw === undefined) return drift('member_missing', path);
  // XML 1.0 §2.11: every CR LF and lone CR is read as LF.
  const text = raw.replace(/\r\n?/g, '\n');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) drift('xml_dtd', path);
  if (text.includes('<![CDATA[')) drift('xml_cdata', path);
  const over = xmlOverCaps(text, { maxTag: MAX_TAG, maxItems: MAX_ITEMS });
  if (over !== null) drift(over, path);
  try {
    if (XMLValidator.validate(text) !== true) throw new Error();
    return PARSER.parse(text) as Node;
  } catch {
    return drift('xml_invalid', path);
  }
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An own child (never an inherited property): `constructor` in a document is just a name. */
const child = (node: Node, key: string): unknown => (Object.hasOwn(node, key) ? node[key] : undefined);

/** A container element: only the named children, whitespace between them, and any attributes. */
function element(v: unknown, children: readonly string[], code: string): Node {
  // An empty element (`<sheetData/>`) parses to ''.
  if (v === '') return {};
  if (!isNode(v)) return drift(code);
  for (const key of Object.keys(v)) {
    if (key.startsWith('@_') || children.includes(key)) continue;
    if (key === '#text' && /^[ \t\n]*$/.test(v[key] as string)) continue;
    drift(code);
  }
  return v;
}

/** A repeated element (the parser's isArray list): absent is none. */
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : drift('xml_shape'));

const PREDEFINED = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);
const REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([\dA-Fa-f]{1,6}));|&/g;

/** An XML 1.0 Char. */
const isXmlChar = (cp: number) =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

/**
 * Character data with its references decoded: the five predefined entities and numeric references, nothing
 * else. The result holds no FORBIDDEN_TEXT character, whether it came raw or as a reference.
 */
function decode(raw: string): string {
  const text = raw.replace(REFERENCE, (_, name?: string, dec?: string, hex?: string) => {
    if (name !== undefined) return PREDEFINED.get(name) as string;
    const cp = dec !== undefined ? Number(dec) : hex !== undefined ? Number.parseInt(hex, 16) : -1;
    if (!isXmlChar(cp)) drift('xml_reference');
    return String.fromCodePoint(cp);
  });
  return FORBIDDEN_TEXT.test(text) ? drift('text_char') : text;
}

/** An attribute's decoded value, or undefined. */
function attr(node: Node, name: string): string | undefined {
  const v = child(node, `@_${name}`);
  if (v === undefined) return undefined;
  return typeof v === 'string' ? decode(v) : drift('xml_attribute');
}

/** The text of a `<t>` (or `<v>`) element: a plain string, or `xml:space` and its text. */
function textOf(v: unknown, code: string): string {
  if (typeof v === 'string') return decode(v);
  if (!isNode(v) || Object.keys(v).some((k) => k !== '#text' && k !== '@_xml:space')) return drift(code);
  const t = child(v, '#text');
  return t === undefined ? '' : decode(t as string);
}

/** The target of the workbook relationship `id` (or of the one relationship of `type`) as a member path under xl/. */
function target(rels: Node, find: (r: Node) => boolean, type: string, code: string): string {
  const root = element(child(rels, 'Relationships'), ['Relationship'], 'rels');
  const found = list(child(root, 'Relationship')).filter((r) => find(element(r, [], 'rels')));
  if (found.length !== 1) return drift(code);
  const rel = found[0] as Node;
  if (attr(rel, 'Type') !== type || (attr(rel, 'TargetMode') ?? 'Internal') !== 'Internal') drift(code);
  const to = attr(rel, 'Target') ?? '';
  const path = to.startsWith('/') ? to.slice(1) : `xl/${to}`;
  if (!/^xl\/(?:worksheets\/)?[A-Za-z0-9_]{1,64}\.xml$/.test(path)) drift(code);
  return path;
}

function sharedStrings(doc: Node): string[] {
  const sst = element(child(doc, 'sst'), ['si'], 'shared_strings');
  const items = list(child(sst, 'si'));
  if (items.length > MAX_SHARED_STRINGS) drift('too_many_shared_strings');
  return items.map((item, i) => {
    const si = element(item, ['t', 'r'], 'shared_string');
    const t = child(si, 't');
    const runs = child(si, 'r');
    // A plain string, or rich text: the runs' texts concatenated (their formatting is not read).
    let s = '';
    if (t !== undefined && runs === undefined) s = textOf(t, 'shared_string');
    else if (t === undefined && runs !== undefined) {
      for (const run of list(runs))
        s += textOf(child(element(run, ['rPr', 't'], 'shared_string'), 't'), 'shared_string');
    } else drift('shared_string', String(i));
    if (s.length > MAX_TEXT) drift('text_too_long', String(i));
    // OOXML escapes a character XML cannot carry as _xHHHH_; no such string is known here.
    if (/_x[\dA-Fa-f]{4}_/.test(s)) drift('xstring_escape', String(i));
    return s;
  });
}

/** Column letters → 1-based index. */
const column = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

type Cell = string | number;

/** The cells of one row by column (1..17), mapped by their `r` reference; an absent cell stays absent. */
function cells(row: Node, n: number, strings: readonly string[]): Map<number, Cell> {
  const out = new Map<number, Cell>();
  let last = 0;
  for (const raw of list(child(row, 'c'))) {
    const c = element(raw, ['v'], 'cell');
    for (const key of Object.keys(c)) if (key.startsWith('@_') && !['@_r', '@_s', '@_t'].includes(key)) drift('cell');
    const ref = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(attr(c, 'r') ?? '');
    if (ref === null || Number(ref[2]) !== n) return drift('cell_ref', `row.${n}`);
    const col = column(ref[1] as string);
    if (col <= last) drift('cell_order', `row.${n}`);
    if (col > HEADER.length) drift('extra_column', `row.${n}`);
    last = col;
    const v = child(c, 'v');
    if (v === undefined) continue;
    if (typeof v !== 'string') return drift('cell_value', `row.${n}`);
    const type = attr(c, 't') ?? 'n';
    if (type === 's') {
      const s = /^\d{1,9}$/.test(v) ? strings[Number(v)] : undefined;
      out.set(col, s ?? drift('shared_string_index', `row.${n}`));
    } else if (type === 'n') {
      // Only whole numbers are expected in numeric cells (months, days, order, priority).
      out.set(col, /^-?\d{1,9}$/.test(v) ? Number(v) : drift('cell_number', `row.${n}`));
    } else drift('cell_type', `row.${n}`);
  }
  return out;
}

const key = z.string().min(1);
const other = z.string().default('');
/** A month or day: a numeric cell, or the string 'NULL' (the `nvt*` period). */
const monthDay = z.union([z.literal('NULL'), z.number().int().min(0).max(99)]);
/** A bound: the verbatim string of a shared-string cell, 'NULL' or a decimal number. */
const bound = z.union([z.literal('NULL'), z.string().regex(/^-?\d+(?:\.\d+)?$/)]);
const rank = z.number().int().min(0).max(32_767);

/** One ParameterLimits row, keyed by the header. Name, Slug and the colours are not used and may be empty cells. */
export const SheetRow = z.strictObject({
  Code: key,
  Name: other,
  Slug: other,
  Description: key,
  Period: key,
  FromMonth: monthDay,
  FromDay: monthDay,
  ToMonth: monthDay,
  ToDay: monthDay,
  Label: key,
  From: bound,
  To: bound,
  Order: rank,
  Priority: rank,
  Color: other,
  HardColor: other,
  SoftColor: other,
});
export type SheetRow = z.infer<typeof SheetRow>;

/** The data rows of the sheet `ParameterLimits`, from the member texts of READ (path → text). */
export function parse(members: ReadonlyMap<string, string>): SheetRow[] {
  // The workbook holds more than the sheet list (views, defined names, …): only `sheets` is read.
  const workbook = child(tree(members, WORKBOOK), 'workbook');
  if (!isNode(workbook)) return drift('workbook');
  const listed = element(child(workbook, 'sheets'), ['sheet'], 'workbook');
  const named = list(child(listed, 'sheet')).filter((s) => attr(element(s, [], 'workbook'), 'name') === SHEET);
  if (named.length !== 1) drift('sheet_missing');
  const id = attr(named[0] as Node, 'r:id') ?? drift('sheet_missing');
  const rels = tree(members, WORKBOOK_RELS);
  const sheetPath = target(rels, (r) => attr(r, 'Id') === id, WORKSHEET_TYPE, 'sheet_target');
  const stringsPath = target(
    rels,
    (r) => attr(r, 'Type') === SHARED_STRINGS_TYPE,
    SHARED_STRINGS_TYPE,
    'strings_target',
  );
  const strings = sharedStrings(tree(members, stringsPath));

  const worksheet = child(tree(members, sheetPath), 'worksheet');
  if (!isNode(worksheet)) return drift('worksheet');
  // Merged cells hold their value in one cell only: the rows would read differently.
  if (child(worksheet, 'mergeCells') !== undefined) drift('merged_cells');
  const data = element(child(worksheet, 'sheetData'), ['row'], 'sheet_data');
  const rows = list(child(data, 'row'));
  if (rows.length === 0) drift('header');
  if (rows.length > MAX_ROWS + 1) drift('too_many_rows');

  const out: SheetRow[] = [];
  rows.forEach((raw, i) => {
    const row = element(raw, ['c'], 'row');
    // Rows are numbered from 1 without a gap: a blank or hidden-away row is not guessed at.
    if (attr(row, 'r') !== String(i + 1)) drift('row_ref', `row.${i + 1}`);
    const values = cells(row, i + 1, strings);
    if (i === 0) {
      if (values.size !== HEADER.length || HEADER.some((h, c) => values.get(c + 1) !== h)) drift('header');
      return;
    }
    const record: Record<string, Cell> = {};
    for (const [col, value] of values) record[HEADER[col - 1] as string] = value;
    const result = SheetRow.safeParse(record);
    if (!result.success) {
      const issue = result.error.issues[0];
      drift(issue?.code ?? 'invalid', ['row', i + 1, ...(issue?.path ?? [])].map(String).join('.'));
    } else out.push(result.data);
  });
  return out;
}
