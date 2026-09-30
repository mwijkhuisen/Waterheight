import { readFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureArchive, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { driftCount, driftReport } from '../../src/adapters/de-1/drift.ts';
import { parseStations } from '../../src/adapters/de-1/parse.ts';
import { LOAD_ADAPTERS, type LoadAdapter } from '../../src/load/adapters.ts';
import { replay } from '../../src/load/replay.ts';
import { seriesOf } from '../../src/load/store.ts';
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
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0 });
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
    expect(
      h.alerts
        .splice(0)
        .map((a) => a.fields.code)
        .sort(),
    ).toEqual(['archive_corrupt', 'archive_too_large', 'not_json', 'sha256_mismatch']);
    const n = (await h.t.admin.query('SELECT count(*)::int AS n FROM obs WHERE value = 777')).rows;
    expect(n).toEqual([{ n: 0 }]);
  });

  it('a payload that keeps failing in the database is quarantined after three passes instead of stalling every source', async () => {
    // A parser bug that yields a row the database refuses (qc outside the bitmask).
    const broken: Record<string, LoadAdapter> = {
      'DE-1': {
        version: 1,
        specs: {
          'de-1-series': {
            maxBytes: 1024,
            needsVariant: true,
            run: (body) =>
              body.length === 2
                ? { obs: [], gaugeZeros: [], dropped: {}, unknown: 0 }
                : {
                    obs: [{ series: EMMERICH_W, ts: '2026-09-30T11:00:00.000Z', value: 1, qc: 5000 }],
                    gaugeZeros: [],
                    dropped: {},
                    unknown: 0,
                  },
          },
        },
      },
    };
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
    expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
    expect(await loader.tick()).toEqual({ lines: 0, loaded: 0 });
    expect(h.alerts).toEqual([]);
    expect(await loader.tick()).toEqual({ lines: 2, loaded: 1 });
    const row = (
      await h.t.admin.query('SELECT parse_status, error FROM ingest_batch WHERE archive_key = $1', [poison.key])
    ).rows;
    expect(row).toEqual([{ parse_status: 'quarantined', error: 'load_error' }]);
    expect(h.alerts.splice(0)).toEqual([
      { code: 'quarantined', fields: { source: 'DE-1', spec: 'de-1-series', code: 'load_error' } },
    ]);
    expect(await loader.backlog()).toEqual({ files: 0, bytes: 0 });
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
