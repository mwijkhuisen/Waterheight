import { CANARY_RENDERINGS, ForecastCoverage, HealthSources } from '@rws/contracts';
import { RUHRORT_W } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forecastCoverage, RUHRORT_STATION } from '../../src/api/forecast.ts';
import { createApp } from '../../src/app.ts';
import { readRegistry, readRiverRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { type Harness, harness } from '../load/harness.ts';

// The forecast coverage of each audience family (P8a; catalogue §0.5) against a real database: the real registry
// synced with its river placement (as `migrate` does), runs seeded as the superuser, the report read as the real
// `rws_api` login (public family) and as `rws_owner_api` (owner family). The owner family fills Sauer / Sûre, Our
// (LU-3) and Maxau → Emmerich (DE-2) and leaves the Mosel (LU/DE) empty; the public report is the same with or
// without those runs and names no owner source.

// A Monday, 15:00 in Berlin: the 12:00 deadline of the day has passed.
const NOW = Date.parse('2026-10-26T14:00:00Z');
// A Saturday, 16:00 in Berlin.
const SATURDAY = Date.parse('2026-10-31T14:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

let h: Harness;
let pub: ReturnType<Harness['dbAs']>;
let own: ReturnType<Harness['dbAs']>;
let n = 0;
const ids: Record<string, number> = {};

const q = async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;

/** The primary series of a station (its first, by id). */
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

type Run = { issued: number | null; first?: number; last: number; fetched?: number };
/** One run of `source` on a series, with a value at its first and its last valid time. */
async function run(series: number, source: string, o: Run): Promise<void> {
  const first = o.first ?? o.issued ?? (o.fetched as number);
  n += 1;
  const [row] = await q<{ id: string }>(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                               content_hash, kind)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz IS NULL, $4, $5, $6, decode(md5($7::text), 'hex'),
             'deterministic') RETURNING id`,
    [
      series,
      source,
      o.issued === null ? null : iso(o.issued),
      iso(first),
      iso(o.last),
      iso(o.fetched ?? (o.issued as number)),
      `${n}`,
    ],
  );
  await q('INSERT INTO forecast_value (run_id, valid_ts, value) VALUES ($1, $2, 100), ($1, $3, 110)', [
    (row as { id: string }).id,
    iso(first),
    iso(o.last),
  ]);
}

const reach = (doc: ForecastCoverage, id: string) => {
  const r = doc.reaches.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no reach ${id}`);
  return r;
};

beforeAll(async () => {
  h = await harness();
  const a = h.t.admin;
  // The real registry with its river placement, as the `migrate` role syncs it (the harness syncs without it).
  const migrator = h.dbAs('rws_migrator', 1);
  await syncRegistry(migrator.db, readRegistry(), readRiverRegistry());
  await migrator.close();
  await a.query(`SELECT ensure_partitions('2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z')`);
  pub = h.dbAs('rws_api', 2);
  own = h.dbAs('rws_owner_api', 2);

  // Real first-release series.
  ids.lobithQ = await seriesOf('nl.rws.lobith.bovenrijn.tolkamer', 'Q', 'NL-1');
  ids.eijsdenQ = await seriesOf('nl.rws.eijsden.grens', 'Q', 'NL-1');
  ids.nijmegen = await seriesOf('nl.rws.nijmegen.waal', 'H', 'NL-1');
  ids.zaltbommel = await seriesOf('nl.rws.zaltbommel', 'H', 'NL-1');
  ids.kaub = await seriesOf('de.wsv.25700100', 'H', 'DE-1');
  ids.emmerich = await seriesOf('de.wsv.2790020', 'H', 'DE-1');
  ids.koblenz = await seriesOf('de.wsv.25900700', 'H', 'DE-1');
  ids.ruhrort = await seriesOf(RUHRORT_STATION, 'H', 'DE-1');
  ids.diekirch = await seriesOf('lu.age.diekirch', 'H', 'LU-1');
  ids.rosport = await seriesOf('lu.age.rosport', 'H', 'LU-1');

  // NL-1 (public): inferred issue time; Lobith and Eijsden are current, Nijmegen's run ended an hour ago, and
  // Zaltbommel's was fetched after "now" (not known yet).
  await run(ids.lobithQ as number, 'NL-1', { issued: null, fetched: NOW - 2 * HOUR, last: NOW + 40 * HOUR });
  await run(ids.eijsdenQ as number, 'NL-1', { issued: null, fetched: NOW - 2 * HOUR, last: NOW + 40 * HOUR });
  await run(ids.nijmegen as number, 'NL-1', { issued: null, fetched: NOW - 30 * HOUR, last: NOW - HOUR });
  await run(ids.zaltbommel as number, 'NL-1', { issued: null, fetched: NOW + HOUR, last: NOW + 40 * HOUR });
}, 300_000);

afterAll(async () => {
  await pub?.close();
  await own?.close();
  await h?.close();
});

describe('forecastCoverage per family', { timeout: 300_000 }, () => {
  it('the registry pins: RUHRORT_STATION holds the W series of core RUHRORT_W', async () => {
    const rows = await q<{ provider_key: string }>('SELECT provider_key FROM series WHERE id = $1', [ids.ruhrort]);
    expect(rows[0]?.provider_key).toBe(RUHRORT_W);
  });

  let publicBefore: ForecastCoverage;

  it('public: NL-1 covers the stations with a current run, and the report is a valid ForecastCoverage', async () => {
    publicBefore = await forecastCoverage(pub.db, 'public', NOW);
    expect(ForecastCoverage.safeParse(publicBefore).success).toBe(true);
    expect(publicBefore.t).toBe(iso(NOW));
    expect(publicBefore.total).toEqual({ stations: 148, covered: 2 });
    expect(reach(publicBefore, 'dutch-rhine-branches')).toMatchObject({ stations: 18, covered: 1, sources: ['NL-1'] });
    expect(reach(publicBefore, 'grensmaas-dutch-meuse')).toMatchObject({ stations: 9, covered: 1, sources: ['NL-1'] });
    // Nijmegen's run ended, Zaltbommel's is not known yet: neither covers its station.
    expect(reach(publicBefore, 'dutch-rhine-branches').covered).toBe(1);
    const nl = publicBefore.countries.find((c) => c.country === 'NL');
    expect(nl?.covered).toBe(2);
    expect(publicBefore.countries.map((c) => c.country)).toEqual(['BE', 'CH', 'DE', 'FR', 'LU', 'NL']);
    expect(publicBefore.countries.reduce((s, c) => s + c.stations, 0)).toBe(148);
    // The 27 stations of no row are in the total.
    expect(publicBefore.other.stations).toBe(27);
  });

  it('public: the rows with no public source are no_official_forecast, with the agencies that could change it', () => {
    const maxau = reach(publicBefore, 'rhine-maxau-emmerich');
    expect(maxau).toMatchObject({
      stations: 17,
      covered: 0,
      sources: [],
      no_official_forecast: true,
      after_permission: ['LfU RLP'],
      none_publishes: [],
    });
    expect(reach(publicBefore, 'sauer-our')).toMatchObject({
      sources: [],
      no_official_forecast: true,
      after_permission: ['LfU RLP', 'AGE'],
    });
    expect(reach(publicBefore, 'meuse-wallonia')).toMatchObject({
      no_official_forecast: true,
      none_publishes: ['SPW'],
    });
    expect(reach(publicBefore, 'swiss-rhine-aare')).toMatchObject({ sources: ['CH-4'], no_official_forecast: false });
  });

  it('seeds owner runs: DE-2 on public DE-1 series (Kaub, Emmerich current; Koblenz of a missed day) and LU-3 on LU-1', async () => {
    // DE-2: issued 07:00 local; Kaub and Emmerich today, Koblenz on the Friday before (a due Monday has passed).
    const today = Date.parse('2026-10-26T05:00:00Z');
    const friday = Date.parse('2026-10-23T05:00:00Z');
    await run(ids.kaub as number, 'DE-2', { issued: today, fetched: today + 12 * 60_000, last: today + 96 * HOUR });
    await run(ids.emmerich as number, 'DE-2', { issued: today, fetched: today + 12 * 60_000, last: today + 96 * HOUR });
    await run(ids.koblenz as number, 'DE-2', {
      issued: friday,
      fetched: friday + 12 * 60_000,
      last: today + 96 * HOUR,
    });
    // LU-3: Diekirch and Rosport, inferred issue time, 46 hours ahead; nothing for the Mosel.
    for (const s of ['diekirch', 'rosport'])
      await run(ids[s] as number, 'LU-3', { issued: null, fetched: NOW - HOUR, last: NOW + 46 * HOUR });
    expect(await q('SELECT 1 FROM forecast_run WHERE source_id IN ($1, $2)', ['DE-2', 'LU-3'])).toHaveLength(5);
  });

  it('public: unchanged by the owner runs, and it names no owner source, no BfG and no canary', async () => {
    const after = await forecastCoverage(pub.db, 'public', NOW);
    expect(after).toEqual(publicBefore);
    const text = JSON.stringify(after);
    expect(text).not.toMatch(/DE-2|DE-3|LU-2|LU-3|LU-4|BE-3|CANARY|BfG/);
    for (const c of CANARY_RENDERINGS) expect(text).not.toContain(c);
    // AGE (a public provider of LU-1) and SPW (the agency that publishes none) are allowed.
    expect(text).toContain('AGE');
    expect(text).toContain('SPW');
  });

  it('owner: fills Sauer / Sûre, Our (LU-3) and Maxau → Emmerich (DE-2), leaves the Mosel (LU/DE) empty', async () => {
    const owner = await forecastCoverage(own.db, 'owner', NOW);
    expect(ForecastCoverage.safeParse(owner).success).toBe(true);
    expect(reach(owner, 'sauer-our')).toMatchObject({
      stations: 6,
      covered: 2,
      sources: ['LU-3'],
      no_official_forecast: false,
    });
    // Kaub and Emmerich: current. Koblenz: its run is superseded (the Monday deadline passed), so no forecast.
    expect(reach(owner, 'rhine-maxau-emmerich')).toMatchObject({
      stations: 17,
      covered: 2,
      sources: ['DE-2', 'DE-3'],
      no_official_forecast: false,
    });
    expect(reach(owner, 'mosel-lu-de')).toMatchObject({
      stations: 9,
      covered: 0,
      sources: [],
      no_official_forecast: true,
    });
    // NL-1 as in the public report; the total gains the owner runs.
    expect(reach(owner, 'dutch-rhine-branches')).toMatchObject({ covered: 1, sources: ['NL-1'] });
    expect(owner.total).toEqual({ stations: 148, covered: 6 });
  });

  it('the denominator is the same in both families: the same stations per country, reach and other', async () => {
    const [p, o] = [await forecastCoverage(pub.db, 'public', NOW), await forecastCoverage(own.db, 'owner', NOW)];
    expect(o.total.stations).toBe(p.total.stations);
    expect(o.other.stations).toBe(p.other.stations);
    expect(o.countries.map((c) => [c.country, c.stations])).toEqual(p.countries.map((c) => [c.country, c.stations]));
    expect(o.reaches.map((r) => [r.id, r.stations])).toEqual(p.reaches.map((r) => [r.id, r.stations]));
    // Owner-only stations (BE-3, LU-2) are not first-release and never count.
    expect(p.total.stations).toBe(148);
  });

  it('a DE-2 run on a weekend is current while Ruhrort stands at 4 m or more or is unknown, superseded below 4 m', async () => {
    // The Friday run of Kaub reaches the weekend; "now" is Saturday afternoon.
    const friday = Date.parse('2026-10-30T05:00:00Z');
    await run(ids.kaub as number, 'DE-2', { issued: friday, fetched: friday + 12 * 60_000, last: friday + 96 * HOUR });
    const covered = async () =>
      reach(await forecastCoverage(own.db, 'owner', SATURDAY), 'rhine-maxau-emmerich').covered;
    // Ruhrort unknown (no observation): a Saturday is not due, the held run is the latest.
    expect(await covered()).toBe(1);
    // 450 cm at Ruhrort 10 minutes ago: still not due.
    await q('INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 450, 0, 1)', [
      ids.ruhrort,
      iso(SATURDAY - 10 * 60_000),
    ]);
    expect(await covered()).toBe(1);
    // 350 cm: the Saturday run is due by 12:00 Berlin and did not come, so the Friday run is no forecast any more.
    await q('UPDATE obs_latest SET value = 350 WHERE series_id = $1', [ids.ruhrort]);
    expect(await covered()).toBe(0);
    // A value older than the series' staleness limit says nothing: silence again.
    await q('UPDATE obs_latest SET ts = $2 WHERE series_id = $1', [ids.ruhrort, iso(SATURDAY - 3 * 24 * HOUR)]);
    expect(await covered()).toBe(1);
    // The public family never sees DE-2 runs, whatever Ruhrort says.
    expect(reach(await forecastCoverage(pub.db, 'public', SATURDAY), 'rhine-maxau-emmerich').covered).toBe(0);
  });

  it('the denominator is the stations with a public primary series: nothing owner-only or off is counted', async () => {
    const o = await forecastCoverage(own.db, 'owner', NOW);
    const rows = await q<{ n: number }>(
      `SELECT count(DISTINCT st.id)::int AS n FROM station st
       JOIN series s ON s.station_id = st.id AND s.active JOIN series_eff e ON e.series_id = s.id
       WHERE st.tier = 1 AND e.audience = 'public' AND e.role = 'primary' AND e.lic_display`,
    );
    expect(o.total.stations).toBe(rows[0]?.n);
  });
});

describe('GET /api/v1/health/sources', { timeout: 300_000 }, () => {
  it('carries the public forecast coverage as the contract document, the same as the function', async () => {
    const app = createApp({ db: pub.db, now: () => new Date(NOW) });
    const res = await app.request('/api/v1/health/sources');
    expect(res.status).toBe(200);
    const doc = HealthSources.parse(await res.json());
    expect(doc.forecast_coverage).toEqual(await forecastCoverage(pub.db, 'public', NOW));
    expect(doc.forecast_coverage?.reaches).toHaveLength(15);
    // A source's `forecast` is null when it has stored no run (health was not computed here).
    expect(doc.sources.every((s) => s.forecast === null)).toBe(true);
  });
});
