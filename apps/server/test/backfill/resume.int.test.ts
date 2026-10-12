import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Job, SqlJobStore } from '../../src/backfill/job.ts';
import { planChunks, probeYears, requestBudget } from '../../src/backfill/plan.ts';
import { DB_BYTES_PER_ROW } from '../../src/backfill/project.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import { type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { sqlState } from '../db/testdb.ts';
import { type Harness, harness } from '../load/harness.ts';
import { type Call, Clock, fakeClient, history, historyBody, LOBITH_H, NIGHT, narrowed, SPEC } from './harness.ts';

// P14a, kill -9 and resume (plan §3.3 step 10, §4): a runner process dies after the put, after the append, after the
// cursor or in the middle of a later chunk's request; a restarted runner finishes the job, and the loader loads the
// archive. Every instant the provider served is in obs exactly once, with no gap, the job is done, the ledger
// reconciles, and a second job over the same history changes nothing. The runner's DB side is the real SqlJobStore
// as rws_backfill (CONNECTION LIMIT 2, shared with roles.int: each use opens and closes its own pool).

const CONFIG = narrowed([LOBITH_H]);
const CHUNK_MS = CONFIG.specs[0]?.chunk_ms ?? 0;
const HOUR = 3_600_000;
const LOAD_NOW = new Date(NIGHT + 6 * HOUR);
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let h: Harness;
let SERIES: number;

/** Waits until no rws_backfill session is left (a killed child's backend goes away a moment after the child). */
async function slotFree(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await h.t.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'rws_backfill'",
    );
    if (rows[0]?.n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('an rws_backfill session is still open');
}

/** The real job store as rws_backfill, for the length of `f`. */
async function withStore<T>(f: (s: SqlJobStore) => Promise<T>): Promise<T> {
  await slotFree();
  const d = openDb(dbConfig({ DATABASE_URL: h.t.urlFor('rws_backfill') }, 'rws_backfill') as DbConfig, { max: 1 });
  try {
    return await f(new SqlJobStore(d.db));
  } finally {
    await d.close();
  }
}

/** What backfill_guard reads: a loader that computes health, no backlog, NL-1 healthy. */
const setGuard = (o: { computed?: string; files?: number; status?: string } = {}) =>
  h.t.admin
    .query(
      `INSERT INTO app_meta (key, value)
     VALUES ('loader', jsonb_build_object('computed_at', now() - $1::interval, 'backlog_age_s', 0, 'backlog_files', $2::int))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [o.computed ?? '0 s', o.files ?? 0],
    )
    .then(() =>
      h.t.admin.query(
        `INSERT INTO source_health (source_id, status) VALUES ('NL-1', $1)
       ON CONFLICT (source_id) DO UPDATE SET status = EXCLUDED.status`,
        [o.status ?? 'ok'],
      ),
    );

const range = (year: number, to = `${year}-06-01T00:00:00Z`) => ({
  from: new Date(`${year}-01-01T00:00:00Z`),
  to: new Date(to),
});

async function plan(from: Date, to: Date): Promise<{ id: number; budget: number }> {
  const budget = requestBudget(planChunks(from, to, CHUNK_MS).length, probeYears(from, to));
  const { id } = await withStore((s) =>
    s.insert({
      spec_id: SPEC,
      source_id: 'NL-1',
      series_key: LOBITH_H,
      range_from: from,
      range_to: to,
      chunk_ms: CHUNK_MS,
      request_budget: budget,
    }),
  );
  return { id, budget };
}

const load = () => h.loader({ now: LOAD_NOW }).tick();

/**
 * The in-process runner on a fake clock, with the loader keeping up after every chunk as in production (the guard
 * stops a runner more than 2 chunks with data ahead of the ledger, review S6); returns its requests and the lines
 * loaded meanwhile.
 */
async function run(start: number): Promise<{ calls: Call[]; loaded: number }> {
  await setGuard();
  const clock = new Clock(start);
  const { client, calls } = fakeClient(clock, history);
  let loaded = 0;
  const out = await withStore((store) =>
    runBackfill({
      config: CONFIG,
      store,
      archive: h.archive,
      client,
      now: clock.now,
      sleep: clock.sleep,
      hooks: {
        afterCursor: async () => {
          loaded += (await load()).loaded;
        },
      },
    }),
  );
  expect(out.stopped).toBe('done');
  return { calls, loaded };
}

const job = (id: number) => withStore((s) => s.get(id)) as Promise<Job>;
const ledger = async (id: number) =>
  (
    await h.t.admin.query<{ chunk_from: Date; kept: number; inserted: number; revised: number; reconciled: boolean }>(
      `SELECT chunk_from, kept, inserted, revised, skipped, reconciled FROM backfill_chunk
       WHERE job_id = $1 ORDER BY chunk_from, loaded_at`,
      [id],
    )
  ).rows;
const stored = async (from: Date, to: Date) =>
  (
    await h.t.admin.query<{ ts: Date; qc: number }>(
      'SELECT ts, qc FROM obs WHERE series_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts',
      [SERIES, from, to],
    )
  ).rows;
/** Archived objects no manifest line names. */
function orphans(): string[] {
  const named = new Set(
    readdirSync(join(h.raw, '_manifest')).flatMap((f) =>
      readFileSync(join(h.raw, '_manifest', f), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l).key),
    ),
  );
  return (readdirSync(join(h.raw, 'NL-1'), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.zst'))
    .map((f) => `raw/NL-1/${f}`)
    .filter((k) => !named.has(k));
}
/** Is a runner's lease of the RWS host live? */
const leaseHeld = async () =>
  (await h.t.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM backfill_lease WHERE until > now()')).rows[0]
    ?.n === 1;
/** Every lease lapses now (what 2 minutes after a kill -9 would do). */
const lapse = () => h.t.admin.query("UPDATE backfill_lease SET until = now() - interval '1 second'");
/** Request spacing on the fake clock. */
const gaps = (calls: readonly Call[]) => calls.slice(1).map((c, i) => c.at - (calls[i] as Call).at);

beforeAll(async () => {
  h = await harness();
  SERIES = await h.seriesId(LOBITH_H);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

type Point = 'afterPut' | 'afterAppend' | 'afterCursor' | 'fetch';

/**
 * One job over Jan–May of `year` (four P40D chunks): a child runner dies at `point` of its `nth` chunk, a runner in
 * this process finishes the job an hour later on the fake clock, and the loader loads the archive.
 */
async function killAndResume(year: number, point: Point, nth: number) {
  const { from, to } = range(year);
  const chunks = planChunks(from, to, CHUNK_MS);
  const { id, budget } = await plan(from, to);
  await setGuard();
  await slotFree();
  const child = spawnSync(
    process.execPath,
    ['--no-experimental-webstorage', CHILD, h.t.urlFor('rws_backfill'), h.raw, point, String(nth), String(NIGHT)],
    { timeout: 60_000 },
  );
  expect(child.signal, child.stderr.toString()).toBe('SIGKILL');
  const before = JSON.parse(child.stdout.toString()) as Call[];
  const crashed = await job(id);
  expect(crashed.status).toBe('running');
  // The killed runner's lease is still held: a new run is busy until it lapses (2 minutes; here made to lapse now).
  expect(await leaseHeld()).toBe(true);
  await lapse();

  const { calls: after, loaded } = await run(NIGHT + HOUR);
  expect(loaded + (await load()).loaded).toBeGreaterThan(0);
  expect(h.alerts).toEqual([]);

  // Every instant served, after normalise's drops (one gap per chunk), exactly once and with no gap; all history.
  const expected = chunks.flatMap((c) => historyBody(c.from, c.to).kept);
  const rows = await stored(from, to);
  expect(rows.map((r) => r.ts.getTime())).toEqual(expected);
  expect(rows.filter((r) => (r.qc & 512) === 0)).toEqual([]);

  const done = await job(id);
  expect(done).toMatchObject({
    status: 'done',
    chunks_done: chunks.length,
    inserted: expected.length,
    revised: 0,
    unreconciled: 0,
    dropped: expect.any(Number),
    last_error: null,
  });
  expect(done.cursor_ts).toEqual(to);
  // Every request counted, within the budget; at least 1 s apart on each runner's pacer, an hour between the two.
  // A request is counted once it returns: the one a kill interrupts inside the fetch is not.
  expect(done.requests).toBe(before.length + after.length - (point === 'fetch' ? 1 : 0));
  expect(done.requests).toBeLessThanOrEqual(budget);
  for (const g of [...gaps(before), ...gaps(after)]) expect(g).toBeGreaterThanOrEqual(1000);
  expect(before[0]?.check).toBe(true);
  expect(after.some((c) => c.check)).toBe(false);

  const rowsOfLedger = await ledger(id);
  expect(rowsOfLedger.every((r) => r.reconciled)).toBe(true);
  expect(new Set(rowsOfLedger.map((r) => r.chunk_from.getTime()))).toEqual(
    new Set(chunks.map((c) => c.from.getTime())),
  );
  return { id, chunks, before, after, ledger: rowsOfLedger, expected };
}

describe('kill -9 and resume (plan §3.3 step 10)', { timeout: 120_000 }, () => {
  it('after the put: the re-fetch loads once; the orphan object has no line until recover() adopts it, harmlessly', async () => {
    const { id, before, after, ledger: l, expected } = await killAndResume(2001, 'afterPut', 2);
    expect(before.map((c) => c.check)).toEqual([true, false, false]);
    expect(after).toHaveLength(3);
    expect(l).toHaveLength(4);
    expect(l.reduce((n, r) => n + r.inserted, 0)).toBe(expected.length);

    // The object the dead child put (chunk 1, at its own fetch time) is on disk, and no manifest line names it.
    expect(orphans()).toHaveLength(1);
    const batches = await h.count('ingest_batch');
    const sums = await h.checksums();
    // Capture's start-up recover() adopts it as a recovered line (no backfill field, so no ledger row). It loads
    // through the backfill spec and changes nothing: the same values as the re-fetch, a backfill row over a backfill row.
    expect(await h.archive.recover(() => undefined, new Date(NIGHT + 2 * HOUR))).toBe(1);
    expect(orphans()).toEqual([]);
    expect(await load()).toMatchObject({ lines: 1, loaded: 1 });
    expect(h.alerts).toEqual([]);
    expect(await h.checksums()).toEqual(sums);
    expect(await ledger(id)).toHaveLength(4);
    expect(await job(id)).toMatchObject({ inserted: expected.length, revised: 0, unreconciled: 0 });
    expect(await h.count('ingest_batch')).toBe(batches + 1);
    expect(await h.count("ingest_batch WHERE origin <> 'backfill'")).toBe(0);
    expect(await h.count('obs_revision')).toBe(0);
  });

  it('after the append: the chunk is fetched and loaded twice, the second time with 0 new and 0 revised', async () => {
    const { before, after, ledger: l } = await killAndResume(2002, 'afterAppend', 2);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(3);
    // Chunk 1 has two ledger rows (two fetches, two archive keys); the second inserts nothing and revises nothing.
    expect(l).toHaveLength(5);
    const twice = l.filter((r) => r.chunk_from.getTime() === l[1]?.chunk_from.getTime());
    expect(twice).toHaveLength(2);
    expect(twice[1]).toMatchObject({ inserted: 0, revised: 0, skipped: twice[0]?.kept });
  });

  it('after the cursor: nothing is fetched twice', async () => {
    const { before, after, ledger: l } = await killAndResume(2003, 'afterCursor', 2);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(2);
    expect(l).toHaveLength(4);
  });

  it('in the middle of a later chunk request: the request is not counted, nothing is archived, the chunk is fetched again', async () => {
    const { before, after, ledger: l } = await killAndResume(2004, 'fetch', 3);
    expect(before).toHaveLength(4);
    expect(after).toHaveLength(2);
    expect(l).toHaveLength(4);
  });

  it('DB_BYTES_PER_ROW is within ±50 % of the measured obs size per row', async () => {
    const { rows } = await h.t.admin.query<{ bytes: number; n: number }>(
      `SELECT sum(pg_total_relation_size(p))::float8 AS bytes, sum(n)::int AS n
       FROM (SELECT tableoid::regclass AS p, count(*) AS n FROM obs GROUP BY 1) AS parts`,
    );
    const { bytes, n } = rows[0] as { bytes: number; n: number };
    expect(n).toBeGreaterThan(80_000);
    const perRow = bytes / n;
    console.info(`obs bytes per row: ${perRow.toFixed(1)} over ${n} rows (DB_BYTES_PER_ROW ${DB_BYTES_PER_ROW})`);
    expect(perRow).toBeGreaterThanOrEqual(DB_BYTES_PER_ROW * 0.5);
    expect(perRow).toBeLessThanOrEqual(DB_BYTES_PER_ROW * 1.5);
  });

  it('a second job over the same history: 0 new rows, 0 revised, no revision, the same obs', async () => {
    const { from } = range(2001);
    // The same plan is the same job (done, so not runnable): a second job needs a range of its own.
    const again = await plan(from, range(2001).to);
    expect((await job(again.id)).status).toBe('done');
    const to = new Date('2001-05-31T23:59:59Z');
    const { id } = await plan(from, to);
    const sums = await h.checksums();
    const obs = await h.count('obs');
    const revisions = await h.count('obs_revision');
    const { loaded } = await run(NIGHT + 3 * HOUR);
    expect(loaded + (await load()).loaded).toBe(4);
    expect(await job(id)).toMatchObject({ status: 'done', inserted: 0, revised: 0, unreconciled: 0 });
    const l = await ledger(id);
    expect(l).toHaveLength(4);
    for (const r of l) expect(r).toMatchObject({ inserted: 0, revised: 0, skipped: r.kept, reconciled: true });
    expect(await h.count('obs')).toBe(obs);
    expect(await h.count('obs_revision')).toBe(revisions);
    expect(await h.checksums()).toEqual(sums);
  });
});

describe('SqlJobStore as rws_backfill', { timeout: 60_000 }, () => {
  const from = new Date('1999-01-01T00:00:00Z');
  const to = new Date('1999-03-01T00:00:00Z');
  const NEW = {
    spec_id: SPEC,
    source_id: 'NL-1',
    series_key: LOBITH_H,
    range_from: from,
    range_to: to,
    chunk_ms: CHUNK_MS,
    request_budget: 4,
  };

  it('inserts once, lists the runnable jobs and keeps to the status transitions', async () => {
    await withStore(async (s) => {
      const a = await s.insert(NEW);
      expect(a.created).toBe(true);
      expect(await s.insert(NEW)).toEqual({ id: a.id, created: false });
      const fresh = await s.get(a.id);
      expect(fresh).toMatchObject({ status: 'planned', chunk_ms: CHUNK_MS, data_from: null, requests: 0 });
      expect(fresh?.cursor_ts).toEqual(from);
      expect((await s.runnable()).map((j) => j.id)).toEqual([a.id]);

      await s.start(a.id);
      await s.addRequest(a.id);
      expect(await s.failAttempt(a.id)).toBe(1);
      expect(await s.failAttempt(a.id)).toBe(2);
      await s.advance(a.id, { cursor_ts: from, data_from: from, chunk: false });
      await s.advance(a.id, { cursor_ts: new Date('1999-02-10T00:00:00Z'), chunk: true });
      expect(await s.get(a.id)).toMatchObject({ status: 'running', requests: 1, attempts: 0, chunks_done: 1 });
      expect((await s.get(a.id))?.data_from).toEqual(from);
      expect((await s.runnable()).map((j) => j.id)).toEqual([a.id]);

      expect(await s.setStatus(a.id, 'paused', 'budget', ['planned', 'running'])).toBe(true);
      expect(await s.runnable()).toEqual([]);
      expect(await s.setStatus(a.id, 'done', null, ['planned', 'running'])).toBe(false);
      await s.failAttempt(a.id);
      expect(await s.setStatus(a.id, 'planned', null, ['paused'])).toBe(true);
      expect(await s.get(a.id)).toMatchObject({ status: 'planned', attempts: 0, last_error: null });
      await expect(s.setStatus(a.id, 'failed', 'Provider said: no', ['planned'])).rejects.toThrow(/fixed code/);
      expect(await s.setStatus(a.id, 'aborted', null, ['planned'])).toBe(true);
      expect(await s.runnable()).toEqual([]);
    });
    const { rows } = await h.t.admin.query(
      'SELECT started_at IS NOT NULL AS started, finished_at IS NOT NULL AS finished FROM backfill_job WHERE range_from = $1',
      [from],
    );
    expect(rows).toEqual([{ started: true, finished: true }]);
  });

  it('cannot touch the budget or the loader counts, nor read obs', async () => {
    await slotFree();
    const c = await h.t.connectAs('rws_backfill');
    try {
      expect(await sqlState(c, 'UPDATE backfill_job SET request_budget = 1000')).toBe('42501');
      expect(await sqlState(c, 'UPDATE backfill_job SET inserted = 0')).toBe('42501');
      expect(await sqlState(c, 'UPDATE backfill_job SET unreconciled = 0')).toBe('42501');
      expect(await sqlState(c, 'SELECT 1 FROM obs LIMIT 1')).toBe('42501');
      expect(await sqlState(c, 'SELECT 1 FROM backfill_chunk LIMIT 1')).toBe('42501');
      expect(await sqlState(c, 'DELETE FROM backfill_job')).toBe('42501');
    } finally {
      await c.end();
    }
  });

  it('backfill_guard: loader_lag, backlog, unloaded, stale and ok', async () => {
    const verdict = () => withStore((s) => s.guard('NL-1'));
    await h.t.admin.query("DELETE FROM app_meta WHERE key = 'loader'");
    expect(await verdict()).toBe('loader_lag');
    // A loader row without computed_at fails closed (review S5).
    await h.t.admin.query(
      `INSERT INTO app_meta (key, value) VALUES ('loader', '{"backlog_age_s": 0, "backlog_files": 0}')`,
    );
    expect(await verdict()).toBe('loader_lag');
    await setGuard({ computed: '6 min' });
    expect(await verdict()).toBe('loader_lag');
    await setGuard({ files: 4 });
    expect(await verdict()).toBe('backlog');
    await setGuard({ status: 'degraded' });
    expect(await verdict()).toBe('stale');
    await h.t.admin.query("DELETE FROM source_health WHERE source_id = 'NL-1'");
    expect(await verdict()).toBe('stale');
    await setGuard();
    expect(await verdict()).toBe('ok');
    // More than 30 chunks of an active job with data that the ledger does not hold (unloaded or quarantined; review
    // C5/S6, N1): its own verdict. 30 is a loader that ticks every 10 s while the runner writes 1 chunk/s.
    const { rows } = await h.t.admin.query<{ id: string; n: number; status: string }>(
      `SELECT j.id, j.status, j.chunks_with_data - (SELECT count(*) FROM backfill_chunk c WHERE c.job_id = j.id)::int AS n
       FROM backfill_job j WHERE j.source_id = 'NL-1' ORDER BY j.id LIMIT 1`,
    );
    const { id, n, status } = rows[0] as { id: string; n: number; status: string };
    const setBehind = (k: number) =>
      h.t.admin.query('UPDATE backfill_job SET chunks_with_data = chunks_with_data + $2 WHERE id = $1', [id, k]);
    await setBehind(31 - n);
    await h.t.admin.query("UPDATE backfill_job SET status = 'running' WHERE id = $1", [id]);
    expect(await verdict()).toBe('unloaded');
    // A paused job still counts, an aborted or failed one (quarantined chunks of a dead job) does not (review N4).
    await h.t.admin.query("UPDATE backfill_job SET status = 'paused' WHERE id = $1", [id]);
    expect(await verdict()).toBe('unloaded');
    for (const dead of ['aborted', 'failed', 'done']) {
      await h.t.admin.query('UPDATE backfill_job SET status = $2 WHERE id = $1', [id, dead]);
      expect(await verdict(), dead).toBe('ok');
    }
    await h.t.admin.query('UPDATE backfill_job SET status = $2 WHERE id = $1', [id, status]);
    // Precedence: a lagging loader or a long backlog says so first.
    await setGuard({ files: 4 });
    expect(await verdict()).toBe('backlog');
    await setGuard();
    await setBehind(-1);
    expect(await verdict()).toBe('ok');
    await setBehind(-(30 - n));
  });

  it('advance counts a chunk with data in the same update as the cursor', async () => {
    const f = new Date('1998-01-01T00:00:00Z');
    const { id } = await plan(f, new Date('1998-03-01T00:00:00Z'));
    await withStore(async (s) => {
      await s.advance(id, { cursor_ts: new Date('1998-02-10T00:00:00Z'), chunk: true, data: true });
      await s.advance(id, { cursor_ts: new Date('1998-03-01T00:00:00Z'), chunk: true });
      expect(await s.get(id)).toMatchObject({ chunks_done: 2, chunks_with_data: 1 });
    });
  });
});

describe('one runner per host: the lease (review C1/S1)', { timeout: 60_000 }, () => {
  const HOST = CONFIG.specs[0]?.host as string;

  it('a second runner is busy while the first holds the lease; after it lapses, the second proceeds', async () => {
    await lapse();
    const { id } = await plan(new Date('1997-01-01T00:00:00Z'), new Date('1997-02-01T00:00:00Z'));
    // The first runner (another process: its own holder id) takes the lease and is still running.
    expect(await withStore((s) => s.lease(HOST, 'aaaaaaaa-0000-0000-0000-000000000001'))).toBe(true);
    await setGuard();
    const clock = new Clock(NIGHT);
    const { client, calls } = fakeClient(clock, history);
    const second = () =>
      withStore((store) =>
        runBackfill({
          config: CONFIG,
          store,
          archive: h.archive,
          client,
          now: clock.now,
          sleep: clock.sleep,
          holder: 'bbbbbbbb-0000-0000-0000-000000000002',
        }),
      );
    expect((await second()).stopped).toBe('busy');
    expect(calls).toHaveLength(0);
    expect((await job(id)).status).toBe('planned');
    // The first one's own renewal keeps it; another holder cannot take it, and cannot give it back either.
    expect(await withStore((s) => s.lease(HOST, 'aaaaaaaa-0000-0000-0000-000000000001'))).toBe(true);
    await withStore((s) => s.release(HOST, 'bbbbbbbb-0000-0000-0000-000000000002'));
    expect(await leaseHeld()).toBe(true);
    // Two minutes later (made to lapse now) the second runner proceeds, and gives the lease back at exit.
    await lapse();
    expect((await second()).stopped).toBe('done');
    expect((await job(id)).status).toBe('done');
    expect(await leaseHeld()).toBe(false);
    const { rows } = await h.t.admin.query<{ holder: string }>('SELECT holder FROM backfill_lease');
    expect(rows).toEqual([{ holder: 'bbbbbbbb-0000-0000-0000-000000000002' }]);
  });

  it('rws_backfill may not delete a lease', async () => {
    await slotFree();
    const c = await h.t.connectAs('rws_backfill');
    try {
      expect(await sqlState(c, 'DELETE FROM backfill_lease')).toBe('42501');
    } finally {
      await c.end();
    }
  });
});
