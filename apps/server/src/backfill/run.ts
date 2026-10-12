import { randomUUID } from 'node:crypto';
import { keptHeaders, type ManifestLine, redactUrl } from '../archive/manifest.ts';
import { validate } from '../archive/validity.ts';
import { type Archive, sha256 } from '../archive/writer.ts';
import type { Client } from '../http/client.ts';
import type { ErrorCode, Req } from '../http/types.ts';
import { DATA_EPOCH } from '../load/dirty.ts';
import type { JobStatus, JobStore } from './job.ts';
import { inWindow, Pacer, windowEnd } from './pacer.ts';
import { nextChunk, planChunks, probeYears, requestBudget, yearEnd } from './plan.ts';
import { PROVIDERS, type Provider } from './provider.ts';
import type { LoadedBackfill } from './spec.ts';

// The backfill run loop (P14a, plan §3.3): one-shot, inside the off-peak window, one job at a time in id order.
// Each pass of a job's loop is: window → budget → guard → pace → request → commit. A chunk commits in this order:
// (a) Archive.put, (b) Archive.append (a manifest line that always carries `key`), (c) the cursor update; a kill
// -9 between any two of them resumes at the old cursor, and the second line for the same chunk loads idempotently.
// Only fixed codes reach the job table and the output, never provider text. One runner per host: the run holds the
// host's lease (backfill_lease) from start to exit and renews it before every request (review C1/S1).

export const MAX_ATTEMPTS = 5;
/** The guard said wait (loader not running, backlog, source stale): look again after this long. */
export const GUARD_SLEEP_MS = 5 * 60_000;
/**
 * The guard said `unloaded` (more than 30 chunks archived and not yet loaded): the loader is working through them
 * (it ticks every 10 s), so look again soon rather than after GUARD_SLEEP_MS, which would cost the night (review N1).
 */
export const UNLOADED_SLEEP_MS = 15_000;
/** A truncated response halves the chunk at the cursor, down to this; below it the job fails `truncated` (C3). */
export const MIN_CHUNK_MS = 86_400_000;
const EPOCH_MS = Date.parse(DATA_EPOCH);
/** Client errors returned before anything went out: no request is counted for them (review C6/S4). */
const NOT_SENT: ReadonlySet<ErrorCode> = new Set([
  'bad_url',
  'not_allowlisted',
  'private_address',
  'dns',
  'backoff',
  'breaker_open',
]);

/** Test seams: a child process dies at one of these points. Never set from env or config. */
export type Hooks = {
  afterPut?: () => Promise<void>;
  afterAppend?: () => Promise<void>;
  afterCursor?: () => Promise<void>;
};

export type RunDeps = {
  config: LoadedBackfill;
  store: JobStore;
  archive: Pick<Archive, 'put' | 'append'>;
  client: Pick<Client, 'fetch'>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  hooks?: Hooks;
  providers?: Readonly<Record<string, Provider>>;
  /** This process's lease holder id (default: a random UUID). */
  holder?: string;
};
export type RunOptions = {
  /** No request starts at or after this instant. */
  until?: Date;
  /** Polled at the top of every pass, between two chunks (never between put, append and cursor): true ends the run. */
  stop?: () => boolean;
};
export type JobResult = {
  job: number;
  series: string;
  status: JobStatus;
  chunks: number;
  requests: number;
  error: string | null;
};
/**
 * Why the run ended. `busy`: another runner holds a host's lease. `throttled`: the client backs off past the window
 * after a 403/429/451/5xx or a network failure (an in-memory backoff a restart forgets). `busy`, `throttled` and
 * `breaker_open` exit 1. `interrupted`: the `stop` hook said so (SIGTERM, SIGINT), exit 0.
 */
export type Stopped = 'done' | 'window_closed' | 'until' | 'breaker_open' | 'busy' | 'throttled' | 'interrupted';
export type RunResult = { stopped: Stopped; jobs: JobResult[]; guard_waits: number };

type Step =
  | { kind: 'ok'; res: { status: number; headers: Record<string, string>; body: Buffer }; start: Date; end: Date }
  | { kind: 'retry' }
  | { kind: 'fail'; code: string }
  | { kind: 'truncated' }
  | { kind: 'stop'; stopped: Stopped };

export async function runBackfill(deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
  const providers = deps.providers ?? PROVIDERS;
  const holder = deps.holder ?? randomUUID();
  const pacers = new Map<string, Pacer>();
  const results: JobResult[] = [];
  let guardWaits = 0;
  /** The last transient failure's code, for the job that gives up after MAX_ATTEMPTS. */
  let lastTransient = 'upstream_error';
  /** The last answer was a failure the client backs off from: a `backoff` now means throttled, not the window. */
  let failing = false;

  async function runJob(id: number): Promise<{ result: JobResult; stopped?: Stopped }> {
    const first = await deps.store.get(id);
    if (first === undefined) throw new Error('backfill_job: row vanished');
    const result: JobResult = {
      job: id,
      series: first.series_key,
      status: first.status,
      chunks: 0,
      requests: 0,
      error: null,
    };
    const finish = async (to: JobStatus, error: string | null) => {
      await deps.store.setStatus(id, to, error, ['planned', 'running']);
      result.status = to;
      result.error = error;
      return { result };
    };
    const stop = (stopped: Stopped) => ({ result, stopped });

    // Re-resolved against the registry before any request: the body is built from the registry row only.
    const entry = deps.config.specs.find((s) => s.id === first.spec_id && s.source === first.source_id);
    const series = entry?.series.find((s) => s.series_key === first.series_key);
    const provider = providers[first.source_id];
    if (entry === undefined || series === undefined || provider === undefined) return finish('failed', 'unregistered');
    // The job row is not trusted either (review S2): its chunk is the spec's, its range lies in [floor, DATA_EPOCH)
    // and its budget is no more than the plan gives that range.
    const from = first.range_from.getTime();
    const to = first.range_to.getTime();
    const floor = Date.parse(`${entry.floor}T00:00:00Z`);
    const cursor = first.cursor_ts.getTime();
    if (
      first.chunk_ms !== entry.chunk_ms ||
      from < floor ||
      to > EPOCH_MS ||
      cursor < Math.max(from, floor) ||
      cursor > to ||
      first.request_budget >
        requestBudget(
          planChunks(first.range_from, first.range_to, entry.chunk_ms).length,
          probeYears(first.range_from, first.range_to),
        )
    )
      return finish('failed', 'invalid_job');
    let pacer = pacers.get(entry.host);
    if (pacer === undefined) {
      pacer = new Pacer(entry.limits, deps.now, deps.sleep);
      pacers.set(entry.host, pacer);
    }
    await deps.store.start(id);
    result.status = 'running';
    /** The chunk length: the spec's, halved after a truncated response and kept for the rest of this job (review N2). */
    let spanMs = first.chunk_ms;

    for (;;) {
      // 1. A stop request, the window (and --until).
      if (opts.stop?.() === true) return stop('interrupted');
      const now = deps.now();
      if (opts.until !== undefined && now >= opts.until) return stop('until');
      if (!inWindow(now, entry.limits.window_utc)) return stop('window_closed');
      const closes = windowEnd(now, entry.limits.window_utc).getTime();
      const deadline = Math.min(closes, opts.until?.getTime() ?? Number.POSITIVE_INFINITY);
      const why = (): Stopped =>
        opts.until !== undefined && opts.until.getTime() <= closes ? 'until' : 'window_closed';

      // The job as it is now: a pause or abort from the CLI ends the loop, the loader's counters are read here.
      const job = await deps.store.get(id);
      if (job === undefined || (job.status !== 'running' && job.status !== 'planned')) {
        result.status = job?.status ?? result.status;
        return { result };
      }
      if (job.unreconciled > 0) return finish('failed', 'unreconciled');
      if (job.cursor_ts.getTime() >= job.range_to.getTime()) return finish('done', null);

      // 2. The request budget: a runaway stops here.
      if (job.requests >= job.request_budget) return finish('paused', 'budget');

      // 3. The guard: wait for the loader and the source to be healthy.
      const verdict = await deps.store.guard(entry.source);
      if (verdict !== 'ok') {
        guardWaits += 1;
        const wait = verdict === 'unloaded' ? UNLOADED_SLEEP_MS : GUARD_SLEEP_MS;
        await deps.sleep(Math.min(wait, Math.max(1, deadline - now.getTime())));
        continue;
      }

      // 4.–5. The probe or the chunk.
      const probing = job.data_from === null;
      const chunk = nextChunk(job.cursor_ts, job.range_to, spanMs);
      const probeTo = yearEnd(job.cursor_ts, job.range_to);
      const req: Req = probing
        ? provider.checkRequest(entry, series, job.cursor_ts, probeTo)
        : provider.chunkRequest(entry, series, chunk, now);
      const step = await send(entry.source, entry.host, entry.max_bytes, req, deadline, pacer, id, result, why);
      // 6. Truncation: nothing is committed; the chunk at this cursor is halved and asked again, down to a day.
      const halve = () => {
        const len = chunk.to.getTime() - chunk.from.getTime();
        if (probing || len <= MIN_CHUNK_MS) return false;
        spanMs = Math.max(MIN_CHUNK_MS, Math.ceil(len / 2));
        return true;
      };
      if (step.kind === 'truncated') {
        if (halve()) continue;
        return finish('failed', 'truncated');
      }
      if (step.kind === 'stop') return stop(step.stopped);
      if (step.kind === 'fail') return finish('failed', step.code);
      if (step.kind === 'retry') {
        if ((await deps.store.failAttempt(id)) >= MAX_ATTEMPTS) return finish('failed', lastTransient);
        continue;
      }
      const { res, start, end } = step;

      if (probing) {
        if (res.status !== 200) return finish('failed', 'unexpected_status');
        let present: boolean;
        try {
          present = provider.parseCheck(res.body);
        } catch {
          return finish('failed', 'schema_drift');
        }
        if (present) {
          await deps.store.advance(id, { cursor_ts: job.cursor_ts, data_from: job.cursor_ts, chunk: false });
        } else {
          // No value in this year: the cursor moves past it. The last year without data ends the job.
          await deps.store.advance(id, { cursor_ts: probeTo, chunk: false });
        }
        continue;
      }

      // 8. 204 (and an empty list): no data in this chunk. The cursor moves; no manifest line.
      let wrote = false;
      if (res.status === 200) {
        const v = await validate(provider.validity, res.status, res.body);
        if (!v.ok) return finish('failed', 'invalid');
        const seen = provider.inspect(res.body);
        if (!seen.ok && seen.code === 'truncated' && halve()) continue;
        if (!seen.ok) return finish('failed', seen.code);
        if (v.count !== 0) {
          wrote = true;
          // 9. The commit: (a) put, (b) append, (c) cursor.
          const hash = sha256(res.body);
          let put: Awaited<ReturnType<Archive['put']>>;
          try {
            put = await deps.archive.put(entry.source, entry.id, end, res.body, hash);
            await deps.hooks?.afterPut?.();
            const line: ManifestLine = {
              v: 1,
              source: entry.source,
              spec: entry.id,
              spec_version: entry.version,
              variant: '',
              request: {
                method: req.method,
                url: redactUrl(req.url),
                ...(req.body !== undefined && req.body.length <= 8192 ? { body: req.body } : {}),
              },
              fetched_at: { start: start.toISOString(), end: end.toISOString() },
              status: res.status,
              headers: keptHeaders(res.headers),
              sha256: hash,
              bytes: res.body.length,
              stored_bytes: put.stored,
              // Always a key and never dup_of: a re-put of an orphan object still needs a line that loads it.
              key: put.key,
              dup_of: null,
              gate: { kind: 'hash', key: null, open: true },
              shape: v.shape,
              shape_changed: false,
              validity: { ok: true, reason: null, count: v.count },
              retention: 'backfill',
              error: null,
              backfill: {
                job: id,
                chunk: job.chunks_done,
                from: chunk.from.toISOString(),
                to: chunk.to.toISOString(),
              },
            };
            await deps.archive.append(line);
            await deps.hooks?.afterAppend?.();
          } catch {
            return finish('failed', 'archive');
          }
        }
      } else if (res.status !== 204) {
        return finish('failed', 'unexpected_status');
      }
      await deps.store.advance(id, { cursor_ts: chunk.to, chunk: true, data: wrote });
      result.chunks += 1;
      await deps.hooks?.afterCursor?.();
    }
  }

  /** 4.–7. Pace, renew the lease, fetch, count and classify one request. */
  async function send(
    source: string,
    host: string,
    maxBytes: number,
    req: Req,
    deadline: number,
    pacer: Pacer,
    id: number,
    result: JobResult,
    why: () => Stopped,
  ): Promise<Step> {
    if (!(await pacer.wait(deadline))) return { kind: 'stop', stopped: why() };
    // The lease, renewed before every request: lost to another runner (it lapsed during a long wait), this one stops.
    if (!(await deps.store.lease(host, holder))) return { kind: 'stop', stopped: 'busy' };
    const start = deps.now();
    const r = await deps.client.fetch(source, req, { maxBytes, deadline });
    const end = deps.now();
    // Counted once it went out: a backoff, an open breaker or a refused URL sent nothing.
    if (r.ok || !NOT_SENT.has(r.error)) {
      await deps.store.addRequest(id);
      result.requests += 1;
    }
    const transient = (code: string): Step => {
      lastTransient = code;
      failing = true;
      return { kind: 'retry' };
    };
    if (!r.ok) {
      if (r.error === 'breaker_open') return { kind: 'stop', stopped: 'breaker_open' };
      if (r.error === 'backoff') return { kind: 'stop', stopped: failing ? 'throttled' : why() };
      if (r.error === 'network' || r.error === 'timeout' || r.error === 'dns') return transient(r.error);
      if (r.error === 'too_large' || r.error === 'too_large_decoded') return { kind: 'truncated' };
      return { kind: 'fail', code: r.error };
    }
    const { status } = r.res;
    if (status === 429 || status === 403 || status === 451) return transient('throttled');
    if (status >= 500) return transient('upstream_error');
    failing = false;
    if (status === 200 || status === 204) return { kind: 'ok', res: r.res, start, end };
    return { kind: 'fail', code: status >= 200 && status < 300 ? 'unexpected_status' : 'client_error' };
  }

  // One runner per host: the lease of every host a runnable job will use, before any request, or exit `busy`.
  const runnable = await deps.store.runnable();
  const hosts = new Set<string>();
  for (const j of runnable) {
    const host = deps.config.specs.find((s) => s.id === j.spec_id && s.source === j.source_id)?.host;
    if (host !== undefined) hosts.add(host);
  }
  const held: string[] = [];
  try {
    for (const host of hosts) {
      if (!(await deps.store.lease(host, holder))) return { stopped: 'busy', jobs: results, guard_waits: guardWaits };
      held.push(host);
    }
    for (const j of runnable) {
      const { result, stopped } = await runJob(j.id);
      results.push(result);
      if (stopped !== undefined) return { stopped, jobs: results, guard_waits: guardWaits };
    }
    return { stopped: 'done', jobs: results, guard_waits: guardWaits };
  } finally {
    // A failed release never masks the error that ended the run; the lease lapses by itself within 2 minutes.
    for (const host of held) await deps.store.release(host, holder).catch(() => undefined);
  }
}
