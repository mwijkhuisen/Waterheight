// Child process of crash.int.test.ts (P9a): one public publishOnce that the test kills with SIGKILL at a random point.
// Arguments: the rws_publish database URL, the output directory and the cycle's clock (ms).
import { dbConfig, openDb } from '../../src/db/pool.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';

const [url = '', dir = '', now = ''] = process.argv.slice(2);
const cfg = dbConfig({ DATABASE_URL: url }, 'rws_publish');
if (typeof cfg === 'string') throw new Error(cfg);
const { db, close } = openDb(cfg, { max: 2 });
process.stdout.write('started\n');
await publishOnce(db, 'public', dir, { now: Number(now), render: RENDERERS });
await close();
process.stdout.write('done\n');
