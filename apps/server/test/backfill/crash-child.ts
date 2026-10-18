// Child process of resume.int.test.ts: a backfill runner that dies by a real SIGKILL (kill -9: no catch, no
// cleanup, its lease left to lapse), at one point of its n-th chunk. Before it dies it prints the requests it made (fake-clock times).
// Arguments: the rws_backfill database URL, the raw dir, the point (afterPut, afterAppend, afterCursor, or fetch:
// inside the n-th chunk request), n, the fake clock's start (epoch ms) and the scenario: `nl-1` (default, a fake
// client), or P14b's `de-8`, `fr-2`, `ch-9` (the real Client over this process's own msw server, onUnhandledFrame: 'error').
import { writeSync } from 'node:fs';
import { setupServer } from 'msw/node';
import { Archive } from '../../src/archive/writer.ts';
import { SqlJobStore } from '../../src/backfill/job.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import { type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import {
  type ArchiveName,
  archiveClient,
  archiveScenario,
  Clock,
  fakeClient,
  history,
  LOBITH_H,
  narrowed,
} from './harness.ts';

const [url = '', raw = '', point = '', nth = '0', start = '0', scenario = 'nl-1'] = process.argv.slice(2);
const clock = new Clock(Number(start));
let seen = 0;
let calls: unknown[] = [];
const die = (): never => {
  writeSync(1, `${JSON.stringify(calls)}\n`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('not killed');
};
const at = (p: string) => async () => {
  if (p === point && ++seen === Number(nth)) die();
};
const fetchPoint = () => {
  if (point === 'fetch' && ++seen === Number(nth)) die();
};

let run: { config: Parameters<typeof runBackfill>[0]['config']; client: Parameters<typeof runBackfill>[0]['client'] };
if (scenario === 'nl-1') {
  const fake = fakeClient(clock, (c) => {
    if (!c.check) fetchPoint();
    return history(c);
  });
  calls = fake.calls;
  run = { config: narrowed([LOBITH_H]), client: fake.client };
} else {
  const s = archiveScenario(scenario as ArchiveName);
  const real = archiveClient(clock, s, fetchPoint);
  calls = real.calls;
  setupServer(...real.handlers).listen({ onUnhandledFrame: 'error' });
  run = { config: s.config, client: real.client };
}
const { db } = openDb(dbConfig({ DATABASE_URL: url }, 'rws_backfill') as DbConfig, { max: 1 });
/** No loader runs beside the child, and the guard allows no unloaded chunk: this test is about the kill, not the guard. */
class Unguarded extends SqlJobStore {
  override async guard(): Promise<'ok'> {
    return 'ok';
  }
}
await runBackfill({
  ...run,
  store: new Unguarded(db),
  archive: new Archive(raw),
  now: clock.now,
  sleep: clock.sleep,
  hooks: { afterPut: at('afterPut'), afterAppend: at('afterAppend'), afterCursor: at('afterCursor') },
});
// Never reached: the point was not hit.
writeSync(2, `crash-child: ${scenario} ${point} ${nth} not reached after ${calls.length} requests\n`);
process.exit(3);
