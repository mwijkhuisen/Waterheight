import { HealthSourcesAnswer } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { computeHealth, forecastDetails, type HealthInputs } from '../../src/load/health.ts';
import { type Harness, harness } from './harness.ts';

// P8a (C9): `detail.forecast` per source that has stored runs, and the DE-2 alert `forecast_run_late`, once per due
// day and without a value, against a real database. DE-2 and LU-3 own no series (`has_series` false): a late or old
// run never changes a status. Owner sources reach the public documents only through `owner_sources`.

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
// A Monday, 15:00 in Berlin (past the 12:00 deadline), and the Saturday after it.
const MONDAY = Date.parse('2026-10-26T14:00:00Z');
const SATURDAY = Date.parse('2026-10-31T14:00:00Z');

let h: Harness;
let n = 0;
const ids: Record<string, number> = {};
const q = async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;

async function seriesOf(station: string, quantity: 'H' | 'Q', source: string): Promise<number> {
  const rows = await q<{ id: number }>(
    `SELECT id FROM series WHERE station_id = $1 AND quantity = $2 AND source_id = $3 AND role = 'primary' AND active
     ORDER BY id LIMIT 1`,
    [station, quantity, source],
  );
  const r = rows[0];
  if (r === undefined) throw new Error(`no series for ${station} ${quantity}`);
  return r.id;
}

/** One run of `source` on a series, with a value at its first and last valid time. */
async function run(
  series: number,
  source: string,
  o: { issued: number | null; fetched: number; last: number; first?: number },
) {
  n += 1;
  const first = o.first ?? o.issued ?? o.fetched;
  const [row] = await q<{ id: string }>(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                               content_hash, kind)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz IS NULL, $4, $5, $6, decode(md5($7::text), 'hex'),
             'deterministic') RETURNING id`,
    [series, source, o.issued === null ? null : iso(o.issued), iso(first), iso(o.last), iso(o.fetched), `${n}`],
  );
  await q('INSERT INTO forecast_value (run_id, valid_ts, value) VALUES ($1, $2, 100), ($1, $3, 110)', [
    (row as { id: string }).id,
    iso(first),
    iso(o.last),
  ]);
}

const alerts: { code: string; fields: Record<string, string | number> }[] = [];
const inputs = (now: number): HealthInputs => ({
  cadenceS: new Map(),
  lagP95Ms: new Map(),
  backlog: { files: 0, bytes: 0, age_s: null },
  badLines: 0,
  now: new Date(now),
  alert: (code, fields) => alerts.push({ code, fields }),
});
const health = (now: number) => computeHealth(h.load.db, inputs(now));
const detail = async (source: string) =>
  (
    await q<{ detail: Record<string, unknown>; status: string }>(
      'SELECT detail, status FROM source_health WHERE source_id = $1',
      [source],
    )
  )[0];
const lateDay = async () =>
  (await q<{ day: string | null }>(`SELECT value #>> '{}' AS day FROM app_meta WHERE key = 'forecast_late:DE-2'`))[0]
    ?.day;
const fetchedOk = (source: string, at: number) =>
  q(
    `INSERT INTO source_health (source_id, status, last_fetch_ok) VALUES ($1, 'ok', $2)
     ON CONFLICT (source_id) DO UPDATE SET last_fetch_ok = EXCLUDED.last_fetch_ok`,
    [source, iso(at)],
  );

beforeAll(async () => {
  h = await harness();
  await h.t.admin.query(`SELECT ensure_partitions('2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z')`);
  ids.lobithQ = await seriesOf('nl.rws.lobith.bovenrijn.tolkamer', 'Q', 'NL-1');
  ids.eijsdenQ = await seriesOf('nl.rws.eijsden.grens', 'Q', 'NL-1');
  ids.nijmegen = await seriesOf('nl.rws.nijmegen.waal', 'H', 'NL-1');
  ids.kaub = await seriesOf('de.wsv.25700100', 'H', 'DE-1');
  ids.emmerich = await seriesOf('de.wsv.2790020', 'H', 'DE-1');
  ids.ruhrort = await seriesOf('de.wsv.2770010', 'H', 'DE-1');
  ids.diekirch = await seriesOf('lu.age.diekirch', 'H', 'LU-1');
}, 300_000);

afterAll(async () => {
  await h?.close();
});

describe('detail.forecast', { timeout: 300_000 }, () => {
  it('NL-1: the newest run issue time (inferred: the first fetch), its age, the series with a run and the current ones', async () => {
    // Lobith: a run fetched 3 h ago and a newer one 1 h ago (the newer one counts); Eijsden: a current run fetched 5 h
    // ago; Nijmegen: a run that ended an hour ago; a run fetched after "now" is not known yet.
    await run(ids.lobithQ as number, 'NL-1', { issued: null, fetched: MONDAY - 3 * HOUR, last: MONDAY + 30 * HOUR });
    await run(ids.lobithQ as number, 'NL-1', { issued: null, fetched: MONDAY - HOUR, last: MONDAY + 47 * HOUR });
    await run(ids.eijsdenQ as number, 'NL-1', { issued: null, fetched: MONDAY - 5 * HOUR, last: MONDAY + 40 * HOUR });
    await run(ids.nijmegen as number, 'NL-1', { issued: null, fetched: MONDAY - 30 * HOUR, last: MONDAY - HOUR });
    await run(ids.eijsdenQ as number, 'NL-1', { issued: null, fetched: MONDAY + HOUR, last: MONDAY + 60 * HOUR });
    await health(MONDAY);
    const d = await detail('NL-1');
    expect(d?.detail.forecast).toEqual({
      issued_at: iso(MONDAY - HOUR),
      run_age_s: 3600,
      series: 3,
      current: 2,
      late: null,
    });
    // The other keys of the detail are still there: the forecast key is beside them, not instead.
    expect(d?.detail).toHaveProperty('min_interval_s');
    expect(alerts).toEqual([]);
  });

  it('a source with no run has no forecast key, and a stale one is dropped when the runs go', async () => {
    expect((await detail('DE-1'))?.detail).not.toHaveProperty('forecast');
    await q(
      `UPDATE source_health SET detail = detail || '{"forecast": {"issued_at": "2026-10-01T00:00:00Z"}}' WHERE source_id = 'DE-1'`,
    );
    expect((await detail('DE-1'))?.detail).toHaveProperty('forecast');
    await health(MONDAY);
    expect((await detail('DE-1'))?.detail).not.toHaveProperty('forecast');
  });

  it('forecastDetails lists only sources that have runs, and never an issue time after "now"', async () => {
    const all = await forecastDetails(h.load.db, new Date(MONDAY));
    expect([...all.keys()]).toEqual(['NL-1']);
    // Two hours earlier the run fetched at MONDAY − 1 h is not known yet, and Nijmegen's run still reaches "now".
    const earlier = await forecastDetails(h.load.db, new Date(MONDAY - 2 * HOUR));
    expect(earlier.get('NL-1')).toMatchObject({ issued_at: iso(MONDAY - 3 * HOUR), series: 3, current: 3 });
  });
});

describe('forecast_run_late (DE-2)', { timeout: 300_000 }, () => {
  const friday = Date.parse('2026-10-23T05:00:00Z');

  it('silent while the latest run is of today; fires once for the due day that missed its deadline, never twice', async () => {
    const today = Date.parse('2026-10-26T05:00:00Z');
    await run(ids.kaub as number, 'DE-2', { issued: friday, fetched: friday + 12 * 60_000, last: friday + 96 * HOUR });
    await fetchedOk('DE-2', MONDAY - 10 * 60_000);
    // Monday 15:00 local: Monday's deadline (12:00) has passed and the newest run is Friday's.
    await health(MONDAY);
    expect(alerts).toEqual([{ code: 'forecast_run_late', fields: { source: 'DE-2', day: '2026-10-26' } }]);
    expect(await lateDay()).toBe('2026-10-26');
    expect((await detail('DE-2'))?.detail.forecast).toMatchObject({ series: 1, current: 0, late: '2026-10-26' });
    // The next minute, and the next: the same due day alerts once.
    await health(MONDAY + 60_000);
    await health(MONDAY + 120_000);
    expect(alerts).toHaveLength(1);

    // The run arrives (late): late is null again, no alert, the day marker stays.
    await run(ids.kaub as number, 'DE-2', { issued: today, fetched: MONDAY + 3 * 60_000, last: today + 96 * HOUR });
    await health(MONDAY + 5 * 60_000);
    expect((await detail('DE-2'))?.detail.forecast).toMatchObject({ late: null, current: 1 });
    expect(alerts).toHaveLength(1);
  });

  it('a later due day without a run is another alert, once', async () => {
    const tuesday = Date.parse('2026-10-27T14:00:00Z');
    await health(tuesday);
    expect(alerts.map((a) => a.fields.day)).toEqual(['2026-10-26', '2026-10-27']);
    await health(tuesday + 60_000);
    expect(alerts).toHaveLength(2);
  });

  it('carries the source and the day and nothing else: no value, no series, no threshold', () => {
    for (const a of alerts) {
      expect(a.code).toBe('forecast_run_late');
      expect(Object.keys(a.fields).sort()).toEqual(['day', 'source']);
    }
  });

  it('a weekend with Ruhrort at 4 m or more (or unknown) is silent; below 4 m the Saturday is due', async () => {
    const before = alerts.length;
    const fri = Date.parse('2026-10-30T05:00:00Z');
    await run(ids.emmerich as number, 'DE-2', { issued: fri, fetched: fri + 12 * 60_000, last: fri + 96 * HOUR });
    // No Ruhrort observation: unknown, the weekend is not due.
    await health(SATURDAY);
    expect(alerts).toHaveLength(before);
    expect((await detail('DE-2'))?.detail.forecast).toMatchObject({ late: null });
    // 450 cm ten minutes ago: still not due.
    await q('INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 450, 0, 1)', [
      ids.ruhrort,
      iso(SATURDAY - 10 * 60_000),
    ]);
    await health(SATURDAY);
    expect(alerts).toHaveLength(before);
    // 350 cm: the Saturday run was due by 12:00 Berlin and did not come.
    await q('UPDATE obs_latest SET value = 350 WHERE series_id = $1', [ids.ruhrort]);
    await health(SATURDAY);
    expect(alerts.slice(before)).toEqual([
      { code: 'forecast_run_late', fields: { source: 'DE-2', day: '2026-10-31' } },
    ]);
    expect(await lateDay()).toBe('2026-10-31');
  });

  it('a late or old run never changes the status of DE-2 or LU-3: they own no series', async () => {
    await run(ids.diekirch as number, 'LU-3', {
      issued: null,
      fetched: SATURDAY - 20 * HOUR,
      last: SATURDAY - 10 * HOUR,
    });
    await fetchedOk('LU-3', SATURDAY - 10 * 60_000);
    await fetchedOk('DE-2', SATURDAY - 10 * 60_000);
    await health(SATURDAY);
    expect((await detail('DE-2'))?.status).toBe('ok');
    expect((await detail('LU-3'))?.status).toBe('ok');
    expect((await detail('LU-3'))?.detail.forecast).toMatchObject({ series: 1, current: 0, late: null });
    expect((await detail('DE-2'))?.detail.forecast).toMatchObject({ late: '2026-10-31' });
  });

  it('weeks without a run still alert each newly missed working day (review F1)', async () => {
    const before = alerts.length;
    // The newest DE-2 run is of 2026-10-30, 17 days before Monday 2026-11-16 (15:00 Berlin), then Tuesday.
    await health(Date.parse('2026-11-16T14:00:00Z'));
    await health(Date.parse('2026-11-17T14:00:00Z'));
    expect(alerts.slice(before).map((a) => a.fields.day)).toEqual(['2026-11-16', '2026-11-17']);
  });
});

describe('the public health document', { timeout: 300_000 }, () => {
  it('shows NL-1 forecast numbers, and DE-2 and LU-3 only inside the owner_sources counts', async () => {
    await health(MONDAY);
    const api = h.dbAs('rws_api', 2);
    try {
      const app = createApp({ db: api.db, now: () => new Date(MONDAY + 60_000) });
      const res = await app.request('/api/v1/health/sources');
      expect(res.status).toBe(200);
      const text = await res.text();
      const { attribution, ...doc } = HealthSourcesAnswer.parse(JSON.parse(text));
      // P9b: the attribution names exactly the sources the document names.
      expect(new Set(attribution.map((a) => a.source))).toEqual(
        new Set([...doc.sources.map((s) => s.id), ...doc.quarantined_batches.map((q) => q.source)]),
      );
      expect(doc.sources.find((s) => s.id === 'NL-1')?.forecast).toMatchObject({ series: 3, late: null });
      expect(doc.sources.map((s) => s.id)).not.toContain('DE-2');
      expect(doc.sources.map((s) => s.id)).not.toContain('LU-3');
      expect(doc.owner_sources.total).toBeGreaterThanOrEqual(4);
      expect(text).not.toMatch(/DE-2|DE-3|LU-3|LU-4|BE-3|forecast_run_late|forecast_late/);
    } finally {
      await api.close();
    }
  });
});
