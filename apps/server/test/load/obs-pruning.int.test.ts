import { type ObsRow, QC } from '@rws/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lock, openBatch, type SeriesRow, seriesOf, type UpsertMode, upsertObs } from '../../src/load/store.ts';
import { type Harness, harness } from './harness.ts';

// #190: the upsert's join of obs and both rollups carry the payload's time range as constants, so the planner prunes
// every partition outside it at plan time and never opens one. The proof: another session holds a partition far from
// the payload under ACCESS EXCLUSIVE. A statement that cannot prune at plan time takes ACCESS SHARE on every partition
// and waits, which the 1 s lock_timeout turns into an error (55P03).

let h: Harness;
let nl1: Map<string, SeriesRow>;
let series: SeriesRow;
let n = 0;
const FAR = 'obs_y1960';
const NEWER = new Date('2026-10-06T00:00:00Z');
const OLDER = new Date('2026-10-05T23:00:00Z');

/** One payload in its own transaction, as the loader does it, but with a 1 s lock_timeout. */
async function load(mode: UpsertMode, at: Date, points: readonly { ts: string; value: number }[]) {
  n += 1;
  return h.load.db.transaction().execute(async (tx) => {
    await lock(tx);
    await sql`SET LOCAL lock_timeout = '1s'`.execute(tx);
    const batch = await openBatch(
      tx,
      {
        source: 'NL-1',
        spec: mode === 'backfill' ? 'nl-1-backfill-obs' : 'nl-1-obs-key',
        key: `prune/${n}`,
        sha256: null,
        fetchedAt: at,
        status: 200,
        bytes: null,
        adapterVersion: 1,
        ...(mode === 'backfill' ? { origin: 'backfill' as const } : {}),
      },
      'ok',
    );
    const rows: ObsRow[] = points.map((p) => ({ series: series.key, ts: p.ts, value: p.value, qc: QC.VALIDATED }));
    return upsertObs(tx, rows, nl1, batch.id, at, mode, []);
  });
}

/** Runs `fn` while the admin session holds the far partition. */
async function withFarLocked<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await h.t.admin.query('BEGIN');
    await h.t.admin.query(`LOCK TABLE ${FAR} IN ACCESS EXCLUSIVE MODE`);
    return await fn();
  } finally {
    await h.t.admin.query('ROLLBACK');
  }
}

/** 10-minute points from `start` for 3 hours; the last one has microseconds, which Date.parse drops. */
function points(start: string, base: number) {
  const t0 = Date.parse(start);
  const out = Array.from({ length: 18 }, (_, i) => ({
    ts: new Date(t0 + i * 600_000).toISOString(),
    value: base + i,
  }));
  out.push({ ts: new Date(t0 + 18 * 600_000).toISOString().replace('.000Z', '.000500Z'), value: base + 18 });
  return out;
}

async function stored(from: string, to: string) {
  const { rows } = await h.t.admin.query<{ n: number; sum: number }>(
    'SELECT count(*)::int AS n, sum(value)::float8 AS sum FROM obs WHERE series_id = $1 AND ts >= $2 AND ts < $3',
    [series.id, from, to],
  );
  return rows[0];
}

async function hourly(from: string, to: string) {
  const { rows } = await h.t.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM obs_1h WHERE series_id = $1 AND bucket >= $2 AND bucket < $3',
    [series.id, from, to],
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  h = await harness();
  nl1 = await seriesOf(h.load.db, 'NL-1');
  series = [...nl1.values()].filter((s) => !s.off && s.sameAudience).sort((a, b) => a.id - b.id)[0] as SeriesRow;
  // The far partition, and the payloads' own, made beforehand: the load under test creates none.
  await h.t.admin.query(
    `SELECT ensure_history_partitions('1960-01-01Z', '1960-12-31Z'),
            ensure_history_partitions('1965-01-01Z', '1965-12-31Z'),
            ensure_partitions('2026-09-01Z', '2026-10-31Z')`,
  );
}, 60_000);

afterAll(async () => {
  await h.close();
});

describe('#190: obs joins prune to the payload at plan time', () => {
  it('the far lock stops a read of obs with no time range (the method can fail)', async () => {
    await withFarLocked(async () => {
      await expect(
        h.load.db.transaction().execute(async (tx) => {
          await sql`SET LOCAL lock_timeout = '1s'`.execute(tx);
          await sql`SELECT count(*) FROM obs WHERE series_id = ${series.id}`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    });
  });

  /** A newer payload, then an older one with other values over the same instants. */
  async function newerThenOlder(mode: UpsertMode, start: string) {
    const to = new Date(Date.parse(start) + 4 * 3_600_000).toISOString();
    const first = await load(mode, NEWER, points(start, 100));
    expect(first.inserted).toBe(19);
    // The rollups ran: the four hours have a bucket.
    expect(await hourly(start, to)).toBe(4);
    const before = await stored(start, to);
    // The join finds every stored row, the last one (microseconds) included, so the older payload changes none.
    const second = await load(mode, OLDER, points(start, 500));
    expect(second).toMatchObject({ n_new: 0, n_changed: 0, inserted: 0, revised: 0 });
    expect(await stored(start, to)).toEqual(before);
  }

  it('a live payload opens no partition outside its days', async () => {
    await withFarLocked(() => newerThenOlder('live', '2026-10-05T10:00:00Z'));
  });

  // Review F1/F2: a payload that starts inside a bucket holding older rows, and crosses a month (two partitions).
  it('a payload from the middle of an hour into the next month recomputes whole buckets', async () => {
    const at = (s: string) => new Date(`2026-${s}Z`).toISOString();
    await withFarLocked(async () => {
      await load('live', NEWER, [
        { ts: at('09-30T23:00:00'), value: 1 },
        { ts: at('09-30T23:10:00'), value: 2 },
      ]);
      await load(
        'live',
        NEWER,
        Array.from({ length: 8 }, (_, i) => ({
          ts: new Date(Date.parse(at('09-30T23:20:00')) + i * 600_000).toISOString(),
          value: 3 + i,
        })),
      );
    });
    const { rows } = await h.t.admin.query<{ t: string; bucket: Date; n: number; vavg: number }>(
      `SELECT 'h' AS t, bucket, n, vavg FROM obs_1h WHERE series_id = $1 AND bucket = '2026-09-30T23:00Z'
       UNION ALL SELECT 'd', bucket, n, vavg FROM obs_1d WHERE series_id = $1 AND bucket IN ('2026-09-30Z', '2026-10-01Z')
       ORDER BY 1, 2`,
      [series.id],
    );
    expect(rows.map((r) => [r.t, r.bucket.toISOString(), r.n, r.vavg])).toEqual([
      ['d', '2026-09-30T00:00:00.000Z', 6, 3.5],
      ['d', '2026-10-01T00:00:00.000Z', 4, 8.5],
      ['h', '2026-09-30T23:00:00.000Z', 6, 3.5],
    ]);
  });

  // Without the far lock: ensure_history_partitions reads every partition's bound (pg_get_expr opens each one), which
  // is catalogue work, not a scan. 1965 has negative epoch milliseconds, so this checks the rollups' day bound there.
  it('a backfill payload before 1970 keeps its rows and rollups', async () => {
    await newerThenOlder('backfill', '1965-03-01T10:00:00Z');
  });
});
