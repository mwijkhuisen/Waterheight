import { SchemaDrift } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine } from '../../../../scripts/fixture-archive.ts';
import type { ManifestLine } from '../../src/archive/manifest.ts';
import { sha256 } from '../../src/archive/writer.ts';
import type { Backfilled, LoadAdapter, LoadContext } from '../../src/load/adapters.ts';
import { DATA_FLOOR } from '../../src/load/dirty.ts';
import { computeHealth } from '../../src/load/health.ts';
import { Loader } from '../../src/load/pipeline.ts';
import { replay } from '../../src/load/replay.ts';
import { type Harness, harness } from './harness.ts';

// P14b (plan §3.4, §3.5): a backfill spec that fills another source's series (`obsTarget`) binds that source's
// registry for its rows, stops at DATA_FLOOR, dirties nothing, keeps one ledger row per slice of a shared archive
// key; a provider aggregate series takes rows but no rollup; a backfill quarantine never judges the live source.
// The wires (DE-8, FR-2, CH-9) are built beside this test, so it loads through a test spec of the same shape.

let h: Harness;
const SPEC = 'a2-backfill-test';
const STAH = '2829100000100/W';
const AGG = 'A850061001/A2-test-mean';
const FLOOR_MS = Date.parse(DATA_FLOOR);
const NOW = new Date('2026-10-18T23:00:00Z');
let at = Date.parse('2026-10-18T22:00:00Z');
let jobDe8: number;
let jobFr2: number;

type Row = { series: string; ts: string; value: number };
/** What the test spec saw of each line's context. */
const seen: { registry: LoadContext['registry']; backfill: LoadContext['backfill']; memoKey: string | undefined }[] =
  [];
const info: [string, Record<string, string | number> | undefined][] = [];

/** A backfill run of the wires' shape: rows of the context's registry inside `ctx.backfill`, the rest dropped. */
const run = (b: Uint8Array, c: LoadContext): Backfilled => {
  seen.push({ registry: c.registry, backfill: c.backfill, memoKey: c.memoKey });
  const body = JSON.parse(Buffer.from(b).toString('utf8')) as { rows: Row[]; drift?: true };
  if (body.drift) throw new SchemaDrift('a2_test');
  const window = c.backfill ?? { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };
  const inside = body.rows.filter((r) => Date.parse(r.ts) >= window.from && Date.parse(r.ts) < window.to);
  const obs = inside.filter((r) => c.registry.has(r.series)).map((r) => ({ ...r, qc: 0 }));
  const dropped: Record<string, number> = {};
  if (inside.length < body.rows.length) dropped.outside_backfill = body.rows.length - inside.length;
  return {
    obs,
    gaugeZeros: [],
    dropped,
    unknown: 0,
    provider_values: body.rows.length,
    unknown_values: inside.length - obs.length,
    raw_dropped: { na: 3, off_grid: 0 },
  };
};
const adapters = (target: string): Readonly<Record<string, LoadAdapter>> => ({
  'DE-8': {
    version: 7,
    specs: { [SPEC]: { maxBytes: 1 << 20, needsVariant: false, backfill: true, obsTarget: target, run } },
  },
});
const loader = (target: string) =>
  new Loader({
    db: h.load.db,
    reader: h.reader,
    alert: (code, fields = {}) => h.alerts.push({ code, fields }),
    info: (msg, fields) => info.push([msg, fields]),
    now: () => NOW,
    adapters: adapters(target),
  });

/** Stores one body and appends one line per chunk, all on its one archive key (a DE-8 decade file and its slices). */
async function put(
  body: object,
  job: number,
  chunks: [string, string][],
  spec = SPEC,
  source = 'DE-8',
): Promise<ManifestLine[]> {
  at += 60_000;
  const when = new Date(at);
  const bytes = Buffer.from(JSON.stringify(body));
  const hash = sha256(bytes);
  const { key, stored } = await h.archive.put(source, spec, when, bytes, hash);
  const lines: ManifestLine[] = [];
  for (const [n, [from, to]] of chunks.entries()) {
    const line = bareLine(source, spec, when, {
      sha256: hash,
      bytes: bytes.length,
      stored_bytes: stored,
      key,
      validity: { ok: true, reason: null, count: 1 },
      retention: 'backfill',
      backfill: { job, chunk: n, from, to },
    });
    await h.archive.append(line);
    lines.push(line);
  }
  return lines;
}
const job = async (source: string, key: string) => {
  const { rows } = await h.t.admin.query<{ id: string }>(
    `INSERT INTO backfill_job (spec_id, source_id, series_key, range_from, range_to, chunk, cursor_ts, request_budget)
     VALUES ($1, $2, $3, '2020-01-01', '2026-08-01', '30 days', '2020-01-01', 50) RETURNING id`,
    [SPEC, source, key],
  );
  return Number(rows[0]?.id);
};
const obsOf = async (key: string) =>
  (
    await h.t.admin.query<{ ts: Date; value: number }>(
      'SELECT o.ts, o.value FROM obs o JOIN series s ON s.id = o.series_id WHERE s.provider_key = $1 ORDER BY o.ts',
      [key],
    )
  ).rows;

beforeAll(async () => {
  h = await harness();
  // A provider aggregate series of the FR-1 station Uckange (P14b), added by SQL so that this test does not depend
  // on the generated FR-1 file: a twin of one day's step.
  await h.t.admin.query(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, aggregate)
     VALUES ('fr.sandre.A850061001', 'FR-1', 'Q', NULL, $1, 'l/s', 0.001, NULL, '1 day', '1 day', '1 day', 'twin',
             'mean')`,
    [AGG],
  );
  jobDe8 = await job('DE-8', 'Rureinzugsgebiet/2020');
  jobFr2 = await job('DE-8', 'A850061001/QmnJ');
}, 60_000);

afterAll(async () => {
  await h.close();
});

describe('a backfill into another source (P14b)', { timeout: 60_000 }, () => {
  it("binds the target's registry, stops at DATA_FLOOR, dirties nothing, and keeps a ledger row per slice", async () => {
    const rows: Row[] = [
      { series: STAH, ts: '2026-06-01T00:00:00Z', value: 101 },
      { series: STAH, ts: '2026-06-01T00:15:00Z', value: 102 },
      { series: STAH, ts: '2026-07-01T00:00:00Z', value: 103 },
      { series: STAH, ts: '2026-07-01T00:15:00Z', value: 104 },
      // At and past the floor: the live rows own these days.
      { series: STAH, ts: '2026-08-01T00:00:00Z', value: 105 },
      { series: STAH, ts: '2026-09-01T00:00:00Z', value: 106 },
    ];
    const [slice0, slice1] = await put({ rows }, jobDe8, [
      ['2026-05-20T00:00:00.000Z', '2026-06-19T00:00:00.000Z'],
      ['2026-06-19T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ]);
    expect(slice0?.key).toBe(slice1?.key);
    expect(await loader('DE-7').tick()).toEqual({ lines: 2, loaded: 2 });
    expect(h.alerts).toEqual([]);

    // The context: DE-7's registry, the second slice cut at DATA_FLOOR, one memo key for both slices.
    expect(seen.map((s) => s.registry.has(STAH))).toEqual([true, true]);
    expect(seen.map((s) => s.backfill?.to)).toEqual([Date.parse('2026-06-19T00:00:00Z'), FLOOR_MS]);
    expect(seen.map((s) => s.memoKey)).toEqual([`${slice0?.key}\n7`, `${slice0?.key}\n7`]);

    // Rows exactly once, on DE-7's series, none at or past the floor; no dirty row, no latest row.
    const stored = await obsOf(STAH);
    expect(stored.map((r) => r.value)).toEqual([101, 102, 103, 104]);
    expect(stored.every((r) => r.ts.getTime() < FLOOR_MS)).toBe(true);
    expect(await h.count('publish_dirty')).toBe(0);
    expect(await h.count('obs_latest')).toBe(0);

    // One batch for the key, the payload's own source; a ledger row per slice, both reconciled.
    const batches = await h.t.admin.query('SELECT source_id, origin, parse_status FROM ingest_batch');
    expect(batches.rows).toEqual([{ source_id: 'DE-8', origin: 'backfill', parse_status: 'ok' }]);
    const ledger = await h.t.admin.query(
      `SELECT chunk_from, provider_values, kept, inserted, skipped, dropped, reconciled
       FROM backfill_chunk WHERE job_id = $1 ORDER BY chunk_from`,
      [jobDe8],
    );
    expect(ledger.rows).toEqual([
      {
        chunk_from: new Date('2026-05-20T00:00:00Z'),
        provider_values: 6,
        kept: 2,
        inserted: 2,
        skipped: 0,
        dropped: 4,
        reconciled: true,
      },
      {
        chunk_from: new Date('2026-06-19T00:00:00Z'),
        provider_values: 6,
        kept: 2,
        inserted: 2,
        skipped: 0,
        dropped: 4,
        reconciled: true,
      },
    ]);
    // The raw drops: logged once per line, fixed codes and counts only, the zero counts left out.
    expect(info.filter(([m]) => m === 'backfill_raw_dropped')).toEqual([
      ['backfill_raw_dropped', { na: 3, source: 'DE-8', spec: SPEC }],
      ['backfill_raw_dropped', { na: 3, source: 'DE-8', spec: SPEC }],
    ]);

    // A replay of both slices writes nothing and adds no ledger row.
    const before = await h.checksums();
    const replayed = await replay(
      {
        db: h.load.db,
        reader: h.reader,
        alert: (code, fields = {}) => h.alerts.push({ code, fields }),
        now: () => NOW,
        adapters: adapters('DE-7'),
      },
      { source: 'DE-8', spec: SPEC, from: '2026-10-01', to: '2026-10-31', dryRun: false },
    );
    expect(replayed).toMatchObject({ lines: 2, loaded: 2, n_new: 0, n_changed: 0 });
    expect(await h.checksums()).toEqual(before);
    expect(await h.count('backfill_chunk')).toBe(2);
  });

  it('stores a provider aggregate without a rollup or a dirty row', async () => {
    await put(
      {
        rows: [
          { series: AGG, ts: '2026-06-01T00:00:00Z', value: 89 },
          { series: AGG, ts: '2026-06-02T00:00:00Z', value: 91 },
        ],
      },
      jobFr2,
      [['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']],
    );
    expect(await loader('FR-1').tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await obsOf(AGG)).map((r) => r.value)).toEqual([89, 91]);
    const rollups = await h.t.admin.query(
      `SELECT (SELECT count(*)::int FROM obs_1h r JOIN series s ON s.id = r.series_id WHERE s.provider_key = $1) AS h,
              (SELECT count(*)::int FROM obs_1d r JOIN series s ON s.id = r.series_id WHERE s.provider_key = $1) AS d`,
      [AGG],
    );
    expect(rollups.rows).toEqual([{ h: 0, d: 0 }]);
    // The earlier test's DE-7 rows did get their rollups: the skip is the aggregate's alone.
    expect(await h.count('obs_1h')).toBeGreaterThan(0);
    expect(await h.count('publish_dirty')).toBe(0);
  });

  it('refuses a primary aggregate series (CHECK)', async () => {
    await expect(
      h.t.admin.query(`UPDATE series SET aggregate = 'max' WHERE provider_key = $1`, [STAH]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.t.admin.query(`UPDATE series SET aggregate = 'sum' WHERE provider_key = $1`, [AGG]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it("counts a backfill quarantine in detail.backfill only, never in the live source's status", async () => {
    // A live fetch of the source (a 304 of its station file) and a backfill payload the loader sets aside.
    await h.archive.append(bareLine('DE-8', 'de-8-hydro', new Date(at), { status: 304 }));
    await put({ rows: [], drift: true }, jobDe8, [['2026-04-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z']]);
    expect(await loader('DE-7').tick()).toEqual({ lines: 2, loaded: 0 });
    expect(h.alerts.map((a) => a.code)).toEqual(['quarantined']);
    await computeHealth(h.load.db, {
      cadenceS: new Map([['DE-8', 86_400]]),
      lagP95Ms: new Map(),
      backlog: { files: 0, bytes: 0, age_s: null },
      badLines: 0,
      now: NOW,
    });
    const { rows } = await h.t.admin.query<{
      status: string;
      quarantine_count: number;
      quarantined: number;
    }>(
      `SELECT status, quarantine_count, (detail -> 'backfill' ->> 'quarantined')::int AS quarantined
       FROM source_health WHERE source_id = 'DE-8'`,
    );
    expect(rows).toEqual([{ status: 'ok', quarantine_count: 0, quarantined: 1 }]);
  });
});
