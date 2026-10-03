import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SchemaDrift } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bareLine,
  buildFixtureArchive,
  buildNlFixtureArchive,
  recorded,
  writePayload,
} from '../../../../scripts/fixture-archive.ts';
import { LOAD_ADAPTERS, type LoadAdapter, type SpecLoader } from '../../src/load/adapters.ts';
import { nothingToLoad } from '../../src/load/pipeline.ts';
import { replay } from '../../src/load/replay.ts';
import { EMMERICH_W, type Harness, harness, measurements, RUHRWEHR_W, SERIES_URL } from './harness.ts';

/** An empty backlog, over every line and over the public sources' lines (P5c, KG-075). */
const NONE = { files: 0, bytes: 0, age_s: null };

// The loader on the recorded DE-1 archive (issue #17): replaying it gives the
// identical checksum, no new row and no revision; one changed value gives
// exactly one revision; nothing is lost, skipped or applied twice.

let h: Harness;
const MAXAU_Q = 'b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea/Q';

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

const replayAll = () =>
  replay(
    {
      db: h.load.db,
      reader: h.reader,
      alert: (code, fields = {}) => h.alerts.push({ code, fields }),
      now: () => new Date(),
    },
    { source: 'DE-1', spec: null, from: '2026-08-01', to: '2026-12-31', dryRun: false },
  );
const batches = async () =>
  (
    await h.t.admin.query(
      'SELECT id, archive_key, parse_status, n_rows, n_new, n_changed, loaded_at FROM ingest_batch ORDER BY id',
    )
  ).rows;
const cursor = async () =>
  Object.fromEntries(
    (await h.t.admin.query('SELECT manifest_file, byte_offset FROM load_cursor')).rows.map((r) => [
      r.manifest_file,
      Number(r.byte_offset),
    ]),
  );
const manifestSizes = async () => Object.fromEntries((await h.reader.manifests()).map((m) => [m.file, m.size]));

describe('load and replay of the fixture archive', () => {
  let first: Record<string, string>;

  it('loads every payload: rows in the right partitions, latest values, gauge zeros, one batch per payload', async () => {
    const written = await buildFixtureArchive(h.raw);
    expect(written).toHaveLength(6);
    const result = await h.loader().tick();
    expect(result).toEqual({ lines: 6, loaded: 6 });
    expect(h.alerts).toEqual([]);

    // basin 237 + Emmerich 24 + Kaub 2973 + Ruhrwehr 23 + Maxau 23, minus the rows two payloads share.
    const n = await h.count('obs');
    expect(n).toBeGreaterThan(3200);
    expect(n).toBeLessThanOrEqual(237 + 24 + 2973 + 23 + 23);
    const parts = await h.t.admin.query(
      'SELECT tableoid::regclass::text AS p, count(*)::int AS n FROM obs GROUP BY 1 ORDER BY 1',
    );
    expect(parts.rows.map((r) => r.p)).toEqual(['obs_2026_08', 'obs_2026_09']);
    // 181 gauge zeros in the metadata call, less NEUWIED STADT's.
    expect(await h.count('gauge_zero')).toBe(180);
    expect(await h.count('obs_revision')).toBe(0);
    // 237 basin values, less NEUWIED STADT: audience off (its licence is unverified), so nothing of it is stored.
    expect(await h.count('obs_latest')).toBe(236);
    const neuwied = await h.seriesId('dc407f1e-e25f-4995-9feb-5bacc8658149/W');
    expect((await h.t.admin.query('SELECT count(*)::int AS n FROM obs WHERE series_id = $1', [neuwied])).rows).toEqual([
      { n: 0 },
    ]);
    expect((await batches()).map((b) => [b.parse_status, b.n_changed])).toEqual(Array(6).fill(['ok', 0]));
    // The sentinel of the recorded payload is nowhere.
    const { rows } = await h.t.admin.query('SELECT count(*)::int AS n FROM obs WHERE value >= 99999');
    expect(rows).toEqual([{ n: 0 }]);
    // The cursor is at the end of every manifest file.
    expect(await cursor()).toEqual(await manifestSizes());
    first = await h.checksums();
  });

  it('a second pass has nothing to read; a replay writes 0 rows, 0 revisions and leaves every batch untouched', async () => {
    const before = await batches();
    const rows = await h.count('obs');
    expect(await h.loader().tick()).toEqual({ lines: 0, loaded: 0 });

    for (let pass = 0; pass < 2; pass++) {
      const result = await replayAll();
      expect(result).toEqual({ lines: 6, loaded: 6, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
      expect(await h.checksums()).toEqual(first);
      expect(await h.count('obs')).toBe(rows);
      expect(await h.count('obs_revision')).toBe(0);
      expect(await batches()).toEqual(before);
    }
    // A replay never moves the cursor.
    expect(await cursor()).toEqual(await manifestSizes());
  });

  it('m+NN is stored ×100, a 1-minute series on its 15-minute grid plus its snapshot value as published', async () => {
    const id = await h.seriesId(RUHRWEHR_W);
    const { rows } = await h.t.admin.query('SELECT ts, value FROM obs WHERE series_id = $1 ORDER BY ts', [id]);
    expect(new Set(rows.map((r) => r.value))).toEqual(new Set([2500]));
    expect(rows).toHaveLength(24);
    expect(rows[0].ts.toISOString()).toBe('2026-09-29T13:15:00.000Z');
  });

  it('a changed value produces exactly one obs_revision row and updates latest and rollups', async () => {
    const id = await h.seriesId(EMMERICH_W);
    const before = (
      await h.t.admin.query('SELECT value, batch_id FROM obs WHERE series_id = $1 AND ts = $2', [
        id,
        '2026-09-29T13:30:00Z',
      ])
    ).rows[0];
    expect(before.value).toBe(-28);
    // A later fetch publishes a corrected value for 15:30 and one new point.
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-29T14:40:00Z'),
      body: measurements(['2026-09-29T15:30:00+02:00', -27], ['2026-09-29T15:45:00+02:00', -26]),
      url: SERIES_URL(EMMERICH_W),
    });
    expect(await h.loader().tick()).toEqual({ lines: 1, loaded: 1 });
    const revisions = (
      await h.t.admin.query('SELECT series_id, ts, old_value, new_value, old_qc, new_qc FROM obs_revision')
    ).rows;
    expect(revisions).toEqual([
      { series_id: id, ts: new Date('2026-09-29T13:30:00Z'), old_value: -28, new_value: -27, old_qc: 1, new_qc: 1 },
    ]);
    const latest = (await h.t.admin.query('SELECT ts, value FROM obs_latest WHERE series_id = $1', [id])).rows[0];
    expect(latest).toEqual({ ts: new Date('2026-09-29T13:45:00Z'), value: -26 });
    const batch = (await batches()).at(-1);
    expect(batch).toMatchObject({ parse_status: 'ok', n_rows: 2, n_new: 1, n_changed: 1 });
    const hour = (
      await h.t.admin.query(
        "SELECT vmax, vlast, n FROM obs_1h WHERE series_id = $1 AND bucket = '2026-09-29T13:00:00Z'",
        [id],
      )
    ).rows[0];
    // 13:00, 13:15, 13:30 (corrected) and 13:45 (new): the rollup was recomputed from all four.
    expect(hour).toEqual({ vmax: -26, vlast: -26, n: 4 });

    // Replaying everything again: the older payload must not bring -28 back, and nothing is written.
    const sums = await h.checksums();
    const result = await replayAll();
    expect(result).toMatchObject({ n_new: 0, n_changed: 0, quarantined: 0 });
    expect(await h.checksums()).toEqual(sums);
    expect(await h.count('obs_revision')).toBe(1);
  });

  it('an older payload that arrives after a newer one never reverts a value (newest fetch wins)', async () => {
    const id = await h.seriesId(EMMERICH_W);
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-29T14:00:00Z'), // fetched before the correction above
      body: measurements(['2026-09-29T15:30:00+02:00', -99], ['2026-09-29T15:50:00+02:00', -31]),
      url: SERIES_URL(EMMERICH_W),
    });
    await h.loader().tick();
    const rows = (
      await h.t.admin.query(
        "SELECT ts, value FROM obs WHERE series_id = $1 AND ts >= '2026-09-29T13:30:00Z' ORDER BY ts",
        [id],
      )
    ).rows;
    expect(rows.map((r) => r.value)).toEqual([-27, -26, -31]);
    expect(await h.count('obs_revision')).toBe(1);
  });

  it("a late line appended to an older day's manifest file is still consumed, and its value lands", async () => {
    const before = await h.count('obs');
    // Day 2026-09-30 is already consumed; this line is filed under 2026-09-29.
    // Maxau Q: no payload loaded so far states this point (the Kaub seed would, and is newer).
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: MAXAU_Q,
      at: new Date('2026-09-29T23:59:59Z'),
      body: measurements(['2026-09-30T01:45:00+02:00', 2]),
      url: SERIES_URL(MAXAU_Q),
    });
    expect((await h.reader.manifests()).map((m) => m.file)).toEqual(['2026-09-29.jsonl', '2026-09-30.jsonl']);
    expect(await h.loader().tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await h.count('obs')).toBe(before + 1);
    const id = await h.seriesId(MAXAU_Q);
    const { rows } = await h.t.admin.query('SELECT value FROM obs WHERE series_id = $1 AND ts = $2', [
      id,
      '2026-09-29T23:45:00Z',
    ]);
    expect(rows).toEqual([{ value: 2 }]);
    expect(await cursor()).toEqual(await manifestSizes());
  });

  it('lines without a payload move the cursor and the fetch health, and add no rows and no batch', async () => {
    const at = (s: string) => new Date(`2026-09-30T08:${s}Z`);
    const rowsBefore = await h.count('obs');
    const batchesBefore = await h.count('ingest_batch');
    const known = (await batches())[0]?.archive_key as string;
    await h.archive.append(bareLine('DE-1', 'de-1-basin', at('00:00'), { status: 304 }));
    await h.archive.append(
      bareLine('DE-1', 'de-1-basin', at('15:00'), { dup_of: known, sha256: 'a'.repeat(64), bytes: 10 }),
    );
    await h.archive.append(bareLine('DE-1', 'de-1-series', at('16:00'), { status: null, error: 'timeout' }));
    await h.archive.append(bareLine('DE-1', 'de-1-series', at('17:00'), { status: 503 }));
    await h.archive.append(bareLine('DE-1', 'de-1-series', at('18:00'), { status: 404 }));
    // An owner-audience spec P1 captures: no adapter until P5c, so it is skipped.
    await writePayload(h.archive, {
      source: 'BE-3',
      spec: 'be-3-levels',
      variant: '',
      at: at('19:00'),
      body: Buffer.from('{"synthetic":true}'),
      url: 'https://example.org/',
    });
    expect(await h.loader().tick()).toEqual({ lines: 6, loaded: 0 });
    expect(await h.count('obs')).toBe(rowsBefore);
    expect(await h.count('ingest_batch')).toBe(batchesBefore);
    expect(h.alerts).toEqual([]);
    const health = (
      await h.t.admin.query(
        "SELECT source_id, last_fetch_ok, consecutive_failures FROM source_health WHERE source_id IN ('DE-1', 'BE-3') ORDER BY 1",
      )
    ).rows;
    expect(health).toEqual([
      { source_id: 'BE-3', last_fetch_ok: at('19:00'), consecutive_failures: 0 },
      // 304 and dup_of were fine; then three failures in a row.
      { source_id: 'DE-1', last_fetch_ok: at('15:00'), consecutive_failures: 3 },
    ]);
    expect(await cursor()).toEqual(await manifestSizes());
  });

  it('a failed-validity payload and an unattributable recovered payload are skipped, not drift', async () => {
    const at = new Date('2026-09-30T09:00:00Z');
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at,
      body: Buffer.from('[]'),
      url: SERIES_URL(EMMERICH_W),
      validity: { ok: false, reason: 'count', count: 0 },
    });
    const recovered = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: '',
      at: new Date('2026-09-30T09:01:00Z'),
      body: measurements(['2026-09-30T10:45:00+02:00', 5]),
      url: SERIES_URL(EMMERICH_W),
    });
    expect(recovered.variant).toBe('');
    expect(await h.loader().tick()).toEqual({ lines: 2, loaded: 0 });
    const last = (await h.t.admin.query('SELECT parse_status, error FROM ingest_batch ORDER BY id DESC LIMIT 2')).rows;
    expect(last).toEqual([
      { parse_status: 'skipped', error: 'recovered_unattributed' },
      { parse_status: 'skipped', error: 'failed_validity' },
    ]);
    expect(h.alerts).toEqual([]);
    const health = (await h.t.admin.query("SELECT consecutive_failures FROM source_health WHERE source_id = 'DE-1'"))
      .rows;
    expect(health).toEqual([{ consecutive_failures: 0 }]);
  });

  it('a damaged manifest line is counted, reported and stepped over; a torn last line is left for later', async () => {
    const file = join(h.raw, '_manifest', '2026-09-30.jsonl');
    appendFileSync(file, '{"v":1,"source":"DE-1"\n');
    appendFileSync(file, '{"v":2,"future":"format"}\n');
    appendFileSync(file, '{"v":1,"source":"DE-1","spec":"de-1-basin","torn');
    const loader = h.loader();
    expect(await loader.tick()).toEqual({ lines: 2, loaded: 0 });
    expect(loader.badLines).toBe(2);
    expect(h.alerts.splice(0).map((a) => a.code)).toEqual(['manifest_bad_line', 'manifest_bad_line']);
    const sizes = await manifestSizes();
    const torn = '{"v":1,"source":"DE-1","spec":"de-1-basin","torn'.length;
    expect((await cursor())['2026-09-30.jsonl']).toBe((sizes['2026-09-30.jsonl'] as number) - torn);
    // A torn last line is still being written: backlog bytes, but no unconsumed line to age.
    expect(await loader.backlog()).toEqual({
      files: 1,
      bytes: torn,
      age_s: null,
      // P5c (KG-075): what public health shows, the lines of non-owner sources; a torn line names none and counts.
      public: { files: 1, bytes: torn, age_s: null },
    });
    // Nor does it hold up the checksums and the nightly jobs if it is never completed (review N7).
    expect(nothingToLoad(await loader.backlog())).toBe(true);
    // The torn line ends as a damaged one, and another follows. Damaged whole lines are skipped when the backlog is
    // aged: the first manifest line after them counts (review R2-6).
    appendFileSync(file, '\n{"v":1,"damaged"\n');
    expect(await loader.backlog()).toMatchObject({ files: 1, age_s: null });
    const at = new Date('2026-09-30T07:00:00Z');
    appendFileSync(file, `${JSON.stringify(bareLine('DE-1', 'de-1-basin', at, { status: 304 }))}\n`);
    const later = new Date(at.getTime() + 20 * 60_000);
    expect(await loader.backlog(later)).toMatchObject({ files: 1, age_s: 1200 });
    expect(nothingToLoad(await loader.backlog(later))).toBe(false);
    expect(await loader.tick()).toEqual({ lines: 3, loaded: 0 });
    expect(await loader.backlog()).toEqual({ ...NONE, public: NONE });
    h.alerts.length = 0;
  });
});

describe('atomicity: a payload is one transaction', () => {
  it('when the last statement of the transaction fails, nothing of the payload is stored and the cursor stays', async () => {
    const h2 = await harness();
    try {
      await buildFixtureArchive(h2.raw);
      // The cursor write is the last statement of every load transaction: make it fail.
      await h2.t.admin.query(`
        CREATE FUNCTION fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'killed' USING ERRCODE = '57P01'; END $$;
        CREATE TRIGGER fail_cursor BEFORE INSERT OR UPDATE ON load_cursor FOR EACH ROW EXECUTE FUNCTION fail_cursor();`);
      const loader = h2.loader();
      expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
      for (const table of [
        'obs',
        'obs_latest',
        'obs_1h',
        'obs_1d',
        'gauge_zero',
        'ingest_batch',
        'load_cursor',
        'source_health',
      ]) {
        expect(await h2.count(table), table).toBe(0);
      }
      // The database is back: the same lines load exactly once.
      await h2.t.admin.query('DROP TRIGGER fail_cursor ON load_cursor');
      expect(await loader.tick()).toEqual({ lines: 6, loaded: 6 });
      expect(await h2.count('ingest_batch')).toBe(6);
      expect(await h2.count('obs_revision')).toBe(0);
      expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
    } finally {
      await h2.close();
    }
  });

  it('duplicate timestamps in one payload and a session in another time zone change nothing', async () => {
    const h2 = await harness();
    try {
      await h2.t.admin.query(`ALTER DATABASE ${h2.t.name} SET timezone = 'Europe/Amsterdam'`);
      const load = h2.dbAs('rws_load');
      const { Loader } = await import('../../src/load/pipeline.ts');
      const loader = new Loader({
        db: load.db,
        reader: h2.reader,
        alert: (code) => h2.alerts.push({ code, fields: {} }),
        now: () => new Date(),
      });
      await buildFixtureArchive(h2.raw);
      await loader.tick();
      await writePayload(h2.archive, {
        source: 'DE-1',
        spec: 'de-1-series',
        variant: EMMERICH_W,
        at: new Date('2026-09-30T10:00:00Z'),
        body: measurements(
          ['2026-09-30T11:30:00+02:00', 1],
          ['2026-09-30T11:30:00+02:00', 2],
          ['2026-09-30T11:45:00+02:00', 3],
        ),
        url: SERIES_URL(EMMERICH_W),
      });
      expect(await loader.tick()).toEqual({ lines: 1, loaded: 1 });
      expect(h2.alerts).toEqual([]);
      const id = await h2.seriesId(EMMERICH_W);
      const rows = (
        await h2.t.admin.query(
          "SELECT value FROM obs WHERE series_id = $1 AND ts >= '2026-09-30T09:30:00Z' ORDER BY ts",
          [id],
        )
      ).rows;
      expect(rows.map((r) => r.value)).toEqual([2, 3]);
      // Buckets are UTC hours and days although the loader's session is in Amsterdam.
      const drift = await h2.t.admin.query(`
        SELECT count(*)::int AS n FROM (
          (SELECT series_id, bucket, n FROM obs_1d
           EXCEPT SELECT series_id, date_bin('1 day', ts, timestamptz '2000-01-01 00:00:00+00'), count(*)::int FROM obs GROUP BY 1, 2)
          UNION ALL
          (SELECT series_id, date_bin('1 day', ts, timestamptz '2000-01-01 00:00:00+00'), count(*)::int FROM obs GROUP BY 1, 2
           EXCEPT SELECT series_id, bucket, n FROM obs_1d)) d`);
      expect(drift.rows).toEqual([{ n: 0 }]);
      const sums = await h2.checksums();
      await replay(
        { db: load.db, reader: h2.reader, alert: () => {}, now: () => new Date() },
        { source: 'DE-1', spec: null, from: '2026-09-01', to: '2026-10-31', dryRun: false },
      );
      expect(await h2.checksums()).toEqual(sums);
      expect(await h2.count('obs_revision')).toBe(0);
    } finally {
      await h2.close();
    }
  });
});

describe('newest fetch wins, whatever order the payloads arrive in (review C2, C3)', () => {
  let n: Harness;
  let keys: string[];
  beforeAll(async () => {
    n = await harness();
    // Series of 15-minute steps (no thinning) that share their source's audience.
    keys = (
      await n.t.admin.query(
        `SELECT provider_key FROM series WHERE source_id = 'DE-1' AND quantity = 'H' AND native_step = '15 minutes'
           AND audience IS NULL AND active ORDER BY provider_key LIMIT 12`,
      )
    ).rows.map((r) => r.provider_key);
  });
  afterAll(async () => {
    await n.close();
  });

  const fetched = (hhmm: string) => new Date(`2026-09-30T${hhmm}:00Z`);
  // One point, 09:45Z, in every payload.
  const put = (variant: string, hhmm: string, value: number) =>
    writePayload(n.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant,
      at: fetched(hhmm),
      body: measurements(['2026-09-30T11:45:00+02:00', value]),
      url: SERIES_URL(variant),
    });
  const stored = async (variant: string) =>
    (
      await n.t.admin.query(
        `SELECT o.value, o.qc, b.fetched_at, l.value AS latest, lb.fetched_at AS latest_fetched, r.vlast
         FROM obs o JOIN ingest_batch b ON b.id = o.batch_id
         JOIN obs_latest l ON l.series_id = o.series_id JOIN ingest_batch lb ON lb.id = l.batch_id
         JOIN obs_1h r ON r.series_id = o.series_id AND r.bucket = '2026-09-30T09:00:00Z'
         WHERE o.series_id = $1 AND o.ts = '2026-09-30T09:45:00Z'`,
        [await n.seriesId(variant)],
      )
    ).rows;
  const revisions = async (variant: string) =>
    (
      await n.t.admin.query('SELECT count(*)::int AS n FROM obs_revision WHERE series_id = $1', [
        await n.seriesId(variant),
      ])
    ).rows[0].n as number;
  const replayDay = (adapters?: Record<string, LoadAdapter>) =>
    replay(
      { db: n.load.db, reader: n.reader, alert: () => {}, now: () => new Date(), ...(adapters ? { adapters } : {}) },
      { source: 'DE-1', spec: 'de-1-series', from: '2026-09-30', to: '2026-09-30', dryRun: false },
    );

  it('E1: A 10:00 = 100, B 12:00 = 100, a late D 11:00 = 200: 100 held by B for every order; replaying writes nothing', async () => {
    const payloads = { A: ['10:00', 100], B: ['12:00', 100], D: ['11:00', 200] } as const;
    const orders = ['ABD', 'ADB', 'BAD', 'BDA', 'DAB', 'DBA'] as const;
    const loader = n.loader();
    for (const [i, order] of orders.entries()) {
      for (const name of order) {
        const [hhmm, value] = payloads[name as keyof typeof payloads];
        await put(keys[i] as string, hhmm, value);
        // One arrival at a time.
        expect(await loader.tick()).toEqual({ lines: 1, loaded: 1 });
      }
    }
    const final = {
      value: 100,
      qc: 1,
      fetched_at: fetched('12:00'),
      latest: 100,
      latest_fetched: fetched('12:00'),
      vlast: 100,
    };
    for (const [i, order] of orders.entries())
      expect([order, await stored(keys[i] as string)]).toEqual([order, [final]]);
    // The revision log records each change of the stored value in the order it was stored: the one thing that
    // depends on arrival order. The reviewer's order (A, B, then the late D) changes nothing.
    // One query at a time: a pg client does not run queries concurrently.
    const log: Record<string, number> = {};
    for (const [i, o] of orders.entries()) log[o] = await revisions(keys[i] as string);
    expect(log).toEqual({ ABD: 0, ADB: 2, BAD: 0, BDA: 0, DAB: 1, DBA: 1 });

    const sums = await n.checksums();
    const rows = await n.count('obs');
    const logged = await n.count('obs_revision');
    for (let pass = 0; pass < 2; pass++) {
      expect(await replayDay()).toMatchObject({ lines: 18, loaded: 18, n_new: 0, n_changed: 0 });
      expect(await n.checksums()).toEqual(sums);
      expect(await n.count('obs')).toBe(rows);
      expect(await n.count('obs_revision')).toBe(logged);
    }
  });

  it('E2: two payloads fetched at the same instant: the greater batch id wins; a replay writes nothing', async () => {
    const [x, y] = [keys[6] as string, keys[7] as string];
    const loader = n.loader();
    // x: 1 arrives first, then 2; y: 4, then 3. Same fetch time: the batch that arrived later has the greater id.
    // (The bodies differ: an identical body at the same second would be the same archived object.)
    for (const [variant, first, second] of [
      [x, 1, 2],
      [y, 4, 3],
    ] as const) {
      await put(variant, '13:00', first);
      await loader.tick();
      await put(variant, '13:00', second);
      await loader.tick();
    }
    expect((await stored(x))[0]?.value).toBe(2);
    expect((await stored(y))[0]?.value).toBe(3);
    expect([await revisions(x), await revisions(y)]).toEqual([1, 1]);
    const sums = await n.checksums();
    await replayDay();
    await replayDay();
    expect(await n.checksums()).toEqual(sums);
    expect([await revisions(x), await revisions(y)]).toEqual([1, 1]);
  });

  it('a payload quarantined between a load and its confirmation, fixed and replayed, reverts nothing', async () => {
    const z = keys[8] as string;
    const real = (LOAD_ADAPTERS['DE-1'] as LoadAdapter).specs['de-1-series'] as SpecLoader;
    // The "bug": a parser that refuses the value 200.
    const refuses200: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            ...real,
            run: (body, ctx) => {
              if (JSON.parse(Buffer.from(body).toString('utf8'))[0]?.value === 200)
                throw new SchemaDrift('invalid_value');
              return real.run(body, ctx);
            },
          },
        },
      },
    };
    const loader = n.loader({ adapters: refuses200 });
    for (const [hhmm, value] of [
      ['14:00', 100],
      ['15:00', 200],
      ['16:00', 100],
    ] as const) {
      await put(z, hhmm, value);
      await loader.tick();
    }
    const q = await n.t.admin.query("SELECT parse_status FROM ingest_batch WHERE fetched_at = '2026-09-30T15:00:00Z'");
    expect(q.rows).toEqual([{ parse_status: 'quarantined' }]);
    // The fix: the real parser. The quarantined payload now loads, and it is older than the confirmation.
    expect(await replayDay()).toMatchObject({ quarantined: 0 });
    expect(
      (await n.t.admin.query("SELECT parse_status FROM ingest_batch WHERE fetched_at = '2026-09-30T15:00:00Z'")).rows,
    ).toEqual([{ parse_status: 'ok' }]);
    expect(await stored(z)).toEqual([
      { value: 100, qc: 1, fetched_at: fetched('16:00'), latest: 100, latest_fetched: fetched('16:00'), vlast: 100 },
    ]);
    expect(await revisions(z)).toBe(0);
  });

  it('a timestamp twice in one payload keeps its last value in SQL too (DISTINCT ON over the input order)', async () => {
    const w = keys[9] as string;
    const row = (value: number, ts = '2026-09-30T08:00:00.000Z') => ({ series: w, ts, value, qc: 1 });
    // A parser that yields the same timestamp twice (DE-1's own normalise never does: it keeps the last already).
    const twice: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            maxBytes: 1024,
            needsVariant: true,
            run: () => ({
              obs: [row(1), row(3, '2026-09-30T08:15:00.000Z'), row(2)],
              gaugeZeros: [],
              dropped: {},
              unknown: 0,
            }),
          },
        },
      },
    };
    await writePayload(n.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: w,
      at: fetched('17:00'),
      body: Buffer.from('[]'),
      url: SERIES_URL(w),
    });
    expect(await n.loader({ adapters: twice }).tick()).toEqual({ lines: 1, loaded: 1 });
    const { rows } = await n.t.admin.query('SELECT ts, value FROM obs WHERE series_id = $1 ORDER BY ts', [
      await n.seriesId(w),
    ]);
    expect(rows).toEqual([
      { ts: new Date('2026-09-30T08:00:00Z'), value: 2 },
      { ts: new Date('2026-09-30T08:15:00Z'), value: 3 },
    ]);
    const batch = (
      await n.t.admin.query("SELECT n_rows, n_new FROM ingest_batch WHERE fetched_at = '2026-09-30T17:00:00Z'")
    ).rows;
    expect(batch).toEqual([{ n_rows: 3, n_new: 2 }]);
  });

  // The fix of a parser, a normaliser or a registry factor: every value of the given series doubles.
  const doubled = (...variants: string[]): Record<string, LoadAdapter> => {
    const real = (LOAD_ADAPTERS['DE-1'] as LoadAdapter).specs['de-1-series'] as SpecLoader;
    const run: SpecLoader['run'] = async (body, ctx) => {
      const out = await real.run(body, ctx);
      return variants.includes(ctx.variant) ? { ...out, obs: out.obs.map((o) => ({ ...o, value: o.value * 2 })) } : out;
    };
    return { 'DE-1': { version: 2, specs: { 'de-1-series': { ...real, run } } } };
  };
  const batchAt = async (hhmm: string) =>
    (
      await n.t.admin.query(
        'SELECT id, n_new, n_changed, adapter_version, loaded_at FROM ingest_batch WHERE fetched_at = $1',
        [fetched(hhmm)],
      )
    ).rows;

  it('R2-1: a replay after a fix corrects what its own batch stored: one revision, latest and rollup follow', async () => {
    const s = keys[10] as string;
    await put(s, '18:00', 100);
    expect(await n.loader().tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await replayDay(doubled(s))).toMatchObject({ n_new: 0, n_changed: 1, quarantined: 0 });
    expect(await stored(s)).toEqual([
      { value: 200, qc: 1, fetched_at: fetched('18:00'), latest: 200, latest_fetched: fetched('18:00'), vlast: 200 },
    ]);
    expect(await revisions(s)).toBe(1);
    expect(await batchAt('18:00')).toMatchObject([{ n_new: 0, n_changed: 1, adapter_version: 2 }]);
  });

  it('R2-1: a full replay after a fix corrects a point that an older payload stated and a newer one confirmed', async () => {
    const s = keys[11] as string;
    await put(s, '19:00', 100);
    await put(s, '20:00', 100);
    expect(await n.loader().tick()).toEqual({ lines: 2, loaded: 2 });
    expect(await revisions(s)).toBe(0);
    const older = await batchAt('19:00');
    const holder = (await batchAt('20:00'))[0].id;
    // In manifest order: the older payload leaves the point alone, the confirming payload (its holder) rewrites it.
    const fix = doubled(keys[10] as string, s);
    expect(await replayDay(fix)).toMatchObject({ n_new: 0, n_changed: 1, quarantined: 0 });
    expect(await stored(s)).toEqual([
      { value: 200, qc: 1, fetched_at: fetched('20:00'), latest: 200, latest_fetched: fetched('20:00'), vlast: 200 },
    ]);
    const log = await n.t.admin.query('SELECT old_value, new_value, batch_id FROM obs_revision WHERE series_id = $1', [
      await n.seriesId(s),
    ]);
    expect(log.rows).toEqual([{ old_value: 100, new_value: 200, batch_id: holder }]);
    expect(await batchAt('19:00')).toEqual(older);

    // The same fix again, twice: nothing is written.
    const sums = await n.checksums();
    const logged = await n.count('obs_revision');
    const all = async () => (await n.t.admin.query('SELECT * FROM ingest_batch ORDER BY id')).rows;
    const before = await all();
    for (let pass = 0; pass < 2; pass++) {
      expect(await replayDay(fix)).toMatchObject({ n_new: 0, n_changed: 0, quarantined: 0 });
      expect(await n.checksums()).toEqual(sums);
      expect(await n.count('obs_revision')).toBe(logged);
      expect(await all()).toEqual(before);
    }
  });

  it('R2-2: a gauge zero follows newest fetch wins too: an older metadata payload never reverts it', async () => {
    const meta = recorded('de-1-meta');
    type Station = { uuid: string; timeseries: { shortname: string; gaugeZero?: { value: number } }[] };
    const registered = new Set(
      (
        await n.t.admin.query(
          "SELECT provider_key FROM series WHERE source_id = 'DE-1' AND active AND audience IS NULL",
        )
      ).rows.map((r) => r.provider_key),
    );
    const [x, y, z] = (JSON.parse(meta.body.toString('utf8')) as Station[]).filter((st) =>
      st.timeseries.some((t) => t.shortname === 'W' && t.gaugeZero !== undefined && registered.has(`${st.uuid}/W`)),
    ) as [Station, Station, Station];
    // A metadata payload with one station, whose W gauge zero (same validFrom) is `value`.
    const zero = (st: Station, day: string, hh: string, value: number) =>
      writePayload(n.archive, {
        source: 'DE-1',
        spec: 'de-1-meta',
        variant: '',
        at: new Date(`2026-09-${day}T${hh}:00:00Z`),
        body: Buffer.from(
          JSON.stringify([
            {
              ...st,
              timeseries: st.timeseries.map((t) =>
                t.shortname === 'W' ? { ...t, gaugeZero: { ...t.gaugeZero, value } } : t,
              ),
            },
          ]),
        ),
        url: meta.url,
        retention: 'forever',
      });
    const held = async (st: Station) =>
      (
        await n.t.admin.query(
          `SELECT g.value_m, b.fetched_at FROM gauge_zero g JOIN ingest_batch b ON b.id = g.batch_id
           WHERE g.series_id = $1 AND upper_inf(g.valid)`,
          [await n.seriesId(`${st.uuid}/W`)],
        )
      ).rows;
    const at = (day: string, hh: string) => new Date(`2026-09-${day}T${hh}:00:00Z`);
    const loader = n.loader();
    n.alerts.length = 0;
    // x: M1 (older) then M2 (newer); y: M2 first, then M1 as a late line.
    await zero(x, '28', '03', 9.521);
    await zero(x, '29', '03', 10.521);
    expect(await loader.tick()).toEqual({ lines: 2, loaded: 2 });
    await zero(y, '29', '04', 10.521);
    await loader.tick();
    await zero(y, '28', '04', 9.521);
    await loader.tick();
    // z: M1 9.521, a newer M3 confirms it, then M2 (between them) arrives late with 10.521.
    await zero(z, '28', '05', 9.521);
    await loader.tick();
    await zero(z, '30', '05', 9.521);
    await loader.tick();
    await zero(z, '29', '05', 10.521);
    await loader.tick();
    expect(await held(x)).toEqual([{ value_m: 10.521, fetched_at: at('29', '03') }]);
    expect(await held(y)).toEqual([{ value_m: 10.521, fetched_at: at('29', '04') }]);
    expect(await held(z)).toEqual([{ value_m: 9.521, fetched_at: at('30', '05') }]);
    // Only x's newer payload changed a zero (P7a: its old value is kept, its range ends at that fetch).
    expect(n.alerts.splice(0)).toEqual([
      { code: 'gauge_zero_changed', fields: { source: 'DE-1', spec: 'de-1-meta', n: 1 } },
    ]);
    const history = await n.t.admin.query(
      'SELECT value_m, upper(valid) AS upper FROM gauge_zero WHERE series_id = $1 ORDER BY lower(valid)',
      [await n.seriesId(`${x.uuid}/W`)],
    );
    expect(history.rows).toEqual([
      { value_m: 9.521, upper: at('29', '03') },
      { value_m: 10.521, upper: null },
    ]);

    // A replay of the older day only reverts nothing and alerts nothing.
    const alerts: string[] = [];
    const result = await replay(
      { db: n.load.db, reader: n.reader, alert: (code) => alerts.push(code), now: () => new Date() },
      { source: 'DE-1', spec: 'de-1-meta', from: '2026-09-28', to: '2026-09-28', dryRun: false },
    );
    expect(result).toEqual({ lines: 3, loaded: 3, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
    expect(alerts).toEqual([]);
    expect(await held(x)).toEqual([{ value_m: 10.521, fetched_at: at('29', '03') }]);
    expect(await held(y)).toEqual([{ value_m: 10.521, fetched_at: at('29', '04') }]);
    expect(await held(z)).toEqual([{ value_m: 9.521, fetched_at: at('30', '05') }]);
  });
});

describe('the NL fixture archive: NL-1 and NL-2 payloads load, and a replay changes nothing', () => {
  it('loads every payload, stores no NL-2 row, and replaying either source writes nothing', async () => {
    const n = await harness();
    try {
      // Five NL-1 payloads, the NL-2 snapshot and the recorded 204 of arnhem.nederrijn Q (a line, no object).
      expect(await buildNlFixtureArchive(n.raw)).toHaveLength(7);
      // The newest payload was fetched at 15:49:46Z.
      const loader = n.loader({ now: new Date('2026-09-30T16:00:00Z') });
      expect(await loader.tick()).toEqual({ lines: 7, loaded: 6 });
      // The snapshot lists two series that NL-1 does not register: a drift report in app_meta, no alert.
      expect(n.alerts).toEqual([]);
      const drift = await n.t.admin.query("SELECT value FROM app_meta WHERE key = 'registry_drift:NL-2'");
      expect(drift.rows[0]?.value).toMatchObject({
        spec: 'nl-2-wfs',
        changed: [],
        vanished: [],
        unregistered: ['driel.boven/Q/NVT/other:F103', 'epen.geul.cottessen/Q/NVT/other:F007'],
      });

      // One batch per payload; the 204 line made none. NL-2 is discovery only.
      const all = async () => (await n.t.admin.query('SELECT * FROM ingest_batch ORDER BY id')).rows;
      const loaded = await all();
      expect(
        loaded.map((b) => [b.source_id, b.spec_id, b.parse_status, b.n_rows, b.n_new, b.n_changed, b.n_skipped]),
      ).toEqual([
        ['NL-1', 'nl-1-obs-key', 'ok', 16, 16, 0, 0],
        ['NL-2', 'nl-2-wfs', 'ok', 0, 0, 0, 0],
        ['NL-1', 'nl-1-obs-key', 'ok', 17, 17, 0, 0],
        ['NL-1', 'nl-1-obs-twin', 'ok', 17, 17, 0, 0],
        ['NL-1', 'nl-1-obs-other', 'ok', 35, 35, 0, 0],
        ['NL-1', 'nl-1-obs-other', 'ok', 0, 0, 0, 0],
      ]);
      // Lobith H, Eijsden-grens H, its TAW twin, Lobith Q, and Driel Q (35 gaps, never stored). No series is NL-2's.
      const rows = await n.count('obs');
      expect(rows).toBe(16 + 17 + 17 + 35 + 0);
      const ofNl2 = await n.t.admin.query(
        "SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id WHERE s.source_id = 'NL-2'",
      );
      expect(ofNl2.rows).toEqual([{ n: 0 }]);
      expect(await n.count('obs_revision')).toBe(0);
      expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });

      const sums = await n.checksums();
      const replayOf = (source: string) =>
        replay(
          {
            db: n.load.db,
            reader: n.reader,
            alert: (code, fields = {}) => n.alerts.push({ code, fields }),
            now: () => new Date(),
          },
          { source, spec: null, from: '2026-09-01', to: '2026-12-31', dryRun: false },
        );
      for (const [source, lines] of [
        ['NL-1', 5],
        ['NL-2', 1],
      ] as const) {
        for (let pass = 0; pass < 2; pass++) {
          expect(await replayOf(source)).toEqual({
            lines,
            loaded: lines,
            quarantined: 0,
            skipped: 0,
            n_new: 0,
            n_changed: 0,
          });
          expect(await n.checksums()).toEqual(sums);
          expect(await n.count('obs')).toBe(rows);
          expect(await n.count('obs_revision')).toBe(0);
          expect(await all()).toEqual(loaded);
        }
      }
      expect(n.alerts).toEqual([]);
    } finally {
      await n.close();
    }
  });
});
