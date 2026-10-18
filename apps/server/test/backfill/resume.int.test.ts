import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { dayInstant } from '../../src/adapters/fr-2/normalise.ts';
import { type Job, SqlJobStore } from '../../src/backfill/job.ts';
import { jobBudget, planChunks, probeYears, requestBudget } from '../../src/backfill/plan.ts';
import { DB_BYTES_PER_ROW } from '../../src/backfill/project.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import { type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { seriesOf } from '../../src/load/store.ts';
import { sqlState } from '../db/testdb.ts';
import { type Harness, harness } from '../load/harness.ts';
import {
  type ArchiveName,
  type ArchiveScenario,
  archiveClient,
  archiveScenario,
  type Call,
  Clock,
  ch9Cm,
  FR2_TRUNCATED_FROM,
  fakeClient,
  fr2Value,
  history,
  historyBody,
  LOBITH_H,
  NIGHT,
  narrowed,
  SPEC,
} from './harness.ts';

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
 * stops a runner with any chunk with data ahead of the ledger: review S6, the P14a queue fix); returns its requests
 * and the lines loaded meanwhile.
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
      // The loader runs beside the runner, as in production: a sleep (the pacer's, the guard's) lets it tick, so a
      // chunk that a killed runner left unloaded is loaded while the guard holds the new one.
      sleep: async (ms) => {
        loaded += (await load()).loaded;
        await clock.sleep(ms);
      },
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

// ----------------------------------------------------------- P14b: the open archives (DE-8, FR-2, CH-9)
// The same kill -9 and resume, per committed open-archive spec, through the real Client over msw at the providers' real
// URLs (archiveScenario in harness.ts): DE-8 dies on a slice after the first of a decade file that the first fetch
// serves by reuse (after the restart the file is fetched once more, a second archive object); FR-2 dies during a
// halving (a 206 page, then its halves); CH-9 dies on a chunk. After the restart every row the provider stated is in
// obs once (the series of the target source), with no gap, every ledger row reconciles and its chunks tile the job's
// range, and a second job over the same history writes 0 new and 0 revised.

/** The target series a scenario's rows go to. */
const TARGET_KEYS: Record<ArchiveName, readonly string[]> = {
  'de-8': ['2829100000100/W'],
  'fr-2': ['A850061001/QmnJ'],
  'ch-9': ['2289/W', '2289/Q'],
};

/** What the provider stated for the job's range, as the target series would store it: key → [ts, value][]. */
async function expectedRows(s: ArchiveScenario, to = s.to): Promise<Map<string, [number, number][]>> {
  const out = new Map<string, [number, number][]>(TARGET_KEYS[s.name].map((k) => [k, []]));
  const push = (k: string, ts: number, v: number) => out.get(k)?.push([ts, v]);
  if (s.name === 'de-8') {
    // The real wire over the decade file, windowed to the job (what every slice together states).
    const wire = LOAD_ADAPTERS['DE-8']?.specs['de-8-backfill-w'];
    const body = s.answer(new URL(`${s.spec.url}Rureinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip`)).body;
    const res = await wire?.run(body, {
      registry: await seriesOf(h.load.db, 'DE-7'),
      fetchedAt: NIGHT,
      variant: '',
      unitMismatch: new Set(),
      backfill: { from: s.from.getTime(), to: to.getTime() },
    });
    for (const r of res?.obs ?? []) push(r.series, Date.parse(r.ts), r.value);
  } else if (s.name === 'fr-2') {
    for (let t = s.from.getTime(); t < to.getTime(); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      push('A850061001/QmnJ', dayInstant(d), fr2Value(d) / 1000);
    }
  } else {
    for (let t = s.from.getTime(); t < to.getTime(); t += 600_000) {
      push('2289/W', t, 24_000 + ch9Cm(t));
      push('2289/Q', t, 800 + ((t / 300_000) % 13));
    }
  }
  return out;
}

/**
 * The target series' rows in the job's range: key → [ts, value][], and how many are not backfill rows. From a day
 * before it: an FR-2 day before 2007-03-23 starts at the Paris midnight, an hour or two before the UTC day asked.
 */
async function storedRows(s: ArchiveScenario) {
  const out = new Map<string, [number, number][]>();
  let live = 0;
  for (const key of TARGET_KEYS[s.name]) {
    const { rows } = await h.t.admin.query<{ ts: Date; value: number; qc: number }>(
      `SELECT o.ts, o.value, o.qc FROM obs o JOIN series s ON s.id = o.series_id
       WHERE s.provider_key = $1 AND o.ts >= $2 AND o.ts < $3 ORDER BY o.ts`,
      [key, new Date(s.from.getTime() - 86_400_000), s.to],
    );
    out.set(
      key,
      rows.map((r) => [r.ts.getTime(), r.value]),
    );
    live += rows.filter((r) => (r.qc & 512) === 0).length;
  }
  return { rows: out, live };
}

/** The instants one side has and the other lacks, per series (ISO, at most 5 each): a readable failure. */
const gapsBetween = (got: Map<string, [number, number][]>, want: Map<string, [number, number][]>) =>
  Object.fromEntries(
    [...want].map(([k, w]) => {
      const g = new Set((got.get(k) ?? []).map(([ts]) => ts));
      const e = new Set(w.map(([ts]) => ts));
      const iso = (xs: number[]) => xs.slice(0, 5).map((t) => new Date(t).toISOString());
      return [k, { missing: iso([...e].filter((t) => !g.has(t))), extra: iso([...g].filter((t) => !e.has(t))) }];
    }),
  );
const NO_GAPS = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, { missing: [], extra: [] }]));

/** float32, as obs.value holds it. */
const f32 = (m: Map<string, [number, number][]>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.map(([ts, x]) => [ts, Math.fround(x)])]));

/** A clean slate for the next case: the target series' rows and the scenario's jobs and ledger rows go. */
async function clearArchive(s: ArchiveScenario) {
  for (const table of ['obs_revision', 'obs_latest', 'obs_1h', 'obs_1d', 'obs'])
    await h.t.admin.query(
      `DELETE FROM ${table} WHERE series_id IN (SELECT id FROM series WHERE provider_key = ANY($1))`,
      [TARGET_KEYS[s.name]],
    );
  await h.t.admin.query('DELETE FROM backfill_chunk WHERE job_id IN (SELECT id FROM backfill_job WHERE spec_id = $1)', [
    s.spec.id,
  ]);
  await h.t.admin.query('DELETE FROM backfill_job WHERE spec_id = $1', [s.spec.id]);
}

const setHealth = (source: string) =>
  h.t.admin.query(
    `INSERT INTO source_health (source_id, status) VALUES ($1, 'ok')
     ON CONFLICT (source_id) DO UPDATE SET status = EXCLUDED.status`,
    [source],
  );

async function planArchive(s: ArchiveScenario, to = s.to): Promise<number> {
  const { id } = await withStore((store) =>
    store.insert({
      spec_id: s.spec.id,
      source_id: s.spec.source,
      series_key: s.unit,
      range_from: s.from,
      range_to: to,
      chunk_ms: s.spec.chunk_ms,
      request_budget: jobBudget(s.from, to, s.spec.chunk_ms, false),
    }),
  );
  return id;
}

/** The in-process runner of a scenario, the loader keeping up as in `run` above. */
async function runArchive(s: ArchiveScenario, start: number): Promise<{ calls: Call[]; loaded: number }> {
  await setGuard();
  await setHealth(s.target);
  const clock = new Clock(start);
  const { client, calls, handlers } = archiveClient(clock, s);
  server.use(...handlers);
  let loaded = 0;
  const out = await withStore((store) =>
    runBackfill({
      config: s.config,
      store,
      archive: h.archive,
      client,
      now: clock.now,
      sleep: async (ms) => {
        loaded += (await load()).loaded;
        await clock.sleep(ms);
      },
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

/** A job's manifest lines: their archive keys and chunks. */
const jobLines = (id: number) =>
  readdirSync(join(h.raw, '_manifest'))
    .sort()
    .flatMap((f) =>
      readFileSync(join(h.raw, '_manifest', f), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l))
        .filter((l) => l.backfill?.job === id),
    ) as { key: string; backfill: { from: string; to: string } }[];

async function killAndResumeArchive(name: ArchiveName, point: Point, nth: number) {
  const s = archiveScenario(name);
  await clearArchive(s);
  const id = await planArchive(s);
  await setGuard();
  await slotFree();
  const child = spawnSync(
    process.execPath,
    ['--no-experimental-webstorage', CHILD, h.t.urlFor('rws_backfill'), h.raw, point, String(nth), String(NIGHT), name],
    { timeout: 60_000 },
  );
  expect(child.signal, child.stderr.toString()).toBe('SIGKILL');
  const before = JSON.parse(child.stdout.toString()) as Call[];
  expect((await job(id)).status).toBe('running');
  expect(await leaseHeld()).toBe(true);
  await lapse();

  const alerts = h.alerts.length;
  const { calls: after, loaded } = await run2(s);
  expect(loaded + (await load()).loaded).toBeGreaterThan(0);
  expect(h.alerts.slice(alerts)).toEqual([]);

  // Every row the provider stated, once, with no gap: the stored rows are exactly the expected ones, all backfill.
  const want = await expectedRows(s);
  const got = await storedRows(s);
  expect(got.live).toBe(0);
  expect(gapsBetween(got.rows, want)).toEqual(NO_GAPS(TARGET_KEYS[name]));
  expect(f32(got.rows)).toEqual(f32(want));
  const n = [...want.values()].reduce((a, v) => a + v.length, 0);
  expect(n).toBeGreaterThan(0);

  const done = await job(id);
  expect(done).toMatchObject({ status: 'done', inserted: n, revised: 0, unreconciled: 0, last_error: null });
  expect(done.cursor_ts).toEqual(s.to);
  // Every request counted (the one a kill interrupts inside the fetch is not), within the budget, paced per host.
  expect(done.requests).toBe(before.length + after.length - (point === 'fetch' ? 1 : 0));
  expect(done.requests).toBeLessThanOrEqual(s.budget);
  for (const g of [...gaps(before), ...gaps(after)]) expect(g).toBeGreaterThanOrEqual(s.spec.limits.min_interval_ms);

  // The ledger: every row reconciled, and its distinct chunks tile the range with no gap and no overlap.
  const l = await ledger(id);
  expect(l.every((r) => r.reconciled)).toBe(true);
  const { rows: chunks } = await h.t.admin.query<{ chunk_from: Date; chunk_to: Date }>(
    'SELECT DISTINCT chunk_from, chunk_to FROM backfill_chunk WHERE job_id = $1 ORDER BY chunk_from',
    [id],
  );
  expect(chunks[0]?.chunk_from).toEqual(s.from);
  expect(chunks.at(-1)?.chunk_to).toEqual(s.to);
  for (let i = 1; i < chunks.length; i += 1) expect(chunks[i]?.chunk_from).toEqual(chunks[i - 1]?.chunk_to);
  console.info(
    `${name} ${point} ${nth}: requests ${before.length} + ${after.length}, ledger ${l.length} rows over ${chunks.length} chunks, ${n} rows`,
  );
  return { s, id, before, after, ledger: l, chunks, lines: jobLines(id) };
}
const run2 = (s: ArchiveScenario) => runArchive(s, NIGHT + HOUR);

/** A second job over the same history (a range of its own): 0 new, 0 revised, the same obs. */
async function rerunArchive(s: ArchiveScenario) {
  const to = new Date(s.to.getTime() - 1000);
  const id = await planArchive(s, to);
  const sums = await h.checksums();
  const revisions = await h.count('obs_revision');
  const { calls } = await runArchive(s, NIGHT + 3 * HOUR);
  expect(await job(id)).toMatchObject({ status: 'done', inserted: 0, revised: 0, unreconciled: 0 });
  const l = await ledger(id);
  expect(l.length).toBeGreaterThan(0);
  for (const r of l) expect(r).toMatchObject({ inserted: 0, revised: 0, skipped: r.kept, reconciled: true });
  expect(await h.count('obs_revision')).toBe(revisions);
  expect(await h.checksums()).toEqual(sums);
  return { calls, ledger: l };
}

describe('kill -9 and resume of the open archives (P14b)', { timeout: 300_000 }, () => {
  // The lease test below counts the lease rows of the RWS host alone.
  afterAll(() =>
    h.t.admin.query('DELETE FROM backfill_lease WHERE host = ANY($1)', [
      ['www.opengeodata.nrw.de', 'hubeau.eaufrance.fr', 'data.bs.ch'],
    ]),
  );

  it.each([
    ['afterPut', 6],
    ['afterAppend', 7],
    ['afterCursor', 6],
  ] as const)(
    'DE-8 %s on the second slice of a reused decade file: one more fetch, a second object, rows once',
    async (point, rows) => {
      const r = await killAndResumeArchive('de-8', point, 2);
      // The child's one fetch served slice 1 and 2 (reuse); the restarted runner has no answer kept and fetches again.
      expect(r.before).toHaveLength(1);
      expect(r.after).toHaveLength(1);
      expect(r.chunks).toHaveLength(6);
      expect(r.ledger).toHaveLength(rows);
      // Two archive objects of the one file: the child's (its slices on one key) and the restart's.
      const keys = [...new Set(r.lines.map((l) => l.key))];
      expect(keys).toHaveLength(2);
      for (const k of keys) expect(existsSync(join(h.raw, k.slice('raw/'.length)))).toBe(true);
      if (point === 'afterAppend') {
        const twice = r.ledger.filter((x) => x.chunk_from.getTime() === r.chunks[1]?.chunk_from.getTime());
        expect(twice).toHaveLength(2);
        expect(twice[1]).toMatchObject({ inserted: 0, revised: 0, skipped: twice[0]?.kept });
      }
    },
  );

  it('DE-8: a second job over the same history fetches the file once and changes nothing', async () => {
    const { calls, ledger: l } = await rerunArchive(archiveScenario('de-8'));
    expect(calls).toHaveLength(1);
    expect(l).toHaveLength(6);
  });

  it('FR-2 killed inside the first half after a 206: the restart halves again and loads every day once', async () => {
    const r = await killAndResumeArchive('fr-2', 'fetch', 21);
    // 19 whole chunks and the 206 before the kill; after it the 206 again and both halves.
    expect(r.before).toHaveLength(21);
    expect(r.after).toHaveLength(3);
    expect(new URL(r.after[0]?.url as string).searchParams.get('date_debut_obs_elab')).toBe(FR2_TRUNCATED_FROM);
    expect(r.chunks).toHaveLength(21);
    expect(r.ledger).toHaveLength(21);
  });

  it('FR-2 killed after the first half’s line: that half loads twice, the second time 0 new and 0 revised', async () => {
    const r = await killAndResumeArchive('fr-2', 'afterAppend', 20);
    expect(r.before).toHaveLength(21);
    expect(r.after).toHaveLength(3);
    expect(r.chunks).toHaveLength(21);
    expect(r.ledger).toHaveLength(22);
    const half = r.ledger.filter((x) => x.chunk_from.getTime() === Date.parse(`${FR2_TRUNCATED_FROM}T00:00:00Z`));
    expect(half).toHaveLength(2);
    expect(half[1]).toMatchObject({ inserted: 0, revised: 0, skipped: half[0]?.kept });
  });

  it('FR-2: a second job over the same history changes nothing', async () => {
    const { calls } = await rerunArchive(archiveScenario('fr-2'));
    expect(calls).toHaveLength(22);
  });

  it('FR-2: a halving of an odd number of days loses no day (the halves meet at a day boundary)', async () => {
    // The last chunk is 201 days, so its halves are 100.5 days: the second starts at noon.
    const base = archiveScenario('fr-2');
    const s = { ...base, to: new Date(base.from.getTime() + (19 * 400 + 201) * 86_400_000) };
    s.budget = jobBudget(s.from, s.to, s.spec.chunk_ms, false);
    await clearArchive(s);
    const id = await planArchive(s);
    const { calls } = await runArchive(s, NIGHT + 2 * HOUR);
    expect(calls).toHaveLength(22);
    expect((await job(id)).status).toBe('done');
    const want = await expectedRows(s);
    const got = await storedRows(s);
    expect(gapsBetween(got.rows, want)).toEqual(NO_GAPS(TARGET_KEYS['fr-2']));
    expect(f32(got.rows)).toEqual(f32(want));
    await clearArchive(s);
  });

  it('CH-9 killed after the second chunk’s line: fetched twice, loaded once', async () => {
    const r = await killAndResumeArchive('ch-9', 'afterAppend', 2);
    expect(r.before).toHaveLength(2);
    expect(r.after).toHaveLength(2);
    expect(r.chunks).toHaveLength(3);
    expect(r.ledger).toHaveLength(4);
  });

  it('CH-9: a second job over the same history changes nothing', async () => {
    const { calls } = await rerunArchive(archiveScenario('ch-9'));
    expect(calls).toHaveLength(3);
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
    // P14b: with a target (DE-8 → DE-7) `stale` judges the target's health; a missing row is stale, never ok.
    const health = (id: string, status: string) =>
      h.t.admin.query(
        `INSERT INTO source_health (source_id, status) VALUES ($1, $2)
         ON CONFLICT (source_id) DO UPDATE SET status = EXCLUDED.status`,
        [id, status],
      );
    await h.t.admin.query("DELETE FROM source_health WHERE source_id IN ('DE-7', 'DE-8')");
    const de8 = (target?: string) => withStore((s) => s.guard('DE-8', target));
    expect(await de8('DE-7')).toBe('stale');
    await health('DE-7', 'degraded');
    expect(await de8('DE-7')).toBe('stale');
    await health('DE-7', 'ok');
    expect(await de8('DE-7')).toBe('ok');
    expect(await de8()).toBe('stale');
    await health('DE-8', 'ok');
    await health('DE-7', 'down');
    expect(await de8('DE-7')).toBe('stale');
    await setGuard({ files: 4 });
    expect(await de8('DE-7')).toBe('backlog');
    await setGuard();
    await h.t.admin.query("DELETE FROM source_health WHERE source_id IN ('DE-7', 'DE-8')");
    // Any chunk of an active job with data that the ledger does not hold yet (review C5/S6, N1; the P14a queue fix
    // lowered it from more than 30): its own verdict. A chunk the loader sets aside has a ledger row too.
    const { rows } = await h.t.admin.query<{ id: string; n: number; status: string }>(
      `SELECT j.id, j.status, j.chunks_with_data - (SELECT count(*) FROM backfill_chunk c WHERE c.job_id = j.id)::int AS n
       FROM backfill_job j WHERE j.source_id = 'NL-1' ORDER BY j.id LIMIT 1`,
    );
    const { id, n, status } = rows[0] as { id: string; n: number; status: string };
    const setBehind = (k: number) =>
      h.t.admin.query('UPDATE backfill_job SET chunks_with_data = chunks_with_data + $2 WHERE id = $1', [id, k]);
    await setBehind(1 - n);
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
    await setBehind(n);
  });

  it('advance counts a chunk with data in the same update as the cursor', async () => {
    const f = new Date('1998-01-01T00:00:00Z');
    const { id } = await plan(f, new Date('1998-03-01T00:00:00Z'));
    await withStore(async (s) => {
      await s.advance(id, { cursor_ts: new Date('1998-02-10T00:00:00Z'), chunk: true, data: true });
      await s.advance(id, { cursor_ts: new Date('1998-03-01T00:00:00Z'), chunk: true });
      expect(await s.get(id)).toMatchObject({ chunks_done: 2, chunks_with_data: 1 });
      // Its chunk was never archived, so the loader never loads it: out of the guard's count, or every later runner
      // in this file waits for it and stops `stuck` (the guard allows no unloaded chunk, review Q1).
      expect(await s.setStatus(id, 'aborted', null, ['planned'])).toBe(true);
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
          // The loader ticks during the runner's sleeps, as beside it in production: a finished job waits for its
          // last chunk (review Q2).
          sleep: async (ms) => {
            await load();
            await clock.sleep(ms);
          },
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

describe('a chunk the loader sets aside (P14a queue fix)', { timeout: 60_000 }, () => {
  /** A job's manifest lines as the loader names them: the file, the end offset (after the newline) and the key. */
  const linesOf = (id: number) =>
    readdirSync(join(h.raw, '_manifest'))
      .sort()
      .flatMap((file) => {
        const buf = readFileSync(join(h.raw, '_manifest', file));
        const out: { file: string; end: number; key: string }[] = [];
        for (let start = 0, nl = buf.indexOf(10); nl >= 0; start = nl + 1, nl = buf.indexOf(10, start)) {
          const l = JSON.parse(buf.toString('utf8', start, nl));
          if (l.backfill?.job === id) out.push({ file, end: nl + 1, key: l.key });
        }
        return out;
      });
  /** What the guard compares, for one job: chunks with data the ledger does not hold. */
  const unloaded = async (id: number) =>
    (
      await h.t.admin.query<{ n: number }>(
        `SELECT j.chunks_with_data - (SELECT count(DISTINCT c.chunk_from) FROM backfill_chunk c WHERE c.job_id = j.id)::int AS n
         FROM backfill_job j WHERE j.id = $1`,
        [id],
      )
    ).rows[0]?.n;
  const objectOf = (key: string) => join(h.raw, key.slice('raw/'.length));

  // The first chunk is spoiled before the loader reads it, in each of the three ways a line is set aside.
  const spoil = {
    // The setAside closure, skipped: the object is gone.
    object_missing: async (l: { key: string }) => rmSync(objectOf(l.key)),
    // The setAside closure, quarantined: the object no longer inflates.
    archive_corrupt: async (l: { key: string }) => writeFileSync(objectOf(l.key), 'not zstd'),
    // The tail's MAX_TRIES branch: two passes already failed, so it is quarantined unread.
    load_error: async (l: { file: string; end: number }) =>
      h.t.admin.query(
        `INSERT INTO app_meta (key, value) VALUES ('load_attempt', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify({ file: l.file, end: l.end, n: 2, code: 'load_error' })],
      ),
  };

  it.each([
    ['object_missing', 2006, 'skipped'],
    ['archive_corrupt', 2007, 'quarantined'],
    ['load_error', 2008, 'quarantined'],
  ] as const)(
    '%s: an unreconciled ledger row, nothing left unloaded, the job fails unreconciled',
    async (how, year, status) => {
      const { from, to } = range(year);
      const { id } = await plan(from, to);
      await setGuard();
      const clock = new Clock(NIGHT);
      const { client } = fakeClient(clock, history);
      let first = true;
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
              if (first) {
                const lines = linesOf(id);
                expect(lines).toHaveLength(1);
                await spoil[how](lines[0] as { file: string; end: number; key: string });
              }
              first = false;
              await load();
            },
          },
        }),
      );
      const [line] = linesOf(id);
      const { rows } = await h.t.admin.query<{ parse_status: string; error: string }>(
        'SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1',
        [line?.key],
      );
      expect(rows).toEqual([{ parse_status: status, error: how }]);
      expect(out.jobs.find((j) => j.job === id)).toMatchObject({ status: 'failed', error: 'unreconciled' });
      expect(await job(id)).toMatchObject({
        status: 'failed',
        last_error: 'unreconciled',
        unreconciled: 1,
        inserted: 0,
        chunks_with_data: 1,
      });
      expect(await ledger(id)).toMatchObject([{ kept: 0, inserted: 0, revised: 0, skipped: 0, reconciled: false }]);
      // The guard's own count: nothing of the job is left to wait for (it would be 1 without the ledger row).
      expect(await unloaded(id)).toBe(0);
      expect(await stored(from, to)).toEqual([]);
    },
  );

  it('counts a chunk fetched again after a kill once (distinct chunk start, review Q2)', async () => {
    const { from, to } = range(2009);
    const { id } = await plan(from, to);
    await setGuard();
    const { rows } = await h.t.admin.query<{ n: number }>(
      `WITH j AS (UPDATE backfill_job SET chunks_with_data = 1, status = 'running' WHERE id = $1 RETURNING id)
       INSERT INTO backfill_chunk (job_id, archive_key, chunk_from, chunk_to, provider_values, kept, inserted, revised,
                                   skipped, dropped, reconciled)
       SELECT j.id, k, $2, $3, 0, 0, 0, 0, 0, 0, true FROM j, unnest(ARRAY['raw/a', 'raw/b']) AS k
       RETURNING 1 AS n`,
      [id, from, new Date(from.getTime() + CHUNK_MS)],
    );
    expect(rows).toHaveLength(2);
    expect(await unloaded(id)).toBe(0);
    // One more chunk with data and no ledger row: the guard holds the runner again.
    await h.t.admin.query('UPDATE backfill_job SET chunks_with_data = 2 WHERE id = $1', [id]);
    expect(await withStore((s) => s.guard('NL-1'))).toBe('unloaded');
    await h.t.admin.query("UPDATE backfill_job SET status = 'aborted' WHERE id = $1", [id]);
    expect(await withStore((s) => s.guard('NL-1'))).toBe('ok');
  });
});
