import { CANARIES, CANARY_RENDERINGS, Health, HealthSources } from '@rws/contracts';
import { Kysely, PostgresDialect } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { CACHE_MS } from '../../src/api/health.ts';
import { createApp } from '../../src/app.ts';
import { Archive } from '../../src/archive/writer.ts';
import { PUBLIC_ONLY_VIEWS, VIEWS } from '../../src/db/audience.ts';
import type { DB } from '../../src/db/generated.ts';
import { type Db, dbConfig, openDb } from '../../src/db/pool.ts';
import { computeHealth, LagWindow, storeChecksums } from '../../src/load/health.ts';
import { Loader } from '../../src/load/pipeline.ts';
import { type Harness, harness } from '../load/harness.ts';

// GET /api/v1/health and /api/v1/health/sources against a real database, read as
// the real `rws_api` login: public sources only, the owner sources as two counts.

let h: Harness;
let api: Db;
// Half a minute after the recorded DE-1 basin call (2026-09-29T13:43:26Z); the loader computed health now.
const NOW = new Date('2026-09-29T13:44:00Z');
const cadenceS = new Map([
  ['DE-1', 900],
  ['BE-3', 600],
  ['LU-4', 604800],
]);
// Every recompute keeps the lag the beforeAll load measured (34 s): a pass without samples would show none.
const inputs = {
  cadenceS,
  lagP95Ms: new Map([['DE-1', 34_000]]),
  backlog: { files: 0, bytes: 0, age_s: null },
  badLines: 0,
  now: NOW,
};

/** Kysely over the real rws_api pool that counts the queries it sends. */
function counted() {
  const seen = { queries: 0 };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: api.pool }),
    log: (event) => {
      if (event.level === 'query') seen.queries += 1;
    },
  });
  return { db, seen };
}
/** A real pino logger whose lines are collected: what the api logs is exactly what the tests see. */
function sink() {
  const logged: Record<string, unknown>[] = [];
  const log = pino({ base: null, timestamp: false }, { write: (line: string) => void logged.push(JSON.parse(line)) });
  return { log, logged };
}
/** An app over the counted pool with its own clock and cache; `at` is milliseconds after NOW. */
function appAt(at = 60_000) {
  const clock = { now: new Date(NOW.getTime() + at) };
  const { db, seen } = counted();
  const { log, logged } = sink();
  const app = createApp({ db, now: () => clock.now, log });
  return { app, clock, seen, logged };
}
const json = async (res: Response) => JSON.parse(await res.text()) as unknown;
const admin = async (text: string, values: unknown[] = []) => (await h.t.admin.query(text, values)).rows;

const OWNER_IDS = ['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3', 'CANARY-OWNER'];
const NEVER = [
  ...OWNER_IDS,
  'be-3-levels',
  'lu-4-pages',
  'private_basis',
  'clause',
  'raw/',
  'wallonie',
  'inondations.public.lu',
  'vorhersage.bafg.de',
  ...CANARY_RENDERINGS,
];

beforeAll(async () => {
  h = await harness();
  api = h.dbAs('rws_api', 4);
  // The three DE-1 payloads recorded on 2026-09-29 and two owner-audience lines (no adapter).
  const archive = new Archive(h.raw);
  for (const [spec, name, variant] of [
    ['de-1-meta', 'de-1-meta', ''],
    ['de-1-basin', 'de-1-basin', ''],
    ['de-1-series', 'de-1-series', '9598e4cb-0849-401e-bba0-689234b27644/W'],
  ] as const) {
    const f = recorded(name);
    await writePayload(archive, { source: 'DE-1', spec, variant, at: f.at, body: f.body, url: f.url });
  }
  await h.archive.append(bareLine('BE-3', 'be-3-levels', new Date('2026-09-29T13:43:50Z'), { status: 304 }));
  await h.archive.append(
    bareLine('LU-4', 'lu-4-pages', new Date('2026-09-20T00:00:00Z'), { status: null, error: 'timeout' }),
  );
  const lag = new LagWindow();
  await new Loader({
    db: h.load.db,
    reader: h.reader,
    alert: () => {},
    now: () => NOW,
    onLag: (source, fetchedAt, ms) => lag.add(source, fetchedAt, ms, NOW),
  }).tick();
  await computeHealth(h.load.db, { ...inputs, lagP95Ms: lag.p95(NOW) });
  await storeChecksums(h.load.db, NOW);
});

afterAll(async () => {
  await h.close();
});

describe('GET /api/v1/health and /api/v1/health/sources', () => {
  it('answer 200 as JSON for 30 s, valid against the contract, with nothing else in the headers', async () => {
    const { app } = appAt();
    for (const path of ['/api/v1/health', '/api/v1/health/sources']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('public, max-age=30');
      expect([...res.headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
      const doc = await json(res);
      expect((path.endsWith('sources') ? HealthSources : Health).safeParse(doc).success, path).toBe(true);
    }
  });

  it('/health: ok, the loader lag, and the public sources counted; the owner sources are two counts', async () => {
    const doc = Health.parse(await json(await appAt().app.request('/api/v1/health')));
    expect(doc).toEqual({
      status: 'ok',
      generated_at: NOW.toISOString(),
      // The three DE-1 lines were loaded 34 s after their fetch; no other source has a lag sample.
      loader: { lag_p95_s: 34, backlog_files: 0, backlog_bytes: 0, backlog_age_s: null, bad_manifest_lines: 0 },
      sources: expect.objectContaining({ ok: 1, degraded: 0, down: 0 }),
      // Six captured owner sources: BE-3 answered, LU-4 only ever failed, the others were not fetched.
      owner_sources: { healthy: 1, total: 6 },
      quarantined: 0,
      twins: { ok: 0, failing: 0 },
    });
    expect(doc.sources.total).toBe(doc.sources.ok + doc.sources.unknown);
    expect(Object.keys(doc.owner_sources).sort()).toEqual(['healthy', 'total']);
  });

  it('/health/sources: DE-1 with its tier-1 numbers, freshness and a partition checksum', async () => {
    const doc = HealthSources.parse(await json(await appAt().app.request('/api/v1/health/sources')));
    const de1 = doc.sources.find((s) => s.id === 'DE-1');
    expect(de1).toMatchObject({
      status: 'ok',
      consecutive_failures: 0,
      quarantined: 0,
      lag_p95_s: 34,
      tier1: { total: 69, fresh: 64, provider_stale: 5 },
      last_fetch_ok: '2026-09-29T13:43:26.000Z',
      newest_ts: '2026-09-29T13:41:00.000Z',
      partitions_at: NOW.toISOString(),
    });
    expect(de1?.missing_buckets_24h).toBeGreaterThan(0);
    const [rows] = await admin(
      `SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id WHERE s.source_id = 'DE-1'`,
    );
    expect(de1?.partitions).toEqual([
      { partition: '2026-09', md5: expect.stringMatching(/^[0-9a-f]{32}$/), rows: rows.n },
    ]);
    expect(doc.generated_at).toBe(NOW.toISOString());
    expect(doc.quarantined_batches).toEqual([]);
    expect(doc.twins).toEqual([]);
    expect(doc.owner_sources).toEqual({ healthy: 1, total: 6 });
    // A source that was never fetched: its 41 tier-1 series are all without a value, and it has no checksum.
    expect(doc.sources.find((s) => s.id === 'NL-1')).toMatchObject({
      status: 'unknown',
      last_fetch_ok: null,
      tier1: { total: 41, fresh: 0, provider_stale: 0 },
      outage: null,
      partitions: [],
    });
  });

  it('lists exactly the public sources that have health rows', async () => {
    const doc = HealthSources.parse(await json(await appAt().app.request('/api/v1/health/sources')));
    const expected = (
      await admin(
        `SELECT h.source_id FROM source_health h JOIN source s ON s.id = h.source_id WHERE s.audience = 'public' ORDER BY 1`,
      )
    ).map((r) => r.source_id);
    expect(doc.sources.map((s) => s.id)).toEqual(expected);
    expect(expected).toContain('DE-1');
  });

  it('HEAD answers like GET without a body; other methods are 405, other paths and a trailing slash 404', async () => {
    const { app } = appAt();
    const head = await app.request('/api/v1/health', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('public, max-age=30');
    expect(await head.text()).toBe('');
    for (const [path, method] of [
      ['/api/v1/health', 'POST'],
      ['/api/v1/health/sources', 'DELETE'],
    ] as const)
      expect((await app.request(path, { method })).status, `${method} ${path}`).toBe(405);
    for (const path of ['/api/v1/health/', '/api/v1/health/sources/', '/api/v1/health/other', '/api/v1/', '/api/'])
      expect((await app.request(path)).status, path).toBe(404);
  });

  it('ANY query parameter is a 400 that never echoes it; /healthz is unaffected', async () => {
    const { app, seen } = appAt();
    for (const path of ['/api/v1/health', '/api/v1/health/sources']) {
      for (const query of ['?x=1', '?t=2026-01-01T00:00:00Z', '?=', '?%3Cscript%3E=SECRET-ECHO', '?a=1&a=2']) {
        const res = await app.request(`${path}${query}`);
        expect(res.status, `${path}${query}`).toBe(400);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const text = await res.text();
        expect(text).toBe('{"error":"unknown_parameter"}');
      }
    }
    // A rejected request never reaches the database.
    expect(seen.queries).toBe(0);
    expect(await (await app.request('/healthz?x=1')).json()).toEqual({ status: 'ok' });
  });
});

describe('owner isolation (invariant 11) and the withheld canary', () => {
  it('seeded owner health, an owner quarantined batch and both canaries change no public byte', async () => {
    const read = async () => [
      Health.parse(await json(await appAt().app.request('/api/v1/health'))),
      HealthSources.parse(await json(await appAt().app.request('/api/v1/health/sources'))),
    ];
    const [healthBefore, sourcesBefore] = (await read()) as [Health, HealthSources];
    // Owner canary station and series (owner source), the withheld canary (a series of NL-1 narrowed to off) and an
    // owner-source series with checksums: all as superuser, then health and checksums are recomputed.
    await admin(`SELECT ensure_partitions('2026-09-01', '2026-10-31')`);
    await admin(`
      INSERT INTO station (id, name, country, tier) VALUES
        ('nl.canary.owner', 'owner canary', 'NL', 1), ('nl.canary.withheld', 'withheld canary', 'NL', 1),
        ('be.spw.test', 'owner gauge', 'BE', 1)`);
    const seeded: [string, string, string, string | null, number][] = [
      ['nl.canary.owner', 'CANARY-OWNER', 'canary-owner', null, CANARIES.owner.value],
      ['nl.canary.withheld', 'NL-1', 'canary-withheld', 'off', CANARIES.withheld.value],
      ['be.spw.test', 'BE-3', 'be-3-test', null, 5000.5],
    ];
    for (const [station, source, key, audience, value] of seeded) {
      const [{ id }] = await admin(
        `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                             native_step, expected_step, staleness_limit, role, audience)
         VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary', $4::audience)
         RETURNING id`,
        [station, source, key, audience],
      );
      await admin(
        `INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, '2026-09-29T13:30:00Z', $2, 1, 1)`,
        [id, value],
      );
      await admin(
        `INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, '2026-09-29T13:30:00Z', $2, 1, 1)`,
        [id, value],
      );
    }
    await admin(
      `INSERT INTO ingest_batch (source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status, error)
       VALUES ('BE-3', 'be-3-levels', 'raw/BE-3/be-3-levels/2026/09/29/134000Z-0000000000000000.zst', $1, 1,
               'quarantined', 'be3_owner_secret_code')`,
      [NOW],
    );
    await computeHealth(h.load.db, inputs);
    await storeChecksums(h.load.db, NOW);

    // The owner rows exist in the database and in the owner family (so the test proves something).
    const owner = await h.t.connectAs('rws_owner_api');
    const own = await owner.query(`SELECT source_id, status, quarantine_count FROM ${VIEWS.owner.sourceHealth}`);
    expect(own.rows).toContainEqual({ source_id: 'BE-3', status: 'degraded', quarantine_count: 1 });

    const health = await (await appAt().app.request('/api/v1/health')).text();
    const sources = await (await appAt().app.request('/api/v1/health/sources')).text();
    for (const text of [health, sources]) for (const term of NEVER) expect(text, term).not.toContain(term);
    // The public numbers are unchanged, except the owner counts: BE-3 is degraded now.
    const [healthAfter, sourcesAfter] = (await read()) as [Health, HealthSources];
    expect(healthAfter.owner_sources).toEqual({ healthy: 0, total: 6 });
    expect(sourcesAfter.owner_sources).toEqual({ healthy: 0, total: 6 });
    expect({ ...healthAfter, owner_sources: healthBefore.owner_sources }).toEqual(healthBefore);
    // The withheld canary series is NL-1's (tier 1, with a value), yet NL-1's tier-1 numbers do not count it and
    // NL-1 has no checksum of it: every public source reads exactly as before.
    expect(sourcesAfter.sources.find((s) => s.id === 'NL-1')).toMatchObject({
      tier1: { total: 41, fresh: 0, provider_stale: 0 },
      partitions: [],
    });
    expect(sourcesAfter.sources).toEqual(sourcesBefore.sources);
  });

  it('a public quarantined batch shows (its fixed code only) and degrades; the owner batch never does', async () => {
    await admin(
      `INSERT INTO ingest_batch (source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status, error)
       VALUES ('DE-1', 'de-1-basin', 'raw/DE-1/de-1-basin/2026/09/29/134000Z-0000000000000000.zst', $1, 1,
               'quarantined', 'unrecognized_keys at [0].foo')`,
      [NOW],
    );
    await computeHealth(h.load.db, inputs);
    const { app } = appAt();
    const health = Health.parse(await json(await app.request('/api/v1/health')));
    const sources = HealthSources.parse(await json(await app.request('/api/v1/health/sources')));
    expect(health).toMatchObject({ status: 'degraded', quarantined: 1, sources: { degraded: 1 } });
    expect(sources.sources.find((s) => s.id === 'DE-1')).toMatchObject({ status: 'degraded', quarantined: 1 });
    expect(sources.quarantined_batches).toEqual([
      {
        id: expect.stringMatching(/^[0-9]+$/),
        source: 'DE-1',
        spec: 'de-1-basin',
        fetched_at: NOW.toISOString(),
        error: 'unrecognized_keys at [0].foo',
      },
    ]);
    const text = JSON.stringify(sources);
    for (const term of NEVER) expect(text, term).not.toContain(term);
    await admin(`DELETE FROM ingest_batch WHERE parse_status = 'quarantined'`);
    await computeHealth(h.load.db, inputs);
  });
});

describe('caching and load', () => {
  it('a second request within 30 s does not ask the database; the answer is refreshed after it', async () => {
    const { app, clock, seen } = appAt();
    const first = await (await app.request('/api/v1/health')).text();
    const asked = seen.queries;
    expect(asked).toBeGreaterThan(0);
    await admin(`UPDATE source_health SET consecutive_failures = 3 WHERE source_id = 'DE-1'`);
    clock.now = new Date(clock.now.getTime() + CACHE_MS - 1);
    expect(await (await app.request('/api/v1/health')).text()).toBe(first);
    expect(seen.queries).toBe(asked);
    // The other route has its own cache: it asks once, and then not again.
    const sources = await (await app.request('/api/v1/health/sources')).text();
    const askedBoth = seen.queries;
    expect(askedBoth).toBeGreaterThan(asked);
    expect(HealthSources.parse(JSON.parse(sources)).sources.find((s) => s.id === 'DE-1')?.consecutive_failures).toBe(3);
    await app.request('/api/v1/health/sources');
    expect(seen.queries).toBe(askedBoth);
    clock.now = new Date(clock.now.getTime() + 1);
    await app.request('/api/v1/health');
    expect(seen.queries).toBeGreaterThan(askedBoth);
    await admin(`UPDATE source_health SET consecutive_failures = 0 WHERE source_id = 'DE-1'`);
  });

  it('concurrent requests share one computation', async () => {
    const one = appAt();
    await one.app.request('/api/v1/health');
    const many = appAt();
    const all = await Promise.all(Array.from({ length: 25 }, () => many.app.request('/api/v1/health')));
    expect(all.map((r) => r.status)).toEqual(Array.from({ length: 25 }, () => 200));
    expect(many.seen.queries).toBe(one.seen.queries);
  });

  it('a loader that has not computed for over 5 minutes is down (still HTTP 200)', async () => {
    const at = (ms: number) => appAt(ms).app.request('/api/v1/health');
    expect(Health.parse(await json(await at(300_000))).status).toBe('ok');
    const late = await at(300_001);
    expect(late.status).toBe(200);
    expect(Health.parse(await json(late)).status).toBe('down');
  });

  it('down before the loader has ever computed', async () => {
    await admin(`DELETE FROM app_meta WHERE key = 'loader'`);
    const doc = Health.parse(await json(await appAt().app.request('/api/v1/health')));
    expect(doc).toMatchObject({ status: 'down', generated_at: null, loader: { backlog_files: 0, backlog_bytes: 0 } });
    expect(
      HealthSources.parse(await json(await appAt().app.request('/api/v1/health/sources'))).generated_at,
    ).toBeNull();
    await computeHealth(h.load.db, inputs);
  });

  it('the loader backlog, its age and damaged manifest lines are shown as numbers', async () => {
    await computeHealth(h.load.db, { ...inputs, backlog: { files: 2, bytes: 4096, age_s: 30 }, badLines: 3 });
    const doc = Health.parse(await json(await appAt().app.request('/api/v1/health')));
    expect(doc).toMatchObject({
      status: 'ok',
      loader: { backlog_files: 2, backlog_bytes: 4096, backlog_age_s: 30, bad_manifest_lines: 3 },
    });
    await computeHealth(h.load.db, inputs);
  });

  it('a stalled loader (a line unconsumed for 15 minutes) makes the document degraded, though health is fresh', async () => {
    await computeHealth(h.load.db, { ...inputs, backlog: { files: 1, bytes: 812, age_s: 900 } });
    const doc = Health.parse(await json(await appAt().app.request('/api/v1/health')));
    expect(doc).toMatchObject({ status: 'degraded', generated_at: NOW.toISOString(), loader: { backlog_age_s: 900 } });
    await computeHealth(h.load.db, inputs);
  });
});

describe('the database role', () => {
  it('the pool logs in as rws_api, read-only with a 2 s statement timeout, and cannot read outside the public family', async () => {
    const { rows } = await api.pool.query(
      'SELECT current_user AS u, current_setting($1) AS t, current_setting($2) AS ro',
      ['statement_timeout', 'transaction_read_only'],
    );
    expect(rows).toEqual([{ u: 'rws_api', t: '2s', ro: 'on' }]);
    const state = async (text: string) => {
      try {
        await api.pool.query(text);
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    };
    expect(await state(`SELECT 1 FROM ${VIEWS.owner.sourceHealth}`)).toBe('42501');
    expect(await state(`SELECT 1 FROM ${VIEWS.owner.ingestBatch}`)).toBe('42501');
    expect(await state('SELECT 1 FROM source_health')).toBe('42501');
    expect(await state('SELECT 1 FROM ingest_batch')).toBe('42501');
    expect(await state(`SELECT 1 FROM ${PUBLIC_ONLY_VIEWS.loader}`)).toBe('ok');
    expect(['42501', '25006']).toContain(await state('DELETE FROM source_health'));
  });
});

describe('failures', () => {
  it('a database error is a 503 with a fixed body and one fixed code in the log, and is not retried at once', async () => {
    // Nothing listens on port 1: ECONNREFUSED, whose text names the address.
    const cfg = dbConfig({ DATABASE_URL: 'postgres://nobody:secret@127.0.0.1:1/nowhere' }, 'rws_api');
    if (typeof cfg === 'string') throw new Error(cfg);
    const dead = openDb(cfg, { max: 1 });
    const { log, logged } = sink();
    const app = createApp({ db: dead.db, now: () => NOW, log });
    for (let i = 0; i < 2; i += 1) {
      const res = await app.request('/api/v1/health');
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.text()).toBe('{"status":"down","error":"unavailable"}');
    }
    expect((await app.request('/api/v1/health/sources')).status).toBe(503);
    expect(logged).toEqual([
      { level: 50, code: 'ECONNREFUSED', route: '/api/v1/health', msg: 'health unavailable' },
      { level: 50, code: 'ECONNREFUSED', route: '/api/v1/health/sources', msg: 'health unavailable' },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/127\.0\.0\.1|nobody|secret|nowhere/);
    await dead.close();
  });

  it('a document that does not match the contract is a 503 (fail closed), coded `contract`', async () => {
    await admin(
      `UPDATE source_health SET detail = detail || '{"partitions": {"bad": {"md5": "x", "rows": 1}}}' WHERE source_id = 'DE-1'`,
    );
    const { app, logged } = appAt();
    const res = await app.request('/api/v1/health/sources');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"down","error":"unavailable"}');
    expect(logged).toEqual([
      { level: 50, code: 'contract', route: '/api/v1/health/sources', msg: 'health unavailable' },
    ]);
    // The other route needs no detail and is unaffected.
    expect((await app.request('/api/v1/health')).status).toBe(200);
    await storeChecksums(h.load.db, NOW);
    expect((await appAt().app.request('/api/v1/health/sources')).status).toBe(200);
  });

  it('without a database both routes are 503 and /healthz is still 200', async () => {
    const app = createApp();
    expect((await app.request('/healthz')).status).toBe(200);
    for (const path of ['/api/v1/health', '/api/v1/health/sources']) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('{"status":"down","error":"unavailable"}');
    }
  });
});
