import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { FAMILY_ROLES, FORECAST_AT, VIEWS } from '../../src/db/audience.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { replay } from '../../src/load/replay.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// CH-4 (BAFU forecast figures, public) through the real loader, adapter and registry, on the real recordings of the
// production archive (P8b): the figure of a station is one run of its CH-1 series, keyed by (series, first valid
// time, content hash), whatever the order of its captures, with the earliest capture's fetch time and an inferred
// issue time; a replay writes nothing; a reordered or renamed figure is quarantined with a fixed code; a lake
// figure lands on the W series in centimetres, a station CH-1 does not know is unknown and a withheld one stores
// nothing; and, the source being public, its runs are in the public and in the owner forecast views alike.

const NOW = new Date('2026-10-31T00:00:00Z');
const HOUR = 3_600_000;

const fixture = (name: string) => rawFixture('CH-4', name).body;
const A = fixture('ch-4-forecast-2091-20260930t1535z'); // run of 2026-09-30T11:00+02:00, 118 points, captured 15:35Z
const B = fixture('ch-4-forecast-2091-20260930t1635z'); // the next run, 15:00+02:00, 114 points, captured 16:35Z
const REAL_2602 = fixture('ch-4-forecast-2602-20261004t0535z'); // another station and run, 118 points
const REORDERED = fixture('ch-4-forecast-reordered.synthetic');
const RENAMED = fixture('ch-4-forecast-renamed.synthetic');

type Doc = { plot: { data: { meta: { unit: string }; y: (number | null)[] }[]; layout: { title: string } } };
const edited = (body: Buffer, edit: (doc: Doc) => void): Buffer => {
  const doc = JSON.parse(body.toString('utf8')) as Doc;
  edit(doc);
  return Buffer.from(JSON.stringify(doc));
};
/** The next capture of run A: a later clock time in the title and other measured values, the forecast untouched. */
const A_AGAIN = edited(A, (d) => {
  d.plot.layout.title = 'Rhein - Rheinfelden, Messstation QForecastPlot 17:50 (30.09.26)';
  for (const t of d.plot.data.slice(4)) t.y = t.y.map((v) => (v === null ? v : v + 1));
});
/** A lake figure: the same figure in metres above sea level (`m ü.M.`; the real values are discharges, the shape is real). */
const LAKE = edited(A, (d) => {
  for (const t of d.plot.data) if (t.meta.unit !== '') t.meta.unit = 'm ü.M.';
});

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
    source: 'CH-4',
    spec: 'ch-4-forecast',
    variant,
    at: new Date(at),
    url: 'https://example.invalid/ch-4-forecast',
    body,
    retention: 'forever',
  });
const tick = () => h.loader({ now: NOW }).tick();
const runsOf = (key: string) =>
  q(
    `SELECT r.id::text AS id, r.first_valid, r.last_valid, r.fetched_at, r.issued_at, r.issued_inferred,
            encode(r.content_hash, 'hex') AS hash, r.kind, r.step::text AS step, r.provider_segment_end,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id) AS n
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE s.provider_key = $1 AND s.source_id = 'CH-1' AND r.source_id = 'CH-4' ORDER BY r.first_valid, r.id`,
    [key],
  );
const batches = () =>
  q(
    `SELECT n_rows, n_new, n_changed, n_skipped, parse_status, error FROM ingest_batch WHERE spec_id = 'ch-4-forecast' ORDER BY id`,
  );
const counts = (rows: Row[]) => rows.map((b) => [b.n_rows, b.n_new, b.n_changed]);
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
  adapters: LOAD_ADAPTERS,
});
const date = (iso: string) => new Date(iso);

describe('CH-4 runs through the loader', { timeout: 300_000 }, () => {
  it('captures in order and in reverse give the same runs: one per first valid time and content hash, from the earliest capture', async () => {
    // Station 2091, in order: run A captured three times (the 2nd identical, the 3rd with another title and measured
    // trace), then the next run B.
    await put('2091', '2026-09-30T15:35:10Z', A);
    await put('2091', '2026-09-30T15:55:10Z', A);
    await put('2091', '2026-09-30T16:15:10Z', A_AGAIN);
    await put('2091', '2026-09-30T16:35:10Z', B);
    // Station 2602 with the same four captures, the latest first (30 s later): the earliest arrives last.
    await put('2602', '2026-09-30T16:35:40Z', B);
    await put('2602', '2026-09-30T16:15:40Z', A_AGAIN);
    await put('2602', '2026-09-30T15:55:40Z', A);
    await put('2602', '2026-09-30T15:35:40Z', A);
    // And the real run of station 2602 of 2026-10-04.
    await put('2602', '2026-10-04T05:35:28Z', REAL_2602);
    expect(await tick()).toEqual({ lines: 9, loaded: 9 });

    const r2091 = await runsOf('2091/Q');
    expect(r2091.map((r) => r.n)).toEqual([118, 114]);
    const r2602 = await runsOf('2602/Q');
    expect(r2602.map((r) => r.n)).toEqual([118, 114, 118]);
    // The same runs whatever the order: first and last valid time, hash and length.
    const key = (r: Row) => [r.first_valid, r.last_valid, r.hash, r.n];
    expect(r2602.slice(0, 2).map(key)).toEqual(r2091.map(key));
    expect(r2091[0]?.hash).not.toBe(r2091[1]?.hash);
    // The run is its earliest capture (a changed title or measured trace is not another run).
    expect(r2091[0]?.fetched_at).toEqual(date('2026-09-30T15:35:10Z'));
    expect(r2091[1]?.fetched_at).toEqual(date('2026-09-30T16:35:10Z'));
    expect(r2602[0]?.fetched_at).toEqual(date('2026-09-30T15:35:40Z'));
    expect(r2602[1]?.fetched_at).toEqual(date('2026-09-30T16:35:40Z'));
    expect(r2602[2]?.fetched_at).toEqual(date('2026-10-04T05:35:28Z'));
    // 3 + 3 runs for 9 captures, 118 + 114 + 118 + 114 + 118 values.
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual([{ n: 5 }]);
    expect(await q('SELECT count(*)::int AS n FROM forecast_value')).toEqual([{ n: 118 + 114 + 118 + 114 + 118 }]);
    expect(counts(await batches())).toEqual([
      [118, 118, 0],
      [118, 0, 0],
      [118, 0, 0],
      [114, 114, 0],
      [114, 114, 0],
      [118, 118, 0],
      [118, 0, 1],
      [118, 0, 1],
      [118, 118, 0],
    ]);
    expect(h.alerts).toEqual([]);
  });

  it('a replay, twice, writes nothing: second pass n_new 0 and n_changed 0, the run count the number of unique keys', async () => {
    const before = await q('SELECT count(*)::int AS n FROM forecast_value');
    for (let round = 0; round < 2; round++) {
      const r = await replay(deps(), {
        source: 'CH-4',
        spec: null,
        from: '2026-09-30',
        to: '2026-10-31',
        dryRun: false,
      });
      expect(r).toMatchObject({ lines: 9, loaded: 9, quarantined: 0, n_new: 0, n_changed: 0 });
    }
    expect(await q('SELECT count(*)::int AS n FROM forecast_value')).toEqual(before);
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual([{ n: 5 }]);
  });

  it('a run is the provider’s median figure: ensemble summary, hourly, issued at the earliest fetch (inferred), all five columns', async () => {
    const [a, b] = await runsOf('2091/Q');
    expect(a).toMatchObject({
      kind: 'ensemble_summary',
      step: '01:00:00',
      issued_at: date('2026-09-30T15:35:10Z'),
      issued_inferred: true,
      first_valid: date('2026-09-30T09:00:00Z'),
      last_valid: date('2026-10-05T06:00:00Z'),
      provider_segment_end: null,
    });
    expect(b).toMatchObject({
      issued_at: date('2026-09-30T16:35:10Z'),
      issued_inferred: true,
      first_valid: date('2026-09-30T13:00:00Z'),
      last_valid: date('2026-10-05T06:00:00Z'),
    });
    const values = await q(
      `SELECT valid_ts, value, p25, p50, p75, vmin, vmax, flags, p05, p10, p30, p70, p90, p95
       FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts`,
      [a?.id],
    );
    expect(values).toHaveLength(118);
    // Real values (float4 as stored): the run starts at the measured 328.2 and opens up to 335 … 372.
    expect(values[0]).toMatchObject({ value: 328.2, p25: 328.2, p50: 328.2, p75: 328.2, vmin: 328.2, vmax: 328.2 });
    expect(values.at(-1)).toMatchObject({ value: 340.4, p50: 340.4, vmin: 334.8, vmax: 372.1, flags: 0 });
    // Only the columns the figure has: the other percentiles stay absent, and no value is out of order.
    expect(values.every((v) => v.p05 === null && v.p10 === null && v.p30 === null && v.p70 === null)).toBe(true);
    expect(values.every((v) => v.p90 === null && v.p95 === null && v.flags === 0 && v.value === v.p50)).toBe(true);
    const num = values as Record<'vmin' | 'p25' | 'p50' | 'p75' | 'vmax', number>[];
    expect(num.every((v) => v.vmin <= v.p25 && v.p25 <= v.p50 && v.p50 <= v.p75 && v.p75 <= v.vmax)).toBe(true);
    // Hourly valid times, none from the measured trace that starts a day earlier.
    const ts = values.map((v) => (v.valid_ts as Date).getTime());
    expect(ts.every((t, i) => i === 0 || t - (ts[i - 1] as number) === HOUR)).toBe(true);
  });

  it('the run attaches to the station’s CH-1 series: one source on the series, the run is CH-4’s', async () => {
    const rows = await q(
      `SELECT s.source_id AS series_source, s.role, s.quantity, r.source_id AS run_source, count(*)::int AS n
       FROM forecast_run r JOIN series s ON s.id = r.series_id GROUP BY 1, 2, 3, 4 ORDER BY 1`,
    );
    expect(rows).toEqual([{ series_source: 'CH-1', role: 'primary', quantity: 'Q', run_source: 'CH-4', n: 5 }]);
  });

  it('a lake figure lands on the station’s W series in centimetres; a withheld station stores nothing; an unknown id is counted', async () => {
    await put('2004', '2026-09-30T15:36:10Z', LAKE);
    await put('2022', '2026-09-30T15:36:20Z', LAKE);
    await put('9999', '2026-09-30T15:36:30Z', A);
    expect(await tick()).toEqual({ lines: 3, loaded: 3 });
    const [lake] = await runsOf('2004/W');
    expect(lake).toMatchObject({ n: 118, kind: 'ensemble_summary', issued_inferred: true });
    const first = await q(
      `SELECT value, p25, p75, vmin, vmax FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts LIMIT 1`,
      [lake?.id],
    );
    // 328.2 metres × 100 (float4: 32820 exactly).
    expect(first).toEqual([{ value: 32820, p25: 32820, p75: 32820, vmin: 32820, vmax: 32820 }]);
    expect(await runsOf('2022/W')).toEqual([]);
    expect(await q(`SELECT count(*)::int AS n FROM forecast_run`)).toEqual([{ n: 6 }]);
    expect((await batches()).slice(-3)).toMatchObject([
      { n_rows: 118, n_new: 118, n_skipped: 0, parse_status: 'ok' },
      { n_rows: 0, n_new: 0, n_skipped: 0, parse_status: 'ok' },
      { n_rows: 0, n_new: 0, n_skipped: 1, parse_status: 'ok' },
    ]);
  });

  it('a reordered figure, a renamed trace and a malformed variant are quarantined with a fixed code, nothing stored', async () => {
    await put('2091', '2026-10-01T07:12:00Z', REORDERED);
    await put('2091', '2026-10-01T08:12:00Z', RENAMED);
    await put('20x1', '2026-10-01T09:12:00Z', A);
    const before = h.alerts.length;
    // (a quarantined line is processed, not loaded)
    expect(await tick()).toEqual({ lines: 3, loaded: 0 });
    expect((await batches()).slice(-3)).toMatchObject([
      { parse_status: 'quarantined', error: 'ch4_layout at data.2' },
      { parse_status: 'quarantined', error: 'ch4_layout at data.3' },
      { parse_status: 'quarantined', error: 'bad_variant' },
    ]);
    expect(h.alerts.length).toBeGreaterThan(before);
    expect(await q('SELECT count(*)::int AS n FROM forecast_run')).toEqual([{ n: 6 }]);
    // A replay does not change a quarantined figure (it still does not parse), and writes nothing.
    const r = await replay(deps(), {
      source: 'CH-4',
      spec: null,
      from: '2026-10-01',
      to: '2026-10-01',
      dryRun: false,
    });
    expect(r).toMatchObject({ lines: 3, loaded: 0, quarantined: 3, n_new: 0, n_changed: 0 });
  });

  it('CH-4 is public: its runs are in the public and the owner forecast views and functions alike, API views included', async () => {
    const all = Number((await q('SELECT count(*)::int AS n FROM forecast_run'))[0]?.n);
    const allValues = Number((await q('SELECT count(*)::int AS n FROM forecast_value'))[0]?.n);
    expect([all, allValues]).toEqual([6, 118 + 114 + 118 + 114 + 118 + 118]);
    const asofA = '2026-09-30T16:00:00Z';
    const asofB = '2026-09-30T17:00:00Z';
    const series2091 = await h.seriesId('2091/Q');
    const roles = [
      ...FAMILY_ROLES.public.map((role) => ['public', role] as const),
      ...FAMILY_ROLES.owner.map((role) => ['owner', role] as const),
    ];
    for (const [family, role] of roles) {
      const client = await h.t.connectAs(role);
      clients.push(client);
      const views = VIEWS[family];
      const n = async (view: string) => (await client.query(`SELECT count(*)::int AS n FROM ${view}`)).rows[0]?.n;
      expect([role, await n(views.forecastRun), await n(views.api.forecastRun)]).toEqual([role, all, all]);
      expect([role, await n(views.forecastValue), await n(views.api.forecastValue)]).toEqual([
        role,
        allValues,
        allValues,
      ]);
      const sources = await client.query(`SELECT DISTINCT source_id FROM ${views.forecastRun}`);
      expect(sources.rows).toEqual([{ source_id: 'CH-4' }]);
      // Q2: the latest run issued as of the instant, step-held at it. At 16:00Z run A (issued 15:35:10Z) is the
      // latest, at 17:00Z run B (issued 16:35:10Z).
      const at = (t: string) =>
        client.query(
          `SELECT source_id, issued_at, issued_inferred, last_valid, kind, valid_ts, value, p25, p50, p75, vmin, vmax, flags
           FROM ${FORECAST_AT[family]}($1::timestamptz, $1::timestamptz) WHERE series_id = $2`,
          [t, series2091],
        );
      const [atA, atB] = [await at(asofA), await at(asofB)];
      expect(atA.rows).toHaveLength(1);
      expect(atA.rows[0]).toMatchObject({
        source_id: 'CH-4',
        issued_at: date('2026-09-30T15:35:10Z'),
        issued_inferred: true,
        kind: 'ensemble_summary',
        valid_ts: date(asofA),
        flags: 0,
      });
      expect(atB.rows[0]).toMatchObject({ issued_at: date('2026-09-30T16:35:10Z'), valid_ts: date(asofB) });
      for (const row of [atA.rows[0], atB.rows[0]])
        expect(row.vmin <= row.p25 && row.p25 <= row.p50 && row.p50 <= row.p75 && row.p75 <= row.vmax).toBe(true);
    }
    // The two families state the same values (the series and the source are both public).
    const [pub, own] = [await h.t.connectAs('rws_api'), await h.t.connectAs('rws_owner_api')];
    clients.push(pub, own);
    const state = (c: pg.Client, family: 'public' | 'owner') =>
      c.query(
        `SELECT series_id, value, p25, p50, p75, vmin, vmax FROM ${FORECAST_AT[family]}($1::timestamptz, $1::timestamptz) ORDER BY series_id`,
        [asofB],
      );
    const [p, o] = [await state(pub, 'public'), await state(own, 'owner')];
    expect(p.rows).toHaveLength(3);
    expect(o.rows).toEqual(p.rows);
  });
});
