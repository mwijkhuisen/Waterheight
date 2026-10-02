import { SchemaDrift } from './errors.ts';

// A quote-aware CSV scan with the catalogue §6.7 caps, shared by the capture
// validity guard (apps/server/src/http/guards.ts) and the CSV adapters (P5a:
// CH-1). Failures are a SchemaDrift with a fixed code, never provider text.

export const CSV_MAX_ROWS = 100_000;
export const CSV_MAX_COLUMNS = 1000;
export const CSV_MAX_FIELD = 1024;

export type CsvScanOptions = {
  delimiter: string;
  /** Lines starting with this prefix before the header are skipped (BfG `#` notes). */
  commentPrefix?: string;
  maxRows?: number;
  /**
   * A data row may be one field wider than the header, the extra field dropped
   * (LU-1: a trailing empty field, and one row with one more value column).
   * `false` makes any width but the header's fail (CH-1: a shifted column must
   * never pass). `'keep'` allows it and keeps the field (P5b: LU-1 reads it, because
   * one station's extra field holds a value). Default true.
   */
  extraField?: boolean | 'keep';
};

const fail = (code: string): never => {
  throw new SchemaDrift(code);
};

/**
 * ≤ 100,000 data rows (or `maxRows`), ≤ 1,000 columns, fields ≤ 1 KB, and every
 * row as wide as the header (a truncated last row fails). Returns the header
 * and the data rows.
 */
export function scanCsv(input: string, opts: CsvScanOptions): { header: string[]; rows: string[][] } {
  let text = input;
  if (opts.commentPrefix !== undefined) {
    while (text.startsWith(opts.commentPrefix)) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
  }
  const maxRows = opts.maxRows ?? CSV_MAX_ROWS;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    if (field.length > CSV_MAX_FIELD) fail('csv_field');
    row.push(field);
    field = '';
    if (row.length > CSV_MAX_COLUMNS) fail('csv_columns');
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
    if (records.length > maxRows + 1) fail('csv_rows');
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      if (field.length > CSV_MAX_FIELD) fail('csv_field');
    } else if (c === '"' && field === '') quoted = true;
    else if (c === opts.delimiter) endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') {
      field += c;
      if (field.length > CSV_MAX_FIELD) fail('csv_field');
    }
    i += 1;
  }
  if (quoted) fail('csv_quote');
  if (field !== '' || row.length > 0) endRow();
  const [header, ...rows] = records;
  if (header === undefined) return fail('csv_empty');
  // A row one field wider than the header loses that field (unless `extraField` is false, or 'keep'); any
  // other width fails, which catches a truncated last row.
  for (const r of rows) {
    if (r.length === header.length + 1 && opts.extraField !== false) {
      if (opts.extraField !== 'keep') r.pop();
    } else if (r.length !== header.length) fail('csv_width');
  }
  return { header, rows };
}
