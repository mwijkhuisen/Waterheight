import { SchemaDrift } from '@rws/core';
import { z } from 'zod';
import { FORBIDDEN_TEXT, MAX_TEXT, type SheetRow } from './parse.ts';

// NL-4 sheet rows → Waterinfo display classes (catalogue §2.1): one row per
// class band. These are the legend classes waterinfo.rws.nl colours values
// with, not alert levels. Declared here, never inferred per row:
//  - slug variants are one class: rows are deduplicated on (Code, Description,
//    Period, Label, From, To), and every variant must agree on the season
//    window, Order and Priority;
//  - the season is a recurring MMDD window, both ends inclusive, wrapping the
//    year when from_md > to_md; the `nvt*` period (month and day 'NULL') has
//    no window and applies all year;
//  - bounds come from From and To, never from the label: a band is
//    [from, to), a null bound is open, and bounds are stored as the file states
//    them (some bands have from >= to and so hold no value);
//  - where bands overlap, the lower Priority number wins.

export const H_DESCRIPTION = 'Waterhoogte in Oppervlaktewater t.o.v. Normaal Amsterdams Peil in cm';
export const Q_DESCRIPTION = 'Debiet in Oppervlaktewater in m3/s';

const drift = (code: string): never => {
  throw new SchemaDrift(code);
};

/** Days per month of a recurring MMDD (February has 29): the rule of the reference_value season CHECKs. */
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const isMonthDay = (md: number): boolean =>
  Number.isInteger(md) && md % 100 >= 1 && md % 100 <= (DAYS[Math.floor(md / 100) - 1] ?? 0);

/** A decimal number as the workbook and the CSV write it: no exponent, no sign on zero, no padding. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const canonical = (s: string): boolean => DECIMAL.test(s) && String(Number(s)) === s;

/**
 * No lone surrogate, so the text survives the UTF-8 file unchanged, and no control, bidi or format character
 * (FORBIDDEN_TEXT, as the parser), so a hand-edited CSV cannot carry one either.
 */
const text = z
  .string()
  .min(1)
  .max(MAX_TEXT)
  .refine((s) => !FORBIDDEN_TEXT.test(s));
const monthDay = z.number().refine(isMonthDay);
const bound = z.number().refine((n) => !Object.is(n, -0) && canonical(String(n)));
const rank = z.number().int().min(0).max(32_767);

export const ThresholdRow = z
  .strictObject({
    code: text,
    description: text,
    period: text,
    from_md: monthDay.nullable(),
    to_md: monthDay.nullable(),
    label: text,
    from: bound.nullable(),
    to: bound.nullable(),
    order: rank,
    priority: rank,
  })
  .refine((r) => (r.from_md === null) === (r.to_md === null), { path: ['to_md'] });
export type ThresholdRow = z.infer<typeof ThresholdRow>;

/** A validated row; a Zod issue becomes a SchemaDrift with its code and our schema path. */
function checked(candidate: unknown): ThresholdRow {
  const result = ThresholdRow.safeParse(candidate);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new SchemaDrift(issue?.code ?? 'invalid', (issue?.path ?? []).map(String).join('.'));
}

/** The season window of a sheet row: all four cells 'NULL', or two valid MMDD values. */
function season(r: SheetRow): [number, number] | [null, null] {
  const cells = [r.FromMonth, r.FromDay, r.ToMonth, r.ToDay];
  if (cells.every((c) => c === 'NULL')) return [null, null];
  const [fm, fd, tm, td] = cells.map((c) => (c === 'NULL' ? drift('season_partial') : c)) as number[];
  const from = (fm as number) * 100 + (fd as number);
  const to = (tm as number) * 100 + (td as number);
  if (!isMonthDay(from) || !isMonthDay(to)) drift('season_invalid');
  return [from, to];
}

/** A bound: 'NULL' is open; a number must read back as the same text, so the CSV holds exactly what the file says. */
const boundOf = (s: string): number | null => (s === 'NULL' ? null : canonical(s) ? Number(s) : drift('bound_form'));

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byNumber = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

/**
 * The output order, total over the dedupe key: code, description and period
 * (UTF-16 code units, never locale order), priority, order, label, from, to
 * (a null bound first).
 */
const compare = (a: ThresholdRow, b: ThresholdRow) =>
  byText(a.code, b.code) ||
  byText(a.description, b.description) ||
  byText(a.period, b.period) ||
  a.priority - b.priority ||
  a.order - b.order ||
  byText(a.label, b.label) ||
  byNumber(a.from, b.from) ||
  byNumber(a.to, b.to);

/**
 * Slug variants → one row per class. Fails (SchemaDrift) when variants of one
 * class disagree on the season, Order or Priority, or when two H or Q classes of
 * one code share a season window and a Priority: the reference_value key.
 */
export function dedupe(rows: readonly SheetRow[]): ThresholdRow[] {
  const classes = new Map<string, ThresholdRow>();
  for (const r of rows) {
    const [from_md, to_md] = season(r);
    const row = checked({
      code: r.Code,
      description: r.Description,
      period: r.Period,
      from_md,
      to_md,
      label: r.Label,
      from: boundOf(r.From),
      to: boundOf(r.To),
      order: r.Order,
      priority: r.Priority,
    });
    const key = JSON.stringify([r.Code, r.Description, r.Period, r.Label, r.From, r.To]);
    const seen = classes.get(key);
    if (seen === undefined) classes.set(key, row);
    else if (
      seen.from_md !== from_md ||
      seen.to_md !== to_md ||
      seen.order !== row.order ||
      seen.priority !== row.priority
    ) {
      drift('variant_conflict');
    }
  }
  const out = [...classes.values()].sort(compare);
  const keys = new Set<string>();
  for (const r of out) {
    if (r.description !== H_DESCRIPTION && r.description !== Q_DESCRIPTION) continue;
    const key = JSON.stringify([r.code, r.description, r.from_md, r.to_md, r.priority]);
    if (keys.has(key)) drift('priority_clash');
    keys.add(key);
  }
  return out;
}

const inSeason = (r: ThresholdRow, md: number) =>
  r.from_md === null || r.to_md === null
    ? true
    : r.from_md <= r.to_md
      ? r.from_md <= md && md <= r.to_md
      : md >= r.from_md || md <= r.to_md;

/**
 * The legend of one code and description on the UTC calendar date of `date`:
 * the rows whose season contains that date (a whole-year row always does), in
 * priority order (the lower number first).
 */
export function legendOn(rows: readonly ThresholdRow[], code: string, description: string, date: Date): ThresholdRow[] {
  if (Number.isNaN(date.getTime())) throw new RangeError('legendOn: invalid date');
  const md = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  return rows
    .filter((r) => r.code === code && r.description === description && inSeason(r, md))
    .sort((a, b) => a.priority - b.priority || compare(a, b));
}

/**
 * The class of a value in a legend (from legendOn): the first row, in priority
 * order, whose band [from, to) holds it. A value equal to a bound belongs to
 * the band that starts there; where bands overlap, the lower Priority number
 * wins. Null when no band holds the value.
 */
export const classOf = (legend: readonly ThresholdRow[], value: number): ThresholdRow | null =>
  legend.find((r) => (r.from === null || value >= r.from) && (r.to === null || value < r.to)) ?? null;

export type Coverage = { covered: number; total: number; missing: string[] };

/** How many of the curated codes (per quantity, H or Q) have at least one class; the rest in list order. */
export function coverage(
  rows: readonly ThresholdRow[],
  seed: readonly { code: string; quantity: string }[],
): { h: Coverage; q: Coverage } {
  const of = (quantity: string, description: string): Coverage => {
    const have = new Set(rows.filter((r) => r.description === description).map((r) => r.code));
    const codes = [...new Set(seed.filter((s) => s.quantity === quantity).map((s) => s.code))];
    const missing = codes.filter((c) => !have.has(c));
    return { covered: codes.length - missing.length, total: codes.length, missing };
  };
  return { h: of('H', H_DESCRIPTION), q: of('Q', Q_DESCRIPTION) };
}

// ---------------------------------------------------------------- CSV (registry/thresholds/nl-4.csv)

export const CSV_HEADER = 'code,description,period,from_md,to_md,label,from,to,order,priority';

/** A text cell a spreadsheet could read as a formula, or that starts with the guard itself, gets one leading apostrophe. */
const GUARDED = /^[=+\-@\t\r']/;
const guard = (s: string) => (GUARDED.test(s) ? `'${s}` : s);
/** The inverse of guard: an apostrophe is removed only where guard wrote one; an unguarded formula start is drift. */
function unguard(cell: string): string {
  if (cell.startsWith("'") && GUARDED.test(cell.slice(1))) return cell.slice(1);
  return GUARDED.test(cell) ? drift('csv_guard') : cell;
}

/** RFC 4180: quoted when the cell holds a comma, a quote, CR or LF (quotes doubled), or starts or ends with white space. */
const quote = (cell: string) => (/[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

const numberCell = (n: number | null) => (n === null ? '' : String(n));

/**
 * The text of registry/thresholds/nl-4.csv: `# ` comment lines (what the file
 * is, its source sha256 and edition), the header, one line per row; `\n` line
 * endings and a final newline. Null is an empty cell.
 */
export function toCsv(rows: readonly ThresholdRow[], header: { sha256: string; edition: string }): string {
  if (!/^[0-9a-f]{64}$/.test(header.sha256) || !/^\d{4}-\d{2}-\d{2}$/.test(header.edition)) {
    throw new Error('toCsv: bad sha256 or edition');
  }
  const lines = [
    '# NL-4: Rijkswaterstaat Waterinfo display classes (the legend classes waterinfo.rws.nl colours values with; they are',
    '# display classes, not alert levels), from the workbook "grenswaarden en legendakleuren zoals gebruikt op Waterinfo",',
    '# sheet ParameterLimits, one row per class: slug variants deduplicated on (Code, Description, Period, Label, From, To).',
    '# GENERATED by scripts/convert-nl4.ts from the archived workbook below. Do not edit by hand: run',
    '# `node scripts/convert-nl4.ts`, which reads only an archived file whose sha256 matches its pin.',
    `# source sha256: ${header.sha256}`,
    `# edition: ${header.edition}`,
    '# from_md, to_md: the season as MMDD, both inclusive, wrapping the year when from_md > to_md; empty: all year (nvt*).',
    '# from, to: the band [from, to) as the file states it (some have from >= to); empty: open. Where bands overlap, the',
    "# lower priority number wins. A text cell that starts with = + - @ ' a tab or a CR carries one more leading '.",
    CSV_HEADER,
  ];
  for (const raw of rows) {
    const r = checked(raw);
    const cells = [
      quote(guard(r.code)),
      quote(guard(r.description)),
      quote(guard(r.period)),
      numberCell(r.from_md),
      numberCell(r.to_md),
      quote(guard(r.label)),
      numberCell(r.from),
      numberCell(r.to),
      String(r.order),
      String(r.priority),
    ];
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

const numberOf = (cell: string): number | null =>
  cell === '' ? null : canonical(cell) ? Number(cell) : drift('csv_number');

/** One data line of toCsv, split into its 10 cells (unquoted), back into a validated row. */
export function fromCsvCells(cells: readonly string[]): ThresholdRow {
  if (cells.length !== 10) return drift('csv_width');
  const [code, description, period, fromMd, toMd, label, from, to, order, priority] = cells as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return checked({
    code: unguard(code),
    description: unguard(description),
    period: unguard(period),
    from_md: numberOf(fromMd),
    to_md: numberOf(toMd),
    label: unguard(label),
    from: numberOf(from),
    to: numberOf(to),
    order: numberOf(order),
    priority: numberOf(priority),
  });
}
