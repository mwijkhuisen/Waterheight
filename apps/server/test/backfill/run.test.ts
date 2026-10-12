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
    const id = await newJob(store, { from: '1990-01-01', to: '1993-01-01' });
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
  // Jan–Jul 2026: six chunks and a budget of 9 (the plan's), room for the retries below.
  const failing = async (answer: (c: { check: boolean }, n: number) => Answer) => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { from: '2026-01-01' });
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
    expect(r.job).toMatchObject({ status: 'done', chunks_done: 6, attempts: 0 });
    expect(r.lines.map((l) => l.backfill?.chunk)).toEqual([0, 1, 2, 3, 4, 5]);
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

describe('one runner per host (review C1/S1)', () => {
  const HOST = 'ddapi20-waterwebservices.rijkswaterstaat.nl';

  it('a host whose lease another runner holds: busy before any request, and the job is not touched', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    store.leases.set(HOST, 'someone-else');
    const { client, calls } = fakeClient(clock, normal);
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out).toMatchObject({ stopped: 'busy', jobs: [] });
    expect(calls).toHaveLength(0);
    expect(await store.get(id)).toMatchObject({ status: 'planned', requests: 0 });
    // Once it lapses, the next run proceeds.
    store.leases.delete(HOST);
    expect((await go(clock, store, client, tempArchive().archive)).stopped).toBe('done');
  });

  it('holds the lease while it runs and gives it back at exit', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store);
    const seen: (string | undefined)[] = [];
    const { client } = fakeClient(clock, (c) => {
      seen.push(store.leases.get(HOST));
      return normal(c);
    });
    await runBackfill({
      config: narrowed([LOBITH_H]),
      store,
      archive: tempArchive().archive,
      client,
      now: clock.now,
      sleep: clock.sleep,
      holder: 'me',
    });
    expect(seen).toEqual(['me', 'me', 'me', 'me']);
    expect(store.leases.size).toBe(0);
  });

  it('a lease lost to another runner meanwhile (it lapsed during a long wait) stops the run as busy', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store);
    const { client, calls } = fakeClient(clock, (c, n) => {
      if (n === 2) store.leases.set(HOST, 'other');
      return normal(c);
    });
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out.stopped).toBe('busy');
    expect(calls).toHaveLength(2);
    // Not ours to give back.
    expect(store.leases.get(HOST)).toBe('other');
  });
});

describe('a stop request (review N5)', () => {
  it('ends the run between two chunks, never inside one, and gives the lease back', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store); // three chunks
    const t = tempArchive();
    const { client } = fakeClient(clock, normal);
    let stop = false;
    // The flag rises while the first chunk is being committed: that chunk completes, then the loop ends.
    const out = await runBackfill(
      {
        config: narrowed([LOBITH_H]),
        store,
        archive: t.archive,
        client,
        now: clock.now,
        sleep: clock.sleep,
        hooks: {
          afterPut: async () => {
            stop = true;
          },
        },
      },
      { stop: () => stop },
    );
    expect(out.stopped).toBe('interrupted');
    expect(await store.get(id)).toMatchObject({ status: 'running', chunks_done: 1 });
    expect(t.lines()).toHaveLength(1);
    expect(store.leases.size).toBe(0);
  });

  it('a release that throws does not mask the result', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    await newJob(store);
    store.release = async () => {
      throw new Error('release failed');
    };
    const { client } = fakeClient(clock, normal);
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out.stopped).toBe('done');
  });
});

describe('the job row is not trusted (review S2)', () => {
  const tampered = async (change: (j: Record<string, unknown>) => void) => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    change(store.jobs.get(id) as unknown as Record<string, unknown>);
    const { client, calls } = fakeClient(clock, normal);
    await go(clock, store, client, tempArchive().archive);
    expect(calls).toHaveLength(0);
    return store.get(id);
  };

  it('a chunk other than the spec’s, a range below the floor or past DATA_EPOCH, a budget over the plan’s', async () => {
    for (const change of [
      (j: Record<string, unknown>) => {
        j.chunk_ms = 100 * 365 * 86_400_000;
      },
      (j: Record<string, unknown>) => {
        j.range_from = new Date('1989-12-31T00:00:00Z');
        j.cursor_ts = j.range_from;
      },
      (j: Record<string, unknown>) => {
        j.range_to = new Date('2026-10-02T00:00:01Z');
      },
      (j: Record<string, unknown>) => {
        j.request_budget = 6;
      },
      // A cursor outside [max(range_from, floor), range_to] (review N3).
      (j: Record<string, unknown>) => {
        j.cursor_ts = new Date('2026-04-30T00:00:00Z');
      },
      (j: Record<string, unknown>) => {
        j.cursor_ts = new Date('2026-08-02T00:00:00Z');
      },
    ])
      expect(await tampered(change)).toMatchObject({ status: 'failed', last_error: 'invalid_job' });
  });

  it('the plan’s own budget and a range ending at DATA_EPOCH pass', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { from: '2026-09-01', to: '2026-10-02' });
    const { client } = fakeClient(clock, normal);
    await go(clock, store, client, tempArchive().archive);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 1 });
  });
});

describe('throttled and the request count (review C6/S4)', () => {
  it('a 429 and then the client backing off past the window: throttled, the unsent request not counted', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client, calls } = fakeClient(clock, (c, n) =>
      c.check ? normal(c) : n === 2 ? { status: 429 } : { error: 'backoff' },
    );
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out.stopped).toBe('throttled');
    expect(calls).toHaveLength(3);
    expect(await store.get(id)).toMatchObject({ status: 'running', requests: 2 });
  });

  it('a backoff with no failure before it is the window closing, and counts nothing', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, (c) => (c.check ? normal(c) : { error: 'backoff' }));
    const out = await go(clock, store, client, tempArchive().archive);
    expect(out.stopped).toBe('window_closed');
    expect(await store.get(id)).toMatchObject({ requests: 1 });
  });

  it('an open breaker sent nothing either', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, (c) => (c.check ? normal(c) : { error: 'breaker_open' }));
    expect((await go(clock, store, client, tempArchive().archive)).stopped).toBe('breaker_open');
    expect(await store.get(id)).toMatchObject({ requests: 1 });
  });
});

describe('chunks_with_data (review C5/S6)', () => {
  it('counts the chunks that wrote a manifest line, not a 204 or an empty list', async () => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const { client } = fakeClient(clock, (c, n) =>
      c.check || n === 2
        ? normal(c)
        : n === 3
          ? { status: 204 }
          : { status: 200, body: Buffer.from('{"Succesvol":true,"WaarnemingenLijst":[]}') },
    );
    await go(clock, store, client, tempArchive().archive);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 3, chunks_with_data: 1 });
  });
});
