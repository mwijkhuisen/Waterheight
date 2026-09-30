import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SchemaDrift } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureArchive, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { driftCount, driftReport } from '../../src/adapters/de-1/drift.ts';
import { parseStations } from '../../src/adapters/de-1/parse.ts';
import { createApp } from '../../src/app.ts';
import { LOAD_ADAPTERS, type LoadAdapter } from '../../src/load/adapters.ts';
import { computeHealth } from '../../src/load/health.ts';
import { Loader } from '../../src/load/pipeline.ts';
import { replay } from '../../src/load/replay.ts';
import { seriesOf } from '../../src/load/store.ts';
import { check } from '../../src/watchdog/watchdog.ts';
import { EMMERICH_W, type Harness, harness, measurements, SERIES_URL } from './harness.ts';

// Drift simulation (issue #17): a mutated payload is quarantined and raises an
// alert, the other payloads still load, and a replay after the fix loads it.

let h: Harness;

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

const status = async () =>
  (
    await h.t.admin.query(
      'SELECT spec_id, parse_status, error, adapter_version, n_new FROM ingest_batch ORDER BY fetched_at, id',
    )
  ).rows;

describe('schema drift', () => {
  it('quarantines only the mutated payload; every other payload loads and the cursor moves on', async () => {
    const drift = recorded('de-1-basin-drift.synthetic');
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-basin',
      variant: '',
      at: new Date('2026-09-29T13:30:00Z'),
      body: drift.body,
      url: drift.url,
    });
    await buildFixtureArchive(h.raw);
    const loader = h.loader();
    expect(await loader.tick()).toEqual({ lines: 7, loaded: 6 });
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0, age_s: null });
    expect(await status()).toEqual([
      {
        spec_id: 'de-1-basin',
        parse_status: 'quarantined',
        error: 'unrecognized_keys at 0.timeseries.0.currentMeasurement',
        adapter_version: 1,
        n_new: 0,
      },
      ...Array(6).fill(expect.objectContaining({ parse_status: 'ok' })),
    ]);
    expect(h.alerts.splice(0)).toEqual([
      { code: 'quarantined', fields: { source: 'DE-1', spec: 'de-1-basin', code: 'unrecognized_keys' } },
    ]);
    expect(await h.count('obs')).toBeGreaterThan(3000);
    // Nothing of the quarantined payload was stored.
    const n = (
      await h.t.admin.query(
        "SELECT count(*)::int AS n FROM obs o JOIN ingest_batch b ON b.id = o.batch_id WHERE b.parse_status <> 'ok'",
      )
    ).rows;
    expect(n).toEqual([{ n: 0 }]);
  });

  it('the loader stores the registry drift report of the day: nothing differs from the recorded basin call', async () => {
    const { rows } = await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'registry_drift:DE-1'");
    expect(rows).toEqual([
      { value: { at: '2026-09-29T13:43:26.000Z', spec: 'de-1-basin', unregistered: [], vanished: [], changed: [] } },
    ]);
  });

  it('a replay with the same parser quarantines it again without a second batch row', async () => {
    const before = await h.count('ingest_batch');
    const result = await replay(
      {
        db: h.load.db,
        reader: h.reader,
        alert: (code, fields = {}) => h.alerts.push({ code, fields }),
        now: () => new Date(),
      },
      { source: 'DE-1', spec: 'de-1-basin', from: '2026-09-29', to: '2026-09-29', dryRun: false },
    );
    expect(result).toMatchObject({ lines: 2, loaded: 1, quarantined: 1, n_new: 0, n_changed: 0 });
    expect(await h.count('ingest_batch')).toBe(before);
    expect(h.alerts.splice(0).map((a) => a.code)).toEqual(['quarantined']);
  });

  it('a replay after the fix loads the quarantined payload and marks its batch ok', async () => {
    // The "fix": a parser version that accepts the new key.
    const fixed: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 2,
        specs: {
          ...(LOAD_ADAPTERS['DE-1'] as LoadAdapter).specs,
          'de-1-basin': {
            maxBytes: 4 * 1024 * 1024,
            needsVariant: false,
            run: (body, ctx) => {
              const doc = JSON.parse(Buffer.from(body).toString('utf8'));
              for (const s of doc) for (const t of s.timeseries) delete t.currentMeasurement?.trend;
              return (LOAD_ADAPTERS['DE-1'] as LoadAdapter).specs['de-1-basin']?.run(
                Buffer.from(JSON.stringify(doc)),
                ctx,
              ) as never;
            },
          },
        },
      },
    };
    const result = await replay(
      {
        db: h.load.db,
        reader: h.reader,
        alert: (code, fields = {}) => h.alerts.push({ code, fields }),
        now: () => new Date(),
        adapters: fixed,
      },
      { source: 'DE-1', spec: 'de-1-basin', from: '2026-09-29', to: '2026-09-29', dryRun: false },
    );
    expect(result).toMatchObject({ lines: 2, loaded: 2, quarantined: 0 });
    expect(h.alerts).toEqual([]);
    const first = (await status())[0];
    expect(first).toMatchObject({ spec_id: 'de-1-basin', parse_status: 'ok', error: null, adapter_version: 2 });
    // The drift payload was fetched before the real basin payload: newest fetch wins, so it changed no stored value.
    expect(await h.count('obs_revision')).toBe(0);
  });

  it('--dry-run counts and touches nothing', async () => {
    const before = await h.checksums();
    const result = await replay(
      { db: h.load.db, reader: h.reader, alert: () => {}, now: () => new Date() },
      { source: 'DE-1', spec: null, from: '2026-09-01', to: '2026-09-30', dryRun: true },
    );
    expect(result).toEqual({ lines: 7, loaded: 0, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
    expect(await h.checksums()).toEqual(before);
  });
});

describe('payloads the loader cannot use', () => {
  it('a corrupt object, a wrong hash and a missing object are set aside with fixed codes', async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 10, m));
    const good = measurements(['2026-09-30T12:00:00+02:00', 1]);
    const corrupt = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at(1),
      body: good,
      url: SERIES_URL(EMMERICH_W),
    });
    const { writeFileSync, unlinkSync } = await import('node:fs');
    writeFileSync(h.archive.path(corrupt.key as string), 'not zstd');
    const wrongHash = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at(2),
      body: measurements(['2026-09-30T12:15:00+02:00', 2]),
      url: SERIES_URL(EMMERICH_W),
    });
    // Same key, other content: the archived bytes no longer match the manifest's sha256.
    const { zstdCompressSync } = await import('node:zlib');
    writeFileSync(
      h.archive.path(wrongHash.key as string),
      zstdCompressSync(measurements(['2026-09-30T12:15:00+02:00', 777])),
    );
    const missing = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at(3),
      body: measurements(['2026-09-30T12:30:00+02:00', 3]),
      url: SERIES_URL(EMMERICH_W),
    });
    unlinkSync(h.archive.path(missing.key as string));
    const huge = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at(4),
      body: Buffer.alloc(9 * 1024 * 1024, 0x20),
      url: SERIES_URL(EMMERICH_W),
    });
    const html = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at(5),
      body: Buffer.from('<html>Wartung</html>'),
      url: SERIES_URL(EMMERICH_W),
    });
    const after = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at(6),
      body: measurements(['2026-09-30T12:00:00+02:00', 1]),
      url: SERIES_URL(EMMERICH_W),
    });

    expect(await h.loader().tick()).toEqual({ lines: 6, loaded: 1 });
    const rows = (
      await h.t.admin.query('SELECT archive_key, parse_status, error FROM ingest_batch WHERE archive_key = ANY($1)', [
        [corrupt.key, wrongHash.key, missing.key, huge.key, html.key, after.key],
      ])
    ).rows;
    const by = Object.fromEntries(rows.map((r) => [r.archive_key, `${r.parse_status}:${r.error}`]));
    expect(by).toEqual({
      [corrupt.key as string]: 'quarantined:archive_corrupt',
      [wrongHash.key as string]: 'quarantined:sha256_mismatch',
      [missing.key as string]: 'skipped:object_missing',
      [huge.key as string]: 'quarantined:archive_too_large',
      [html.key as string]: 'quarantined:not_json',
      [after.key as string]: 'ok:null',
    });
    // A missing object in the tail is news too (the recorder writes the object before its line), but it is skipped.
    expect(
      h.alerts
        .splice(0)
        .map((a) => `${a.code}:${a.fields.code ?? ''}`)
        .sort(),
    ).toEqual([
      'object_missing:',
      'quarantined:archive_corrupt',
      'quarantined:archive_too_large',
      'quarantined:not_json',
      'quarantined:sha256_mismatch',
    ]);
    const n = (await h.t.admin.query('SELECT count(*)::int AS n FROM obs WHERE value = 777')).rows;
    expect(n).toEqual([{ n: 0 }]);
  });

  it('a payload that keeps failing in the database is tried twice and quarantined on the third pass, untouched', async () => {
    // A parser bug that yields a row the database refuses (qc outside the bitmask).
    let runs = 0;
    const broken: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            maxBytes: 1024,
            needsVariant: true,
            run: (body) => {
              runs += 1;
              return body.length === 2
                ? { obs: [], gaugeZeros: [], dropped: {}, unknown: 0 }
                : {
                    obs: [{ series: EMMERICH_W, ts: '2026-09-30T11:00:00.000Z', value: 1, qc: 5000 }],
                    gaugeZeros: [],
                    dropped: {},
                    unknown: 0,
                  };
            },
          },
        },
      },
    };
    // A damaged manifest line in front of it is re-read on every stalled pass: counted and alerted once only.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(`${h.raw}/_manifest/2026-09-30.jsonl`, '{"v":1,"damaged"\n');
    const poison = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-30T11:01:00Z'),
      body: Buffer.from('[1]'),
      url: SERIES_URL(EMMERICH_W),
    });
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-30T11:02:00Z'),
      body: Buffer.from('[]'),
      url: SERIES_URL(EMMERICH_W),
    });
    const loader = h.loader({ adapters: broken });
    expect(await loader.tick()).toEqual({ lines: 1, loaded: 0 });
    // The stall is alerted once when it starts, with the fixed code of the cause, not on every pass.
    expect(h.alerts.splice(0)).toEqual([
      { code: 'manifest_bad_line', fields: { file: '2026-09-30.jsonl' } },
      { code: 'load_stalled', fields: { source: 'DE-1', spec: 'de-1-series', code: 'load_error', stalled_s: 0 } },
    ]);
    expect(await loader.tick()).toEqual({ lines: 1, loaded: 0 });
    expect(h.alerts).toEqual([]);
    expect(loader.badLines).toBe(1);
    expect(runs).toBe(2);
    expect(await loader.tick()).toEqual({ lines: 3, loaded: 1 });
    expect(loader.badLines).toBe(1);
    // The third pass did not run the parser for the poison payload (the second line ran it once).
    expect(runs).toBe(3);
    const row = (
      await h.t.admin.query('SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1', [poison.key])
    ).rows;
    expect(row).toEqual([{ parse_status: 'quarantined', error: 'load_error' }]);
    expect(h.alerts.splice(0)).toEqual([
      { code: 'quarantined', fields: { source: 'DE-1', spec: 'de-1-series', code: 'load_error' } },
    ]);
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0, age_s: null });
  });

  it('a payload that kills the loader twice is quarantined on the next pass without reading or parsing it', async () => {
    const crash = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-30T11:03:00Z'),
      body: Buffer.from('[3]'),
      url: SERIES_URL(EMMERICH_W),
    });
    const child = fileURLToPath(new URL('./crash-child.ts', import.meta.url));
    const attempt = async () =>
      (await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'load_attempt'")).rows[0]?.value;
    // Two loader processes die inside the parser (as an out-of-memory kill would): each leaves its attempt behind.
    for (const n of [1, 2]) {
      const run = spawnSync(process.execPath, ['--no-experimental-webstorage', child, h.t.urlFor('rws_load'), h.raw], {
        timeout: 60_000,
      });
      expect(run.status).toBe(137);
      expect(await attempt()).toEqual({ key: crash.key, n, code: 'load_crashed' });
    }
    // The third pass never opens the object (it is unreadable now) and never runs a parser.
    let runs = 0;
    const spy: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            maxBytes: 1024,
            needsVariant: true,
            run: () => {
              runs += 1;
              return { obs: [], gaugeZeros: [], dropped: {}, unknown: 0 };
            },
          },
        },
      },
    };
    chmodSync(h.archive.path(crash.key as string), 0o000);
    try {
      expect(await h.loader({ adapters: spy }).tick()).toEqual({ lines: 1, loaded: 0 });
    } finally {
      chmodSync(h.archive.path(crash.key as string), 0o640);
    }
    expect(runs).toBe(0);
    expect(
      (await h.t.admin.query('SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1', [crash.key])).rows,
    ).toEqual([{ parse_status: 'quarantined', error: 'load_crashed' }]);
    expect(h.alerts.splice(0)).toEqual([
      { code: 'quarantined', fields: { source: 'DE-1', spec: 'de-1-series', code: 'load_crashed' } },
    ]);
  });

  it('a failure outside the payload (the database going away) stalls and alerts, and never counts', async () => {
    const key = (
      await writePayload(h.archive, {
        source: 'DE-1',
        spec: 'de-1-series',
        variant: EMMERICH_W,
        at: new Date('2026-09-30T11:04:00Z'),
        body: measurements(['2026-09-30T13:00:00+02:00', 4]),
        url: SERIES_URL(EMMERICH_W),
      })
    ).key;
    // The last statement of every load transaction fails as a server shutdown would (57P01).
    await h.t.admin.query(`
      CREATE FUNCTION fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'down' USING ERRCODE = '57P01'; END $$;
      CREATE TRIGGER fail_cursor BEFORE INSERT OR UPDATE ON load_cursor FOR EACH ROW EXECUTE FUNCTION fail_cursor();`);
    const loader = h.loader();
    try {
      for (let pass = 0; pass < 4; pass++) expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
    } finally {
      await h.t.admin.query('DROP TRIGGER fail_cursor ON load_cursor; DROP FUNCTION fail_cursor()');
    }
    const attempt = (await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'load_attempt'")).rows[0]?.value;
    expect(attempt).toEqual({ key, n: 0, code: 'load_crashed' });
    // Alerted when it started, with the SQLSTATE: not on every one of the four passes.
    expect(h.alerts.splice(0)).toEqual([
      { code: 'load_stalled', fields: { source: 'DE-1', spec: 'de-1-series', code: '57P01', stalled_s: 0 } },
    ]);
    // Four passes did not use up the payload's two tries: it loads now.
    expect(await loader.tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0, age_s: null });
  });

  // Review C1 (exp3): one object at mode 000 with a good payload behind it. Root reads anything: skipped as root.
  it.skipIf(process.getuid?.() === 0)(
    'an object the loader cannot read is tried twice, then quarantined with an alert; the payload behind it loads',
    async () => {
      const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 11, m));
      const unreadable = await writePayload(h.archive, {
        source: 'DE-1',
        spec: 'de-1-series',
        variant: EMMERICH_W,
        at: at(6),
        body: measurements(['2026-09-30T13:15:00+02:00', 5]),
        url: SERIES_URL(EMMERICH_W),
      });
      await writePayload(h.archive, {
        source: 'DE-1',
        spec: 'de-1-series',
        variant: EMMERICH_W,
        at: at(7),
        body: measurements(['2026-09-30T12:45:00+02:00', 6]),
        url: SERIES_URL(EMMERICH_W),
      });
      chmodSync(h.archive.path(unreadable.key as string), 0o000);
      const loader = h.loader();
      try {
        expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
        expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
        expect(await loader.tick()).toEqual({ lines: 2, loaded: 1 });
      } finally {
        chmodSync(h.archive.path(unreadable.key as string), 0o640);
      }
      expect(
        (await h.t.admin.query('SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1', [unreadable.key]))
          .rows,
      ).toEqual([{ parse_status: 'quarantined', error: 'archive_unreadable' }]);
      expect(h.alerts.splice(0).map((a) => [a.code, a.fields.code])).toEqual([
        ['load_stalled', 'archive_unreadable'],
        ['quarantined', 'archive_unreadable'],
      ]);
      const id = (await h.t.admin.query('SELECT id FROM series WHERE provider_key = $1', [EMMERICH_W])).rows[0].id;
      expect(
        (await h.t.admin.query("SELECT value FROM obs WHERE series_id = $1 AND ts = '2026-09-30T10:45:00Z'", [id]))
          .rows,
      ).toEqual([{ value: 6 }]);
    },
  );

  it("a broken deployment (a missing grant) stalls the tail, never quarantines, and turns the watchdog's load check red", async () => {
    const fetched = new Date('2026-09-30T11:08:00Z');
    const line = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: fetched,
      body: measurements(['2026-09-30T13:00:00+02:00', 7]),
      url: SERIES_URL(EMMERICH_W),
    });
    await h.t.admin.query('REVOKE UPDATE ON obs FROM rws_load');
    const loader = h.loader();
    try {
      for (let pass = 0; pass < 4; pass++) expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
      // No batch row: nothing was quarantined or skipped.
      expect((await h.t.admin.query('SELECT 1 FROM ingest_batch WHERE archive_key = $1', [line.key])).rows).toEqual([]);
      expect(h.alerts.splice(0).map((a) => [a.code, a.fields.code])).toEqual([['load_stalled', '42501']]);

      // Twenty minutes on: the health pass publishes the age of the stuck line, and the watchdog pages.
      const now = new Date(fetched.getTime() + 20 * 60_000);
      const backlog = await loader.backlog(now);
      expect(backlog).toMatchObject({ files: 1, age_s: 1200 });
      await computeHealth(h.load.db, { cadenceS: new Map(), lagP95Ms: new Map(), backlog, badLines: 0, now });
      const api = h.dbAs('rws_api');
      const res = await createApp({ db: api.db, now: () => now }).request('/api/v1/health');
      const body = Buffer.from(await res.text());
      expect(JSON.parse(body.toString())).toMatchObject({ status: 'degraded', loader: { backlog_age_s: 1200 } });
      const verdicts = await check(
        {
          get: async (path) => (path === '/api/v1/health' ? { status: res.status, body } : { error: 'not_asked' }),
          certDaysLeft: async () => 90,
        },
        now,
      );
      // (Earlier tests of this file left quarantined payloads behind: `load_quarantined` fires as well.)
      expect(verdicts.load).toContain('load_backlog');
      expect(verdicts.load).not.toContain('load_stale');
    } finally {
      await h.t.admin.query('GRANT UPDATE ON obs TO rws_load');
    }
    // The grant is back: the same line loads, nothing was skipped.
    expect(await loader.tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0, age_s: null });
  });

  it('a payload that loaded before (a replay ran ahead of the tail) is never downgraded by a later quarantine', async () => {
    const line = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: new Date('2026-09-30T11:09:00Z'),
      body: measurements(['2026-09-30T13:00:00+02:00', 8]),
      url: SERIES_URL(EMMERICH_W),
    });
    await replay(
      { db: h.load.db, reader: h.reader, alert: () => {}, now: () => new Date() },
      { source: 'DE-1', spec: 'de-1-series', from: '2026-09-30', to: '2026-09-30', dryRun: false },
    );
    const status = async () =>
      (await h.t.admin.query('SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1', [line.key])).rows;
    expect(await status()).toEqual([{ parse_status: 'ok', error: null }]);
    // The tail meets it with a parser whose rows the database refuses: two tries, then the quarantine path.
    const refused: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            maxBytes: 1024,
            needsVariant: true,
            run: () => ({
              obs: [{ series: EMMERICH_W, ts: '2026-09-30T11:00:00.000Z', value: 1, qc: 5000 }],
              gaugeZeros: [],
              dropped: {},
              unknown: 0,
            }),
          },
        },
      },
    };
    const loader = h.loader({ adapters: refused });
    for (let pass = 0; pass < 3; pass++) await loader.tick();
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0, age_s: null });
    expect(await status()).toEqual([{ parse_status: 'ok', error: null }]);
    h.alerts.length = 0;
  });

  it('a long tick stops between lines at its time budget or when asked to stop, and goes on where it stopped', async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 11, 10 + m));
    for (let i = 0; i < 5; i++) {
      await writePayload(h.archive, {
        source: 'DE-1',
        spec: 'de-1-series',
        variant: EMMERICH_W,
        at: at(i),
        body: measurements([`2026-09-30T13:${String(i).padStart(2, '0')}:00+02:00`, 20 + i]),
        url: SERIES_URL(EMMERICH_W),
      });
    }
    // A clock that moves one second per reading: a budget of 2.5 s ends the tick after a few lines.
    let clock = at(10).getTime();
    const loader = new Loader({
      db: h.load.db,
      reader: h.reader,
      alert: (code, fields = {}) => h.alerts.push({ code, fields }),
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
    });
    const first = await loader.tick({ until: clock + 2500 });
    expect(first.more).toBe(true);
    expect(first.lines).toBeGreaterThan(0);
    expect(first.lines).toBeLessThan(5);
    // A stop asked for before the tick begins still lets one line through (progress), then stops.
    expect(await loader.tick({ stop: () => true })).toEqual({ lines: 1, loaded: 1, more: true });
    let lines = first.lines + 1;
    for (;;) {
      const next = await loader.tick({ until: clock + 2500 });
      lines += next.lines;
      if (!next.more) break;
    }
    expect(lines).toBe(5);
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0, age_s: null });
    expect(h.alerts).toEqual([]);
  });

  it('tells a failure of the payload from a broken deployment or database (review C8)', async () => {
    const { ArchiveError } = await import('../../src/archive/reader.ts');
    const { failureOf } = await import('../../src/load/pipeline.ts');
    const pg = (code: string) => Object.assign(new Error('driver text'), { code });
    // The payload's own: a constraint, a bad value, a bug its data triggers, an object that cannot be read.
    for (const code of ['23514', '23505', '22P02', '22003', '21000', '42P10', 'P0001'])
      expect([code, failureOf(pg(code))]).toEqual([code, { kind: 'payload', code: 'load_error' }]);
    expect(failureOf(new TypeError('x'))).toEqual({ kind: 'payload', code: 'load_error' });
    expect(failureOf(new ArchiveError('unreadable'))).toEqual({ kind: 'payload', code: 'archive_unreadable' });
    // Not the payload's: a missing grant, table, column or function, a feature, a lock timeout, the connection.
    for (const code of ['42501', '42P01', '42703', '42883', '0A000', '55P03', '57P01', '08006', '53300', '40001'])
      expect([code, failureOf(pg(code))]).toEqual([code, { kind: 'stall', code }]);
    expect(failureOf(new Error('Connection terminated unexpectedly'))).toEqual({ kind: 'stall', code: 'unknown' });
    expect(failureOf(Object.assign(new Error('x'), { code: 'EACCES' }))).toEqual({ kind: 'stall', code: 'EACCES' });
  });

  it('a parser that throws something unexpected quarantines that payload as adapter_error', async () => {
    const throwing: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            maxBytes: 1024,
            needsVariant: true,
            run: () => {
              throw new Error('secret provider text');
            },
          },
        },
      },
    };
    const key = (
      await writePayload(h.archive, {
        source: 'DE-1',
        spec: 'de-1-series',
        variant: EMMERICH_W,
        at: new Date('2026-09-30T11:05:00Z'),
        body: Buffer.from('[2]'),
        url: SERIES_URL(EMMERICH_W),
      })
    ).key;
    await h.loader({ adapters: throwing }).tick();
    const row = (await h.t.admin.query('SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1', [key]))
      .rows;
    expect(row).toEqual([{ parse_status: 'quarantined', error: 'adapter_error' }]);
    expect(JSON.stringify(h.alerts.splice(0))).not.toContain('secret');
    expect(new SchemaDrift('x')).toBeInstanceOf(Error);
  });
});

describe('a unit switch (review C7) and what the pruner keeps (review C10)', () => {
  it('series payloads of a series whose unit changed store nothing until the registry is fixed, then a replay loads them', async () => {
    const basin = recorded('de-1-basin');
    const withUnit = (unit: string, value: number) => {
      const doc = JSON.parse(basin.body.toString('utf8')) as {
        uuid: string;
        timeseries: { shortname: string; unit: string; currentMeasurement?: { value: number } }[];
      }[];
      for (const station of doc)
        for (const t of station.timeseries)
          if (`${station.uuid}/${t.shortname}` === EMMERICH_W) {
            t.unit = unit;
            if (t.currentMeasurement) t.currentMeasurement.value = value;
          }
      return Buffer.from(JSON.stringify(doc));
    };
    const at = (hhmm: string) => new Date(`2026-09-30T${hhmm}:00Z`);
    // The provider switches Emmerich W from cm to m+NN: the basin call shows it.
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-basin',
      variant: '',
      at: at('12:00'),
      body: withUnit('m+NN', 7.7),
      url: basin.url,
    });
    expect(await h.loader().tick()).toMatchObject({ lines: 1, loaded: 1 });
    const list = await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'unit_mismatch:DE-1'");
    expect(list.rows).toEqual([{ value: { at: '2026-09-30T12:00:00.000Z', keys: [EMMERICH_W] } }]);
    // The hourly series payload carries no unit: its metres would be stored as centimetres. They are not.
    const series = await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-series',
      variant: EMMERICH_W,
      at: at('12:40'),
      body: measurements(['2026-09-30T14:15:00+02:00', 7.8], ['2026-09-30T14:30:00+02:00', 7.9]),
      url: SERIES_URL(EMMERICH_W),
    });
    h.alerts.length = 0;
    expect(await h.loader().tick()).toMatchObject({ lines: 1, loaded: 1 });
    const batch = async () =>
      (
        await h.t.admin.query('SELECT parse_status, n_rows, n_skipped FROM ingest_batch WHERE archive_key = $1', [
          series.key,
        ])
      ).rows;
    expect(await batch()).toEqual([{ parse_status: 'ok', n_rows: 0, n_skipped: 2 }]);
    expect(h.alerts.splice(0)).toEqual([
      { code: 'unit_mismatch', fields: { source: 'DE-1', spec: 'de-1-series', n: 2 } },
    ]);
    const id = (await h.t.admin.query('SELECT id FROM series WHERE provider_key = $1', [EMMERICH_W])).rows[0].id;
    const stored = async () =>
      (
        await h.t.admin.query(
          "SELECT value FROM obs WHERE series_id = $1 AND ts >= '2026-09-30T12:15:00Z' ORDER BY ts",
          [id],
        )
      ).rows;
    expect(await stored()).toEqual([]);
    // A payload that did not store everything a registry change could still load is never pruned.
    const { parsedOkIn } = await import('../../src/load/prune.ts');
    expect(await parsedOkIn(h.load.db)([series.key as string])).toEqual(new Set());

    // The fix: a reviewed registry change (here by hand), deployed; the next basin call agrees with it.
    await h.t.admin.query(
      "UPDATE series SET native_unit = 'm+NN', to_canonical = 100, value_kind = 'level', datum = 'NN' WHERE id = $1",
      [id],
    );
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-basin',
      variant: '',
      at: at('12:45'),
      body: withUnit('m+NN', 7.9),
      url: basin.url,
    });
    expect(await h.loader().tick()).toMatchObject({ lines: 1, loaded: 1 });
    expect((await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'unit_mismatch:DE-1'")).rows).toEqual([
      { value: { at: '2026-09-30T12:45:00.000Z', keys: [] } },
    ]);
    // Then the replay of the day: the older basin payload does not bring the old list back, and the series loads.
    await replay(
      { db: h.load.db, reader: h.reader, alert: () => {}, now: () => new Date() },
      { source: 'DE-1', spec: null, from: '2026-09-30', to: '2026-09-30', dryRun: false },
    );
    expect(
      (await h.t.admin.query("SELECT value->'keys' AS keys FROM app_meta WHERE key = 'unit_mismatch:DE-1'")).rows,
    ).toEqual([{ keys: [] }]);
    expect(await stored()).toEqual([{ value: 780 }, { value: 790 }]);
    expect(await batch()).toEqual([{ parse_status: 'ok', n_rows: 2, n_skipped: 0 }]);
    expect(await parsedOkIn(h.load.db)([series.key as string])).toEqual(new Set([series.key]));
    // Back to the registry the rest of this file was written for.
    await h.t.admin.query(
      "UPDATE series SET native_unit = 'cm', to_canonical = 1, value_kind = 'stage', datum = 'NHN' WHERE id = $1",
      [id],
    );
  });
});

describe('registry drift report', () => {
  it('reports nothing for the archived stations.json the registry was generated from', async () => {
    const registry = await seriesOf(h.load.db, 'DE-1');
    const stations = parseStations(
      readFileSync(new URL('../../src/adapters/de-1/fixtures/de-1-basin.raw', import.meta.url)),
    );
    const drift = driftReport(registry, stations);
    expect(drift).toEqual({ unregistered: [], vanished: [], changed: [] });
    expect(driftCount(drift)).toBe(0);
  });

  it('reports a new series, a vanished one, and a changed unit or step', async () => {
    const registry = await seriesOf(h.load.db, 'DE-1');
    const stations = parseStations(
      readFileSync(new URL('../../src/adapters/de-1/fixtures/de-1-basin.raw', import.meta.url)),
    );
    const [first, second, third, ...rest] = stations as [
      (typeof stations)[0],
      (typeof stations)[0],
      (typeof stations)[0],
      ...typeof stations,
    ];
    const mutated = [
      { ...first, uuid: '00000000-0000-4000-8000-000000000001' },
      { ...second, timeseries: second.timeseries.map((t) => ({ ...t, unit: 'm+NHN' })) },
      { ...third, timeseries: third.timeseries.map((t) => ({ ...t, equidistance: 5 })) },
      ...rest,
    ];
    const drift = driftReport(registry, mutated);
    expect(drift.unregistered).toEqual(
      first.timeseries.map((t) => `00000000-0000-4000-8000-000000000001/${t.shortname}`),
    );
    expect(drift.vanished).toEqual(first.timeseries.map((t) => `${first.uuid}/${t.shortname}`).sort());
    expect(drift.changed.map((c) => c.field).sort()).toEqual([
      ...second.timeseries.map(() => 'step' as const).slice(0, 0),
      ...third.timeseries.map(() => 'step' as const),
      ...second.timeseries.map(() => 'unit' as const),
    ]);
  });
});
