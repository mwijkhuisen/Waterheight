import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { PUBLIC_ONLY_VIEWS, VIEWS } from '../../src/db/audience.ts';
import { computeHealth, LagWindow, storeChecksums } from '../../src/load/health.ts';
import { type Harness, harness } from './harness.ts';

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
  backlog: { files: 0, bytes: 0 },
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
    expect(row.detail.missing_buckets_24h).toBeGreaterThan(0);
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
    // A pass without new lag samples keeps the last known lag.
    expect((await de1()).lag_p95_s).toBe(34);
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

  it('the loader records its own state: when it last computed, its backlog and damaged lines', async () => {
    await computeHealth(h.load.db, inputs({ backlog: { files: 2, bytes: 4096 }, badLines: 3 }));
    const { rows } = await api.query(`SELECT * FROM ${PUBLIC_ONLY_VIEWS.loader}`);
    expect(rows).toEqual([{ computed_at: NOW, backlog_files: 2, backlog_bytes: '4096', bad_manifest_lines: 3 }]);
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
