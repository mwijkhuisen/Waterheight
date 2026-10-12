import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';

// The job table as the runner sees it (P14a): SQL as the `rws_backfill` role, which can SELECT and INSERT
// `backfill_job`, UPDATE only the progress columns, and call `backfill_guard`. The loader keeps the counters
// (provider_values … unreconciled); the runner only reads them. Parameterised `sql` templates only (invariant 2).
// The runner takes this as an interface so that the unit tests run on an in-memory store.

export const STATUSES = ['planned', 'running', 'paused', 'done', 'failed', 'aborted'] as const;
export type JobStatus = (typeof STATUSES)[number];
export type GuardVerdict = 'ok' | 'loader_lag' | 'backlog' | 'stale';
/** `last_error`: a fixed code, never provider text (the column's CHECK). */
export const ERROR_CODE = /^[a-z_]{1,40}$/;

export type NewJob = {
  spec_id: string;
  source_id: string;
  series_key: string;
  range_from: Date;
  range_to: Date;
  chunk_ms: number;
  request_budget: number;
};

export type Job = Omit<NewJob, 'request_budget'> & {
  id: number;
  data_from: Date | null;
  /** End of the last committed chunk (range_from at creation). */
  cursor_ts: Date;
  chunks_done: number;
  status: JobStatus;
  attempts: number;
  request_budget: number;
  requests: number;
  provider_values: number;
  inserted: number;
  revised: number;
  skipped: number;
  dropped: number;
  unreconciled: number;
  last_error: string | null;
};

export interface JobStore {
  /** Idempotent on (spec_id, series_key, range_from, range_to): an existing job is returned, not created. */
  insert(job: NewJob): Promise<{ id: number; created: boolean }>;
  get(id: number): Promise<Job | undefined>;
  list(): Promise<Job[]>;
  /** Jobs the runner may work on (`planned`, or `running` after a crash), in id order. */
  runnable(): Promise<Job[]>;
  /** `running`, and `started_at` once. */
  start(id: number): Promise<void>;
  /** One request is about to go out (counts against `request_budget`). */
  addRequest(id: number): Promise<void>;
  /** A transient failure: `attempts` + 1, returned. */
  failAttempt(id: number): Promise<number>;
  /** Moves the cursor (and sets `data_from` after the probe); `chunk` counts a committed chunk. Resets `attempts`. */
  advance(id: number, a: { cursor_ts: Date; data_from?: Date; chunk: boolean }): Promise<void>;
  /**
   * Sets the status (and `last_error`) if the job is in one of `only`; false when it is not (changed meanwhile).
   * `done`, `failed` and `aborted` set `finished_at`; `planned` clears `attempts` and `last_error`.
   */
  setStatus(id: number, to: JobStatus, error: string | null, only: readonly JobStatus[]): Promise<boolean>;
  guard(source: string): Promise<GuardVerdict>;
}

type Row = {
  id: number;
  spec_id: string;
  source_id: string;
  series_key: string;
  range_from: Date;
  range_to: Date;
  chunk_ms: number;
  data_from: Date | null;
  cursor_ts: Date;
  chunks_done: number;
  status: JobStatus;
  attempts: number;
  request_budget: number;
  requests: number;
  provider_values: number;
  inserted: number;
  revised: number;
  skipped: number;
  dropped: number;
  unreconciled: number;
  last_error: string | null;
};

// bigint counters come back as numbers through ::float8 (they stay far below 2^53).
const COLUMNS = sql`id::float8 AS id, spec_id, source_id, series_key, range_from, range_to,
  (extract(epoch from chunk) * 1000)::float8 AS chunk_ms, data_from, cursor_ts, chunks_done, status, attempts,
  request_budget, requests, provider_values::float8 AS provider_values, inserted::float8 AS inserted,
  revised::float8 AS revised, skipped::float8 AS skipped, dropped::float8 AS dropped, unreconciled, last_error`;

export class SqlJobStore implements JobStore {
  private readonly db: Kysely<DB>;
  constructor(db: Kysely<DB>) {
    this.db = db;
  }

  async insert(j: NewJob): Promise<{ id: number; created: boolean }> {
    const secs = j.chunk_ms / 1000;
    const made = await sql<{ id: number }>`
      INSERT INTO backfill_job (spec_id, source_id, series_key, range_from, range_to, chunk, cursor_ts, request_budget)
      VALUES (${j.spec_id}, ${j.source_id}, ${j.series_key}, ${j.range_from}, ${j.range_to},
              make_interval(secs => ${secs}::float8), ${j.range_from}, ${j.request_budget})
      ON CONFLICT (spec_id, series_key, range_from, range_to) DO NOTHING
      RETURNING id::float8 AS id`.execute(this.db);
    if (made.rows[0] !== undefined) return { id: made.rows[0].id, created: true };
    const old = await sql<{ id: number }>`
      SELECT id::float8 AS id FROM backfill_job
      WHERE spec_id = ${j.spec_id} AND series_key = ${j.series_key}
        AND range_from = ${j.range_from} AND range_to = ${j.range_to}`.execute(this.db);
    const id = old.rows[0]?.id;
    if (id === undefined) throw new Error('backfill_job: insert found no row');
    return { id, created: false };
  }

  async get(id: number): Promise<Job | undefined> {
    const r = await sql<Row>`SELECT ${COLUMNS} FROM backfill_job WHERE id = ${id}`.execute(this.db);
    return r.rows[0];
  }

  async list(): Promise<Job[]> {
    return (await sql<Row>`SELECT ${COLUMNS} FROM backfill_job ORDER BY id`.execute(this.db)).rows;
  }

  async runnable(): Promise<Job[]> {
    return (
      await sql<Row>`SELECT ${COLUMNS} FROM backfill_job WHERE status IN ('planned', 'running') ORDER BY id`.execute(
        this.db,
      )
    ).rows;
  }

  async start(id: number): Promise<void> {
    await sql`UPDATE backfill_job SET status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
      WHERE id = ${id} AND status IN ('planned', 'running')`.execute(this.db);
  }

  async addRequest(id: number): Promise<void> {
    await sql`UPDATE backfill_job SET requests = requests + 1, updated_at = now() WHERE id = ${id}`.execute(this.db);
  }

  async failAttempt(id: number): Promise<number> {
    const r = await sql<{ attempts: number }>`UPDATE backfill_job SET attempts = attempts + 1, updated_at = now()
      WHERE id = ${id} RETURNING attempts`.execute(this.db);
    return r.rows[0]?.attempts ?? 0;
  }

  async advance(id: number, a: { cursor_ts: Date; data_from?: Date; chunk: boolean }): Promise<void> {
    const more = a.chunk ? 1 : 0;
    const dataFrom = a.data_from ?? null;
    await sql`UPDATE backfill_job SET cursor_ts = ${a.cursor_ts}, chunks_done = chunks_done + ${more}, attempts = 0,
        data_from = coalesce(${dataFrom}::timestamptz, data_from), updated_at = now()
      WHERE id = ${id}`.execute(this.db);
  }

  async setStatus(id: number, to: JobStatus, error: string | null, only: readonly JobStatus[]): Promise<boolean> {
    if (error !== null && !ERROR_CODE.test(error)) throw new Error('backfill_job: last_error is a fixed code');
    const finished = to === 'done' || to === 'failed' || to === 'aborted';
    const r = await sql`UPDATE backfill_job SET status = ${to}, last_error = ${error}, updated_at = now(),
        attempts = CASE WHEN ${to} = 'planned' THEN 0 ELSE attempts END,
        finished_at = CASE WHEN ${finished} THEN now() ELSE finished_at END
      WHERE id = ${id} AND status = ANY(${sql.val([...only])}::text[])`.execute(this.db);
    return Number(r.numAffectedRows ?? 0) > 0;
  }

  async guard(source: string): Promise<GuardVerdict> {
    const r = await sql<{ v: GuardVerdict }>`SELECT backfill_guard(${source}) AS v`.execute(this.db);
    const v = r.rows[0]?.v;
    // A verdict this code does not know is a stop, never an ok.
    return v === 'ok' || v === 'loader_lag' || v === 'backlog' || v === 'stale' ? v : 'stale';
  }
}
