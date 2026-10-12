// Child process of resume.int.test.ts: a backfill runner that dies by a real SIGKILL (kill -9: no catch, no
// cleanup, its lease left to lapse), at one point of its n-th chunk. Before it dies it prints the requests it made (fake-clock times).
// Arguments: the rws_backfill database URL, the raw dir, the point (afterPut, afterAppend, afterCursor, or fetch:
// inside the n-th chunk request), n, and the fake clock's start (epoch ms).
import { writeSync } from 'node:fs';
import { Archive } from '../../src/archive/writer.ts';
import { SqlJobStore } from '../../src/backfill/job.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import { type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { Clock, fakeClient, history, LOBITH_H, narrowed } from './harness.ts';

const [url = '', raw = '', point = '', nth = '0', start = '0'] = process.argv.slice(2);
const clock = new Clock(Number(start));
let seen = 0;
const die = (): never => {
  writeSync(1, `${JSON.stringify(calls)}\n`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('not killed');
};
const at = (p: string) => async () => {
  if (p === point && ++seen === Number(nth)) die();
};
const { client, calls } = fakeClient(clock, (c) => {
  if (point === 'fetch' && !c.check && ++seen === Number(nth)) die();
  return history(c);
});
const { db } = openDb(dbConfig({ DATABASE_URL: url }, 'rws_backfill') as DbConfig, { max: 1 });
await runBackfill({
  config: narrowed([LOBITH_H]),
  store: new SqlJobStore(db),
  archive: new Archive(raw),
  client,
  now: clock.now,
  sleep: clock.sleep,
  hooks: { afterPut: at('afterPut'), afterAppend: at('afterAppend'), afterCursor: at('afterCursor') },
});
// Never reached: the point was not hit.
writeSync(2, `crash-child: ${point} ${nth} not reached after ${calls.length} requests\n`);
process.exit(3);
