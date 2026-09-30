// Child process of drift.int.test.ts (review S1): a loader whose parser kills
// the process, as running out of memory would. Nothing after the parser runs:
// no catch, no cleanup. Arguments: the rws_load database URL and the raw dir.
import { ArchiveReader } from '../../src/archive/reader.ts';
import { type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { Loader } from '../../src/load/pipeline.ts';

const [url = '', raw = ''] = process.argv.slice(2);
const { db } = openDb(dbConfig({ DATABASE_URL: url }, 'rws_load') as DbConfig, { max: 1 });
await new Loader({
  db,
  reader: new ArchiveReader(raw),
  alert: () => {},
  now: () => new Date(),
  adapters: {
    'DE-1': {
      version: 1,
      specs: { 'de-1-series': { maxBytes: 1024, needsVariant: true, run: () => process.exit(137) } },
    },
  },
}).tick();
process.exit(0);
