/**
 * API-level integration tests.
 *
 * These run against a throwaway database and a mocked upstream -- nothing here
 * touches the live Rijkswaterstaat service. They are skipped unless a database
 * is reachable, so `npm test` stays useful without one.
 *
 * Point TEST_DATABASE_URL at a PostgreSQL instance with TimescaleDB available
 * (docker-compose provides one). A uniquely named database is created and
 * dropped around the suite.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seriesIdentity } from '../src/rws/normalise.js';

const ADMIN_URL = process.env['TEST_DATABASE_URL']
  ?? 'postgres://postgres@127.0.0.1:5433/postgres';
const TEST_DB = `rws_test_${process.pid}`;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/trimmed');

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await canConnect();
const suite = dbAvailable ? describe : describe.skip;

if (!dbAvailable) {
  console.warn(
    `[integration] skipping: no database at ${ADMIN_URL}. ` +
    'Start one with docker-compose and set TEST_DATABASE_URL.',
  );
}

suite('API integration', () => {
  let app: FastifyInstance;
  let closePool: () => Promise<void>;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();

    // config reads the environment once at import, so it must be set before
    // any application module is loaded -- hence the dynamic imports below.
    const url = new URL(ADMIN_URL);
    url.pathname = `/${TEST_DB}`;
    process.env['DATABASE_URL'] = url.toString();
    process.env['LOG_LEVEL'] = 'silent';

    // Upstream is mocked for the whole suite; no live calls are made.
    vi.stubGlobal('fetch', fetchMock);

    const { migrate } = await import('../src/db/migrate.js');
    await migrate(() => {});

    const pool = await import('../src/db/pool.js');
    closePool = pool.closePool;

    // Seed one active location with two published quantities.
    await pool.getPool().query(`
      INSERT INTO locations (code, name, lat, lon, active, last_seen_at)
      VALUES ('vlissingen', 'Vlissingen', 51.442, 3.6, true, now()),
             ('sleepy', 'Sleepy Station', 52.0, 4.0, false, now() - INTERVAL '60 days')
    `);
    await pool.getPool().query(`
      INSERT INTO location_quantities (location_code, compartiment, grootheid, eenheid, last_seen_at)
      VALUES ('vlissingen', 'OW', 'WATHTE', 'cm', now()),
             ('vlissingen', 'OW', 'T', 'oC', now()),
             ('sleepy', 'OW', 'WATHTE', 'cm', now() - INTERVAL '60 days')
    `);
    await pool.getPool().query(`
      INSERT INTO aquo_codes (domain, code, description)
      VALUES ('grootheid', 'WATHTE', 'Waterhoogte'),
             ('compartiment', 'OW', 'Oppervlaktewater')
    `);

    const { buildServer } = await import('../src/api/server.js');
    app = await buildServer();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closePool?.();
    vi.unstubAllGlobals();

    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  /** Reply to the next upstream POST with a canned body. */
  function mockUpstream(status: number, body: unknown): void {
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === null ? '' : JSON.stringify(body)),
      json: async () => body,
      headers: new Headers(),
    });
  }

  it('returns only active locations by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((l: { code: string }) => l.code)).toEqual(['vlissingen']);
    expect(body[0].quantities).toEqual(['T', 'WATHTE']);
  });

  it('includes inactive locations when asked', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations?includeInactive=true' });
    const codes = res.json().map((l: { code: string }) => l.code).sort();
    expect(codes).toEqual(['sleepy', 'vlissingen']);
  });

  it('filters by quantity', async () => {
    const hit = await app.inject({ method: 'GET', url: '/api/locations?grootheid=T' });
    expect(hit.json()).toHaveLength(1);
    const miss = await app.inject({ method: 'GET', url: '/api/locations?grootheid=NOSUCH' });
    expect(miss.json()).toEqual([]);
  });

  it('searches by name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations?q=vliss' });
    expect(res.json()).toHaveLength(1);
  });

  it('filters by bounding box', async () => {
    const inside = await app.inject({ method: 'GET', url: '/api/locations?bbox=3,51,4,52' });
    expect(inside.json()).toHaveLength(1);
    const outside = await app.inject({ method: 'GET', url: '/api/locations?bbox=8,53,9,54' });
    expect(outside.json()).toEqual([]);
  });

  it('rejects a malformed bbox with the standard error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations?bbox=1,2,3' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'bad_request', message: expect.stringContaining('bbox') },
    });
  });

  it('404s an unknown location in the same envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations/nowhere' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('lists published measurement types even with no observations stored', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations/vlissingen' });
    const body = res.json();
    expect(body.measurementTypes.map((m: { quantity: string }) => m.quantity)).toEqual(['T', 'WATHTE']);
    // Labels come from the catalogue, and coverage is empty until ingest runs.
    const wathte = body.measurementTypes.find((m: { quantity: string }) => m.quantity === 'WATHTE');
    expect(wathte.quantityLabel).toBe('Waterhoogte');
    expect(wathte.coverage).toEqual({ from: null, to: null, points: 0 });
  });

  it('ingests from upstream on demand and serves the result', async () => {
    // A trimmed shape of a real OphalenWaarnemingen response.
    mockUpstream(200, {
      Succesvol: true,
      WaarnemingenLijst: [{
        Locatie: { Code: 'vlissingen', Naam: 'Vlissingen', Lat: 51.442, Lon: 3.6 },
        AquoMetadata: {
          Compartiment: { Code: 'OW', Omschrijving: 'Oppervlaktewater' },
          Grootheid: { Code: 'WATHTE', Omschrijving: 'Waterhoogte' },
          Eenheid: { Code: 'cm' },
          ProcesType: 'meting',
        },
        MetingenLijst: [
          {
            Tijdstip: '2026-08-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 100, Waarde_Alfanumeriek: '100' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00', Statuswaarde: 'Ongecontroleerd' },
          },
          {
            Tijdstip: '2026-08-01T02:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 120, Waarde_Alfanumeriek: '120' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00', Statuswaarde: 'Ongecontroleerd' },
          },
          {
            // A gap: the 99999 sentinel must not reach the client as a value.
            Tijdstip: '2026-08-01T03:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 99999, Waarde_Alfanumeriek: '99999' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '99', Statuswaarde: 'Ongecontroleerd' },
          },
        ],
      }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/locations/vlissingen/observations'
        + '?grootheid=WATHTE&from=2026-08-01T00:00:00Z&to=2026-08-01T06:00:00Z&resolution=raw',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resolution).toBe('raw');
    expect(body.unit).toBe('cm');
    // The gap is filtered out of the default view by quality code.
    expect(body.points.map((p: { v: number }) => p.v)).toEqual([100, 120]);
    // Timestamps are UTC, converted from the archive's fixed +01:00 offset.
    expect(body.points[0].t).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns the gap when the quality filter is opted out of, still without the sentinel', async () => {
    // The stored window ends before the requested `to`, so the route tries
    // upstream again; 204 means it finds nothing new and serves what is stored.
    mockUpstream(204, null);
    const res = await app.inject({
      method: 'GET',
      url: '/api/locations/vlissingen/observations'
        + '?grootheid=WATHTE&from=2026-08-01T00:00:00Z&to=2026-08-01T06:00:00Z'
        + '&resolution=raw&includeAllQuality=true',
    });
    const body = res.json();
    const gap = body.points.find((p: { q: string }) => p.q === '99');
    expect(gap).toBeDefined();
    // Raw code preserved for the consumer, but 99999 never surfaces as a value.
    expect(gap.v).toBeNull();
  });

  it('serves an upstream 204 as an empty series rather than an error', async () => {
    mockUpstream(204, null);
    const res = await app.inject({
      method: 'GET',
      url: '/api/locations/vlissingen/observations'
        + '?grootheid=T&from=2026-08-01T00:00:00Z&to=2026-08-01T06:00:00Z',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toEqual([]);
    expect(res.json().backfillPending).toBe(true);
  });

  it('maps an upstream failure to 502', async () => {
    // Every retry fails, so the client sees a gateway error rather than a 500.
    fetchMock.mockRejectedValue(new Error('connection reset'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/locations/vlissingen/observations'
        + '?grootheid=T&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('upstream_failure');
    fetchMock.mockReset();
  }, 60_000);

  it('requires a quantity on the observations endpoint', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/locations/vlissingen/observations',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('grootheid');
  });

  it('reports the latest stored value per series', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/locations/vlissingen/latest' });
    const body = res.json();
    expect(body).toHaveLength(1);
    // The newest stored row for this series is a gap; the latest *reading* is
    // the 120 before it, which is what the panel needs to show.
    expect(body[0]).toMatchObject({
      code: 'vlissingen', quantity: 'WATHTE', unit: 'cm', value: 120,
    });
  });

  it('exposes quantities and compartments for the filter UI', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quantities' });
    const body = res.json();
    expect(body.quantities.map((q: { code: string }) => q.code).sort()).toEqual(['T', 'WATHTE']);
    const wathte = body.quantities.find((q: { code: string }) => q.code === 'WATHTE');
    expect(wathte).toMatchObject({ label: 'Waterhoogte', activeLocations: 1 });
    expect(body.compartments[0]).toMatchObject({ code: 'OW', label: 'Oppervlaktewater' });
  });

  it('reports health including location counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locations).toEqual({ total: 2, active: 1 });
    expect(body.backfill.total).toBe(0);
  });

  it('404s an unknown endpoint in the standard envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('never leaks raw Rijkswaterstaat field names to clients', async () => {
    // The whole point of this layer: Dutch wire-format names stay inside it.
    for (const url of [
      '/api/locations',
      '/api/locations/vlissingen',
      '/api/locations/vlissingen/latest',
      '/api/quantities',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      const payload = res.payload;
      for (const leak of [
        'MetingenLijst', 'AquoMetadata', 'Waarde_Alfanumeriek', 'Meetwaarde',
        'Kwaliteitswaardecode', 'Tijdstip', 'LocatieLijst', 'Grootheid',
      ]) {
        expect(payload, `${leak} leaked from ${url}`).not.toContain(leak);
      }
    }
  });

  it('applies migrations idempotently', async () => {
    const { migrate } = await import('../src/db/migrate.js');
    const result = await migrate(() => {});
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('has the hypertable, both continuous aggregates and their policies', async () => {
    const { getPool } = await import('../src/db/pool.js');

    const hypertables = await getPool().query(
      `SELECT hypertable_name FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'observations'`,
    );
    expect(hypertables.rows).toHaveLength(1);

    const aggregates = await getPool().query(
      `SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY view_name`,
    );
    expect(aggregates.rows.map((r: { view_name: string }) => r.view_name))
      .toEqual(['observations_daily', 'observations_hourly']);

    const policies = await getPool().query(
      `SELECT proc_name FROM timescaledb_information.jobs
        WHERE proc_name IN ('policy_compression', 'policy_refresh_continuous_aggregate')`,
    );
    // One compression policy plus one refresh policy per aggregate.
    expect(policies.rows.length).toBe(3);

    // 7-day chunks, per the storage decision. pg returns an interval object.
    const dimensions = await getPool().query<{ time_interval: { days?: number } }>(
      `SELECT time_interval FROM timescaledb_information.dimensions
        WHERE hypertable_name = 'observations'`,
    );
    expect(dimensions.rows[0]?.time_interval).toMatchObject({ days: 7 });
  });

  describe('backfill queue semantics', () => {
    it('marks a chunk done in the same transaction as its rows', async () => {
      // This is the crash-safety property: a chunk can never be recorded as
      // complete while its data is missing.
      const { enqueue, claim, completeWithData, stats } = await import('../src/backfill/queue.js');
      const { getPool } = await import('../src/db/pool.js');

      const month = new Date('2026-04-01T00:00:00Z');
      await enqueue([{
        locationCode: 'vlissingen', compartiment: 'OW', grootheid: 'WATHTE',
        month, tier: 'eager', priority: 10,
      }]);

      const job = await claim();
      expect(job).not.toBeNull();

      await completeWithData(job!, [{
        identity: seriesIdentity('vlissingen',
          { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' }, ProcesType: 'meting' },
          { Bemonsteringshoogte: '0' }),
        location: { code: 'vlissingen', name: 'Vlissingen', lat: 51.4, lon: 3.6 },
        points: [
          { t: '2026-04-01T00:00:00.000Z', value: 10, text: '10', qualityCode: '00', status: 'Ongecontroleerd' },
          { t: '2026-04-01T00:10:00.000Z', value: 12, text: '12', qualityCode: '00', status: 'Ongecontroleerd' },
        ],
      }]);

      const { rows } = await getPool().query(
        `SELECT status, rows_written, fetched_at FROM backfill_jobs WHERE id = $1`, [job!.id]);
      expect(rows[0].status).toBe('done');
      expect(Number(rows[0].rows_written)).toBe(2);
      // fetched_at records how fresh this slice of history is.
      expect(rows[0].fetched_at).not.toBeNull();

      const s = await stats();
      expect(s.done).toBeGreaterThan(0);
    });

    it('never re-queues a chunk that already completed, which is what makes resume work', async () => {
      const { enqueue } = await import('../src/backfill/queue.js');
      const job = {
        locationCode: 'vlissingen', compartiment: 'OW', grootheid: 'WATHTE',
        month: new Date('2026-04-01T00:00:00Z'), tier: 'eager', priority: 10,
      };
      const inserted = await enqueue([job]);
      expect(inserted).toBe(0);
    });

    it('parks a chunk as failed only after the retry limit, so one bad chunk cannot stall the queue', async () => {
      const { enqueue, claim, recordFailure } = await import('../src/backfill/queue.js');
      await enqueue([{
        locationCode: 'vlissingen', compartiment: 'OW', grootheid: 'T',
        month: new Date('2026-04-01T00:00:00Z'), tier: 'eager', priority: 20,
      }]);

      let job = await claim(); // attempts -> 1
      expect(job).not.toBeNull();
      expect(await recordFailure(job!, 'upstream exploded', 3)).toBe('pending');

      job = await claim(); // attempts -> 2
      expect(await recordFailure(job!, 'upstream exploded', 3)).toBe('pending');

      job = await claim(); // attempts -> 3, at the limit
      expect(await recordFailure(job!, 'upstream exploded', 3)).toBe('failed');

      // Parked, so the next claim moves on rather than looping on it.
      expect(await claim()).toBeNull();
    });

    it('returns stale running claims to the queue after a crash', async () => {
      const { claim, reclaimStale, retryFailed } = await import('../src/backfill/queue.js');
      const { getPool } = await import('../src/db/pool.js');

      await retryFailed();
      const job = await claim();
      expect(job).not.toBeNull();

      // A live worker's claim must not be stolen.
      expect(await reclaimStale(30)).toBe(0);

      // Age it past the threshold, as a crashed worker's claim would be.
      await getPool().query(
        `UPDATE backfill_jobs SET started_at = now() - INTERVAL '2 hours' WHERE id = $1`,
        [job!.id]);
      expect(await reclaimStale(30)).toBe(1);
    });

    it('re-queues a window for the correction re-fetch', async () => {
      // The archive revises published values in place, so done chunks in the
      // recent window are deliberately reset to be downloaded again.
      const { requeueWindow } = await import('../src/backfill/queue.js');
      const n = await requeueWindow(
        new Date('2026-04-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
      expect(n).toBeGreaterThan(0);
    });
  });

  describe('production hardening', () => {
    it('rate-limits with a 429 and the standard envelope, not a 500', async () => {
      // A throttled client told "500" retries immediately instead of backing
      // off, so the status has to survive the shared error handler.
      const { buildServer } = await import('../src/api/server.js');
      process.env['RATE_LIMIT_MAX'] = '2';
      vi.resetModules();
      const limited = await (await import('../src/api/server.js')).buildServer();

      try {
        const codes: number[] = [];
        for (let i = 0; i < 4; i++) {
          codes.push((await limited.inject({ method: 'GET', url: '/api/quantities' })).statusCode);
        }
        expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);

        const limitedRes = await limited.inject({ method: 'GET', url: '/api/quantities' });
        expect(limitedRes.statusCode).toBe(429);
        expect(limitedRes.json()).toEqual({
          error: { code: 'rate_limited', message: expect.stringContaining('Too many requests') },
        });

        // A monitor must never be able to trip the limiter.
        const health = await limited.inject({ method: 'GET', url: '/api/health' });
        expect(health.statusCode).toBe(200);
      } finally {
        await limited.close();
        delete process.env['RATE_LIMIT_MAX'];
        vi.resetModules();
        expect(buildServer).toBeTypeOf('function');
      }
    }, 30_000);

    it('keeps the JSON envelope for unknown /api paths', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('sends a CORS header, since RWS itself sends none', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  it('has a fixture set the normalisers can be tested against', () => {
    // Guards the trimmed fixtures against being dropped or emptied.
    const catalogue = JSON.parse(
      readFileSync(join(FIXTURES, 'OphalenCatalogus.json'), 'utf8'),
    );
    expect(catalogue.AquoMetadataLijst.length).toBeGreaterThan(0);
  });
});
