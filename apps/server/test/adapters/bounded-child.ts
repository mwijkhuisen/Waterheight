// Child process of de-1.test.ts (review S1): builds one hostile body by name
// and parses it under the heap the test gives it (--max-old-space-size). It
// prints the SchemaDrift message and exits 0; anything else exits 1, and running
// out of memory kills it.
import { SchemaDrift } from '@rws/core';
import { JSON_CAPS, parseMeasurements, parseStations } from '../../src/adapters/de-1/parse.ts';

const MIB = 1024 * 1024;
const station = (timeseries: string) =>
  `{"uuid":"00000000-0000-4000-8000-000000000000","number":"1","shortname":"X","longname":"X","agency":"X",` +
  `"water":{"shortname":"X","longname":"X"},"timeseries":[${timeseries}]}`;
const list = (n: number, item: string) => Array(n).fill(item).join(',');
/** One empty object per three bytes: the shape that costs JSON.parse the most per byte. */
const objects = (bytes: number) => `[${list(Math.floor(bytes / 3) - 1, '{}')}]`;
const basin = (b: Uint8Array) => parseStations(b, JSON_CAPS.basin);
const meta = (b: Uint8Array) => parseStations(b, JSON_CAPS.meta);

export const BODIES: Record<string, [() => string, (b: Uint8Array) => unknown]> = {
  // The reviewer's two: 8 MiB of [0,0,…] as a series window; a basin body of 101 valid-looking stations, one
  // of which has a timeseries array of 2 M zeros (both inside the byte caps).
  'series-zeros': [() => `[${list(4 * MIB - 1, '0')}]`, parseMeasurements],
  'basin-2m': [
    () =>
      `[${list(100, station('{"shortname":"W","longname":"X","unit":"cm","equidistance":15}'))},${station(list(2_000_000, '0'))}]`,
    basin,
  ],
  // At each spec's byte cap (4, 8 and 16 MiB).
  'basin-bytes': [() => objects(4 * MIB), basin],
  'series-bytes': [() => objects(8 * MIB), parseMeasurements],
  'meta-bytes': [() => objects(16 * MIB), meta],
  // Just under each spec's node cap, the shape that yields the most issues: one station whose 60 timeseries
  // hold 200 characteristic values each, every one of the wrong shape (4 missing keys, and 14 wrong items in meta).
  'basin-issues': [() => `[${station(list(60, `{"characteristicValues":[${list(200, '{}')}]}`))}]`, basin],
  'meta-issues': [
    () => `[${station(list(60, `{"characteristicValues":[${list(200, `{"occurrences":[${list(14, '0')}]}`)}]}`))}]`,
    meta,
  ],
  'series-issues': [() => `[${list(60_000, '{}')}]`, parseMeasurements],
};

if (import.meta.main) {
  const [build, parse] = BODIES[process.argv[2] ?? ''] ?? [];
  if (build === undefined || parse === undefined) process.exit(64);
  try {
    parse(Buffer.from(build()));
    console.log('parsed');
    process.exit(1);
  } catch (err) {
    console.log(err instanceof SchemaDrift ? err.message : 'other');
    process.exit(err instanceof SchemaDrift ? 0 : 1);
  }
}
