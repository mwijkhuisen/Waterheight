import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, writePayload } from '../../../../scripts/fixture-archive.ts';
import { readSeries, readStations } from '../../src/api/data.ts';
import type { ManifestLine } from '../../src/archive/manifest.ts';
import { sha256 } from '../../src/archive/writer.ts';
import type { Db } from '../../src/db/pool.ts';
import { goldenUrl, rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// P14a, rollups, dayVersions and the ledger (plan §3.6, §3.7): a backfill of history loaded through the real
// `nl-1-backfill-obs` spec keeps the inline rollups exact, dirties nothing the publishers render, leaves the display
// window (D9) and the public answers as they were, and keeps a ledger whose counts reconcile, once per archive key.

let h: Harness;
let api: Db;
let job: number;
let KEY: string;
let SERIES: number;
const SPEC = 'nl-1-backfill-obs';
const URL_ = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
/** The runner fetches history long after the live fixtures were recorded (2026-09-29/30). */
const NOW = new Date('2026-10-12T22:30:00Z');
const DISPLAY_START = '2026-09-29T00:00:00Z';
const DATA_EPOCH = '2026-09-28T00:00:00Z';
let at = NOW.getTime();
/** The line of chunk 0, appended again by the re-load test. */
let chunk0: ManifestLine;

/** A real NL-1 payload with its instants moved back to `year`: history as the provider serves it. */
const movedTo = (body: Buffer, year: string) =>
  Buffer.from(body.toString('utf8').replaceAll('"2026-09-', `"${year}-09-`));
const fixture = (name: string) => rawFixture('NL-1', name).body;

/** A backfill line as the runner writes it (variant '', retention 'backfill', the chunk), each a new fetch. */
async function putBackfill(body: Buffer, chunk?: NonNullable<ManifestLine['backfill']>): Promise<ManifestLine> {
  at += 60_000;
  const when = new Date(at);
  const hash = sha256(body);
  const { key, stored } = await h.archive.put('NL-1', SPEC, when, body, hash);
  const line = bareLine('NL-1', SPEC, when, {
    request: { method: 'POST', url: URL_ },
    sha256: hash,
    bytes: body.length,
    stored_bytes: stored,
    key,
    validity: { ok: true, reason: null, count: 1 },
    retention: 'backfill',
    ...(chunk === undefined ? {} : { backfill: chunk }),
  });
  await h.archive.append(line);
  return line;
}
const chunk = (n: number) => ({ job, chunk: n, from: '2005-09-01T00:00:00.000Z', to: '2005-10-11T00:00:00.000Z' });
const tick = () => h.loader({ now: new Date(at + 60_000) }).tick();

const meta = async () =>
  (
    await h.t.admin.query<{ key: string; v: unknown }>(
      `SELECT key, value AS v FROM app_meta
       WHERE key IN ('display_start', 'data_epoch', 'day_versions:public', 'day_versions:owner') ORDER BY key`,
    )
  ).rows;
const dirtyRows = () => h.count('publish_dirty');
const jobCounts = async () =>
  (
    await h.t.admin.query(
      `SELECT provider_values::int, inserted::int, revised::int, skipped::int, dropped::int, unreconciled
       FROM backfill_job WHERE id = $1`,
      [job],
    )
  ).rows[0];
const ledger = async () =>
  (
    await h.t.admin.query(
      `SELECT chunk_from, provider_values, kept, inserted, revised, skipped, dropped, reconciled
       FROM backfill_chunk WHERE job_id = $1 ORDER BY loaded_at, archive_key`,
      [job],
    )
  ).rows;
/** What the public sees in the display window: /stations and the series' raw history from the display start on. */
const publicAnswers = async () => ({
  stations: await readStations(api.db, 'public'),
  history: await readSeries(api.db, 'public', {
    id: SERIES,
    from: Date.parse(DISPLAY_START),
    to: Date.parse('2026-10-01T00:00:00Z'),
    res: 'raw',
  }),
});
const rollupsMatch = async (table: 'obs_1h' | 'obs_1d', width: string) => {
  const stored = await h.t.admin.query(
    `SELECT bucket, vmin, vmax, vavg, vlast, n, qc_or FROM ${table}
     WHERE series_id = $1 AND bucket < '2026-01-01' ORDER BY bucket`,
    [SERIES],
  );
  const fresh = await h.t.admin.query(
    `SELECT date_bin($2::interval, ts, timestamptz '2000-01-01 00:00:00+00') AS bucket, min(value) AS vmin,
            max(value) AS vmax, avg(value)::real AS vavg, (array_agg(value ORDER BY ts DESC))[1] AS vlast,
            count(*)::int AS n, bit_or(qc) AS qc_or
     FROM obs WHERE series_id = $1 AND ts < '2026-01-01' GROUP BY 1 ORDER BY 1`,
    [SERIES, width],
  );
  expect(stored.rows.length).toBeGreaterThan(0);
  expect(stored.rows).toEqual(fresh.rows);
};

beforeAll(async () => {
  h = await harness();
  api = h.dbAs('rws_api');
  const golden = JSON.parse(readFileSync(goldenUrl('NL-1', 'nl-1-obs-key'), 'utf8')) as { obs: { series: string }[] };
  KEY = golden.obs[0]?.series as string;
  SERIES = await h.seriesId(KEY);
  for (const [key, value] of [
    ['display_start', DISPLAY_START],
    ['data_epoch', DATA_EPOCH],
  ])
    await h.t.admin.query(
      `INSERT INTO app_meta (key, value) VALUES ($1, to_jsonb($2::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  // The live payload of the same series, so the public answers have something to show.
  const live = rawFixture('NL-1', 'nl-1-obs-key');
  await writePayload(h.archive, {
    source: 'NL-1',
    spec: 'nl-1-obs-key',
    variant: 'lobith.bovenrijn.tolkamer/H',
    at: new Date(live.meta.recorded_at),
    body: live.body,
    url: live.meta.url,
  });
  expect(await tick()).toEqual({ lines: 1, loaded: 1 });
  const { rows } = await h.t.admin.query<{ id: string }>(
    `INSERT INTO backfill_job (spec_id, source_id, series_key, range_from, range_to, chunk, cursor_ts, request_budget)
     VALUES ($1, 'NL-1', $2, '2005-01-01', '2006-01-01', '40 days', '2005-01-01', 20) RETURNING id`,
    [SPEC, KEY],
  );
  job = Number(rows[0]?.id);
}, 60_000);

afterAll(async () => {
  await h.close();
});

describe('a backfill of history (plan §3.6, §3.7)', { timeout: 60_000 }, () => {
  it('keeps the inline rollups exact and leaves the publishers, the display window and the public answers alone', async () => {
    const before = { meta: await meta(), dirty: await dirtyRows(), answers: await publicAnswers() };
    expect(before.answers.stations.stations.length).toBeGreaterThan(0);
    expect(before.answers.history?.points.length).toBe(16);
    chunk0 = await putBackfill(movedTo(fixture('nl-1-obs-key'), '2005'), chunk(0));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(h.alerts).toEqual([]);
    const { rows } = await h.t.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM obs WHERE series_id = $1 AND ts < '2006-01-01' AND (qc & 512) <> 0",
      [SERIES],
    );
    expect(rows).toEqual([{ n: 16 }]);
    await rollupsMatch('obs_1h', '1 hour');
    await rollupsMatch('obs_1d', '1 day');
    // No publish_dirty row, no bumped day, the same display window and the same public answers (D9).
    expect({ meta: await meta(), dirty: await dirtyRows(), answers: await publicAnswers() }).toEqual(before);
  });

  it('keeps a ledger whose counts reconcile on real payloads, the dropped and the unknown values included', async () => {
    // Driel boven Q: 35 values of a series we never store (stale_series); a list under a location RWS never had:
    // unknown to the registry, counted by value.
    await putBackfill(movedTo(fixture('nl-1-obs-other-driel-boven-q'), '2005'), chunk(1));
    const unknown = movedTo(fixture('nl-1-obs-key'), '2004')
      .toString('utf8')
      .replaceAll('lobith.bovenrijn.tolkamer', 'x.unknown');
    await putBackfill(Buffer.from(unknown), chunk(2));
    expect(await tick()).toEqual({ lines: 2, loaded: 2 });
    const c = (n: number) => new Date(chunk(n).from);
    expect(await ledger()).toEqual([
      {
        chunk_from: c(0),
        provider_values: 16,
        kept: 16,
        inserted: 16,
        revised: 0,
        skipped: 0,
        dropped: 0,
        reconciled: true,
      },
      {
        chunk_from: c(1),
        provider_values: 35,
        kept: 0,
        inserted: 0,
        revised: 0,
        skipped: 0,
        dropped: 35,
        reconciled: true,
      },
      {
        chunk_from: c(2),
        provider_values: 16,
        kept: 0,
        inserted: 0,
        revised: 0,
        skipped: 0,
        dropped: 16,
        reconciled: true,
      },
    ]);
    expect(await jobCounts()).toEqual({
      provider_values: 67,
      inserted: 16,
      revised: 0,
      skipped: 0,
      dropped: 51,
      unreconciled: 0,
    });
    // Counters only: a backfill payload raises no RETAINED alert.
    expect(h.alerts).toEqual([]);
  });

  it('a re-load of the same archive key writes nothing and counts nothing again', async () => {
    const first = (await ledger()).length;
    const counts = await jobCounts();
    const revisions = await h.count('obs_revision');
    const batches = (await h.t.admin.query('SELECT id, n_new, n_changed, loaded_at FROM ingest_batch ORDER BY id'))
      .rows;
    const sums = await h.checksums();
    // A second line for the object of chunk 0 (a runner killed between its append and its cursor, or a recovered
    // line): the same archive key, loaded again.
    await h.archive.append(chunk0);
    const { rows } = await h.t.admin.query('SELECT count(*)::int AS n FROM backfill_chunk WHERE archive_key = $1', [
      chunk0.key,
    ]);
    expect(rows).toEqual([{ n: 1 }]);
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await ledger()).length).toBe(first);
    expect(await jobCounts()).toEqual(counts);
    expect(await h.count('obs_revision')).toBe(revisions);
    expect(
      (await h.t.admin.query('SELECT id, n_new, n_changed, loaded_at FROM ingest_batch ORDER BY id')).rows,
    ).toEqual(batches);
    expect(await h.checksums()).toEqual(sums);
  });

  it('a validated backfill value over a live day at or after the display start revises it and bumps that day once', async () => {
    const day = '2026-09-29';
    const versions = async () =>
      (
        await h.t.admin.query<{ v: Record<string, { v: number }> | null }>(
          "SELECT value AS v FROM app_meta WHERE key = 'day_versions:public'",
        )
      ).rows[0]?.v?.[day]?.v ?? 1;
    const v0 = await versions();
    // The first value of the live payload (10:50Z), now Gecontroleerd and 1 cm higher.
    const doc = JSON.parse(fixture('nl-1-obs-key').toString('utf8'));
    const list = doc.WaarnemingenLijst[0];
    const first = list.MetingenLijst[0];
    first.WaarnemingMetadata.Statuswaarde = 'Gecontroleerd';
    first.Meetwaarde.Waarde_Numeriek += 1;
    list.MetingenLijst = [first];
    const revisions = await h.count('obs_revision');
    await putBackfill(Buffer.from(JSON.stringify(doc)), {
      ...chunk(3),
      from: `${day}T00:00:00.000Z`,
      to: '2026-10-01T00:00:00.000Z',
    });
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await h.count('obs_revision')).toBe(revisions + 1);
    expect(await versions()).toBe(v0 + 1);
    expect((await ledger()).at(-1)).toMatchObject({ provider_values: 1, kept: 1, revised: 1, reconciled: true });
    expect(await jobCounts()).toMatchObject({ revised: 1, unreconciled: 0 });
    // The live answer of that day now shows the validated value.
    const history = await readSeries(api.db, 'public', {
      id: SERIES,
      from: Date.parse(DISPLAY_START),
      to: Date.parse('2026-10-01T00:00:00Z'),
      res: 'raw',
    });
    expect(history?.points[0]).toMatchObject({ qc: 2 | 512 });
    // display_start and data_epoch never move.
    expect((await meta()).filter((m) => m.key === 'display_start' || m.key === 'data_epoch')).toEqual([
      { key: 'data_epoch', v: DATA_EPOCH },
      { key: 'display_start', v: DISPLAY_START },
    ]);
  });
});
