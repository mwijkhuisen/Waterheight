import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK, MIGRATION, migrationSql, type Orphans, parseMigration } from '../../../../scripts/gen-184-orphans.ts';
import { type Harness, harness } from './harness.ts';

// #184 stage 2, PR B (D-5, B3): the orphan migration on a real database (the production roles and migrations, the
// real registry synced). The committed file runs as rws_migrator inside a transaction, as dbmate runs it. It deletes
// exactly the listed rows that are present and pass every guard; an absent row is counted; a present row that fails
// one guard aborts with nothing changed; the touched buckets equal a fresh rollup of what remains.

const MIGRATION_TEXT = readFileSync(MIGRATION, 'utf8');
const CHECK_TEXT = readFileSync(CHECK, 'utf8');
const up = (text: string) => text.slice(text.indexOf('-- migrate:up'), text.indexOf('-- migrate:down'));
const committed = parseMigration(MIGRATION_TEXT);
const keyOf = (r: { ix: number }) => committed.keys[r.ix - 1] as string;
const rowsOf = (key: string) => committed.rows.filter((r) => keyOf(r) === key);
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

const BORGHAREN = 'maastricht.borgharen.maas.beneden/Q/NVT/other:F006';
const EIJSDEN = 'eijsden.grens/Q/NVT/other:F216';
const OLST = 'olst/Q/NVT/other:F006';
const GRAVE_H = 'grave.boven/WATHTE/NAP/other:F007';
const MEGEN = 'megen.maas/Q/NVT/other:F103';
const LOBITH = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';

type Run = { error: string | null; notices: string[] };

let h: Harness;
let admin: pg.Client;
let backfill: number;
let live: number;

/** A migration's up section as rws_migrator in one transaction (dbmate's way): its notices, or its error. */
async function migrate(text: string): Promise<Run> {
  const c = await h.t.connectAs('rws_migrator');
  const notices: string[] = [];
  c.on('notice', (n) => notices.push(n.message ?? ''));
  try {
    await c.query('BEGIN');
    await c.query(up(text));
    await c.query('COMMIT');
    return { error: null, notices };
  } catch (err) {
    await c.query('ROLLBACK');
    return { error: (err as Error).message, notices };
  } finally {
    await c.end();
  }
}

/** The check file's report (one row per key), read as the owner reads it. */
async function check(): Promise<Record<string, Record<string, number>>> {
  const results = (await admin.query(CHECK_TEXT)) as unknown as pg.QueryResult[];
  const select = results.find((r) => r.command === 'SELECT') as pg.QueryResult;
  return Object.fromEntries(
    select.rows.map((r: Record<string, unknown>) => [
      r.key as string,
      Object.fromEntries(
        Object.entries(r)
          .filter(([k]) => k !== 'key')
          .map(([k, v]) => [k, Number(v)]),
      ),
    ]),
  );
}

const id = async (key: string) => h.seriesId(key);
const twin = async (key: string) => h.seriesId(`${key}/GEM24H`);

async function insertObs(series: number, ts: string, value: number, qc: number, batch: number) {
  await admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, $4, $5)', [
    series,
    ts,
    value,
    qc,
    batch,
  ]);
}

/** A listed row and its twin row, as the old code and PR A's replay left them. */
async function seedListed(r: { ix: number; epoch: number; value: number }, opts: { qc?: number; batch?: number } = {}) {
  const key = keyOf(r);
  await insertObs(await id(key), iso(r.epoch), r.value, opts.qc ?? 512 | 2, opts.batch ?? backfill);
  await insertObs(await twin(key), iso(r.epoch), r.value, 512 | 2, backfill);
}

/** The buckets of every non-aggregate series, recomputed from obs as the store and the reconciliation do. */
async function rebuildRollups() {
  for (const [table, width] of [
    ['obs_1h', '1 hour'],
    ['obs_1d', '1 day'],
  ] as const) {
    await admin.query(`DELETE FROM ${table}`);
    await admin.query(`
      INSERT INTO ${table} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
      SELECT o.series_id, date_bin('${width}', o.ts, timestamptz '2000-01-01 00:00:00+00'), min(o.value), max(o.value),
             avg(o.value)::real, (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)
      FROM obs o WHERE NOT EXISTS (SELECT 1 FROM series s WHERE s.id = o.series_id AND s.aggregate IS NOT NULL)
      GROUP BY 1, 2`);
  }
}

/** Rows of obs_1h and obs_1d that differ from a fresh rollup of obs (both ways): empty means exact. */
async function rollupDrift(): Promise<number> {
  let n = 0;
  for (const [table, width] of [
    ['obs_1h', '1 hour'],
    ['obs_1d', '1 day'],
  ] as const) {
    const fresh = `SELECT o.series_id, date_bin('${width}', o.ts, timestamptz '2000-01-01 00:00:00+00') AS bucket,
                          min(o.value) AS vmin, max(o.value) AS vmax, avg(o.value)::real AS vavg,
                          (array_agg(o.value ORDER BY o.ts DESC))[1] AS vlast, count(*)::int AS n, bit_or(o.qc) AS qc_or
                   FROM obs o WHERE NOT EXISTS (SELECT 1 FROM series s WHERE s.id = o.series_id AND s.aggregate IS NOT NULL)
                   GROUP BY 1, 2`;
    const stored = `SELECT series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or FROM ${table}`;
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ((${fresh} EXCEPT ${stored}) UNION ALL (${stored} EXCEPT ${fresh})) d`,
    );
    n += rows[0]?.n ?? 0;
  }
  return n;
}

/** md5 of a table's rows in a fixed order: "unchanged" means the same md5. */
async function md5(table: string, order: string): Promise<string> {
  const { rows } = await admin.query<{ m: string | null }>(
    `SELECT md5(string_agg(t::text, ',' ORDER BY ${order})) AS m FROM ${table} t`,
  );
  return rows[0]?.m ?? '';
}
const state = async () => ({
  obs: await md5('obs', 'series_id, ts'),
  obs_1h: await md5('obs_1h', 'series_id, bucket'),
  obs_1d: await md5('obs_1d', 'series_id, bucket'),
  obs_latest: await md5('obs_latest', 'series_id'),
  obs_revision: await md5('obs_revision', 'series_id, ts, changed_at'),
  ingest_batch: await md5('ingest_batch', 'id'),
  series: await md5('series', 'id'),
});

const notice = (run: Run, key: string) => run.notices.find((n) => n.startsWith(`184 orphans: ${key} `));

beforeAll(async () => {
  h = await harness();
  admin = h.t.admin;
  await admin.query(`SELECT ensure_history_partitions('1990-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`);
  await admin.query(`SELECT ensure_partitions('2026-07-01T00:00:00Z', '2026-12-01T00:00:00Z')`);
  const batch = async (key: string, origin: string) =>
    (
      await admin.query<{ id: number }>(
        `INSERT INTO ingest_batch (source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status, origin)
         VALUES ('NL-1', $1, $2, '2026-10-20T00:00:00Z', 3, 'ok', $3) RETURNING id`,
        [origin === 'backfill' ? 'nl-1-backfill-obs' : 'nl-1-obs-key', key, origin],
      )
    ).rows[0]?.id as number;
  backfill = await batch('backfill/1', 'backfill');
  live = await batch('live/1', 'live');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('the committed orphan migration (#184 PR B, D-5)', () => {
  it('on the synced registry with no rows it deletes nothing and counts every listed row absent', async () => {
    const before = await state();
    const run = await migrate(MIGRATION_TEXT);
    expect(run.error).toBeNull();
    expect(await state()).toEqual(before);
    expect(run.notices).toHaveLength(committed.keys.length);
    expect(notice(run, BORGHAREN)).toBe(`184 orphans: ${BORGHAREN} listed 7582, found 0, deleted 0, absent 7582`);
  });

  describe('on a database holding orphans, their twins, neighbours, live rows and buckets', () => {
    const borgharen = rowsOf(BORGHAREN);
    // A day with two listed stamps (11:00Z and 23:00Z, D-6): its daily bucket empties.
    const day = (r: { epoch: number }) => Math.floor(r.epoch / 86_400);
    const doubled = borgharen.filter((r) => borgharen.filter((s) => day(s) === day(r)).length === 2).slice(0, 2);
    const lone = borgharen[0] as (typeof borgharen)[number];
    const withNeighbours = borgharen[1] as (typeof borgharen)[number];
    const seeded = [lone, withNeighbours, ...doubled, ...rowsOf(EIJSDEN).slice(0, 2), ...rowsOf(GRAVE_H).slice(0, 1)];
    let before: Awaited<ReturnType<typeof state>>;
    let keep: string;

    beforeAll(async () => {
      expect(doubled).toHaveLength(2);
      for (const r of seeded) await seedListed(r);
      const b = await id(BORGHAREN);
      // Two unlisted readings in the hour of one orphan: that hour's bucket is recomputed, never deleted.
      await insertObs(b, iso(withNeighbours.epoch + 600), 1000, 512 | 2, backfill);
      await insertObs(b, iso(withNeighbours.epoch + 1200), 1010, 512 | 2, backfill);
      // Untouched: Megen Q F103 (D-1 keeps it), a live row with its obs_latest, an older obs_revision elsewhere.
      await insertObs(await id(MEGEN), '2024-03-01T00:10:00Z', 1051, 512, backfill);
      await insertObs(await id(LOBITH), '2026-10-30T12:00:00Z', 2100, 0, live);
      await admin.query(
        `INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, '2026-10-30T12:00:00Z', 2100, 0, $2)`,
        [await id(LOBITH), live],
      );
      await admin.query(
        `INSERT INTO obs_revision (series_id, ts, old_value, new_value, old_qc, new_qc, batch_id)
         VALUES ($1, '2026-10-30T12:00:00Z', 2000, 2100, 0, 0, $2)`,
        [await id(LOBITH), live],
      );
      await rebuildRollups();
      before = await state();
      // obs less the seeded listed rows: what must be byte-equal afterwards.
      const sids = await Promise.all(seeded.map((r) => id(keyOf(r))));
      const { rows } = await admin.query<{ m: string }>(
        `SELECT md5(string_agg(t::text, ',' ORDER BY series_id, ts)) AS m
         FROM obs t WHERE NOT EXISTS (SELECT 1 FROM unnest($1::int[], $2::timestamptz[]) AS l(s, ts)
                                      WHERE l.s = t.series_id AND l.ts = t.ts)`,
        [sids, seeded.map((r) => iso(r.epoch))],
      );
      keep = rows[0]?.m as string;
    }, 120_000);

    it('the check reports every seeded row present and no guard failing', async () => {
      const report = await check();
      expect(report[BORGHAREN]).toMatchObject({ listed: 7582, present: 4, absent: 7578 });
      expect(report[EIJSDEN]).toMatchObject({ present: 2 });
      expect(report[GRAVE_H]).toMatchObject({ present: 1 });
      expect(report[OLST]).toMatchObject({ present: 0, absent: 2590 });
      for (const row of Object.values(report))
        for (const [k, v] of Object.entries(row)) if (k.startsWith('fail_')) expect(v, k).toBe(0);
    });

    it('deletes exactly the seeded listed rows and recomputes their buckets', async () => {
      const run = await migrate(MIGRATION_TEXT);
      expect(run.error).toBeNull();
      expect(notice(run, BORGHAREN)).toBe(`184 orphans: ${BORGHAREN} listed 7582, found 4, deleted 4, absent 7578`);
      expect(notice(run, EIJSDEN)).toBe(`184 orphans: ${EIJSDEN} listed 1786, found 2, deleted 2, absent 1784`);
      expect(notice(run, GRAVE_H)).toBe(`184 orphans: ${GRAVE_H} listed 4, found 1, deleted 1, absent 3`);

      const after = await state();
      expect(await md5('obs', 'series_id, ts')).toBe(keep);
      expect(await h.count('obs')).toBe(
        // the seeded rows and their twins, the two neighbours, Megen, the live row; less the deleted listed rows
        seeded.length * 2 + 4 - seeded.length,
      );
      expect(await rollupDrift()).toBe(0);
      expect(after.obs_latest).toBe(before.obs_latest);
      expect(after.obs_revision).toBe(before.obs_revision);
      expect(after.ingest_batch).toBe(before.ingest_batch);
      expect(after.series).toBe(before.series);

      const b = await id(BORGHAREN);
      const bucket = async (table: string, width: string, epoch: number) =>
        (
          await admin.query<{ n: number }>(
            `SELECT n FROM ${table} WHERE series_id = $1
               AND bucket = date_bin('${width}', $2::timestamptz, timestamptz '2000-01-01 00:00:00+00')`,
            [b, iso(epoch)],
          )
        ).rows[0]?.n;
      expect(await bucket('obs_1h', '1 hour', lone.epoch)).toBeUndefined();
      expect(await bucket('obs_1h', '1 hour', withNeighbours.epoch)).toBe(2);
      expect(await bucket('obs_1d', '1 day', (doubled[0] as { epoch: number }).epoch)).toBeUndefined();

      const report = await check();
      for (const row of Object.values(report)) expect(row.present).toBe(0);
    });

    it('a second run deletes nothing', async () => {
      const before2 = await state();
      const run = await migrate(MIGRATION_TEXT);
      expect(run.error).toBeNull();
      expect(await state()).toEqual(before2);
      expect(notice(run, BORGHAREN)).toBe(`184 orphans: ${BORGHAREN} listed 7582, found 0, deleted 0, absent 7582`);
    });
  });

  describe('each guard, broken alone, aborts with nothing changed', () => {
    const r = rowsOf(OLST)[0] as (typeof committed.rows)[number];
    const ts = iso(r.epoch);

    const aborts = async (text: string, guard: string) => {
      await rebuildRollups();
      const before = await state();
      const run = await migrate(text);
      expect(run.error).toMatch(/fail a guard/);
      expect(run.error).toContain(`${guard} 1`);
      expect(await state()).toEqual(before);
      return run;
    };
    const cleanup = async () => {
      await admin.query('DELETE FROM obs WHERE series_id IN ($1, $2)', [await id(OLST), await twin(OLST)]);
      await admin.query('DELETE FROM obs_revision WHERE series_id = $1', [await id(OLST)]);
      await admin.query('DELETE FROM obs_latest WHERE series_id = $1', [await id(OLST)]);
    };

    it('qc bit 512', async () => {
      await seedListed(r, { qc: 2 });
      expect((await check())[OLST]).toMatchObject({ present: 1, fail_bit512: 1 });
      await aborts(MIGRATION_TEXT, 'bit512');
      await cleanup();
    });

    it("the batch's origin backfill (a live batch, and a batch that does not exist)", async () => {
      await seedListed(r, { batch: live });
      await aborts(MIGRATION_TEXT, 'origin');
      await cleanup();
      await seedListed(r, { batch: 987_654_321 });
      await aborts(MIGRATION_TEXT, 'origin');
      await cleanup();
    });

    it('a ts before DATA_FLOOR (a synthetic list, since the committed one holds no later row)', async () => {
      const at = Date.parse('2026-08-01T00:00:00Z') / 1000;
      const synthetic: Orphans = { keys: [OLST], rows: [{ ix: 1, epoch: at, value: 42 }] };
      await insertObs(await id(OLST), iso(at), 42, 512, backfill);
      await insertObs(await twin(OLST), iso(at), 42, 512, backfill);
      await aborts(migrationSql(synthetic), 'floor');
      await cleanup();
    });

    it('the census value', async () => {
      await insertObs(await id(OLST), ts, r.value + 1, 512, backfill);
      await insertObs(await twin(OLST), ts, r.value, 512, backfill);
      await aborts(MIGRATION_TEXT, 'value');
      await cleanup();
    });

    it('the twin row at the same instant (missing, then with another value)', async () => {
      await insertObs(await id(OLST), ts, r.value, 512, backfill);
      await aborts(MIGRATION_TEXT, 'twin_row');
      await insertObs(await twin(OLST), ts, r.value + 1, 512, backfill);
      await aborts(MIGRATION_TEXT, 'twin_row');
      await cleanup();
    });

    it('the twin series (a database without the twins)', async () => {
      await seedListed(r);
      const t = await twin(OLST);
      await admin.query(`UPDATE series SET provider_key = provider_key || '-gone' WHERE id = $1`, [t]);
      try {
        await aborts(MIGRATION_TEXT, 'twin_series');
      } finally {
        await admin.query(`UPDATE series SET provider_key = left(provider_key, -5) WHERE id = $1`, [t]);
      }
      await cleanup();
    });

    it('not the obs_latest row', async () => {
      await seedListed(r);
      await admin.query('INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 512, $4)', [
        await id(OLST),
        ts,
        r.value,
        backfill,
      ]);
      await aborts(MIGRATION_TEXT, 'latest');
      await cleanup();
    });

    it('no obs_revision', async () => {
      await seedListed(r);
      await admin.query(
        `INSERT INTO obs_revision (series_id, ts, old_value, new_value, old_qc, new_qc, batch_id)
         VALUES ($1, $2, 1, $3, 512, 512, $4)`,
        [await id(OLST), ts, r.value, backfill],
      );
      await aborts(MIGRATION_TEXT, 'revision');
      await cleanup();
    });
  });
});
