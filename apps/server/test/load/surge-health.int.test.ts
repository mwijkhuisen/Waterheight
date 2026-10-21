import { HealthSourcesAnswer } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { computeHealth } from '../../src/load/health.ts';
import { type Harness, harness } from './harness.ts';

// P18a (D-7): `detail.surge = {tidal, astro, surge}` per source with tier-1 tidal primary series: those series, those
// with an astronomical row within a day of now, and of those the ones whose newest value (within its staleness limit)
// has an astro row at exactly its timestamp. Counts only; a source with no such series has no key.

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const NOW = Date.parse('2026-10-26T14:00:00Z');

let h: Harness;
const q = async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;
const health = () =>
  computeHealth(h.load.db, {
    cadenceS: new Map(),
    lagP95Ms: new Map(),
    backlog: { files: 0, bytes: 0, age_s: null },
    badLines: 0,
    now: new Date(NOW),
  });
const detail = async (source: string) =>
  (await q<{ detail: Record<string, unknown> }>('SELECT detail FROM source_health WHERE source_id = $1', [source]))[0]
    ?.detail;
const latest = (series: number, ts: number) =>
  q('INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 120, 0, 1)', [series, iso(ts)]);
const astro = (series: number, ...ts: number[]) =>
  q(
    `INSERT INTO tide (series_id, kind, ts, value, batch_id) SELECT $1, 'astro', t, 100, 1 FROM unnest($2::timestamptz[]) t`,
    [series, ts.map(iso)],
  );
/** Active primary H series of NL-1 at stations of the given tier whose tidal flag is as given, by id. */
const seriesOf = (tier: 1 | 2, tidal: boolean) =>
  q<{ id: number; staleness_s: number }>(
    `SELECT s.id, extract(epoch FROM s.staleness_limit)::int AS staleness_s
     FROM series s JOIN station st ON st.id = s.station_id
     WHERE s.source_id = 'NL-1' AND s.role = 'primary' AND s.active AND s.quantity = 'H' AND st.tier = $1
       AND (st.flags ->> 'tidal') IS NOT DISTINCT FROM $2 ORDER BY s.id`,
    [tier, `${tidal}`],
  );

beforeAll(async () => {
  h = await harness();
}, 300_000);

afterAll(async () => {
  await h?.close();
});

describe('detail.surge', { timeout: 300_000 }, () => {
  it('a source with tier-1 tidal series and no astro is {tidal: n, astro: 0, surge: 0}', async () => {
    await health();
    const [{ n } = { n: 0 }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM series s JOIN station st ON st.id = s.station_id
       WHERE s.source_id = 'NL-1' AND s.role = 'primary' AND s.active AND st.tier = 1 AND st.flags ->> 'tidal' = 'true'`,
    );
    expect(n).toBeGreaterThanOrEqual(27);
    expect((await detail('NL-1'))?.surge).toEqual({ tidal: n, astro: 0, surge: 0 });
  });

  it('counts astro within a day and the astro row at the newest value, and nothing else', async () => {
    const tidal = await seriesOf(1, true);
    const [a, b, c] = tidal as [(typeof tidal)[number], (typeof tidal)[number], (typeof tidal)[number]];
    // A: newest value 10 min ago with an astro row at exactly that instant: astro and surge.
    await latest(a.id, NOW - 10 * MIN);
    await astro(a.id, NOW - 10 * MIN, NOW - 20 * MIN);
    // B: newest value 10 min ago, astro rows only at other instants: astro, no surge.
    await latest(b.id, NOW - 10 * MIN);
    await astro(b.id, NOW - 5 * MIN, NOW + 5 * MIN);
    // C: its newest value is past its staleness limit (the astro row at its instant does not make a surge).
    const old = NOW - (c.staleness_s + 60) * 1000;
    await latest(c.id, old);
    await astro(c.id, old, NOW - 5 * MIN);
    // Not counted: a non-tidal tier-1 series, a tier-2 tidal series, a tidal series whose astro is a day and more old.
    const [river] = await seriesOf(1, false);
    const [lower] = await seriesOf(2, true);
    const d = tidal[3] as (typeof tidal)[number];
    for (const s of [river, lower, d]) {
      const id = (s as { id: number }).id;
      await latest(id, NOW - 10 * MIN);
      await astro(id, s === d ? NOW - 26 * 60 * MIN : NOW - 10 * MIN);
    }
    await health();
    const surge = (await detail('NL-1'))?.surge as { tidal: number; astro: number; surge: number };
    expect(surge).toEqual({ tidal: tidal.length, astro: 3, surge: 1 });
    // The key is replaced on every pass, and counts nothing for a source without tidal series.
    await q('DELETE FROM tide WHERE series_id = $1', [a.id]);
    await health();
    expect((await detail('NL-1'))?.surge).toEqual({ tidal: tidal.length, astro: 2, surge: 0 });
  });

  it('a source with no tier-1 tidal series has no surge key (DE-1: its 9 tidal gauges are tier 2)', async () => {
    expect(await detail('LU-1')).not.toHaveProperty('surge');
    expect(await detail('DE-1')).not.toHaveProperty('surge');
  });

  it('the public health document carries the counts (null for a source without) and the contract accepts it', async () => {
    const api = h.dbAs('rws_api', 2);
    try {
      const app = createApp({ db: api.db, now: () => new Date(NOW + MIN) });
      const res = await app.request('/api/v1/health/sources');
      expect(res.status).toBe(200);
      const doc = HealthSourcesAnswer.parse(await res.json());
      expect(doc.sources.find((s) => s.id === 'NL-1')?.surge).toMatchObject({ astro: 2, surge: 0 });
      expect(doc.sources.find((s) => s.id === 'LU-1')?.surge).toBeNull();
    } finally {
      await api.close();
    }
  });
});
