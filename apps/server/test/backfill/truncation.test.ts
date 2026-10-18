import { SchemaDrift } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { driftCode, PROVIDERS } from '../../src/backfill/provider.ts';
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

// Plan §3.3 step 6: a response that may be cut short by a cap commits nothing. Review C3: the chunk at that cursor is
// halved and asked again, down to one day; below that the job fails `truncated`.

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
  it('calls any other drift schema_drift, not truncation, and keeps the parser code', () => {
    expect(nl1.inspect(Buffer.from('{"Succesvol":true,"WaarnemingenLijst":[{"x":1}]}'))).toEqual({
      ok: false,
      code: 'schema_drift',
      drift: expect.stringMatching(/^[a-z0-9_]{1,40}$/),
    });
  });
  it('prints a drift code only when it is a fixed code', () => {
    expect(driftCode(new SchemaDrift('bad_value'))).toBe('bad_value');
    expect(driftCode(new SchemaDrift('Bad value <x>'))).toBe('other');
    expect(driftCode(new Error('bad_value'))).toBe('other');
  });
});

describe('a truncated chunk (review C3)', () => {
  // Jan–Jul 2026 (six chunks, the plan's budget of 9): room for the halvings of one chunk.
  const run = async (answer: Parameters<typeof fakeClient>[1]) => {
    const clock = new Clock();
    const store = new MemoryJobStore();
    const id = await newJob(store, { from: '2026-01-01' });
    const t = tempArchive();
    const { client, calls } = fakeClient(clock, answer);
    await runBackfill({
      config: narrowed([LOBITH_H]),
      store,
      archive: t.archive,
      client,
      now: clock.now,
      sleep: clock.sleep,
    });
    const periods = calls
      .filter((c) => !c.check)
      .map((c) => {
        const p = JSON.parse(c.body ?? '{}').Periode;
        return (Date.parse(p.Einddatumtijd) - Date.parse(p.Begindatumtijd)) / 86_400_000;
      });
    return { job: await store.get(id), t, periods };
  };

  it('halves the chunk at the cursor down to a day, then fails truncated: nothing committed, every request counted', async () => {
    const { job, t, periods } = await run((c) => (c.check ? normal(c) : { status: 200, body: withValues(9500) }));
    // P14b: halves are whole days (a provider that asks by UTC day would miss a boundary at noon).
    expect(periods).toEqual([40, 20, 10, 5, 3, 2, 1]);
    expect(job).toMatchObject({ status: 'failed', last_error: 'truncated', chunks_done: 0, requests: 8 });
    expect(job?.cursor_ts.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(t.lines()).toHaveLength(0);
  });

  it('the client cap (too_large, too_large_decoded) is the same', async () => {
    for (const error of ['too_large', 'too_large_decoded'] as const) {
      const { job, t, periods } = await run((c) => (c.check ? normal(c) : { error }));
      expect(periods).toHaveLength(7);
      expect(job).toMatchObject({ status: 'failed', last_error: 'truncated', chunks_done: 0 });
      expect(t.lines()).toHaveLength(0);
    }
  });

  it('a half that fits commits, and the rest of the job keeps the half (review N2)', async () => {
    const { job, t, periods } = await run((c, n) =>
      c.check ? normal(c) : n === 2 ? { status: 200, body: withValues(9500) } : normal(c),
    );
    // 40 truncated, then 20 at that cursor and at every cursor after it. The halves cost requests: the plan's budget
    // of 9 (six chunks of 40 days) ends the job `paused` after seven of them, to be re-planned from its cursor.
    expect(periods).toEqual([40, ...Array(7).fill(20)]);
    expect(job).toMatchObject({ status: 'paused', last_error: 'budget', chunks_done: 7, requests: 9 });
    expect(t.lines()[0]?.backfill).toMatchObject({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-21T00:00:00.000Z' });
  });

  it('a chunk below the line commits as usual', async () => {
    const { job, t } = await run((c) => (c.check ? normal(c) : { status: 200, body: withValues(8999) }));
    expect(job).toMatchObject({ status: 'done', chunks_done: 6 });
    expect(t.lines()).toHaveLength(6);
  });
});
