import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { PUBLIC_ONLY_VIEWS, VIEWS } from '../../src/db/audience.ts';
import { computeHealth, LagWindow, storeChecksums } from '../../src/load/health.ts';
import { claimNightly } from '../../src/load/run.ts';
import { type Harness, harness, measurements } from './harness.ts';

// Health is precomputed by the loader and read by the API as rws_api through
// the public health views: public sources only, owner sources as two counts.

let h: Harness;
let api: pg.Client;
// Half a minute after the recorded basin call (2026-09-29T13:43:26Z).
const NOW = new Date('2026-09-29T13:44:00Z');
const cadenceS = new Map([
  ['DE-1', 900],
  ['BE-3', 600],
  ['LU-4', 604800],
]);
const inputs = (over: Partial<Parameters<typeof computeHealth>[1]> = {}) => ({
  cadenceS,
  lagP95Ms: new Map<string, number>(),
  backlog: { files: 0, bytes: 0, age_s: null as number | null },
  badLines: 0,
  now: NOW,
  ...over,
});
const de1 = async () =>
  (await api.query(`SELECT * FROM ${VIEWS.public.sourceHealth} WHERE source_id = 'DE-1'`)).rows[0];

beforeAll(async () => {
  h = await harness();
  api = await h.t.connectAs('rws_api');
  // Only the payloads recorded on 2026-09-29: the basin call, the metadata and one series.
  const { Archive } = await import('../../src/archive/writer.ts');
  const archive = new Archive(h.raw);
  for (const [spec, name, variant] of [
    ['de-1-meta', 'de-1-meta', ''],
    ['de-1-basin', 'de-1-basin', ''],
    ['de-1-series', 'de-1-series', '9598e4cb-0849-401e-bba0-689234b27644/W'],
  ] as const) {
    const f = recorded(name);
    await writePayload(archive, { source: 'DE-1', spec, variant, at: f.at, body: f.body, url: f.url });
  }
  // Owner-audience specs are captured too; their lines carry no adapter.
  await h.archive.append(bareLine('BE-3', 'be-3-levels', new Date('2026-09-29T13:43:50Z'), { status: 304 }));
  await h.archive.append(
    bareLine('LU-4', 'lu-4-pages', new Date('2026-09-20T00:00:00Z'), { status: null, error: 'timeout' }),
  );
  const lag = new LagWindow();
  const { Loader } = await import('../../src/load/pipeline.ts');
  await new Loader({
    db: h.load.db,
    reader: h.reader,
    alert: () => {},
    now: () => NOW,
    onLag: (source, fetchedAt, ms) => lag.add(source, fetchedAt, ms, NOW),
  }).tick();
  await computeHealth(h.load.db, inputs({ lagP95Ms: lag.p95(NOW) }));
});

afterAll(async () => {
  await h.close();
});

describe('source health', () => {
  it('DE-1: tier-1 freshness splits fresh from provider-stale; status ok', async () => {
    const row = await de1();
    expect(row).toMatchObject({
      source_id: 'DE-1',
      status: 'ok',
      quarantine_count: 0,
      consecutive_failures: 0,
      last_fetch_ok: new Date('2026-09-29T13:43:26Z'),
      updated_at: NOW,
    });
    // 69 tier-1 series; five Q series were stale at the provider that day (low-water rating cut-off).
    expect(row.detail.tier1).toEqual({ total: 69, fresh: 64, provider_stale: 5 });
    // Q7, recounted here bucket by bucket from the rows (an independent count of the same rule).
    expect(row.detail.missing_buckets_24h).toBe(await missingBuckets(NOW));
    expect(row.detail.missing_buckets_24h).toBe(6397);
    expect(row.newest_ts).toEqual(new Date('2026-09-29T13:41:00Z'));
    // The three lines were loaded 34 s after their fetch.
    expect(row.lag_p95_s).toBe(34);
  });

  it('lists public sources only; owner sources are two counts', async () => {
    const ids = (await api.query(`SELECT source_id FROM ${VIEWS.public.sourceHealth} ORDER BY 1`)).rows.map(
      (r) => r.source_id,
    );
    expect(ids).toContain('DE-1');
    expect(ids).toContain('NL-1');
    for (const owner of ['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3', 'CANARY-OWNER'])
      expect(ids).not.toContain(owner);
    for (const off of ['NL-3', 'DE-9', 'DE-10']) expect(ids).not.toContain(off);
    // Six captured owner sources; BE-3 answered, LU-4 only ever failed, the others have not been fetched at all.
    expect((await api.query(`SELECT * FROM ${PUBLIC_ONLY_VIEWS.ownerHealth}`)).rows).toEqual([
      { healthy: 1, total: 6 },
    ]);
    const owner = await h.t.connectAs('rws_owner_api');
    const own = Object.fromEntries(
      (await owner.query(`SELECT source_id, status FROM ${VIEWS.owner.sourceHealth}`)).rows.map((r) => [
        r.source_id,
        r.status,
      ]),
    );
    expect(own).toMatchObject({ 'BE-3': 'ok', 'LU-4': 'down', 'DE-2': 'unknown', 'DE-1': 'ok' });
  });

  it('partition checksums are stored beside the rest and survive the next health pass', async () => {
    await storeChecksums(h.load.db, NOW);
    const parts = (await de1()).detail.partitions;
    expect(Object.keys(parts)).toEqual(['2026-09']);
    expect(parts['2026-09'].md5).toMatch(/^[0-9a-f]{32}$/);
    expect(parts['2026-09'].rows).toBe(await h.count('obs'));
    await computeHealth(h.load.db, inputs());
    const again = (await de1()).detail;
    expect(again.partitions).toEqual(parts);
    expect(again.tier1).toEqual({ total: 69, fresh: 64, provider_stale: 5 });
    // A pass without a lag sample of the last hour shows none: a stalled loader never keeps an old, good lag.
    expect((await de1()).lag_p95_s).toBeNull();
    await computeHealth(h.load.db, inputs({ lagP95Ms: new Map([['DE-1', 34_000]]) }));
  });

  it('a quarantined payload degrades the source; five failed fetches or a silent source take it down', async () => {
    await h.t.admin.query(
      `INSERT INTO ingest_batch (source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status, error)
       VALUES ('DE-1', 'de-1-basin', 'raw/DE-1/de-1-basin/2026/09/29/134000Z-0000000000000000.zst', $1, 1, 'quarantined', 'unrecognized_keys')`,
      [NOW],
    );
    await computeHealth(h.load.db, inputs());
    expect(await de1()).toMatchObject({ status: 'degraded', quarantine_count: 1 });
    await h.t.admin.query("DELETE FROM ingest_batch WHERE parse_status = 'quarantined'");

    await h.t.admin.query("UPDATE source_health SET consecutive_failures = 5 WHERE source_id = 'DE-1'");
    await computeHealth(h.load.db, inputs());
    expect((await de1()).status).toBe('down');
    await h.t.admin.query("UPDATE source_health SET consecutive_failures = 0 WHERE source_id = 'DE-1'");

    // An hour later nothing new was fetched: more than three cadences of silence.
    await computeHealth(h.load.db, inputs({ now: new Date('2026-09-29T14:45:00Z') }));
    expect((await de1()).status).toBe('down');
    // Fetches still answer (304) but no payload has loaded for over two cadences: not provider-stale any more.
    await h.t.admin.query("UPDATE source_health SET last_fetch_ok = '2026-09-29T14:44:00Z' WHERE source_id = 'DE-1'");
    await computeHealth(h.load.db, inputs({ now: new Date('2026-09-29T14:45:00Z') }));
    const stale = await de1();
    expect(stale.status).toBe('degraded');
    expect(stale.detail.tier1).toEqual({ total: 69, fresh: 0, provider_stale: 0 });
  });

  it('the loader records its own state: when it last computed, its backlog, its age and damaged lines', async () => {
    await computeHealth(h.load.db, inputs({ backlog: { files: 2, bytes: 4096, age_s: 1200 }, badLines: 3 }));
    const { rows } = await api.query(`SELECT * FROM ${PUBLIC_ONLY_VIEWS.loader}`);
    expect(rows).toEqual([
      { computed_at: NOW, backlog_files: 2, backlog_bytes: '4096', backlog_age_s: 1200, bad_manifest_lines: 3 },
    ]);
    await computeHealth(h.load.db, inputs());
    expect((await api.query(`SELECT backlog_age_s FROM ${PUBLIC_ONLY_VIEWS.loader}`)).rows).toEqual([
      { backlog_age_s: null },
    ]);
  });

  it('a stale series is provider-stale only if a recent payload itself stated its latest value (review C9)', async () => {
    // Half an hour later the basin call answers again with the same values, but five discharge series are gone
    // from it (a key change, a unit change, a 404: we stopped storing them). Their latest value is not
    // restated, so they are plain stale; every other stale series was confirmed by the new payload.
    const stale = ['9598e4cb-0849-401e-bba0-689234b27644/Q'];
    const basin = recorded('de-1-basin');
    const doc = JSON.parse(basin.body.toString('utf8')) as { uuid: string; timeseries: { shortname: string }[] }[];
    const before = (await de1()).detail.tier1 as { fresh: number; provider_stale: number };
    const staleKeys = (
      await h.t.admin.query(
        `SELECT s.provider_key FROM series s JOIN station st ON st.id = s.station_id AND st.tier = 1
         JOIN obs_latest l ON l.series_id = s.id
         WHERE s.source_id = 'DE-1' AND s.role = 'primary' AND l.ts <= $1::timestamptz - s.staleness_limit`,
        [NOW],
      )
    ).rows.map((r) => r.provider_key as string);
    expect(staleKeys).toHaveLength(before.provider_stale);
    expect(staleKeys).toEqual(expect.arrayContaining(stale));
    const dropped = new Set(staleKeys);
    for (const station of doc)
      station.timeseries = station.timeseries.filter((t) => !dropped.has(`${station.uuid}/${t.shortname}`));
    const later = new Date('2026-09-29T14:13:26Z');
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-basin',
      variant: '',
      at: later,
      body: Buffer.from(JSON.stringify(doc)),
      url: basin.url,
    });
    const { Loader } = await import('../../src/load/pipeline.ts');
    await new Loader({ db: h.load.db, reader: h.reader, alert: () => {}, now: () => later }).tick();
    // 14:20: past two cadences (30 min) since 13:43, within them since 14:13.
    const at = new Date('2026-09-29T14:20:00Z');
    await computeHealth(h.load.db, inputs({ now: at }));
    const row = await de1();
    const t1 = row.detail.tier1 as { total: number; fresh: number; provider_stale: number };
    expect(t1.total).toBe(69);
    // Before this change the five would still count as provider-stale (the source's newest payload loaded fine).
    expect(t1.fresh + t1.provider_stale).toBe(69 - staleKeys.length);
    expect(row.status).toBe('degraded');
    await computeHealth(h.load.db, inputs());
  });

  it("a series narrowed below its source's audience never moves the source's public numbers (review S6/C5)", async () => {
    const narrowed = '1d26e504-7f9e-480a-b52c-5932be6549ab/W';
    await h.t.admin.query("UPDATE series SET audience = 'owner' WHERE provider_key = $1", [narrowed]);
    const health = async () =>
      (await h.t.admin.query("SELECT newest_ts, last_new_data FROM source_health WHERE source_id = 'DE-1'")).rows[0];
    const before = await health();
    const fetched = new Date('2026-09-29T14:30:00Z');
    const line = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: narrowed,
      at: fetched,
      body: measurements(['2026-09-29T16:15:00+02:00', 150], ['2026-09-29T16:30:00+02:00', 151]),
      url: 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/x/W/measurements.json',
    });
    const { Loader } = await import('../../src/load/pipeline.ts');
    await new Loader({ db: h.load.db, reader: h.reader, alert: () => {}, now: () => fetched }).tick();
    // The rows are stored (for the owner channel) …
    expect(
      (
        await h.t.admin.query(
          'SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id WHERE s.provider_key = $1 AND o.ts >= $2',
          [narrowed, '2026-09-29T14:15:00Z'],
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    // … but the public health and the public batch counters do not see them.
    expect(await health()).toEqual(before);
    expect(
      (
        await h.t.admin.query(
          'SELECT parse_status, n_rows, n_new, n_changed FROM ingest_batch WHERE archive_key = $1',
          [line.key],
        )
      ).rows,
    ).toEqual([{ parse_status: 'ok', n_rows: 0, n_new: 0, n_changed: 0 }]);
    await h.t.admin.query('UPDATE series SET audience = NULL WHERE provider_key = $1', [narrowed]);
  });
});

/** Q7 counted in TypeScript: expected buckets of the last 24 h (up to now − staleness − step) without a row. */
async function missingBuckets(now: Date): Promise<number> {
  const { rows } = await h.t.admin.query<{ id: number; step: number; stale: number; ts: Date[] | null }>(
    `SELECT s.id, extract(epoch FROM s.expected_step)::int * 1000 AS step,
            extract(epoch FROM s.staleness_limit)::int * 1000 AS stale,
            (SELECT array_agg(o.ts) FROM obs o WHERE o.series_id = s.id) AS ts
     FROM series s JOIN station st ON st.id = s.station_id AND st.tier = 1
     WHERE s.source_id = 'DE-1' AND s.active AND s.role = 'primary' AND s.audience IS NULL`,
  );
  let missing = 0;
  for (const s of rows) {
    const times = (s.ts ?? []).map((t) => t.getTime());
    const first = Math.floor((now.getTime() - 86_400_000) / s.step) * s.step;
    for (let b = first; b <= now.getTime() - s.stale - s.step; b += s.step) {
      if (!times.some((t) => t >= b && t < b + s.step)) missing += 1;
    }
  }
  return missing;
}

describe('the nightly jobs', () => {
  const idle = { files: 0, bytes: 0, age_s: null };
  it('run once per UTC day after 02:00, and a restart does not run them again (the day is kept in app_meta)', async () => {
    const at = (iso: string) => new Date(iso);
    expect(await claimNightly(h.load.db, at('2026-10-05T01:59:59Z'), idle)).toBe(false);
    expect(await claimNightly(h.load.db, at('2026-10-05T02:00:00Z'), idle)).toBe(true);
    expect(await claimNightly(h.load.db, at('2026-10-05T02:10:00Z'), idle)).toBe(false);
    // Another process (a restart): nothing in memory, the database remembers.
    const again = h.dbAs('rws_load', 1);
    expect(await claimNightly(again.db, at('2026-10-05T23:59:00Z'), idle)).toBe(false);
    expect(await claimNightly(again.db, at('2026-10-06T02:00:00Z'), idle)).toBe(true);
  });

  it('wait while a whole manifest line is unconsumed; a torn last line does not hold them up (review N7, R3-9)', async () => {
    const at = new Date('2026-10-07T02:00:00Z');
    expect(await claimNightly(h.load.db, at, { files: 1, bytes: 812, age_s: 30 })).toBe(false);
    expect(await claimNightly(h.load.db, at, { files: 1, bytes: 40, age_s: null })).toBe(true);
  });
});

describe('lag window', () => {
  it('takes the p95 of the last hour and ignores lines that are a backlog being replayed', () => {
    const lag = new LagWindow();
    const now = new Date('2026-10-05T12:00:00Z');
    for (let i = 1; i <= 100; i++) lag.add('DE-1', new Date(now.getTime() - i * 1000), i * 1000, now);
    // A line fetched yesterday, loaded now: replay, not lag.
    lag.add('DE-1', new Date('2026-10-04T12:00:00Z'), 86_400_000, now);
    expect(lag.p95(now).get('DE-1')).toBe(95_000);
    expect(lag.p95(new Date('2026-10-05T13:00:01Z')).size).toBe(0);
  });
});
