import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../src/backfill/provider.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import {
  Clock,
  fakeClient,
  fixtureText,
  LOBITH_H,
  MemoryJobStore,
  narrowed,
  newJob,
  normal,
  tempArchive,
} from './harness.ts';

// Plan §3.3 step 6: a response that may be cut short by a cap fails the job with `truncated` and commits nothing.
// There is no halving: P40D of a 10-minute series sits at 58 % of the list cap.

const nl1 = PROVIDERS['NL-1'];
if (nl1 === undefined) throw new Error('no NL-1 provider');

/** The Lobith H fixture with its one list grown to `n` values (the first value repeated). */
function withValues(n: number, lists = 1): Buffer {
  const doc = JSON.parse(fixtureText('nl-1-obs-key'));
  const list = doc.WaarnemingenLijst[0];
  const one = list.MetingenLijst[0];
  const grown = { ...list, MetingenLijst: Array.from({ length: n }, () => one) };
  doc.WaarnemingenLijst = Array.from({ length: lists }, () => grown);
  return Buffer.from(JSON.stringify(doc));
}

describe('inspect', () => {
  it('accepts a list just under 90 % of maxValues and counts its values', () => {
    expect(nl1.inspect(withValues(8999))).toEqual({ ok: true, values: 8999 });
  });
  it('refuses a list at 90 % of maxValues', () => {
    expect(nl1.inspect(withValues(9000))).toEqual({ ok: false, code: 'truncated' });
  });
  it('refuses a list over the parser cap (too_big)', () => {
    expect(nl1.inspect(withValues(10_001))).toEqual({ ok: false, code: 'truncated' });
  });
  it('refuses a response over the node cap', () => {
    expect(nl1.inspect(withValues(8000, 3))).toEqual({ ok: false, code: 'truncated' });
  });
  it('refuses more lists than the parser reads', () => {
    expect(nl1.inspect(withValues(2, 51))).toEqual({ ok: false, code: 'truncated' });
  });
  it('calls any other drift schema_drift, not truncation', () => {
    expect(nl1.inspect(Buffer.from('{"Succesvol":true,"WaarnemingenLijst":[{"x":1}]}'))).toEqual({
      ok: false,
      code: 'schema_drift',
    });
  });
});

describe('a truncated chunk', () => {
  const run = async (answer: Parameters<typeof fakeClient>[1]) => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store);
    const t = tempArchive();
    const { client } = fakeClient(clock, answer);
    await runBackfill({
      config: narrowed([LOBITH_H]),
      store,
      archive: t.archive,
      client,
      now: clock.now,
      sleep: clock.sleep,
    });
    return { job: await store.get(id), t };
  };

  it('fails the job with truncated and commits nothing: no object, no line, the cursor stays', async () => {
    const { job, t } = await run((c) => (c.check ? normal(c) : { status: 200, body: withValues(9500) }));
    expect(job).toMatchObject({ status: 'failed', last_error: 'truncated', chunks_done: 0 });
    expect(job?.cursor_ts.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(t.lines()).toHaveLength(0);
  });

  it('the client cap (too_large, too_large_decoded) is the same failure', async () => {
    for (const error of ['too_large', 'too_large_decoded'] as const) {
      const { job, t } = await run((c) => (c.check ? normal(c) : { error }));
      expect(job).toMatchObject({ status: 'failed', last_error: 'truncated', chunks_done: 0 });
      expect(t.lines()).toHaveLength(0);
    }
  });

  it('a chunk below the line commits as usual', async () => {
    const { job, t } = await run((c) => (c.check ? normal(c) : { status: 200, body: withValues(8999) }));
    expect(job).toMatchObject({ status: 'done', chunks_done: 3 });
    expect(t.lines()).toHaveLength(3);
  });
});
