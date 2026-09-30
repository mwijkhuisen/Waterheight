import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureArchive, writePayload } from '../../../../scripts/fixture-archive.ts';
import { computeChecksums } from '../../src/load/health.ts';
import { reconcileRollups } from '../../src/load/reconcile.ts';
import { EMMERICH_W, type Harness, harness, KAUB_W, measurements, SERIES_URL } from './harness.ts';

// Incremental obs_1h / obs_1d equal a from-scratch aggregate over the same
// data (issue #17), also after a late revision; the nightly reconciliation
// finds nothing to repair, and repairs what is damaged on purpose.

let h: Harness;

beforeAll(async () => {
  h = await harness();
  await buildFixtureArchive(h.raw);
  await h.loader().tick();
});

afterAll(async () => {
  await h.close();
});

/** Rows of the rollup table that differ from a fresh aggregate of obs, in either direction. */
async function difference(table: 'obs_1h' | 'obs_1d', step: '1 hour' | '1 day'): Promise<number> {
  const fresh = `
    SELECT series_id, date_bin('${step}', ts, timestamptz '2000-01-01 00:00:00+00') AS bucket,
           min(value) AS vmin, max(value) AS vmax, avg(value)::real AS vavg,
           (array_agg(value ORDER BY ts DESC))[1] AS vlast, count(*)::int AS n, bit_or(qc) AS qc_or
    FROM obs GROUP BY 1, 2`;
  const stored = `SELECT series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or FROM ${table}`;
  const { rows } = await h.t.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ((${stored} EXCEPT ${fresh}) UNION ALL (${fresh} EXCEPT ${stored})) d`,
  );
  return rows[0]?.n ?? -1;
}

describe('rollups', () => {
  it('equal a from-scratch aggregate after the first load', async () => {
    expect(await h.count('obs_1h')).toBeGreaterThan(700);
    expect(await h.count('obs_1d')).toBeGreaterThan(30);
    expect(await difference('obs_1h', '1 hour')).toBe(0);
    expect(await difference('obs_1d', '1 day')).toBe(0);
  });

  it('still equal it after a late revision of an old value and a new last value in an old hour', async () => {
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: KAUB_W,
      at: new Date('2026-09-30T08:00:00Z'),
      // A corrected value three weeks back, and the last quarter of a past hour.
      body: measurements(['2026-09-09T12:45:00+02:00', 999], ['2026-09-30T09:45:00+02:00', -5]),
      url: SERIES_URL(KAUB_W),
    });
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-30T08:01:00Z'),
      body: measurements(
        ['2026-09-29T23:59:00+02:00', 7],
        ['2026-09-30T00:00:00+02:00', 8],
        ['2026-09-30T02:00:00+02:00', 9],
      ),
      url: SERIES_URL(EMMERICH_W),
    });
    expect(await h.loader().tick()).toEqual({ lines: 2, loaded: 2 });
    expect(await h.count('obs_revision')).toBe(1);
    expect(await difference('obs_1h', '1 hour')).toBe(0);
    expect(await difference('obs_1d', '1 day')).toBe(0);
    // The revised hour and its UTC day carry the new maximum; vlast follows ts, not arrival order.
    const id = await h.seriesId(KAUB_W);
    const hour = (
      await h.t.admin.query("SELECT vmax FROM obs_1h WHERE series_id = $1 AND bucket = '2026-09-09T10:00:00Z'", [id])
    ).rows;
    const day = (
      await h.t.admin.query("SELECT vmax FROM obs_1d WHERE series_id = $1 AND bucket = '2026-09-09T00:00:00Z'", [id])
    ).rows;
    expect(hour).toEqual([{ vmax: 999 }]);
    expect(day).toEqual([{ vmax: 999 }]);
    // 23:59+02:00 and 00:00+02:00 are 21:59Z and 22:00Z: two UTC hours, one UTC day (2026-09-29).
    const e = await h.seriesId(EMMERICH_W);
    const late = (
      await h.t.admin.query(
        "SELECT bucket, vlast FROM obs_1h WHERE series_id = $1 AND bucket >= '2026-09-29T21:00:00Z' ORDER BY 1",
        [e],
      )
    ).rows;
    expect(late).toEqual([
      { bucket: new Date('2026-09-29T21:00:00Z'), vlast: 7 },
      { bucket: new Date('2026-09-29T22:00:00Z'), vlast: 8 },
      { bucket: new Date('2026-09-30T00:00:00Z'), vlast: 9 },
    ]);
  });

  it('the nightly reconciliation repairs nothing when the loader was right, and repairs a damaged bucket', async () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(await reconcileRollups(h.load.db, now)).toEqual({ repaired: 0 });
    await h.t.admin.query("UPDATE obs_1h SET vmax = vmax + 1 WHERE bucket = '2026-09-29T10:00:00Z'");
    await h.t.admin.query("DELETE FROM obs_1d WHERE bucket = '2026-09-20T00:00:00Z'");
    const damagedHours = (
      await h.t.admin.query("SELECT count(*)::int AS n FROM obs_1h WHERE bucket = '2026-09-29T10:00:00Z'")
    ).rows[0].n;
    const { repaired } = await reconcileRollups(h.load.db, now);
    expect(repaired).toBe(damagedHours + 1);
    expect(await difference('obs_1h', '1 hour')).toBe(0);
    expect(await difference('obs_1d', '1 day')).toBe(0);
    expect(await reconcileRollups(h.load.db, now)).toEqual({ repaired: 0 });
  });
});

describe('partition checksums', () => {
  it('name a series by its registry key, per source and UTC month, and do not change on a replay', async () => {
    const sums = await computeChecksums(h.load.db);
    expect([...sums.keys()]).toEqual(['DE-1']);
    const de1 = sums.get('DE-1') ?? {};
    expect(Object.keys(de1).sort()).toEqual(['2026-08', '2026-09']);
    for (const p of Object.values(de1)) expect(p.md5).toMatch(/^[0-9a-f]{32}$/);
    expect((de1['2026-08']?.rows ?? 0) + (de1['2026-09']?.rows ?? 0)).toBe(await h.count('obs'));
    expect(await computeChecksums(h.load.db, 'DE-1')).toEqual(sums);
    // A series that its source withholds is not part of the source's checksum.
    const id = await h.seriesId(KAUB_W);
    await h.t.admin.query("UPDATE series SET audience = 'off' WHERE id = $1", [id]);
    const without = (await computeChecksums(h.load.db)).get('DE-1') ?? {};
    // KAUB is the only series with August rows (its 31-day seed): the month drops out, September shrinks.
    expect(without['2026-08']).toBeUndefined();
    expect(without['2026-09']?.rows).toBeLessThan(de1['2026-09']?.rows ?? 0);
    await h.t.admin.query('UPDATE series SET audience = NULL WHERE id = $1', [id]);
  });
});
