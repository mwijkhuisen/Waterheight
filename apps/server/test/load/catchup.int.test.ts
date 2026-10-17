import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { DATA_EPOCH, PENDING_BUMPS_KEY, versionKey } from '../../src/load/dirty.ts';
import { catchupBody, LOBITH_H } from './catchup-body.ts';
import { type Harness, harness } from './harness.ts';

// P16b: the catch-up seeds through the real loader. A catch-up window loads in live mode however old it is (nothing
// before DATA_EPOCH), and its day bumps are deferred: the dirty rows are written per payload as ever, while the
// settled days it revises are bumped once per pending set (one bumpDays), an hour after the set's first deferral or
// once no catch-up payload came for 15 minutes, never once per payload.

const MIN = 60_000;
const EPOCH = Date.parse(DATA_EPOCH);
/** The first night of the catch-up, 50 days after the epoch: every day the windows reach is settled. */
const T0 = EPOCH + 50 * 86_400_000;

let h: Harness;
const q = async (text: string, args: unknown[] = []) => (await h.t.admin.query(text, args)).rows;
const meta = async <T>(key: string) =>
  (await q('SELECT value FROM app_meta WHERE key = $1', [key]))[0]?.value as T | undefined;
type Versions = Record<string, { v: number; reason: string }>;
type Pending = { days: Record<string, string[]>; since: string; last: string } | null;
const versions = (family: string) => meta<Versions>(versionKey(family as 'public' | 'owner'));

/** One catch-up payload of the lobith H series: 6 values before the epoch and 288 after it, fetched at `at`. */
let n = 0;
const put = (at: number) =>
  writePayload(h.archive, {
    source: 'NL-1',
    spec: 'nl-1-obs-sea-catchup',
    variant: 'lobith.bovenrijn.tolkamer/H',
    at: new Date(at),
    // Each payload moves every value, so each one revises the same days.
    body: catchupBody(EPOCH - 60 * MIN, 6 + 288, n++),
    url: 'https://example.org/OphalenWaarnemingen',
    method: 'POST',
    seed: true,
  });
const tick = (at: number) => h.loader({ now: new Date(at) }).tick();

beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(() => h.close());

describe('the catch-up through the loader', { timeout: 300_000 }, () => {
  let days: string[];

  it('loads a window older than 45 days in live mode, from DATA_EPOCH on, and defers its day bumps', async () => {
    await put(T0 - MIN);
    expect(await tick(T0)).toEqual({ lines: 1, loaded: 1 });
    const series = await h.seriesId(LOBITH_H);
    expect(await q('SELECT count(*)::int AS n, min(ts) AS first FROM obs WHERE series_id = $1', [series])).toEqual([
      { n: 288, first: new Date(EPOCH) },
    ]);
    expect(
      await q('SELECT origin, parse_status, n_rows, n_new, n_skipped FROM ingest_batch WHERE spec_id = $1', [
        'nl-1-obs-sea-catchup',
      ]),
    ).toEqual([{ origin: 'live', parse_status: 'ok', n_rows: 288, n_new: 288, n_skipped: 0 }]);
    // The dirty rows are written at once (both families: NL-1 is public), the bumps are not.
    expect(
      (await q('SELECT family, kind FROM publish_dirty ORDER BY family')).map((r) => `${r.family} ${r.kind}`),
    ).toEqual(['owner obs', 'public obs']);
    expect(await versions('public')).toBeUndefined();
    const pending = (await meta<Pending>(PENDING_BUMPS_KEY)) as NonNullable<Pending>;
    days = pending.days.public as string[];
    expect(days[0]).toBe(DATA_EPOCH.slice(0, 10));
    expect(days).toContain('2026-10-03');
    expect(pending).toEqual({
      days: { public: days, owner: days },
      since: new Date(T0).toISOString(),
      last: new Date(T0).toISOString(),
    });
    expect(h.alerts).toEqual([]);
  });

  it('flushes once the catch-up went quiet for 15 minutes: one bump for two payloads, then the set is cleared', async () => {
    expect(await tick(T0 + 10 * MIN)).toEqual({ lines: 0, loaded: 0 });
    await put(T0 + 12 * MIN - 1000);
    expect(await tick(T0 + 12 * MIN)).toEqual({ lines: 1, loaded: 1 });
    expect(await versions('public')).toBeUndefined();
    // 14 minutes after the last deferral: still waiting.
    expect(await tick(T0 + 26 * MIN)).toEqual({ lines: 0, loaded: 0 });
    expect(await versions('public')).toBeUndefined();
    expect(await tick(T0 + 28 * MIN)).toEqual({ lines: 0, loaded: 0 });
    for (const family of ['public', 'owner']) {
      const v = (await versions(family)) as Versions;
      expect(Object.keys(v).sort(), family).toEqual(days);
      for (const d of days) expect(v[d], `${family} ${d}`).toMatchObject({ v: 2, reason: 'revision' });
    }
    expect(await meta<Pending>(PENDING_BUMPS_KEY)).toBeNull();
    // Nothing pending: an idle tick writes nothing.
    expect(await tick(T0 + 40 * MIN)).toEqual({ lines: 0, loaded: 0 });
    expect(((await versions('public')) as Versions)[days[0] as string]?.v).toBe(2);
  });

  it('a paced catch-up is flushed at most once an hour, an hour after its first deferral', async () => {
    // Six payloads 14 minutes apart from T0 + 30 min: the quiet time never passes between two of them.
    const starts = [30, 44, 58, 72, 86, 100].map((m) => T0 + m * MIN);
    for (const [i, at] of starts.entries()) {
      await put(at - 1000);
      expect(await tick(at)).toEqual({ lines: 1, loaded: 1 });
      const v = ((await versions('public')) as Versions)[days[0] as string]?.v;
      // The set was opened at T0 + 30 min: the tick at T0 + 100 min is the first one past the hour.
      expect(v, `after payload ${i}`).toBe(i < 5 ? 2 : 3);
    }
    expect(await meta<Pending>(PENDING_BUMPS_KEY)).toBeNull();
    expect(
      (await q("SELECT count(*)::int AS n FROM publish_dirty WHERE family = 'public' AND kind = 'obs'"))[0]?.n,
    ).toBe(8);
  });
});

// Review SR-5: a malformed pending set never throws in the tick (it is cleared or replaced, with one alert), and a
// flush that fails is alerted and leaves the tail running.
describe('a malformed pending set and a failing flush', { timeout: 300_000 }, () => {
  const T1 = T0 + 200 * MIN;
  const iso = (ms: number) => new Date(ms).toISOString();
  const setMeta = (key: string, value: unknown) =>
    q(
      `INSERT INTO app_meta (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  const codes = () => h.alerts.map((a) => a.code);

  it('an idle tick clears a malformed set with one alert each, and stalls nothing', async () => {
    h.alerts.length = 0;
    const bad = [
      5,
      { days: { public: 'x' }, since: iso(T1), last: iso(T1) },
      { days: { public: ['2026-13-40'] }, since: iso(T1), last: iso(T1) },
      { days: {}, since: 'never', last: iso(T1) },
      { days: {}, since: iso(T1), last: iso(T1), more: 1 },
    ];
    for (const value of bad) {
      await setMeta(PENDING_BUMPS_KEY, value);
      expect(await tick(T1)).toEqual({ lines: 0, loaded: 0 });
      expect(await meta<Pending>(PENDING_BUMPS_KEY)).toBeNull();
    }
    expect(codes()).toEqual(bad.map(() => 'bump_pending_bad'));
    expect(h.alerts.every((a) => Object.keys(a.fields).length === 0)).toBe(true);
  });

  it('a catch-up payload replaces a malformed set with its own days, alerted once', async () => {
    h.alerts.length = 0;
    await setMeta(PENDING_BUMPS_KEY, { days: { public: ['not a day'] }, since: iso(T1), last: iso(T1) });
    await put(T1 + MIN - 1000);
    expect(await tick(T1 + MIN)).toEqual({ lines: 1, loaded: 1 });
    const pending = (await meta<Pending>(PENDING_BUMPS_KEY)) as NonNullable<Pending>;
    expect(pending.days.public?.[0]).toBe(DATA_EPOCH.slice(0, 10));
    expect([pending.since, pending.last]).toEqual([iso(T1 + MIN), iso(T1 + MIN)]);
    expect(h.alerts).toEqual([
      {
        code: 'bump_pending_bad',
        fields: expect.objectContaining({ source: 'NL-1', spec: 'nl-1-obs-sea-catchup', n: 1 }),
      },
    ]);
  });

  it('a failing flush is alerted, keeps the set and stalls no payload; the next good tick flushes', async () => {
    h.alerts.length = 0;
    const good = await versions('public');
    // A version map bumpDays cannot write into: the flush throws.
    await setMeta(versionKey('public'), 5);
    expect(await tick(T1 + 17 * MIN)).toEqual({ lines: 0, loaded: 0 });
    expect(h.alerts).toEqual([{ code: 'bump_flush_failed', fields: { code: 'unknown' } }]);
    expect(await meta<Pending>(PENDING_BUMPS_KEY)).not.toBeNull();
    // The tail still loads.
    await put(T1 + 18 * MIN - 1000);
    expect(await tick(T1 + 18 * MIN)).toEqual({ lines: 1, loaded: 1 });
    expect(codes()).not.toContain('load_stalled');
    await setMeta(versionKey('public'), good);
    expect(await tick(T1 + 34 * MIN)).toEqual({ lines: 0, loaded: 0 });
    expect(await meta<Pending>(PENDING_BUMPS_KEY)).toBeNull();
    expect(codes()).toEqual(['bump_flush_failed']);
  });
});
