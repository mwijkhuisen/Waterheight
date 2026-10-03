import { FORECAST_FLAGS } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { FAMILY_ROLES, FORECAST_AT, VIEWS } from '../../src/db/audience.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { replay } from '../../src/load/replay.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// DE-2 (BfG `WV` forecast, owner audience) through the real loader and adapter (P8a, package S2), on synthetic
// captures only (the synthetic fixtures of apps/server/src/adapters/de-2 and runs generated here; every value is
// invented): a run keeps its own key whatever the order of its captures, a replay writes nothing, a value beyond
// 48 h is stored flagged ESTIMATE, the run sits on the station's DE-1 stage series, and reaches the owner family
// only (the series is public, the run's own source is not).

const KAUB = '1d26e504-7f9e-480a-b52c-5932be6549ab';
const KOBLENZ = '4c7d796a-39f2-4f26-97a9-3aad01713e29';
const NOW = new Date('2026-10-31T00:00:00Z');
const HOUR = 3_600_000;
const ESTIMATE = FORECAST_FLAGS.ESTIMATE;

const fixture = (name: string) => rawFixture('DE-2', `de-2-wv-${name}.synthetic`).body;
/** A made-up run of `n` two-hourly points from `init` (UTC), the labels at +02:00 (October before the 25th). */
const generated = (init: string, n: number, base: number): Buffer => {
  const t0 = Date.parse(init);
  const label = (ms: number) => new Date(ms + 2 * HOUR).toISOString().replace('.000Z', '+02:00');
  return Buffer.from(
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        initialized: label(t0),
        timestamp: label(t0 + i * 2 * HOUR),
        value: base + 3 * i,
        type: i * 2 > 48 ? 'estimate' : 'forecast',
      })),
    ),
  );
};

const WEEKEND = fixture('weekend'); // initialized 2026-10-10T05:00Z (a Saturday), 49 points
const TRUNCATED = fixture('truncated'); // initialized 2026-10-12T05:00Z, 13 points, no estimate
const DST = fixture('dst-fall-back'); // initialized 2026-10-24T05:00Z, 49 points across the fall-back
const SECOND = generated('2026-10-10T10:00:00Z', 49, 410); // a second run of the same Saturday

let h: Harness;
const clients: pg.Client[] = [];
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.end()));
  await h.close();
});

type Row = Record<string, unknown>;
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(text, args)).rows;
const put = (variant: string, at: string, body: Buffer) =>
  writePayload(h.archive, {
    source: 'DE-2',
    spec: 'de-2-wv',
    variant,
    at: new Date(at),
    url: 'https://example.invalid/de-2-wv',
    body,
    retention: 'forever',
  });
const tick = () => h.loader({ now: NOW }).tick();
const runsOf = (uuid: string) =>
  q(
    `SELECT r.id::text AS id, r.first_valid, r.last_valid, r.fetched_at, r.issued_at, r.issued_inferred,
            encode(r.content_hash, 'hex') AS hash, r.kind, r.step::text AS step, r.provider_segment_end,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id) AS n,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id AND (v.flags & ${ESTIMATE}) = ${ESTIMATE}) AS n_estimate
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE s.provider_key = $1 AND s.source_id = 'DE-1' AND r.source_id = 'DE-2' ORDER BY r.first_valid, r.id`,
    [`${uuid}/W`],
  );
const batches = () =>
  q(
    `SELECT n_rows, n_new, n_changed, n_skipped, parse_status, error FROM ingest_batch WHERE spec_id = 'de-2-wv' ORDER BY id`,
  );
const counts = (rows: Row[]) => rows.map((b) => [b.n_rows, b.n_new, b.n_changed]);
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
  adapters: LOAD_ADAPTERS,
});

describe('DE-2 runs through the loader', { timeout: 300_000 }, () => {
  it('captures in order and in reverse give the same runs, keyed by first valid time and hash', async () => {
    // Kaub, in order: a Saturday run captured twice (the second capture an hour later), then a second run that day,
    // a truncated run two days later and the run across the fall-back.
    await put(KAUB, '2026-10-10T07:12:00Z', WEEKEND);
    await put(KAUB, '2026-10-10T08:12:00Z', WEEKEND);
    await put(KAUB, '2026-10-10T12:12:00Z', SECOND);
    // Koblenz: the same three captures of that day, the latest first.
    await put(KOBLENZ, '2026-10-10T12:12:30Z', SECOND);
    await put(KOBLENZ, '2026-10-10T08:12:30Z', WEEKEND);
    await put(KOBLENZ, '2026-10-10T07:12:30Z', WEEKEND);
    await put(KAUB, '2026-10-12T07:12:00Z', TRUNCATED);
    await put(KAUB, '2026-10-24T07:12:00Z', DST);
    expect(await tick()).toEqual({ lines: 8, loaded: 8 });

    const kaub = await runsOf(KAUB);
    expect(kaub).toHaveLength(4);
    expect(kaub.map((r) => [r.n, r.n_estimate])).toEqual([
      [49, 24],
      [49, 24],
      [13, 0],
      [49, 24],
    ]);
    // Reverse order: the earlier capture arriving last lowers fetched_at, so the run is its earliest capture.
    const koblenz = await runsOf(KOBLENZ);
    expect(koblenz).toHaveLength(2);
    const key = (r: Row) => [r.first_valid, r.last_valid, r.hash, r.issued_at, r.n];
    expect(koblenz.map(key)).toEqual(kaub.slice(0, 2).map(key));
    expect(kaub[0]?.fetched_at).toEqual(new Date('2026-10-10T07:12:00Z'));
    expect(koblenz[0]?.fetched_at).toEqual(new Date('2026-10-10T07:12:30Z'));
    expect(kaub[1]?.fetched_at).toEqual(new Date('2026-10-10T12:12:00Z'));
    expect(koblenz[1]?.fetched_at).toEqual(new Date('2026-10-10T12:12:30Z'));
    // The run count is the number of unique keys: 4 + 2 runs for 8 captures.
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual([{ n: 6 }]);
    expect(await q('SELECT count(*)::int AS n FROM forecast_value')).toEqual([{ n: 49 + 49 + 13 + 49 + 49 + 49 }]);
    expect(counts(await batches())).toEqual([
      [49, 49, 0],
      [49, 0, 0],
      [49, 49, 0],
      [49, 49, 0],
      [49, 49, 0],
      [49, 0, 1],
      [13, 13, 0],
      [49, 49, 0],
    ]);
    expect(h.alerts).toEqual([]);
  });

  it('a replay, twice, writes nothing', async () => {
    const before = await q('SELECT count(*)::int AS n FROM forecast_value');
    for (let round = 0; round < 2; round++) {
      const r = await replay(deps(), {
        source: 'DE-2',
        spec: null,
        from: '2026-10-10',
        to: '2026-10-31',
        dryRun: false,
      });
      expect(r).toMatchObject({ lines: 8, loaded: 8, quarantined: 0, n_new: 0, n_changed: 0 });
    }
    expect(await q('SELECT count(*)::int AS n FROM forecast_value')).toEqual(before);
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual([{ n: 6 }]);
  });

  it('a run is its provider’s: issued as stated, deterministic, two-hourly, segment end at +48 h, values beyond 48 h ESTIMATE', async () => {
    const [weekend, , truncated, dst] = await runsOf(KAUB);
    expect(weekend).toMatchObject({
      kind: 'deterministic',
      step: '02:00:00',
      issued_at: new Date('2026-10-10T05:00:00Z'),
      issued_inferred: false,
      first_valid: new Date('2026-10-10T05:00:00Z'),
      last_valid: new Date('2026-10-14T05:00:00Z'),
      provider_segment_end: new Date('2026-10-12T05:00:00Z'),
    });
    expect(dst).toMatchObject({
      issued_at: new Date('2026-10-24T05:00:00Z'),
      // +48 h of real time, across the fall-back: the label of that instant is 06:00+01:00.
      provider_segment_end: new Date('2026-10-26T05:00:00Z'),
      last_valid: new Date('2026-10-28T05:00:00Z'),
    });
    // A run that ends early states no estimate and its segment ends at its last point; it is not extended.
    expect(truncated).toMatchObject({
      last_valid: new Date('2026-10-13T05:00:00Z'),
      provider_segment_end: new Date('2026-10-13T05:00:00Z'),
      n: 13,
      n_estimate: 0,
    });
    const flags = await q(
      `SELECT v.valid_ts, v.flags, v.value FROM forecast_value v WHERE v.run_id = $1::bigint ORDER BY v.valid_ts`,
      [weekend?.id],
    );
    expect(flags).toHaveLength(49);
    // The 48 h point is a forecast, the next one (50 h) the first estimate.
    expect(flags.slice(24, 26).map((f) => [f.valid_ts, f.flags])).toEqual([
      [new Date('2026-10-12T05:00:00Z'), 0],
      [new Date('2026-10-12T07:00:00Z'), ESTIMATE],
    ]);
    expect(flags.filter((f) => f.flags === ESTIMATE)).toHaveLength(24);
    expect(flags.filter((f) => f.flags === 0)).toHaveLength(25);
  });

  it('the run attaches to the station’s DE-1 stage series: one source on the series, its run in the DE-1 registry', async () => {
    const rows = await q(
      `SELECT s.source_id AS series_source, s.role, s.quantity, r.source_id AS run_source, count(*)::int AS n
       FROM forecast_run r JOIN series s ON s.id = r.series_id GROUP BY 1, 2, 3, 4 ORDER BY 1`,
    );
    expect(rows).toEqual([{ series_source: 'DE-1', role: 'primary', quantity: 'H', run_source: 'DE-2', n: 6 }]);
  });

  it('a DE-2 run is in the owner forecast views and functions, in no public one (the series is public)', async () => {
    const asof = '2026-10-10T13:00:00Z';
    const owner = await h.t.connectAs(FAMILY_ROLES.owner[0]);
    clients.push(owner);
    const ownerRuns = await owner.query(`SELECT source_id FROM ${VIEWS.owner.forecastRun}`);
    expect(ownerRuns.rows).toHaveLength(6);
    const ownerValues = await owner.query(`SELECT count(*)::int AS n FROM ${VIEWS.owner.forecastValue}`);
    expect(ownerValues.rows).toEqual([{ n: 49 + 49 + 13 + 49 + 49 + 49 }]);
    for (const view of [VIEWS.owner.api.forecastRun, VIEWS.owner.api.forecastValue])
      expect(Number((await owner.query(`SELECT count(*)::int AS n FROM ${view}`)).rows[0]?.n)).toBeGreaterThan(0);
    // Q2 as of that Saturday afternoon: each station's latest run (the second one), step-held at `t`.
    const at = await owner.query(
      `SELECT source_id, series_id, issued_at, last_valid, kind, value, flags FROM ${FORECAST_AT.owner}($1::timestamptz, $1::timestamptz) ORDER BY series_id`,
      [asof],
    );
    expect(at.rows).toHaveLength(2);
    expect(at.rows.every((r) => r.source_id === 'DE-2' && r.kind === 'deterministic' && r.flags === 0)).toBe(true);
    expect(at.rows.every((r) => r.issued_at.getTime() === Date.parse('2026-10-10T10:00:00Z'))).toBe(true);
    // A truncated run is no forecast beyond its end, and the older run that reaches further is never shown instead.
    // (Koblenz has no truncated run, so its second run still reaches both instants.)
    const kaub = await h.seriesId(`${KAUB}/W`);
    const q2 = (t: string) =>
      owner.query(
        `SELECT source_id, last_valid FROM ${FORECAST_AT.owner}($1::timestamptz, $1::timestamptz) WHERE series_id = $2`,
        [t, kaub],
      );
    expect((await q2('2026-10-13T08:00:00Z')).rows).toEqual([]);
    expect((await q2('2026-10-13T03:00:00Z')).rows).toEqual([
      { source_id: 'DE-2', last_valid: new Date('2026-10-13T05:00:00Z') },
    ]);

    for (const role of FAMILY_ROLES.public) {
      const pub = await h.t.connectAs(role);
      clients.push(pub);
      for (const view of [
        VIEWS.public.forecastRun,
        VIEWS.public.forecastValue,
        VIEWS.public.api.forecastRun,
        VIEWS.public.api.forecastValue,
      ])
        expect([role, view, (await pub.query(`SELECT 1 FROM ${view}`)).rowCount]).toEqual([role, view, 0]);
      for (const t of [asof, '2026-10-10T08:00:00Z', '2026-10-24T08:00:00Z'])
        expect([
          role,
          t,
          (await pub.query(`SELECT 1 FROM ${FORECAST_AT.public}($1::timestamptz, $1::timestamptz)`, [t])).rowCount,
        ]).toEqual([role, t, 0]);
    }
  });

  it('a station DE-1 does not register is unknown: counted, kept for a replay, nothing stored', async () => {
    const before = await q('SELECT count(*)::int AS n FROM forecast_run');
    await put(
      '00000000-0000-4000-8000-000000000001',
      '2026-10-25T07:12:00Z',
      generated('2026-10-25T05:00:00Z', 49, 300),
    );
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 0, n_new: 0, n_skipped: 1, parse_status: 'ok' });
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual(before);
  });

  it('a malformed variant, two issue times or an issue time ahead of the fetch quarantine the payload with a fixed code', async () => {
    const two = JSON.parse(SECOND.toString('utf8'));
    two[7].initialized = '2026-10-10T13:00:00+02:00';
    await put('not-a-uuid', '2026-10-26T07:12:00Z', SECOND);
    await put(KAUB, '2026-10-26T08:12:00Z', Buffer.from(JSON.stringify(two)));
    // initialized 2026-10-24T07:00+02:00 fetched an hour before it
    await put(KAUB, '2026-10-24T03:12:00Z', DST);
    const before = h.alerts.length;
    // (a quarantined line is processed, not loaded)
    expect(await tick()).toEqual({ lines: 3, loaded: 0 });
    expect((await batches()).slice(-3)).toMatchObject([
      { parse_status: 'quarantined', error: 'future_issue' },
      { parse_status: 'quarantined', error: 'bad_variant' },
      { parse_status: 'quarantined', error: 'run_mismatch at 7.initialized' },
    ]);
    expect(h.alerts.length).toBeGreaterThan(before);
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual([{ n: 6 }]);
  });
});
