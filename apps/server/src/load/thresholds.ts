import { SchemaDrift } from '@rws/core';
import { CSV_HEADER, fromCsvCells, type ThresholdRow, toCsv } from '../adapters/nl-4/normalise.ts';
import { scanCsv } from '../http/guards.ts';

// registry/thresholds/nl-4.csv (the NL-4 Waterinfo display classes), read for
// the registry sync. The file is generated (scripts/convert-nl4.ts) and read
// back strictly: it must be exactly what toCsv writes for its own rows, so a
// hand edit, a truncation or a stray cell fails closed.

/** The rows of the file with the source sha256 and edition its header states. Throws on anything malformed. */
export function readThresholds(text: string): { sha256: string; edition: string; rows: ThresholdRow[] } {
  const sha256 = /^# source sha256: ([0-9a-f]{64})$/m.exec(text)?.[1];
  const edition = /^# edition: (\d{4}-\d{2}-\d{2})$/m.exec(text)?.[1];
  if (sha256 === undefined || edition === undefined) throw new SchemaDrift('thresholds_header');
  const { header, rows } = scanCsv(Buffer.from(text, 'utf8'), { delimiter: ',', commentPrefix: '#' });
  if (header.join(',') !== CSV_HEADER) throw new SchemaDrift('thresholds_header');
  const out = rows.map(fromCsvCells);
  if (toCsv(out, { sha256, edition }) !== text) throw new SchemaDrift('thresholds_not_canonical');
  return { sha256, edition, rows: out };
}
