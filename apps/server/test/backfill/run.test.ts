import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/archive/writer.ts';
import { MAX_ATTEMPTS, runBackfill } from '../../src/backfill/run.ts';
import {
  type Answer,
  CHECK,
  Clock,
  fakeClient,
  fixtureBody,
  LOBITH_H,
  MemoryJobStore,
  narrowed,
  newJob,
  normal,
  tempArchive,
} from './harness.ts';

// The run loop on a fake clock, a fake transport that serves NL-1 fixture bodies, an in-memory job store and a
// temp-dir Archive (plan §3.3 steps 5–10).

type Archive = Parameters<typeof runBackfill>[0]['archive'];
const go = (
  clock: Clock,
  store: MemoryJobStore,
  client: ReturnType<typeof fakeClient>['client'],
  archive: Archive,
  hooks?: Parameters<typeof runBackfill>[0]['hooks'],
) =>
  runBackfill({
    config: narrowed([LOBITH_H]),
    store,
    archive,
    client,
    now: clock.now,
    sleep: clock.sleep,
    ...(hooks === undefined ? {} : { hooks }),
  });

describe('the commit of a chunk', () => {
  it('is put, then append, then the cursor; the line has a key, variant "" and the backfill ledger fields', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store); // 2026-05-01 .. 2026-08-01 = three chunks (40 d, 40 d, 12 d)
    const t = tempArchive();
    const events: string[] = [];
    const archive = {
      put: async (...a: Parameters<typeof t.archive.put>) => {
        events.push('put');
        return t.archive.put(...a);
      },
      append: async (...a: Parameters<typeof t.archive.append>) => {
        events.push('append');
        return t.archive.append(...a);
      },
    };
    const advance = store.advance.bind(store);
    store.advance = async (jobId, a) => {
      if (a.chunk) events.push('cursor');
      return advance(jobId, a);
    };
    const { client, calls } = fakeClient(clock, normal);
    const out = await go(clock, store, client, archive);

    expect(out.stopped).toBe('done');
    expect(events).toEqual(['put', 'append', 'cursor', 'put', 'append', 'cursor', 'put', 'append', 'cursor']);
    const job = await store.get(id);
    expect(job).toMatchObject({ status: 'done', chunks_done: 3, requests: 4, attempts: 0 });
    expect(job?.cursor_ts.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(job?.data_from?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    // The probe, then the three chunk windows, in the registry's UTC form.
    expect(calls.map((c) => c.check)).toEqual([true, false, false, false]);
    expect(JSON.parse(calls[0]?.body ?? '{}').AquoMetadataLijst[0].WaardeBepalingsMethode).toEqual({
      Code: 'other:F007',
    });
    expect(calls.slice(1).map((c) => JSON.parse(c.body ?? '{}').Periode)).toEqual([
      { Begindatumtijd: '2026-05-01T00:00:00Z', Einddatumtijd: '2026-06-10T00:00:00Z' },
      { Begindatumtijd: '2026-06-10T00:00:00Z', Einddatumtijd: '2026-07-20T00:00:00Z' },
      { Begindatumtijd: '2026-07-20T00:00:00Z', Einddatumtijd: '2026-08-01T00:00:00Z' },
    ]);

    const lines = t.lines();
    expect(lines).toHaveLength(3);
    lines.forEach((l, i) => {
      expect(l).toMatchObject({
        source: 'NL-1',
        spec: 'nl-1-backfill-obs',
        variant: '',
        retention: 'backfill',
        dup_of: null,
        status: 200,
        error: null,
      });
      expect(l.key).toMatch(/^raw\/NL-1\/nl-1-backfill-obs\//);
      expect(l.backfill).toMatchObject({ job: id, chunk: i });
      expect(l.request?.url).toMatch(/OphalenWaarnemingen$/);
    });
    expect(lines.map((l) => l.backfill?.from)).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-10T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    ]);
    expect(lines.map((l) => l.backfill?.to)).toEqual([
      '2026-06-10T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });

  it('204: the cursor advances and no manifest line is written', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const t = tempArchive();
    const { client } = fakeClient(clock, (c, n) => (c.check || n !== 3 ? normal(c) : { status: 204 }));
    const out = await go(clock, store, client, t.archive);
    expect(out.stopped).toBe('done');
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 3 });
    expect(t.lines().map((l) => l.backfill?.chunk)).toEqual([0, 2]);
  });

  it('an empty list (200, no lists) counts as no data: no object, no line', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { from: '2026-07-20', to: '2026-08-01' });
    const t = tempArchive();
    const { client } = fakeClient(clock, (c) =>
      c.check ? normal(c) : { status: 200, body: Buffer.from('{"Succesvol":true,"WaarnemingenLijst":[]}') },
    );
    await go(clock, store, client, t.archive);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 1 });
    expect(t.lines()).toHaveLength(0);
  });
});

describe('resume', () => {
  it('a failure after the put leaves the cursor; the next run fetches the chunk again and its line loads it', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const t = tempArchive();
    const { client } = fakeClient(clock, normal);
    let puts = 0;
    const out1 = await go(clock, store, client, t.archive, {
      afterPut: async () => {
        // The second chunk's object is on disk; its line is not.
        if (++puts === 2) throw new Error('killed');
      },
    });
    expect(out1.jobs[0]).toMatchObject({ status: 'failed', error: 'archive', chunks: 1 });
    expect(t.lines()).toHaveLength(1);
    const cut = await store.get(id);
    expect(cut?.cursor_ts.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(cut?.chunks_done).toBe(1);

    // resume: failed → planned
    expect(await store.setStatus(id, 'planned', null, ['paused', 'failed'])).toBe(true);
    clock.t += 5000;
    const out2 = await go(clock, store, client, t.archive);
    expect(out2.stopped).toBe('done');
    const lines = t.lines();
    // Chunk 0 once, chunks 1 and 2 once each: no gap and no duplicate line.
    expect(lines.map((l) => l.backfill?.chunk)).toEqual([0, 1, 2]);
    expect(lines.map((l) => l.backfill?.from)).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-10T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    ]);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 3 });
    // The probe is not repeated: data_from is kept.
    expect((await store.get(id))?.requests).toBe(1 + 2 + 2);
  });

  it('a second line for the same chunk (put again in the same second) still carries a key and no dup_of', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store, { from: '2026-07-20', to: '2026-08-01' });
    const t = tempArchive();
    // The object of that body at that second already exists, so the runner's `put` answers created:false.
    const at = new Date('2026-10-13T23:00:01Z');
    const { client } = fakeClient(clock, normal);
    const body = fixtureBody();
    const archive = {
      put: (s: string, spec: string, _at: Date, b: Uint8Array, hash: string) => t.archive.put(s, spec, at, b, hash),
      append: t.archive.append.bind(t.archive),
    };
    expect((await archive.put('NL-1', 'nl-1-backfill-obs', at, body, sha256(body))).created).toBe(true);
    await go(clock, store, client, archive);
    const lines = t.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.key).not.toBeNull();
    expect(lines[0]?.dup_of).toBeNull();
  });
});

describe('probe', () => {
  it('asks year by year, moves the cursor past years without data and stops at the first with data', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { from: '1990-01-01', to: '1993-01-01', budget: 500 });
    const t = tempArchive();
    const years: string[] = [];
    const { client } = fakeClient(clock, (c) => {
      if (!c.check) return { status: 204 };
      const p = JSON.parse(c.body ?? '{}').Periode;
      years.push(`${p.Begindatumtijd.slice(0, 10)}..${p.Einddatumtijd.slice(0, 10)}`);
      return { status: 200, body: CHECK(p.Begindatumtijd.startsWith('1991')) };
    });
    await go(clock, store, client, t.archive);
    expect(years).toEqual(['1990-01-01..1991-01-01', '1991-01-01..1992-01-01']);
    const job = await store.get(id);
    expect(job?.data_from?.toISOString()).toBe('1991-01-01T00:00:00.000Z');
    expect(job?.status).toBe('done');
    // 1991-01-01 .. 1993-01-01 in 40-day chunks: 18 of them.
    expect(job?.chunks_done).toBe(Math.ceil((Date.parse('1993-01-01') - Date.parse('1991-01-01')) / (40 * 86_400_000)));
  });

  it('no year with data: the job is done without a chunk', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { from: '1990-01-01', to: '1992-06-01', budget: 20 });
    const { client, calls } = fakeClient(clock, () => ({ status: 200, body: CHECK(false) }));
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out.stopped).toBe('done');
    expect(calls).toHaveLength(3); // 1990, 1991, 1992 (to June)
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 0, data_from: null });
    expect((await store.get(id))?.cursor_ts.toISOString()).toBe('1992-06-01T00:00:00.000Z');
  });

  it('a probe answer that is not the string "true" or "false" fails the job as schema_drift', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, () => ({
      status: 200,
      body: Buffer.from('{"Succesvol":true,"WaarnemingenAanwezig":true}'),
    }));
    await go(clock, store, client, tempArchive().archive);
    expect(await store.get(id)).toMatchObject({ status: 'failed', last_error: 'schema_drift' });
  });
});

describe('errors', () => {
  const failing = async (answer: (c: { check: boolean }, n: number) => Answer) => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const t = tempArchive();
    const { client, calls } = fakeClient(clock, (c, n) => (c.check ? normal(c) : answer(c, n)));
    const out = await go(clock, store, client, t.archive);
    return { job: await store.get(id), out, calls, lines: t.lines() };
  };

  it('429 five times: failed with throttled after MAX_ATTEMPTS attempts, nothing committed', async () => {
    const r = await failing(() => ({ status: 429 }));
    expect(r.job).toMatchObject({ status: 'failed', last_error: 'throttled', chunks_done: 0, attempts: MAX_ATTEMPTS });
    expect(r.calls.filter((c) => !c.check)).toHaveLength(MAX_ATTEMPTS);
    expect(r.lines).toHaveLength(0);
  });

  it('a 5xx that clears on the 3rd attempt: the chunk commits and attempts reset', async () => {
    const r = await failing((_c, n) => (n < 4 ? { status: 503 } : normal({ check: false })));
    expect(r.job).toMatchObject({ status: 'done', chunks_done: 3, attempts: 0 });
    expect(r.lines.map((l) => l.backfill?.chunk)).toEqual([0, 1, 2]);
  });

  it('another 4xx fails at once with client_error', async () => {
    const r = await failing(() => ({ status: 400 }));
    expect(r.job).toMatchObject({ status: 'failed', last_error: 'client_error', chunks_done: 0 });
    expect(r.calls.filter((c) => !c.check)).toHaveLength(1);
  });

  it('a body that is not valid JSON fails as invalid and is not archived', async () => {
    const r = await failing(() => ({ status: 200, body: Buffer.from('<html>') }));
    expect(r.job).toMatchObject({ status: 'failed', last_error: 'invalid' });
    expect(r.lines).toHaveLength(0);
  });

  it('a network error is retried; the breaker open stops the run without failing the job', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, (c, n) =>
      c.check ? normal(c) : n === 2 ? { error: 'network' } : { error: 'breaker_open' },
    );
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out.stopped).toBe('breaker_open');
    expect((await store.get(id))?.status).toBe('running');
  });

  it('a job whose loader counters show an unreconciled chunk fails with unreconciled', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, normal);
    const t = tempArchive();
    const advance = store.advance.bind(store);
    store.advance = async (jobId, a) => {
      await advance(jobId, a);
      // The loader reports its first chunk.
      if (a.chunk) (store.jobs.get(jobId) as { unreconciled: number }).unreconciled = 1;
    };
    const out = await go(clock, store, client, t.archive);
    expect(out.jobs[0]).toMatchObject({ status: 'failed', error: 'unreconciled', chunks: 1 });
    expect((await store.get(id))?.last_error).toBe('unreconciled');
  });

  it('a series the registry does not select fails with unregistered before any request', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { series: 'eijsden.grens/WATHTE/TAW/other:F007' });
    const { client, calls } = fakeClient(clock, normal);
    await go(clock, store, client, tempArchive().archive);
    expect(calls).toHaveLength(0);
    expect(await store.get(id)).toMatchObject({ status: 'failed', last_error: 'unregistered' });
  });

  it('a job paused or aborted from the CLI meanwhile ends the loop', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, normal);
    const t = tempArchive();
    const advance = store.advance.bind(store);
    store.advance = async (jobId, a) => {
      await advance(jobId, a);
      if (a.chunk) await store.setStatus(id, 'paused', null, ['running']);
    };
    const out = await go(clock, store, client, t.archive);
    expect(out.jobs[0]).toMatchObject({ status: 'paused', chunks: 1 });
    expect(t.lines()).toHaveLength(1);
  });
});
