import { FORECAST_FLAGS } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { FAMILY_ROLES, FORECAST_AT, VIEWS } from '../../src/db/audience.ts';
import { DST_REFUSED, LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { parseReplayArgs, type ReplayArgs, replay } from '../../src/load/replay.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// DE-3 (BfG 14-day quantile forecast, owner audience) through the real loader, adapter and registry, on synthetic
// files only (the synthetic fixtures of apps/server/src/adapters/de-3, their rows moved to October 2026; every value
// is invented): a run keeps its own key whatever the order of its captures, a replay writes nothing, `---` is stored
// as NULL with the CENSORED flag, a run sits on the gauge's DE-1 stage series and reaches the owner family only (the
// series is public, the run's own source is not).

const NOW = new Date('2026-10-05T00:00:00Z');
const DAY = 86_400_000;
const CENSORED = FORECAST_FLAGS.CENSORED;
const EMMERICH = '14-Tage-Vorhersage/Emmerich_Quantile_2790020.csv';
const EMMERICH_KEY = '9598e4cb-0849-401e-bba0-689234b27644/W';
const KAUB = '14-Tage-Vorhersage/Kaub_Quantile_25700100.csv';
const KAUB_KEY = '1d26e504-7f9e-480a-b52c-5932be6549ab/W';
const RUHRORT = '14-Tage-Vorhersage/Duisburg-Ruhrort_Quantile_2770010.csv';
const RUHRORT_KEY = 'c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1/W';
const SIX_WEEK = '6-Wochen-Vorhersage/Rhein-Kaub_6Wochen_Wasserstand_QuansBox.csv';

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
const pad = (n: number) => String(n).padStart(2, '0');
/**
 * A committed synthetic file with its rows on the days from `first` (a CET midnight, `yyyy-mm-dd`), every number moved
 * by `bump` (a `---` stays): the same structure, another run.
 */
const file = (name: string, first: string, bump = 0): Buffer => {
  const t0 = Date.parse(`${first}T00:00:00Z`);
  let i = 0;
  const lines = rawFixture('DE-3', name)
    .body.toString('latin1')
    .split('\n')
    .map((l) => {
      if (!/^\d{2}\.\d{2}\.\d{4} /.test(l)) return l;
      const d = new Date(t0 + i++ * DAY);
      const [, ...cells] = l.split(';');
      const day = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} 00:00`;
      return [day, ...cells.map((c) => c.replace(/^-?\d+/, (n) => String(Number(n) + bump)))].join(';');
    });
  return Buffer.from(lines.join('\n'), 'latin1');
};
const put = (variant: string, at: string, body: Buffer) =>
  writePayload(h.archive, {
    source: 'DE-3',
    spec: 'de-3-files',
    variant,
    at: new Date(at),
    url: `https://example.invalid/${variant}`,
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
     WHERE s.provider_key = $1 AND s.source_id = 'DE-1' AND r.source_id = 'DE-3' ORDER BY r.first_valid, r.fetched_at`,
    [key],
  );
const batches = () =>
  q(
    `SELECT n_rows, n_new, n_changed, n_skipped, parse_status, error FROM ingest_batch WHERE spec_id = 'de-3-files' ORDER BY id`,
  );
const counts = (rows: Row[]) => rows.map((b) => [b.n_rows, b.n_new, b.n_changed]);
const total = async (table: string) => (await q(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n;
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
  adapters: LOAD_ADAPTERS,
});

describe('DE-3 runs through the loader', { timeout: 300_000 }, () => {
  it('the loader admits the spec: it has a DST proof, so the gate keeps it', () => {
    expect(DST_REFUSED).not.toContain('de-3-files');
    expect(Object.keys(LOAD_ADAPTERS['DE-3']?.specs ?? {})).toEqual(['de-3-files']);
  });

  it('captures in order and in reverse give the same runs, keyed by first valid time and hash', async () => {
    // Emmerich, in order: a file captured twice, the next day's file, and that day's file again with other values.
    await put(EMMERICH, '2026-10-02T10:15:00Z', file('de-3-files-emmerich.synthetic', '2026-10-02'));
    await put(EMMERICH, '2026-10-02T10:15:30Z', file('de-3-files-emmerich.synthetic', '2026-10-02'));
    await put(EMMERICH, '2026-10-03T10:15:00Z', file('de-3-files-emmerich.synthetic', '2026-10-03', 5));
    await put(EMMERICH, '2026-10-03T13:15:00Z', file('de-3-files-emmerich.synthetic', '2026-10-03', 9));
    // Kaub: the same two days, the later one first (the earlier capture arrives last).
    await put(KAUB, '2026-10-03T10:15:00Z', file('de-3-files-kaub.synthetic', '2026-10-03', 5));
    await put(KAUB, '2026-10-02T10:15:00Z', file('de-3-files-kaub.synthetic', '2026-10-02'));
    // Ruhrort: a file with `---` cells, one row of them only `---`.
    await put(RUHRORT, '2026-10-02T10:15:00Z', file('de-3-files-ruhrort-censored.synthetic', '2026-10-02'));
    expect(await tick()).toEqual({ lines: 7, loaded: 7 });

    const emmerich = await runsOf(EMMERICH_KEY);
    expect(emmerich).toHaveLength(3);
    // Two runs share the first valid time (2026-10-03) and differ by their hash: both are kept.
    expect(emmerich.map((r) => r.first_valid)).toEqual([
      new Date('2026-10-01T23:00:00Z'),
      new Date('2026-10-02T23:00:00Z'),
      new Date('2026-10-02T23:00:00Z'),
    ]);
    expect(emmerich[1]?.hash).not.toBe(emmerich[2]?.hash);
    // The file captured twice is one run, and it is its earliest capture.
    expect(emmerich[0]?.fetched_at).toEqual(new Date('2026-10-02T10:15:00Z'));
    const kaub = await runsOf(KAUB_KEY);
    expect(kaub.map((r) => [r.first_valid, r.fetched_at])).toEqual([
      [new Date('2026-10-01T23:00:00Z'), new Date('2026-10-02T10:15:00Z')],
      [new Date('2026-10-02T23:00:00Z'), new Date('2026-10-03T10:15:00Z')],
    ]);
    expect(await runsOf(RUHRORT_KEY)).toHaveLength(1);
    // The run count is the number of unique keys: 3 + 2 + 1 runs for 7 captures, 14 values each.
    expect(await total('forecast_run')).toBe(6);
    expect(await total('forecast_value')).toBe(6 * 14);
    expect(counts(await batches())).toEqual([
      [14, 14, 0],
      [14, 0, 0],
      [14, 14, 0],
      [14, 14, 0],
      [14, 14, 0],
      [14, 14, 0],
      [14, 14, 0],
    ]);
    expect(h.alerts).toEqual([]);
  });

  it('a replay of the source, twice, writes nothing (`replay --source DE-3` is admitted)', async () => {
    const args = parseReplayArgs(['--source', 'DE-3', '--from', '2026-10-02', '--to', '2026-10-31']) as ReplayArgs;
    expect(typeof args).toBe('object');
    const before = [await total('forecast_value'), await total('forecast_run')];
    for (const spec of [null, 'de-3-files']) {
      for (let round = 0; round < 2; round++) {
        const r = await replay(deps(), { ...args, spec });
        expect(r).toMatchObject({ lines: 7, loaded: 7, quarantined: 0, n_new: 0, n_changed: 0 });
      }
    }
    expect([await total('forecast_value'), await total('forecast_run')]).toEqual(before);
    expect(
      parseReplayArgs(['--source', 'DE-3', '--spec', 'de-3-index', '--from', '2026-10-02', '--to', '2026-10-31']),
    ).toBe('replay: --spec is not a spec of that adapter');
  });

  it('a run is its provider’s: quantiles, one day a step, no issue time (inferred from the fetch), no segment', async () => {
    const [first, second] = await runsOf(EMMERICH_KEY);
    expect(first).toMatchObject({
      kind: 'quantiles',
      step: '24:00:00',
      issued_at: new Date('2026-10-02T10:15:00Z'),
      issued_inferred: true,
      first_valid: new Date('2026-10-01T23:00:00Z'),
      last_valid: new Date('2026-10-14T23:00:00Z'),
      provider_segment_end: null,
      n: 14,
    });
    expect(second).toMatchObject({ issued_at: new Date('2026-10-03T10:15:00Z'), issued_inferred: true });
    // One run per gauge sits on its DE-1 stage series: the series' source is DE-1, the run's DE-3.
    const rows = await q(
      `SELECT s.source_id AS series_source, s.role, s.quantity, r.source_id AS run_source, count(*)::int AS n
       FROM forecast_run r JOIN series s ON s.id = r.series_id GROUP BY 1, 2, 3, 4 ORDER BY 1`,
    );
    expect(rows).toEqual([{ series_source: 'DE-1', role: 'primary', quantity: 'H', run_source: 'DE-3', n: 6 }]);
  });

  it('the stored values are the published ones: p05 p10 p25 p50 p75 p90 p95 and value = p50, whole centimetres', async () => {
    const [run] = await runsOf(EMMERICH_KEY);
    const rows = await q(
      `SELECT valid_ts, value, p05, p10, p25, p30, p50, p70, p75, p90, p95, vmin, vmax, flags
       FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts`,
      [run?.id],
    );
    expect(rows).toHaveLength(14);
    // The file's own cells, read here without the adapter: columns 5, 10, 25, 50, 75, 90, 95 % are cells 1, 2, 4, 7, 10, 12, 13.
    const cells = file('de-3-files-emmerich.synthetic', '2026-10-02')
      .toString('latin1')
      .split('\n')
      .filter((l) => /^\d{2}\.\d{2}\.\d{4} /.test(l))
      .map((l) => l.trim().split(';').slice(1).map(Number));
    for (const [i, r] of rows.entries()) {
      const c = cells[i] as number[];
      expect([r.p05, r.p10, r.p25, r.p50, r.p75, r.p90, r.p95, r.value]).toEqual([
        c[0],
        c[1],
        c[3],
        c[6],
        c[9],
        c[11],
        c[12],
        c[6],
      ]);
      // Not LU-3's columns, nor the ensemble's.
      expect([r.p30, r.p70, r.vmin, r.vmax]).toEqual([null, null, null, null]);
      expect((r.flags as number) & CENSORED).toBe(0);
      expect(r.valid_ts).toEqual(new Date(Date.parse('2026-10-01T23:00:00Z') + i * DAY));
    }
  });

  it('`---` is stored as NULL with the CENSORED flag, never as 0; a row of only `---` is kept', async () => {
    const [run] = await runsOf(RUHRORT_KEY);
    expect(run?.n).toBe(14);
    const rows = await q(
      `SELECT value, p05, p10, p25, p50, p75, p90, p95, flags FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts`,
      [run?.id],
    );
    const text = file('de-3-files-ruhrort-censored.synthetic', '2026-10-02').toString('latin1').split('\n');
    const cells = text.filter((l) => /^\d{2}\.\d{2}\.\d{4} /.test(l)).map((l) => l.trim().split(';').slice(1));
    const kept = [0, 1, 3, 6, 9, 11, 12];
    for (const [i, r] of rows.entries()) {
      const c = cells[i] as string[];
      const published = (k: number) => (c[k] === '---' ? null : Number(c[k]));
      expect([r.p05, r.p10, r.p25, r.p50, r.p75, r.p90, r.p95]).toEqual(kept.map(published));
      expect(r.value).toBe(published(6));
      expect((r.flags as number) & CENSORED).toBe(kept.some((k) => c[k] === '---') ? CENSORED : 0);
    }
    // Seven points are censored, the last three have no value at all, and the one dropped column leaves no trace.
    expect(rows.filter((r) => ((r.flags as number) & CENSORED) !== 0)).toHaveLength(7);
    expect(rows.slice(-3).every((r) => [r.value, r.p05, r.p50, r.p95].every((v) => v === null))).toBe(true);
    expect(rows[4]?.flags).not.toBe(CENSORED);
    expect(((rows[4]?.flags as number) & CENSORED) === 0).toBe(true);
  });

  it('a DE-3 run is in the owner forecast views and functions, in no public one (the series is public)', async () => {
    const asof = '2026-10-03T12:00:00Z';
    const owner = await h.t.connectAs(FAMILY_ROLES.owner[0]);
    clients.push(owner);
    const ownerRuns = await owner.query(`SELECT source_id FROM ${VIEWS.owner.forecastRun}`);
    expect(ownerRuns.rows).toHaveLength(6);
    expect(new Set(ownerRuns.rows.map((r) => r.source_id))).toEqual(new Set(['DE-3']));
    const ownerValues = await owner.query(`SELECT count(*)::int AS n FROM ${VIEWS.owner.forecastValue}`);
    expect(ownerValues.rows).toEqual([{ n: 6 * 14 }]);
    for (const view of [VIEWS.owner.api.forecastRun, VIEWS.owner.api.forecastValue])
      expect(Number((await owner.query(`SELECT count(*)::int AS n FROM ${view}`)).rows[0]?.n)).toBeGreaterThan(0);
    // Q2 as of 2026-10-03 midday: each gauge's latest run known then (Emmerich's second run, fetched 10:15, not the
    // third, fetched 13:15), as quantiles of the DE-3 source.
    const at = await owner.query(
      `SELECT source_id, series_id, issued_at, kind FROM ${FORECAST_AT.owner}($1::timestamptz, $1::timestamptz) ORDER BY series_id`,
      [asof],
    );
    expect(at.rows).toHaveLength(3);
    expect(at.rows.every((r) => r.source_id === 'DE-3' && r.kind === 'quantiles')).toBe(true);
    const emmerich = await h.seriesId(EMMERICH_KEY);
    expect(at.rows.find((r) => Number(r.series_id) === emmerich)?.issued_at).toEqual(new Date('2026-10-03T10:15:00Z'));

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
      for (const t of [asof, '2026-10-02T12:00:00Z', '2026-10-10T12:00:00Z'])
        expect([
          role,
          t,
          (await pub.query(`SELECT 1 FROM ${FORECAST_AT.public}($1::timestamptz, $1::timestamptz)`, [t])).rowCount,
        ]).toEqual([role, t, 0]);
    }
  });

  it('a gauge DE-1 does not register is unknown, a 6-week file is read as nothing: counted, kept, nothing stored', async () => {
    const before = [await total('forecast_run'), await total('forecast_value')];
    await put(
      '14-Tage-Vorhersage/Oestrich_Quantile_9999999.csv',
      '2026-10-04T10:15:00Z',
      file('de-3-files-oestrich-unknown.synthetic', '2026-10-04'),
    );
    await put(SIX_WEEK, '2026-10-04T10:15:30Z', Buffer.from('Datum;QuansBox\r\n01.01.2030;1\r\n'));
    expect(await tick()).toEqual({ lines: 2, loaded: 2 });
    expect((await batches()).slice(-2)).toMatchObject([
      { n_rows: 0, n_new: 0, n_skipped: 1, parse_status: 'ok' },
      { n_rows: 0, n_new: 0, n_skipped: 0, parse_status: 'ok' },
    ]);
    expect([await total('forecast_run'), await total('forecast_value')]).toEqual(before);
    expect(h.alerts).toEqual([]);
  });

  it('a changed header or a malformed variant quarantine the payload with a fixed code', async () => {
    const good = file('de-3-files-kaub.synthetic', '2026-10-04');
    // The provider moves to GMT+2: drift, never a shifted day.
    await put(KAUB, '2026-10-04T10:15:00Z', Buffer.from(good.toString('latin1').replace('GMT+1', 'GMT+2'), 'latin1'));
    await put('14-Tage-Vorhersage/Kaub_Quantile_.csv', '2026-10-04T10:16:00Z', good);
    const before = h.alerts.length;
    // (a quarantined line is processed, not loaded)
    expect(await tick()).toEqual({ lines: 2, loaded: 0 });
    expect((await batches()).slice(-2)).toMatchObject([
      { parse_status: 'quarantined', error: 'comment_line at lines.0' },
      { parse_status: 'quarantined', error: 'bad_variant' },
    ]);
    expect(h.alerts.length).toBeGreaterThan(before);
    expect(await total('forecast_run')).toBe(6);
  });
});
