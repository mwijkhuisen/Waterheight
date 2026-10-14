import { Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFamilySources, readSources } from '../../src/api/health.ts';
import type { DB } from '../../src/db/generated.ts';
import { computeHealth } from '../../src/load/health.ts';
import { type Harness, harness } from '../load/harness.ts';

// P14a: backfill reconciliation in health. detail.backfill is written by computeHealth into every source with jobs
// and reaches the documents through the per-audience views: an owner source's numbers only in the owner family.

let h: Harness;
const NOW = new Date('2026-11-12T12:00:00Z');
const inputs = {
  cadenceS: new Map<string, number>(),
  lagP95Ms: new Map<string, number>(),
  backlog: { files: 0, bytes: 0, age_s: null },
  badLines: 0,
  now: NOW,
};
const kysely = (user: 'rws_api' | 'rws_owner_api') =>
  new Kysely<DB>({ dialect: new PostgresDialect({ pool: h.dbAs(user, 2).pool }) });
const job = (source: string, spec: string, status: string, chunks: number, ins: number, rev: number, unrec: number) =>
  h.t.admin.query(
    `INSERT INTO backfill_job (spec_id, source_id, series_key, range_from, range_to, chunk, cursor_ts, chunks_done,
                               chunks_with_data, status, request_budget, inserted, revised, unreconciled)
     VALUES ($1, $2, 'k', '2026-01-01Z', '2026-02-01Z', '1 day', '2026-01-01Z', $3, $3 - 1, $4, 100, $5, $6, $7)`,
    [spec, source, chunks, status, ins, rev, unrec],
  );

beforeAll(async () => {
  h = await harness();
  // Two NL-1 jobs (one active), one job of an owner source (BE-3) with numbers that must stay out of public output.
  await job('NL-1', 'nl-1-q', 'running', 3, 1000, 20, 1);
  await job('NL-1', 'nl-1-r', 'done', 5, 4000, 30, 0);
  await job('BE-3', 'be-3-levels', 'paused', 7, 987654, 4321, 2);
  // A backfill payload of NL-1 the loader set aside, and a live one that does not count (review C5/S6).
  await h.t.admin.query(
    `INSERT INTO ingest_batch (id, source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status, origin)
     VALUES (9001, 'NL-1', 'nl-1-backfill-obs', 'raw/x', now(), 1, 'quarantined', 'backfill'),
            (9002, 'NL-1', 'nl-1-obs-key', 'raw/y', now(), 1, 'quarantined', 'live')`,
  );
  await computeHealth(h.load.db, inputs);
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe('detail.backfill in health', { timeout: 60_000 }, () => {
  it('public sources show it for NL-1 only; the owner document has both; owner numbers stay out of public', async () => {
    const pub = await readSources(kysely('rws_api'), NOW);
    expect(pub.sources.filter((s) => s.backfill !== undefined).map((s) => s.id)).toEqual(['NL-1']);
    expect(pub.sources.find((s) => s.id === 'NL-1')?.backfill).toEqual({
      jobs: 2,
      active: 1,
      chunks_done: 8,
      chunks_with_data: 6,
      inserted: 5000,
      revised: 50,
      unreconciled: 1,
      quarantined: 1,
    });
    expect(JSON.stringify(pub)).not.toMatch(/987654|4321/);
    expect(pub.owner_sources.total).toBeGreaterThan(0);

    const own = await readFamilySources(kysely('rws_owner_api'), NOW, { sections: new Map(), log: undefined }, 'owner');
    expect(own.sources.find((s) => s.id === 'BE-3')?.backfill).toEqual({
      jobs: 1,
      active: 1,
      chunks_done: 7,
      chunks_with_data: 6,
      inserted: 987654,
      revised: 4321,
      unreconciled: 2,
      quarantined: 0,
    });
    expect(own.sources.find((s) => s.id === 'NL-1')?.backfill?.jobs).toBe(2);
  });

  it('a deleted job leaves no stale numbers', async () => {
    await h.t.admin.query(`DELETE FROM backfill_job WHERE source_id = 'BE-3'`);
    await computeHealth(h.load.db, inputs);
    const { rows } = await h.t.admin.query(
      `SELECT detail ? 'backfill' AS has FROM source_health WHERE source_id = 'BE-3'`,
    );
    expect(rows[0]?.has).toBe(false);
  });
});
