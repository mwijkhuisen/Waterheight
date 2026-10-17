import { describe, expect, it } from 'vitest';
import { LOAD_ADAPTERS, type SpecLoader } from '../../src/load/adapters.ts';
import { BUMP_DEFER_MS, BUMP_QUIET_MS, bumpsDue, DATA_EPOCH } from '../../src/load/dirty.ts';
import { registryOf } from '../adapters/registry.ts';
import { catchupBody, LOBITH_H } from './catchup-body.ts';

// P16b: the catch-up loader (nl1Catchup: no age limit, the future check kept, nothing before DATA_EPOCH) and the rule
// that flushes the catch-up's deferred day bumps.

const MIN = 60_000;
const EPOCH = Date.parse(DATA_EPOCH);

describe('the catch-up loader (nl-1-obs-*-catchup)', () => {
  const specs = LOAD_ADAPTERS['NL-1']?.specs ?? {};
  const registry = registryOf('NL-1');

  it('the three catch-up specs share it: live mode, 25 MiB, their day bumps deferred', () => {
    for (const id of ['nl-1-obs-sea-catchup', 'nl-1-obs-wide-catchup', 'nl-1-obs-slow-catchup']) {
      const spec = specs[id] as SpecLoader;
      expect(spec, id).toBe(specs['nl-1-obs-sea-catchup']);
      expect(spec).toMatchObject({ maxBytes: 25 * 1024 * 1024, needsVariant: false, deferBumps: true });
      expect(spec.backfill).toBeUndefined();
    }
    // The live tiers keep the observation loader, which bumps per payload.
    for (const id of ['nl-1-obs-sea', 'nl-1-obs-wide', 'nl-1-obs-slow'])
      expect(specs[id], id).toBe(specs['nl-1-obs-key']);
  });

  it('keeps a window more than 45 days old, drops what lies before DATA_EPOCH and what lies in the future', async () => {
    // Six values before the epoch, 288 after it; fetched 50 days after the epoch, with three values ahead of the fetch.
    const fetchedAt = EPOCH + 50 * 86_400_000;
    const body = catchupBody(EPOCH - 60 * MIN, 6 + 288);
    const ctx = { registry, fetchedAt, variant: '', unitMismatch: new Set<string>() };
    const out = await (specs['nl-1-obs-sea-catchup'] as SpecLoader).run(body, ctx);
    expect(out.obs).toHaveLength(288);
    expect(out.obs.every((r) => r.series === LOBITH_H && Date.parse(r.ts) >= EPOCH)).toBe(true);
    expect(out.dropped).toEqual({ before_epoch: 6 });
    // The live loader would drop the whole window as too old.
    expect((await (specs['nl-1-obs-key'] as SpecLoader).run(body, ctx)).dropped).toEqual({ too_old: 294 });
    const ahead = await (specs['nl-1-obs-sea-catchup'] as SpecLoader).run(catchupBody(fetchedAt + 20 * MIN, 3), ctx);
    expect(ahead.obs).toEqual([]);
    expect(ahead.dropped).toEqual({ future: 3 });
  });
});

describe('bumpsDue: when the deferred day bumps are flushed', () => {
  const at = Date.parse('2026-10-20T01:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const pending = (since: number, last: number) => ({
    days: { public: ['2026-10-02'] },
    since: iso(since),
    last: iso(last),
  });

  it('not while the catch-up runs paced (each payload within the quiet time) and its oldest day waited under an hour', () => {
    expect(bumpsDue(pending(at, at), at)).toBe(false);
    expect(bumpsDue(pending(at, at + 40 * MIN), at + 40 * MIN + BUMP_QUIET_MS - 1)).toBe(false);
  });

  it('an hour after the first deferral, however busy the catch-up still is', () => {
    expect(bumpsDue(pending(at, at + BUMP_DEFER_MS), at + BUMP_DEFER_MS)).toBe(true);
    expect(BUMP_DEFER_MS).toBe(60 * MIN);
  });

  it('once no catch-up payload came for the quiet time (the night window or the seed ended)', () => {
    expect(bumpsDue(pending(at, at + 10 * MIN), at + 10 * MIN + BUMP_QUIET_MS)).toBe(true);
    expect(BUMP_QUIET_MS).toBe(15 * MIN);
  });
});
