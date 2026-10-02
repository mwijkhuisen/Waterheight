import { SchemaDrift, scanCsv } from '@rws/core';

// LU-1 AGE `Water-Levels-LocalTime.csv` (CC0; catalogue §2.6). A wide table, one row per station:
//
//   "Name","Number","Unit","23.09.2026 16:00",…,"30.09.2026 15:45"      (672 labels: 7 days of 15 min)
//   "Diekirch","","cm","121.0",…,"120.7"
//
// UTF-8 (names with ü, é), LF line ends, every field quoted. `Number` is always empty, so rows are matched by
// Name (normalise). Since 2026-09-30 every row is as wide as the header. The 5-day file before it (480 labels,
// the P1a recording) had one more field per row, empty except at Esch-Sure, which carried one more value than
// there were labels: such a field is kept here as `extra` and judged in normalise. The labels are local
// wall-clock times without an offset: normalise reads them. Parsing is strict; a failure is a SchemaDrift with
// a fixed code, never provider text.

/** 42 rows (2026-09-30); 100 leaves room for new stations without letting a flood of rows through. */
export const MAX_ROWS = 100;
/** A station name is at most 40 characters today. */
const MAX_NAME = 64;
const LABEL = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/;
/** cm (one decimal) or, at Esch-Sure, m NN (two decimals). */
const VALUE = /^-?\d{1,5}(?:\.\d{1,3})?$/;
const UNIT = /^(?:cm|m)$/;

export type Row = {
  name: string;
  unit: string;
  /** One cell per label: '' is a gap, else a decimal. */
  cells: string[];
  /** The field after the last label: '' or a decimal (Esch-Sure). */
  extra: string;
};
export type Table = { labels: string[]; rows: Row[] };

export function parseCsv(body: Uint8Array): Table {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  const { header, rows } = scanCsv(text, { delimiter: ',', maxRows: MAX_ROWS, extraField: 'keep' });
  if (header[0] !== 'Name' || header[1] !== 'Number' || header[2] !== 'Unit') throw new SchemaDrift('csv_header');
  const labels = header.slice(3);
  if (labels.length === 0) throw new SchemaDrift('csv_header');
  labels.forEach((l, i) => {
    if (!LABEL.test(l)) throw new SchemaDrift('time_bad_format', `labels.${i}`);
  });
  return {
    labels,
    rows: rows.map((r, i) => {
      const at = `rows.${i}`;
      const [name, number, unit] = r as [string, string, string];
      if (name === '' || name.length > MAX_NAME) throw new SchemaDrift('name', at);
      if (number !== '') throw new SchemaDrift('number', at);
      if (!UNIT.test(unit)) throw new SchemaDrift('unit', at);
      const cells = r.slice(3, 3 + labels.length);
      const extra = r.length > header.length ? (r.at(-1) as string) : '';
      for (const c of [...cells, extra]) if (c !== '' && !VALUE.test(c)) throw new SchemaDrift('bad_value', at);
      return { name, unit, cells, extra };
    }),
  };
}
