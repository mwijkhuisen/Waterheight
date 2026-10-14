import { describe, expect, it } from 'vitest';
import { inWindow, Pacer, windowEnd } from '../../src/backfill/pacer.ts';
import { GUARD_SLEEP_MS, runBackfill, UNLOADED_SLEEP_MS } from '../../src/backfill/run.ts';
import {
  Clock,
  fakeClient,
  LOBITH_H,
  LOBITH_Q,
  MemoryJobStore,
  NIGHT,
  narrowed,
  newJob,
  normal,
  tempArchive,
  unusedArchive,
} from './harness.ts';

// Criterion "[CI] the per-provider rate budget holds" (issue #29, P14a): the pacer's spacing and sliding hour, the
// off-peak window, the request budget and the guard's pause, all on a fake clock.

const W = { from: '22:00', to: '05:00' };
const at = (iso: string) => new Date(`${iso}Z`);

describe('window', () => {
  it('22:00–05:00 UTC wraps midnight', () => {
    for (const t of ['2026-10-13T22:00:00', '2026-10-13T23:59:59', '2026-10-14T00:00:00', '2026-10-14T04:59:59'])
      expect(inWindow(at(t), W), t).toBe(true);
    for (const t of ['2026-10-13T21:59:59', '2026-10-14T05:00:00', '2026-10-14T12:00:00'])
      expect(inWindow(at(t), W), t).toBe(false);
  });

  it('a window inside one day does not wrap', () => {
    const w = { from: '02:00', to: '05:00' };
    expect(inWindow(at('2026-10-14T03:00:00'), w)).toBe(true);
    expect(inWindow(at('2026-10-14T23:00:00'), w)).toBe(false);
  });

  it('closes at the next 05:00', () => {
    expect(windowEnd(at('2026-10-13T23:00:00'), W).toISOString()).toBe('2026-10-14T05:00:00.000Z');
    expect(windowEnd(at('2026-10-14T03:00:00'), W).toISOString()).toBe('2026-10-14T05:00:00.000Z');
  });
});

describe('Pacer', () => {
  it('starts two requests at least min_interval_ms apart', async () => {
    const clock = new Clock();
    const pacer = new Pacer({ min_interval_ms: 1000, max_per_hour: 3600 }, clock.now, clock.sleep);
    const starts: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      expect(await pacer.wait(Number.POSITIVE_INFINITY)).toBe(true);
      starts.push(clock.t);
      clock.t += 10; // the request itself
    }
    for (let i = 1; i < starts.length; i += 1)
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(1000);
  });

  it('holds max_per_hour over a sliding hour', async () => {
    const clock = new Clock();
    const pacer = new Pacer({ min_interval_ms: 1000, max_per_hour: 5 }, clock.now, clock.sleep);
    const starts: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      await pacer.wait(Number.POSITIVE_INFINITY);
      starts.push(clock.t);
    }
    for (let i = 5; i < starts.length; i += 1)
      expect((starts[i] as number) - (starts[i - 5] as number)).toBeGreaterThanOrEqual(3_600_000);
  });

  it('refuses, without waiting, a request that could only start after the deadline', async () => {
    const clock = new Clock();
    const pacer = new Pacer({ min_interval_ms: 1000, max_per_hour: 3600 }, clock.now, clock.sleep);
    expect(await pacer.wait(clock.t + 500)).toBe(true);
    const before = clock.t;
    expect(await pacer.wait(clock.t + 500)).toBe(false);
    expect(clock.t).toBe(before);
    expect(clock.slept).toEqual([]);
  });
});

describe('runBackfill', () => {
  const run = (
    clock: Clock,
    store: MemoryJobStore,
    client: ReturnType<typeof fakeClient>['client'],
    archive: Parameters<typeof runBackfill>[0]['archive'],
    keys = [LOBITH_H],
  ) => runBackfill({ config: narrowed(keys), store, archive, client, now: clock.now, sleep: clock.sleep });

  it('sends nothing outside the window and exits window_closed', async () => {
    const clock = new Clock(Date.parse('2026-10-13T12:00:00Z'));
    const store = new MemoryJobStore();
    await newJob(store);
    const { client, calls } = fakeClient(clock, normal);
    const out = await run(clock, store, client, unusedArchive);
    expect(out.stopped).toBe('window_closed');
    expect(calls).toHaveLength(0);
  });

  it('stops when the window closes mid-run, leaving the job running at its cursor', async () => {
    const clock = new Clock(Date.parse('2026-10-14T04:59:59.500Z'));
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client, calls } = fakeClient(clock, (c) => (c.check ? normal(c) : { status: 204 }));
    const out = await run(clock, store, client, unusedArchive);
    expect(out.stopped).toBe('window_closed');
    // The probe fits; the next request would start after 05:00, so it is not sent.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.check).toBe(true);
    expect((await store.get(id))?.status).toBe('running');
  });

  it('stops at --until', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store);
    const { client, calls } = fakeClient(clock, (c) => (c.check ? normal(c) : { status: 204 }));
    const out = await runBackfill(
      { config: narrowed([LOBITH_H]), store, archive: unusedArchive, client, now: clock.now, sleep: clock.sleep },
      { until: new Date(NIGHT + 1500) },
    );
    expect(out.stopped).toBe('until');
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('pauses a job that used its request budget, with the code budget', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { budget: 2 });
    const { client, calls } = fakeClient(clock, normal);
    const t = tempArchive();
    const out = await run(clock, store, client, t.archive);
    expect(calls).toHaveLength(2); // the probe and one chunk
    expect(out.jobs[0]).toMatchObject({ status: 'paused', error: 'budget', chunks: 1, requests: 2 });
    expect(await store.get(id)).toMatchObject({ status: 'paused', last_error: 'budget', requests: 2, chunks_done: 1 });
    expect(t.lines()).toHaveLength(1);
    // A paused job is not picked up again.
    expect((await store.runnable()).length).toBe(0);
  });

  it('waits GUARD_SLEEP_MS while the guard says no, then goes on', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    store.verdicts = ['backlog', 'loader_lag'];
    const id = await newJob(store, { from: '2026-07-20', to: '2026-08-01' });
    const { client, calls } = fakeClient(clock, normal);
    const out = await run(clock, store, client, tempArchive().archive);
    expect(clock.slept.slice(0, 2)).toEqual([GUARD_SLEEP_MS, GUARD_SLEEP_MS]);
    expect(out.guard_waits).toBe(2);
    expect(calls[0]?.at).toBeGreaterThanOrEqual(NIGHT + 2 * GUARD_SLEEP_MS);
    expect((await store.get(id))?.status).toBe('done');
  });

  it('waits only UNLOADED_SLEEP_MS when the loader has chunks to catch up on', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    store.verdicts = ['unloaded', 'unloaded', 'backlog'];
    await newJob(store, { from: '2026-07-20', to: '2026-08-01' });
    const { client } = fakeClient(clock, normal);
    const out = await run(clock, store, client, tempArchive().archive);
    expect(clock.slept.slice(0, 3)).toEqual([UNLOADED_SLEEP_MS, UNLOADED_SLEEP_MS, GUARD_SLEEP_MS]);
    expect(out.guard_waits).toBe(3);
  });

  it('is not throttled by a loader that ticks every 10 s: about one chunk a second, no long sleep (review N1)', async () => {
    const clock = new Clock();
    // The loader reads every 10 s and then has loaded every chunk archived so far; the guard sees the ledger as of that
    // tick, with the SQL's threshold (more than 30 chunks with data not in the ledger).
    class TickingStore extends MemoryJobStore {
      private lastTick = clock.t;
      private loaded = 0;
      override async guard() {
        if (clock.t - this.lastTick >= 10_000) {
          this.lastTick = clock.t;
          this.loaded = [...this.jobs.values()].reduce((a, j) => a + j.chunks_with_data, 0);
        }
        const behind = [...this.jobs.values()].reduce((a, j) => a + j.chunks_with_data, 0) - this.loaded;
        return behind > 30 ? 'unloaded' : 'ok';
      }
    }
    const store = new TickingStore();
    const id = await newJob(store, { from: '2010-01-01', to: '2026-10-02' }); // 153 chunks
    const { client, calls } = fakeClient(clock, normal);
    const t0 = clock.t;
    const out = await run(clock, store, client, tempArchive().archive);
    const job = await store.get(id);
    expect(job).toMatchObject({ status: 'done', chunks_done: 153 });
    expect(out.guard_waits).toBe(0);
    expect(clock.slept.every((ms) => ms <= 1000)).toBe(true);
    // 154 requests (the probe and the chunks) at 1 req/s: under 3 minutes, not the hours of 5-minute sleeps.
    expect(calls).toHaveLength(154);
    expect(clock.t - t0).toBeLessThan(180_000);
  });

  it('keeps the guard waiting to the end of the window, then stops without a request', async () => {
    const clock = new Clock(Date.parse('2026-10-14T04:50:00Z'));
    const store = new MemoryJobStore();
    store.verdicts = Array(10).fill('stale');
    await newJob(store);
    const { client, calls } = fakeClient(clock, normal);
    const out = await run(clock, store, client, unusedArchive);
    expect(out.stopped).toBe('window_closed');
    expect(out.guard_waits).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(0);
  });

  it('spaces every request, probes included, at least 1 s apart', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store, { from: '2026-05-01', to: '2026-08-01' });
    const { client, calls } = fakeClient(clock, (c) => (c.check ? normal(c) : { status: 204 }));
    await run(clock, store, client, unusedArchive);
    expect(calls).toHaveLength(4); // the probe and three chunks
    for (let i = 1; i < calls.length; i += 1)
      expect((calls[i] as { at: number }).at - (calls[i - 1] as { at: number }).at).toBeGreaterThanOrEqual(1000);
  });

  it('spaces the first request of the next job from the last of the one before', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store, { from: '2026-07-20', to: '2026-08-01' });
    await newJob(store, { series: LOBITH_Q, from: '2026-07-20', to: '2026-08-01' });
    const { client, calls } = fakeClient(clock, (c) => (c.check ? normal(c) : { status: 204 }));
    await run(clock, store, client, unusedArchive, [LOBITH_H, LOBITH_Q]);
    expect(calls).toHaveLength(4);
    for (let i = 1; i < calls.length; i += 1)
      expect((calls[i] as { at: number }).at - (calls[i - 1] as { at: number }).at).toBeGreaterThanOrEqual(1000);
  });
});
