import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BODIES } from './bounded-child.ts';

// Review S1: no DE-1, NL-1, NL-2, FR-1, FR-3, CH-1, CH-2 or CH-3 payload inside the byte caps can run the loader out of
// memory on its way to a SchemaDrift. Each hostile body is parsed in its own
// process with a 256 MiB heap (the load container has 768 MiB). In the
// integration project, which runs one file at a time: these children are heavy,
// and the unit project has timing tests. Since review S1 of P2b also the XML
// attribute floods, through the NL-4 parser and through the guard's XML rule
// (the capture validity check and readXlsx): a fixed code, never a crash.

const child = fileURLToPath(new URL('./bounded-child.ts', import.meta.url));
const expected: Record<keyof typeof BODIES, string> = {
  'series-zeros': 'json_too_many_nodes',
  'basin-2m': 'json_too_many_nodes',
  'basin-bytes': 'json_too_many_nodes',
  'series-bytes': 'json_too_many_nodes',
  'meta-bytes': 'json_too_many_nodes',
  'basin-issues': 'invalid_type at 0.timeseries.0.shortname',
  'meta-issues': 'invalid_type at 0.timeseries.0.shortname',
  'series-issues': 'invalid_type at 0.timestamp',
  'nl1-bytes': 'json_too_many_nodes',
  'nl1-lists': 'too_big at WaarnemingenLijst',
  'nl1-values': 'too_big at WaarnemingenLijst.0.MetingenLijst',
  'nl1-issues': 'invalid_type at WaarnemingenLijst.0.MetingenLijst.0.Meetwaarde',
  'nl2-bytes': 'json_too_many_nodes',
  'nl2-features': 'too_big at features',
  'nl2-issues': 'invalid_value at features.0.type',
  'fr1-bytes': 'json_too_many_nodes',
  'fr1-ref-bytes': 'json_too_many_nodes',
  'fr1-nodes': 'json_too_many_nodes',
  'fr1-issues': 'invalid_type at data.0.code_site',
  'fr1-ref-issues': 'invalid_type at data.0.code_site',
  'fr3-bytes': 'json_too_many_nodes',
  'fr3-nodes': 'json_too_many_nodes',
  'fr3-issues': 'invalid_type at Serie.ObssHydro.0',
  'ch1-rows': 'csv_rows',
  'ch1-columns': 'csv_columns',
  'ch1-quote': 'csv_field',
  'ch1-issues': 'bad_id at rows.0',
  'ch2-bytes': 'json_too_many_nodes',
  'ch2-features': 'too_big at features',
  'ch2-issues': 'invalid_value at features.0.type',
  'ch3-bytes': 'json_too_many_nodes',
  'ch3-nodes': 'json_too_many_nodes',
  'ch3-issues': 'invalid_type at plot.data.0.x.0',
  'nl4-one-tag-700k-attributes': 'xml_tag_too_long at xl?worksheets?sheet1.xml',
  'nl4-one-tag-3m-equals': 'xml_tag_too_long at xl?worksheets?sheet1.xml',
  'nl4-one-tag-1.5m-quoted': 'xml_tag_too_long at xl?worksheets?sheet1.xml',
  'nl4-many-tags-10-attributes': 'xml_too_many_items at xl?worksheets?sheet1.xml',
  'xml-one-tag-700k-attributes': 'xml_tag_too_long',
  'xml-one-tag-3m-equals': 'xml_tag_too_long',
  'xml-one-tag-1.5m-quoted': 'xml_tag_too_long',
  'xml-many-tags-10-attributes': 'xml_too_many_items',
  'nl4-unclosed-1.5m-tags': 'xml_too_deep at xl?worksheets?sheet1.xml',
  'nl4-one-instruction-1.6m-attributes': 'xml_tag_too_long at xl?worksheets?sheet1.xml',
  'xml-unclosed-1.5m-tags': 'xml_too_deep',
  'xml-one-instruction-1.6m-attributes': 'xml_tag_too_long',
};

describe('bounded parsing: every hostile body ends in a SchemaDrift or a guard code, not a crash', () => {
  it.each(Object.keys(expected))('%s, under a 256 MiB heap', (name) => {
    const run = spawnSync(process.execPath, ['--max-old-space-size=256', '--no-experimental-webstorage', child, name], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect([name, run.status, run.stdout.trim()]).toEqual([name, 0, expected[name]]);
  });
});
