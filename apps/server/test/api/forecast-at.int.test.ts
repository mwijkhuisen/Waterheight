import {
  CANARIES,
  CANARY_RENDERINGS,
  MetaAnswer,
  SeriesForecast,
  SeriesForecastAnswer,
  Snapshot,
  SnapshotAnswer,
} from '@rws/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { forecastCoverage, visibleSources } from '../../src/api/forecast.ts';
import { forecastHorizons, readFutureSnapshot, readSeriesForecast } from '../../src/api/forecast-at.ts';
import { lu3Limits } from '../../src/api/forecast-latest.ts';
import { readStates } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { readRegistry, readRiverRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import { type Harness, harness } from '../load/harness.ts';

// The forecast slider's reads through the real database roles (P8b, A§8 Q2, A§9.2): the future snapshot and
// /series/{id}/forecast for the public family (read as `rws_api`) and the owner family (`rws_owner_api`), over runs
// seeded as the superuser on real registry series, and the public HTTP routes on a fixed clock. The rules under test:
// the latest run known at now's 10-minute bucket (never a newer one, never an older one that reaches further), one
// source per series by precedence, its value held at the greatest valid time at or before t, classified against
// references only, and no owner run, no owner canary and no withheld canary in any public answer.

const T = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;
const TEN = 600_000;
// Monday 2026-10-05, 11:00 in Berlin: DE-2's Friday run is still current (Monday's deadline is 10:00Z).
const NOW = T('2026-10-05T09:00:00Z');
const FRIDAY = '2026-10-02T05:00:00Z';
const SECTIONS = vigicruesSections();
const OWNER_SOURCES = ['DE-2', 'DE-3', 'LU-3', 'CANARY'];

let h: Harness;
let pub: ReturnType<Harness['dbAs']>;
let own: ReturnType<Harness['dbAs']>;
let display: DisplayWindow;
const id: Record<string, number> = {};
const station: Record<string, string> = {};

const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;

async function seriesOf(st: string, quantity: 'H' | 'Q', source: string): Promise<number> {
  const rows = await q<{ id: number }>(
    `SELECT id FROM series WHERE station_id = $1 AND quantity = $2 AND source_id = $3 AND role = 'primary' AND active
     ORDER BY id LIMIT 1`,
    [st, quantity, source],
  );
  if (rows[0] === undefined) throw new Error(`no series ${st} ${quantity} ${source}`);
  return rows[0].id;
}

const COLUMNS = ['value', 'p10', 'p25', 'p30', 'p50', 'p70', 'p75', 'p90', 'vmin', 'vmax'] as const;
type Pt = { ts: string; flags?: number } & Partial<Record<(typeof COLUMNS)[number], number | null>>;
let runs = 0;

/** One run and its points (the superuser writes the base tables); `issued` null is an inferred issue time. */
async function seedRun(o: {
  series: number;
  source: string;
  issued: string | null;
  fetched: string;
  kind: 'deterministic' | 'quantiles' | 'ensemble_summary';
  stepS: number | null;
  segmentEnd?: string;
  points: Pt[];
}): Promise<string> {
  const first = o.points[0]?.ts;
  const last = o.points.at(-1)?.ts;
  runs += 1;
  const [run] = await q<{ id: string }>(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                               content_hash, kind, step, provider_segment_end)
     VALUES ($1::int, $2::text, COALESCE($3::timestamptz, $4::timestamptz), $3::timestamptz IS NULL, $5::timestamptz,
             $6::timestamptz, $4::timestamptz, decode(md5($7::text), 'hex'), $8::text,
             make_interval(secs => $9::int), $10::timestamptz)
     RETURNING id::text AS id`,
    [o.series, o.source, o.issued, o.fetched, first, last, `run ${runs}`, o.kind, o.stepS, o.segmentEnd ?? null],
  );
  const runId = (run as { id: string }).id;
  const args: unknown[] = [runId];
  const rows = o.points.map((p) => {
    const at = args.length;
    args.push(p.ts, ...COLUMNS.map((c) => p[c] ?? null), p.flags ?? 0);
    return `($1::bigint, ${Array.from({ length: COLUMNS.length + 2 }, (_, i) => `$${at + i + 1}`).join(', ')})`;
  });
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, ${COLUMNS.join(', ')}, flags) VALUES ${rows.join(', ')}`,
    args,
  );
  return runId;
}

/** n points every `stepMs` from `from`; `at` makes the columns of point i. */
const grid = (
  from: string,
  n: number,
  stepMs: number,
  at: (i: number, ts: number) => Omit<Pt, 'ts'> = () => ({}),
): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const ts = T(from) + i * stepMs;
    return { ts: iso(ts), value: 100 + i, ...at(i, ts) };
  });

type RefSpec = { period?: string; label?: string; priority?: number; from?: string };
const ref = (series: number, source: string, kind: string, value: number, semantics: string, o: RefSpec = {}) =>
  q(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, period, priority, basis_label, valid)
     VALUES ($1, $2, $3, $4, 'cm', $5, $6::daterange, $7, $8, tstzrange($9::timestamptz, NULL))`,
    [
      series,
      source,
      kind,
      value,
      semantics,
      o.period ?? null,
      o.priority ?? 0,
      o.label ?? null,
      o.from ?? '2020-01-01',
    ],
  );

/** Every body this file received over HTTP and every public read, scanned for leaks at the end. */
const publicTexts: { label: string; text: string }[] = [];
const keep = <V>(label: string, value: V): V => {
  publicTexts.push({ label, text: JSON.stringify(value) });
  return value;
};

const optsAt = (now: number) => ({ now, sections: SECTIONS });
const futurePub = async (t: number, now = NOW) =>
  keep(`public ${iso(t)}`, await readFutureSnapshot(pub.db, 'public', t, optsAt(now)));
const futureOwn = (t: number, now = NOW, extra: { limitsH?: ReadonlyMap<string, number> } = {}) =>
  readFutureSnapshot(own.db, 'owner', t, { ...optsAt(now), ...extra });
const entry = <F extends { series: number }>(snap: { forecasts?: F[] | undefined }, series: number): F | undefined =>
  (snap.forecasts ?? []).find((f) => f.series === series);
const seriesIn = (snap: { forecasts?: { series: number }[] | undefined }) =>
  (snap.forecasts ?? []).map((f) => f.series);
const byId = (ids: number[]) => [...ids].sort((a, b) => a - b);

beforeAll(async () => {
  h = await harness();
  const a = h.t.admin;
  // The real registry with its river placement, as the `migrate` role syncs it (the coverage reads it).
  const migrator = h.dbAs('rws_migrator', 1);
  await syncRegistry(migrator.db, readRegistry(), readRiverRegistry());
  await migrator.close();
  await a.query(`SELECT ensure_partitions('2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z')`);
  await a.query(`UPDATE app_meta SET value = to_jsonb('2026-10-01T00:00:00Z'::text) WHERE key = 'display_start'`);
  pub = h.dbAs('rws_api', 4);
  own = h.dbAs('rws_owner_api', 2);
  display = new DisplayWindow(pub.db);
  expect(await display.refresh()).toBe(true);

  // Real registry series.
  id.lobithQ = await seriesOf('nl.rws.lobith.bovenrijn.tolkamer', 'Q', 'NL-1');
  id.eijsdenQ = await seriesOf('nl.rws.eijsden.grens', 'Q', 'NL-1');
  id.zaltbommel = await seriesOf('nl.rws.zaltbommel', 'H', 'NL-1');
  id.kaub = await seriesOf('de.wsv.25700100', 'H', 'DE-1');
  id.emmerich = await seriesOf('de.wsv.2790020', 'H', 'DE-1');
  id.koeln = await seriesOf('de.wsv.2730010', 'H', 'DE-1');
  id.koblenz = await seriesOf('de.wsv.25900700', 'H', 'DE-1');
  id.diekirch = await seriesOf('lu.age.diekirch', 'H', 'LU-1');
  const more = await q<{ id: number; station_id: string; quantity: string }>(
    `SELECT s.id, s.station_id, s.quantity FROM series s JOIN series_eff e ON e.series_id = s.id
     JOIN station st ON st.id = s.station_id
     WHERE s.source_id = 'NL-1' AND s.active AND e.role = 'primary' AND e.audience = 'public'
       AND NOT EXISTS (SELECT 1 FROM reference_value r WHERE r.series_id = s.id)
       AND s.id <> ALL($1) AND COALESCE((st.flags->>'tidal')::boolean, false) = false
     ORDER BY s.quantity DESC, s.id`,
    [[id.lobithQ, id.eijsdenQ, id.zaltbommel]],
  );
  const plain = more.filter((r) => r.quantity === 'H');
  id.band = (plain[0] as { id: number }).id;
  id.later = (plain[1] as { id: number }).id;
  id.soon = (plain[2] as { id: number }).id;
  id.noRun = (more.find((r) => r.quantity === 'Q') as { id: number }).id;
  // A CH-1 discharge series and a CH-1 stage series that no discharge series shares (a CH-5 river area attaches to it).
  const chq = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     WHERE e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'Q' AND s.active
     ORDER BY e.series_id LIMIT 1`,
  );
  const chw = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     WHERE e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.active
       AND e.station_id ~ '^ch\\.bafu\\.[0-9]+$' AND NOT EXISTS
         (SELECT 1 FROM series x WHERE x.station_id = e.station_id AND x.quantity = 'Q' AND x.active)
     ORDER BY e.series_id LIMIT 1`,
  );
  id.chq = (chq[0] as { id: number }).id;
  station.chq = (chq[0] as { station_id: string }).station_id;
  id.chw = (chw[0] as { id: number }).id;
  station.chw = (chw[0] as { station_id: string }).station_id;
  station.kaub = 'de.wsv.25700100';

  // The two canaries on stations of their own (the real registry holds neither).
  await a.query(`INSERT INTO station (id, name, country, tier) VALUES ('nl.canary.owner', 'owner canary', 'NL', 2),
                                                                      ('nl.canary.withheld', 'withheld canary', 'NL', 2)`);
  for (const [key, st, source, audience] of [
    ['canaryOwner', 'nl.canary.owner', 'CANARY-OWNER', null],
    ['canaryWithheld', 'nl.canary.withheld', 'NL-1', 'off'],
  ] as const) {
    const [row] = await q<{ id: number }>(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, audience)
       VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary', $4::audience)
       RETURNING id`,
      [st, source, key, audience],
    );
    id[key] = (row as { id: number }).id;
  }

  // References: an NL-4 band [200, 300) on an NL-1 stage series without references, one that starts only on 2026-10-06 12:00Z on another NL-1 stage
  // series, and Kaub's WSV levels; a DE-6 gauge class on Kaub, a CH-1 gauge class on the CH-1 discharge series and a
  // CH-5 river area on the CH-1 stage series: the three things a forecast must not be classified by.
  const band = (series: number, from?: string) =>
    Promise.all([
      ref(series, 'NL-4', 'NL4_FROM', 200, 'provider_class', {
        label: 'Hoogwater (>200cm)',
        priority: 1,
        ...(from && { from }),
      }),
      ref(series, 'NL-4', 'NL4_TO', 300, 'provider_class', {
        label: 'Hoogwater (>200cm)',
        priority: 1,
        ...(from && { from }),
      }),
    ]);
  await band(id.band as number);
  await band(id.later as number, '2026-10-06T12:00:00Z');
  const period = '[2010-11-01,2020-11-01)';
  await ref(id.kaub as number, 'DE-1', 'MNW', 65, 'statistical', { period });
  await ref(id.kaub as number, 'DE-1', 'MHW', 544, 'statistical', { period });
  await ref(id.kaub as number, 'DE-1', 'HSW', 640, 'operational', { period });
  await a.query(
    `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, level_norm) VALUES
       ('station', $1, '2026-10-01T00:00:00Z', 'DE-6', 'RP:0', 2),
       ('station', $2, '2026-10-01T00:00:00Z', 'CH-1', '3', 4)`,
    [station.kaub, station.chq],
  );
  await a.query(
    `INSERT INTO warning_area (source_id, area_key, name, level_norm, level_raw, valid)
     VALUES ('CH-5', $1, 'Test section', 3, '2', tstzrange('2026-10-01T00:00:00Z', NULL))`,
    [`river:${station.chw?.slice('ch.bafu.'.length)}`],
  );
  // Kaub's observation (the present reading the class would colour) and fresh fetches of the class sources.
  await a.query(`INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, '2026-10-05T08:50:00Z', 600, 1, 1)`, [
    id.kaub,
  ]);
  for (const source of ['DE-6', 'CH-1', 'CH-5', 'DE-1', 'NL-1'])
    await a.query(
      `INSERT INTO source_health (source_id, status, last_fetch_ok) VALUES ($1, 'ok', $2)
       ON CONFLICT (source_id) DO UPDATE SET last_fetch_ok = EXCLUDED.last_fetch_ok`,
      [source, iso(NOW - 5 * 60_000)],
    );

  // --- Public runs ---------------------------------------------------------------------------------------------
  // Lobith: run A of 06:25Z (inferred issue time), 10-minute steps for 47 hours: value 1000 + the step index.
  // Run B was fetched at 09:20Z, after now: no read at NOW knows it.
  await seedRun({
    series: id.lobithQ as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:20:00Z', 6 * 47, TEN, (i) => ({ value: 1000 + i })),
  });
  await seedRun({
    series: id.lobithQ as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T09:20:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T09:10:00Z', 240, TEN, (i) => ({ value: 2000 + i })),
  });
  // Eijsden: O1 reaches two days ahead; the run fetched at 08:00Z (O2) is the latest known and ends at 12:00Z.
  await seedRun({
    series: id.eijsdenQ as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:20:00Z', 6 * 47, TEN, (i) => ({ value: 3000 + i })),
  });
  await seedRun({
    series: id.eijsdenQ as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T08:00:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T07:50:00Z', 26, TEN, (i) => ({ value: 4000 + i })),
  });
  // Zaltbommel: Z of 06:25Z; Z2 fetched at 09:05Z (inside the 09:00 bucket: unknown to a read at 09:07); Z3 with a
  // stated issue time of 09:30Z fetched at 08:50Z (unknown before 09:30).
  const zalt = (fetched: string, issued: string | null, start: string, base: number) =>
    seedRun({
      series: id.zaltbommel as number,
      source: 'NL-1',
      issued,
      fetched,
      kind: 'deterministic',
      stepS: 600,
      points: grid(start, 6 * 40, TEN, (i) => ({ value: base + i })),
    });
  await zalt('2026-10-05T06:25:00Z', null, '2026-10-05T06:20:00Z', 5000);
  await zalt('2026-10-05T09:05:00Z', null, '2026-10-05T09:00:00Z', 6000);
  await zalt('2026-10-05T08:50:00Z', '2026-10-05T09:30:00Z', '2026-10-05T09:30:00Z', 7000);
  // band: 100 until 12:00Z, 250 until 18:00Z, then 350. "later": 250 throughout.
  const stepped = (ts: number) => (ts < T('2026-10-05T12:00:00Z') ? 100 : ts < T('2026-10-05T18:00:00Z') ? 250 : 350);
  await seedRun({
    series: id.band as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:20:00Z', 6 * 47, TEN, (_, ts) => ({ value: stepped(ts) })),
  });
  await seedRun({
    series: id.later as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:20:00Z', 6 * 47, TEN, () => ({ value: 250 })),
  });
  // A run whose values begin only on the 6th (FR-4: the first value can be a day after the production time).
  await seedRun({
    series: id.soon as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 3600,
    points: grid('2026-10-06T00:00:00Z', 13, H, (i) => ({ value: 700 + i })),
  });
  // Kaub: a public run on a series that has WSV levels, a DE-6 class and an observation of 600 cm at 08:50Z.
  await seedRun({
    series: id.kaub as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:20:00Z', 6 * 47, TEN, (_, ts) => ({ value: ts < T('2026-10-05T12:00:00Z') ? 9 : 600 })),
  });
  // CH-4 (BAFU, public) on CH-1 series: hourly for five days, p25-p75 with the ensemble minimum and maximum.
  const bafu = (series: number) =>
    seedRun({
      series,
      source: 'CH-4',
      issued: null,
      fetched: '2026-10-05T07:40:00Z',
      kind: 'ensemble_summary',
      stepS: 3600,
      points: grid('2026-10-05T07:00:00Z', 120, H, (i) => ({
        value: 100 + i,
        p25: 90 + i,
        p75: 110 + i,
        vmin: 80 + i,
        vmax: 120 + i,
      })),
    });
  await bafu(id.chq as number);
  await bafu(id.chw as number);

  // --- Owner runs on public series -------------------------------------------------------------------------------
  // Emmerich: DE-2's Friday run (49 points two hours apart to Tuesday 05:00Z; the owner canary at Monday 09:00Z; the
  // provider's own segment ends Monday 12:00Z) and a DE-3 run of the morning (daily means for fifteen days).
  await seedRun({
    series: id.emmerich as number,
    source: 'DE-2',
    issued: FRIDAY,
    fetched: '2026-10-02T05:12:00Z',
    kind: 'deterministic',
    stepS: 7200,
    segmentEnd: '2026-10-05T12:00:00Z',
    points: grid(FRIDAY, 49, 2 * H, (i) => ({ value: i === 38 ? CANARIES.owner.value : 300 + i })),
  });
  const de3 = (series: number, base: number) =>
    seedRun({
      series,
      source: 'DE-3',
      issued: null,
      fetched: '2026-10-05T07:00:00Z',
      kind: 'quantiles',
      stepS: 86_400,
      points: grid('2026-10-05T00:00:00Z', 15, 24 * H, (i) => ({
        value: base + i,
        p10: base - 20 + i,
        p25: base - 10 + i,
        p50: base + i,
        p75: base + 10 + i,
        p90: base + 20 + i,
      })),
    });
  await de3(id.emmerich as number, 500);
  await de3(id.koeln as number, 800);
  // Diekirch: LU-3's 46 hourly steps from 06:00Z with a band; the point at 11:00Z is below the provider's floor.
  await seedRun({
    series: id.diekirch as number,
    source: 'LU-3',
    issued: null,
    fetched: '2026-10-05T07:45:00Z',
    kind: 'quantiles',
    stepS: 3600,
    points: grid('2026-10-05T06:00:00Z', 46, H, (i) => ({
      value: i === 5 ? 55 : 50 + i,
      p10: 40 + i,
      p30: 45 + i,
      p50: 50 + i,
      p70: 55 + i,
      p90: 60 + i,
      flags: i === 5 ? 1024 : 0,
    })),
  });
  // The owner canary's own source on its own series (forty hours), and the withheld canary on an `off` series.
  await seedRun({
    series: id.canaryOwner as number,
    source: 'CANARY-OWNER',
    issued: null,
    fetched: '2026-10-05T06:30:00Z',
    kind: 'deterministic',
    stepS: 3600,
    points: grid('2026-10-05T06:00:00Z', 40, H, () => ({ value: CANARIES.owner.value })),
  });
  await seedRun({
    series: id.canaryWithheld as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:30:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:00:00Z', 6 * 40, TEN, () => ({ value: CANARIES.withheld.value })),
  });
}, 300_000);

afterAll(async () => {
  await pub?.close();
  await own?.close();
  await h?.close();
});

describe('the future snapshot, public family', { timeout: 120_000 }, () => {
  it('holds the value of the greatest valid time at or before t: never interpolated, with its provenance', async () => {
    const t = T('2026-10-05T09:35:00Z');
    const snap = await futurePub(t);
    expect(Snapshot.safeParse(snap).success).toBe(true);
    expect(snap.t).toBe(iso(t));
    // observations stop at now: no value, though Kaub has an observation a few minutes old
    expect(snap.values).toEqual([]);
    const f = entry(snap, id.lobithQ as number);
    expect(f).toMatchObject({
      series: id.lobithQ,
      source: 'NL-1',
      agency: 'RWS',
      // 06:20 + 19 steps: the point at 09:30 holds until the one at 09:40 (1019 now, 1020 then)
      ts: '2026-10-05T09:30:00.000Z',
      value: 1019,
      flags: 0,
      estimate: false,
      issuedAt: '2026-10-05T06:25:00.000Z',
      issuedInferred: true,
      providerSegmentEnd: null,
      band: null,
      // the run's own end (06:20 + 46 h 50 min), earlier than now + 48 h
      horizonEnd: '2026-10-07T05:10:00.000Z',
    });
    // a discharge forecast is classified against RWS Waterinfo's discharge classes for Lobith (a reference row of the
    // registry): 1019 m3/s is "Normaal", as an observation of that value would be
    expect(f).toMatchObject({
      state: 'normal',
      basis: { source: 'NL-4', kind: 'provider_class', measure: 'discharge' },
    });
    for (const [at, value] of [
      ['2026-10-05T09:30:00Z', 1019],
      ['2026-10-05T09:39:59Z', 1019],
      ['2026-10-05T09:40:00Z', 1020],
      ['2026-10-05T09:10:00Z', 1017],
    ] as const)
      expect(entry(await futurePub(T(at)), id.lobithQ as number)?.value, at).toBe(value);
  });

  it('shows only the series that have a public run reaching t: no owner run, no run of a series without one', async () => {
    const snap = await futurePub(T('2026-10-05T09:35:00Z'));
    const want = ['lobithQ', 'eijsdenQ', 'band', 'zaltbommel', 'kaub', 'later', 'chq', 'chw'].map(
      (k) => id[k] as number,
    );
    expect(seriesIn(snap)).toEqual(byId(want));
    // a series without a run is absent, and so is every series that only an owner source forecasts
    for (const key of ['noRun', 'emmerich', 'koeln', 'diekirch', 'canaryOwner', 'canaryWithheld'])
      expect(seriesIn(snap), key).not.toContain(id[key]);
    const text = JSON.stringify(snap);
    for (const word of [...OWNER_SOURCES, 'BfG', 'AGE']) expect(text, word).not.toContain(word);
    for (const rendering of CANARY_RENDERINGS) expect(text, rendering).not.toContain(rendering);
    // CH-4 on CH-1 series: BAFU's p25-p75 band, the held point 09:00 (index 2)
    expect(entry(snap, id.chq as number)).toMatchObject({
      source: 'CH-4',
      agency: 'BAFU',
      ts: '2026-10-05T09:00:00.000Z',
      value: 102,
      band: { kind: 'p25p75', lo: 92, hi: 112 },
      issuedAt: '2026-10-05T07:40:00.000Z',
      issuedInferred: true,
      // five days of run, capped at now + 48 h
      horizonEnd: iso(NOW + 48 * H),
    });
  });

  it('is empty where no run reaches t, and a run that ended is not replaced by an older one that reaches further', async () => {
    // Eijsden: O2 (fetched 08:00Z) is the latest known and ends at 12:00Z; O1 reaches two days but is not shown
    const at = async (when: string) => entry(await futurePub(T(when)), id.eijsdenQ as number);
    expect(await at('2026-10-05T11:05:00Z')).toMatchObject({ ts: '2026-10-05T11:00:00.000Z', value: 4000 + 19 });
    expect(await at('2026-10-05T12:00:00Z')).toMatchObject({ value: 4000 + 25 });
    expect(await at('2026-10-05T12:10:00Z')).toBeUndefined();
    expect(await at('2026-10-05T15:00:00Z')).toBeUndefined();
    expect(await at('2026-10-06T12:00:00Z')).toBeUndefined();
  });

  it('holds no value before the first valid time of a run, though the run is the latest known', async () => {
    const at = async (when: string) => entry(await futurePub(T(when)), id.soon as number);
    expect(await at('2026-10-05T12:00:00Z')).toBeUndefined();
    expect(await at('2026-10-05T23:50:00Z')).toBeUndefined();
    expect(await at('2026-10-06T00:00:00Z')).toMatchObject({ ts: '2026-10-06T00:00:00.000Z', value: 700 });
    expect(await at('2026-10-06T05:30:00Z')).toMatchObject({ ts: '2026-10-06T05:00:00.000Z', value: 705 });
    expect(await at('2026-10-06T12:00:00Z')).toMatchObject({ value: 712 });
    expect(await at('2026-10-06T12:10:00Z')).toBeUndefined();
  });

  it('shows nothing past now + 48 h, and the run of a longer source is cut there', async () => {
    const last = iso(NOW + 48 * H);
    const snap = await futurePub(NOW + 48 * H);
    // Lobith's A ended at 05:10Z of the 7th, CH-4 reaches five days: only CH-4 is shown at the boundary
    expect(seriesIn(snap)).toEqual(byId([id.chq as number, id.chw as number]));
    expect(entry(snap, id.chq as number)).toMatchObject({ ts: last, horizonEnd: last });
    // one step beyond: out of this function's contract (the route refuses it), and no run is held past it
    expect(seriesIn(await futurePub(NOW + 48 * H + TEN))).toEqual([]);
  });

  it('does not use a run issued or first fetched after the bucket of now, and uses it from the next bucket on', async () => {
    const z = async (now: string, t: string) => entry(await futurePub(T(t), T(now)), id.zaltbommel as number);
    const t = '2026-10-05T09:40:00Z';
    // 09:07: bucket 09:00. Z2 was fetched at 09:05 (after the bucket start): unknown. Z3 states 09:30: unknown.
    expect(await z('2026-10-05T09:07:00Z', t)).toMatchObject({
      value: 5000 + 20,
      issuedAt: '2026-10-05T06:25:00.000Z',
    });
    // 09:12: bucket 09:10 knows Z2 (and now Z2 is the latest known run: its value at 09:40 is 6004)
    expect(await z('2026-10-05T09:12:00Z', t)).toMatchObject({ value: 6000 + 4, issuedAt: '2026-10-05T09:05:00.000Z' });
    // 09:25 (bucket 09:20): Z3's stated issue time 09:30 is still ahead; 09:35 (bucket 09:30) knows it
    expect(await z('2026-10-05T09:25:00Z', t)).toMatchObject({ value: 6000 + 4 });
    expect(await z('2026-10-05T09:35:00Z', t)).toMatchObject({
      // Z3 is the latest by its issue time (09:30), though it was fetched first: its point at 09:40 is its second
      value: 7000 + 1,
      issuedAt: '2026-10-05T09:30:00.000Z',
      issuedInferred: false,
    });
    // Lobith: B (fetched 09:20) is not known at NOW and is the run from 09:20 on
    const lobith = async (now: string) =>
      entry(await futurePub(T('2026-10-05T09:40:00Z'), T(now)), id.lobithQ as number);
    expect(await lobith('2026-10-05T09:00:00Z')).toMatchObject({ value: 1020, issuedAt: '2026-10-05T06:25:00.000Z' });
    expect(await lobith('2026-10-05T09:19:59Z')).toMatchObject({ value: 1020 });
    expect(await lobith('2026-10-05T09:20:00Z')).toMatchObject({ value: 2003, issuedAt: '2026-10-05T09:20:00.000Z' });
    // before any run was fetched there is no forecast at all
    expect(seriesIn(await futurePub(T('2026-10-05T07:00:00Z'), T('2026-10-05T06:00:00Z')))).toEqual([]);
  });

  it('shows an inactive series nowhere, and the display channel still shows a series whose api channel is off', async () => {
    const t = T('2026-10-05T09:35:00Z');
    await q(`UPDATE series SET lic_override = '{"api": false}'::jsonb WHERE id = $1`, [id.zaltbommel]);
    try {
      expect(seriesIn(await futurePub(t))).toContain(id.zaltbommel);
    } finally {
      await q('UPDATE series SET lic_override = NULL WHERE id = $1', [id.zaltbommel]);
    }
    await q('UPDATE series SET active = false WHERE id = $1', [id.zaltbommel]);
    try {
      expect(seriesIn(await futurePub(t))).not.toContain(id.zaltbommel);
    } finally {
      await q('UPDATE series SET active = true WHERE id = $1', [id.zaltbommel]);
    }
    expect(seriesIn(await futurePub(t))).toContain(id.zaltbommel);
  });
});

describe('classification of a forecast value', { timeout: 120_000 }, () => {
  const state = async (series: number, at: string, now = NOW) => {
    const f = entry(await futurePub(T(at), now), series);
    expect(f, `${series} ${at}`).toBeDefined();
    return { state: f?.state, basis: f?.basis, value: f?.value };
  };

  it('a value inside an agency band gets that band as state and basis; outside it no reference decides', async () => {
    expect(await state(id.band as number, '2026-10-05T10:00:00Z')).toEqual({
      state: 'no_ref',
      basis: null,
      value: 100,
    });
    expect(await state(id.band as number, '2026-10-05T13:00:00Z')).toMatchObject({
      state: 'high',
      value: 250,
      basis: { source: 'NL-4', kind: 'provider_class', label: 'Hoogwater (>200cm)' },
    });
    // above the band's upper bound (300) it is not the band either
    expect(await state(id.band as number, '2026-10-05T19:00:00Z')).toEqual({
      state: 'no_ref',
      basis: null,
      value: 350,
    });
  });

  it('uses the references valid at t: a band that starts on the 6th at 12:00Z does not classify a value before it', async () => {
    expect(await state(id.later as number, '2026-10-06T00:00:00Z')).toMatchObject({
      state: 'no_ref',
      basis: null,
      value: 250,
    });
    expect(await state(id.later as number, '2026-10-06T11:50:00Z')).toMatchObject({ state: 'no_ref' });
    expect(await state(id.later as number, '2026-10-06T12:00:00Z')).toMatchObject({
      state: 'high',
      basis: { source: 'NL-4', kind: 'provider_class' },
    });
    expect(await state(id.later as number, '2026-10-07T03:00:00Z')).toMatchObject({ state: 'high' });
  });

  it('classifies a value against the WSV levels of its series: below MNW is low, above MHW is elevated', async () => {
    const low = await state(id.kaub as number, '2026-10-05T10:00:00Z');
    expect(low).toMatchObject({ state: 'low', value: 9 });
    expect(low.basis).toMatchObject({
      source: 'DE-1',
      kind: 'statistical',
      measure: 'stage',
      label: 'WSV MNW 2010–2020',
    });
    const high = await state(id.kaub as number, '2026-10-05T13:00:00Z');
    expect(high).toMatchObject({ state: 'elevated', value: 600 });
    expect(high.basis).toMatchObject({
      source: 'DE-1',
      kind: 'statistical',
      measure: 'stage',
      label: 'WSV MHW 2010–2020',
    });
  });

  it('never uses a provider class or an area: what colours the present reading is ignored for a forecast', async () => {
    const present = await readStates(pub.db, 'public', NOW, { now: NOW, current: true, sections: SECTIONS });
    const now = (series: number) => present.series.find((s) => s.series === series)?.classified;
    // Present reading, 600 cm at Kaub with the DE-6 class RP:0 current: the class decides (normal) ...
    expect(now(id.kaub as number)).toMatchObject({ state: 'normal', basis: { source: 'DE-6', kind: 'operational' } });
    // ... and a forecast of the same 600 cm is classified by the WSV references alone: elevated, on MHW
    expect(await state(id.kaub as number, '2026-10-05T13:00:00Z')).toMatchObject({
      state: 'elevated',
      value: 600,
      basis: { source: 'DE-1', kind: 'statistical' },
    });
    // CH-1's gauge class 3 (high) on the discharge series and the CH-5 river area on the stage series colour the
    // present reading too; neither is used for a forecast, and nothing is guessed in their place
    expect(now(id.chq as number)?.state).toBe('high');
    expect(now(id.chw as number)).toMatchObject({ section: true });
    expect(await state(id.chq as number, '2026-10-05T10:00:00Z')).toEqual({ state: 'no_ref', basis: null, value: 103 });
    expect(await state(id.chw as number, '2026-10-05T10:00:00Z')).toEqual({ state: 'no_ref', basis: null, value: 103 });
  });
});

describe('the future snapshot, owner family', { timeout: 120_000 }, () => {
  const LU3_LIMIT = new Map([['lu.age.diekirch', 24]]);

  it('shows DE-2 where DE-2 and DE-3 both forecast the series, with its estimate marks and the owner canary', async () => {
    const snap = await futureOwn(T('2026-10-05T09:30:00Z'));
    const f = entry(snap, id.emmerich as number);
    expect(f).toMatchObject({
      source: 'DE-2',
      agency: 'BfG',
      ts: '2026-10-05T09:00:00.000Z',
      value: Number(CANARIES.owner.real),
      issuedAt: FRIDAY.replace('Z', '.000Z'),
      issuedInferred: false,
      providerSegmentEnd: '2026-10-05T12:00:00.000Z',
      estimate: false,
      band: null,
      // the run ends Tuesday 05:00Z, before now + 48 h
      horizonEnd: '2026-10-06T05:00:00.000Z',
    });
    // the owner family sees the canary, in the DE-2 run on a public series
    expect(JSON.stringify(snap)).toContain(CANARIES.owner.real);
    // after the provider's own segment: an estimate, still DE-2
    const later = entry(await futureOwn(T('2026-10-05T15:30:00Z')), id.emmerich as number);
    expect(later).toMatchObject({ source: 'DE-2', ts: '2026-10-05T15:00:00.000Z', value: 300 + 41, estimate: true });
    expect(later?.band).toBeNull();
  });

  it('shows DE-3 alone where only DE-3 forecasts: daily means, the p10-p90 band, the 15-day run cut at now + 48 h', async () => {
    const f = entry(await futureOwn(T('2026-10-06T20:00:00Z')), id.koeln as number);
    expect(f).toMatchObject({
      source: 'DE-3',
      agency: 'BfG',
      ts: '2026-10-06T00:00:00.000Z',
      value: 801,
      band: { kind: 'p10p90', lo: 781, hi: 821 },
      issuedAt: '2026-10-05T07:00:00.000Z',
      issuedInferred: true,
      estimate: false,
      horizonEnd: iso(NOW + 48 * H),
    });
    // DE-3's value is held to the end of the 48 hours: the point of the 7th at 00:00Z holds until 09:00Z
    expect(entry(await futureOwn(NOW + 48 * H), id.koeln as number)).toMatchObject({
      ts: '2026-10-07T00:00:00.000Z',
      value: 802,
    });
    expect(entry(await futureOwn(NOW + 48 * H + TEN), id.koeln as number)).toBeUndefined();
  });

  it('falls back to DE-3 where DE-2 ended before t, and where its Monday deadline passed without a new run', async () => {
    // DE-2 ends Tuesday 05:00Z; at 08:00Z only DE-3 forecasts Emmerich
    expect(entry(await futureOwn(T('2026-10-06T08:00:00Z')), id.emmerich as number)).toMatchObject({
      source: 'DE-3',
      value: 501,
      ts: '2026-10-06T00:00:00.000Z',
    });
    // 10:00Z is 12:00 in Berlin: Friday's run is superseded (C4), DE-3 forecasts the day instead
    const late = T('2026-10-05T10:00:00Z');
    expect(entry(await futureOwn(T('2026-10-05T11:00:00Z'), late), id.emmerich as number)).toMatchObject({
      source: 'DE-3',
      value: 500,
    });
    // a minute earlier DE-2 still holds
    expect(entry(await futureOwn(T('2026-10-05T11:00:00Z'), late - 60_000), id.emmerich as number)).toMatchObject({
      source: 'DE-2',
    });
  });

  it('cuts an LU-3 run at its display limit, shows a below-floor point with no number, and cuts nothing without a limit', async () => {
    const at = async (when: string, limit: ReadonlyMap<string, number> | null = LU3_LIMIT) =>
      entry(
        await futureOwn(T(when), NOW, limit === null ? { limitsH: new Map() } : { limitsH: limit }),
        id.diekirch as number,
      );
    // run start 06:00Z, limit 24 h: shown to 06:00Z the next day, not a minute after
    expect(await at('2026-10-06T06:00:00Z')).toMatchObject({
      source: 'LU-3',
      agency: 'AGE',
      value: 50 + 24,
      band: { kind: 'p10p90', lo: 40 + 24, hi: 60 + 24 },
      horizonEnd: '2026-10-06T06:00:00.000Z',
    });
    expect(await at('2026-10-06T06:10:00Z')).toBeUndefined();
    expect(await at('2026-10-06T22:00:00Z')).toBeUndefined();
    // a limit of 48 h, or none: the run's own end (45 hours after its start)
    expect(await at('2026-10-06T22:00:00Z', null)).toMatchObject({ value: 50 + 40 });
    expect(await at('2026-10-06T22:00:00Z', new Map([['lu.age.diekirch', 48]]))).toMatchObject({ value: 50 + 40 });
    expect(await at('2026-10-07T03:10:00Z', null)).toBeUndefined();
    // the point below the floor: no value, no band, its flag kept, no state
    expect(await at('2026-10-05T11:30:00Z')).toMatchObject({
      value: null,
      band: null,
      flags: 1024,
      state: 'no_ref',
      basis: null,
      ts: '2026-10-05T11:00:00.000Z',
    });
  });

  it("cuts an LU-3 run at the seed's limit for its station when no limit is passed (the production default)", async () => {
    const limit = lu3Limits().get('lu.age.diekirch');
    expect(limit === 24 || limit === 48).toBe(true);
    // the run starts at 06:00Z: 30 hours on is past a 24 h limit and inside a 48 h one
    const got = entry(
      await readFutureSnapshot(own.db, 'owner', T('2026-10-06T12:00:00Z'), optsAt(NOW)),
      id.diekirch as number,
    );
    if (limit === 24) expect(got).toBeUndefined();
    else expect(got).toMatchObject({ source: 'LU-3', value: 50 + 30 });
  });

  it("shows the owner canary's own run (invariant 11: in the owner output), and the withheld canary nowhere", async () => {
    const snap = await futureOwn(T('2026-10-05T09:30:00Z'));
    expect(entry(snap, id.canaryOwner as number)).toMatchObject({
      source: 'CANARY-OWNER',
      value: Math.fround(CANARIES.owner.value),
    });
    expect(seriesIn(snap)).not.toContain(id.canaryWithheld);
    const text = JSON.stringify(snap);
    expect(text).not.toContain(CANARIES.withheld.real);
    expect(text).not.toContain(CANARIES.withheld.text);
    // the owner family also sees the public runs
    expect(seriesIn(snap)).toEqual(
      byId(
        [
          'lobithQ',
          'eijsdenQ',
          'band',
          'zaltbommel',
          'kaub',
          'later',
          'chq',
          'chw',
          'emmerich',
          'koeln',
          'diekirch',
          'canaryOwner',
        ].map((k) => id[k] as number),
      ),
    );
    expect(entry(snap, id.lobithQ as number)).toMatchObject({ source: 'NL-1', value: 1019 });
  });

  it('fails closed when a read returns a run of a source the family cannot see (review SEC-2)', async () => {
    const t = T('2026-10-05T09:30:00Z');
    await expect(
      readFutureSnapshot(own.db, 'owner', t, { ...optsAt(NOW), visible: visibleSources('public') }),
    ).rejects.toMatchObject({ code: 'owner_source' });
    await expect(
      readSeriesForecast(own.db, 'owner', id.emmerich as number, NOW, { visible: visibleSources('public') }),
    ).rejects.toMatchObject({ code: 'owner_source' });
  });
});

describe('the owner canary and every owner run stay out of the public answers', { timeout: 120_000 }, () => {
  it('the public reads hold no DE-2, DE-3 or LU-3 run and no canary, for the series that owner sources forecast', async () => {
    const t = T('2026-10-05T09:30:00Z');
    const snap = await futurePub(t);
    for (const key of ['emmerich', 'koeln', 'diekirch']) {
      expect(entry(snap, id[key] as number), key).toBeUndefined();
      const forecast = keep(
        `public forecast ${key}`,
        await readSeriesForecast(pub.db, 'public', id[key] as number, NOW),
      );
      // the series is public and in the api channel, its owner run is invisible: no run
      expect(forecast, key).toEqual({ series: id[key], asof: iso(NOW), run: null });
    }
    // the series of the owner canary is an owner series: not in the public api channel at all
    expect(await readSeriesForecast(pub.db, 'public', id.canaryOwner as number, NOW)).toBeUndefined();
    expect(await readSeriesForecast(pub.db, 'public', id.canaryWithheld as number, NOW)).toBeUndefined();
    expect(await readSeriesForecast(own.db, 'owner', id.canaryWithheld as number, NOW)).toBeUndefined();
  });
});

describe('readSeriesForecast', { timeout: 120_000 }, () => {
  const pubRead = async (series: number, asof: number) =>
    keep(`series ${series} ${iso(asof)}`, await readSeriesForecast(pub.db, 'public', series, asof));
  const ownRead = (series: number, asof: number, limitsH?: ReadonlyMap<string, number>) =>
    readSeriesForecast(own.db, 'owner', series, asof, limitsH === undefined ? {} : { limitsH });

  it('answers the current run with its points up to its horizon end, lead-in included, one value per valid time', async () => {
    const got = await pubRead(id.lobithQ as number, NOW);
    expect(SeriesForecast.safeParse(got).success).toBe(true);
    expect(got).toMatchObject({ series: id.lobithQ, asof: iso(NOW) });
    const run = got?.run;
    expect(run).toMatchObject({
      source: 'NL-1',
      agency: 'RWS',
      issuedAt: '2026-10-05T06:25:00.000Z',
      issuedInferred: true,
      fetchedAt: '2026-10-05T06:25:00.000Z',
      providerSegmentEnd: null,
      kind: 'deterministic',
      stepSeconds: 600,
      bandKind: null,
      horizonEnd: '2026-10-07T05:10:00.000Z',
    });
    // 06:20Z to 05:10Z two days on: 47 hours of ten-minute steps (the run's own points, nothing added or interpolated)
    expect(run?.points).toHaveLength(6 * 47);
    expect(run?.points[0]).toEqual({ ts: '2026-10-05T06:20:00.000Z', value: 1000, lo: null, hi: null, flags: 0 });
    expect(run?.points.at(-1)).toMatchObject({ ts: '2026-10-07T05:10:00.000Z', value: 1000 + 6 * 47 - 1 });
    const times = (run?.points ?? []).map((p) => p.ts);
    expect(times).toEqual([...times].sort());
  });

  it('caps the points at asof + 48 h, and shows the band of the run (BAFU p25-p75, with the lead-in)', async () => {
    const got = await pubRead(id.chq as number, NOW);
    const run = got?.run;
    expect(run).toMatchObject({
      source: 'CH-4',
      agency: 'BAFU',
      kind: 'ensemble_summary',
      stepSeconds: 3600,
      bandKind: 'p25p75',
    });
    expect(run?.horizonEnd).toBe(iso(NOW + 48 * H));
    // hourly from 07:00Z of the 5th to 09:00Z of the 7th, both ends included
    expect(run?.points).toHaveLength(51);
    expect(run?.points[0]).toEqual({ ts: '2026-10-05T07:00:00.000Z', value: 100, lo: 90, hi: 110, flags: 0 });
    expect(run?.points.at(-1)).toMatchObject({ ts: iso(NOW + 48 * H), value: 150, lo: 140, hi: 160 });
    // an earlier asof moves the cap with it
    const early = await pubRead(id.chq as number, T('2026-10-05T08:00:00Z'));
    expect(early?.run?.horizonEnd).toBe('2026-10-07T08:00:00.000Z');
    expect(early?.run?.points.at(-1)?.ts).toBe('2026-10-07T08:00:00.000Z');
  });

  it('answers the run that was known at asof: a run fetched after asof is invisible, and the newest known one wins', async () => {
    const lobith = id.lobithQ as number;
    // before anything was fetched: no run
    expect(await pubRead(lobith, T('2026-10-05T06:20:00Z'))).toEqual({
      series: lobith,
      asof: '2026-10-05T06:20:00.000Z',
      run: null,
    });
    // A, fetched 06:25Z, is the run until B arrives at 09:20Z
    for (const asof of ['2026-10-05T06:30:00Z', '2026-10-05T08:00:00Z', '2026-10-05T09:10:00Z'])
      expect((await pubRead(lobith, T(asof)))?.run?.fetchedAt, asof).toBe('2026-10-05T06:25:00.000Z');
    const b = await pubRead(lobith, T('2026-10-05T09:20:00Z'));
    expect(b?.run).toMatchObject({ fetchedAt: '2026-10-05T09:20:00.000Z', issuedAt: '2026-10-05T09:20:00.000Z' });
    expect(b?.run?.points[0]).toMatchObject({ ts: '2026-10-05T09:10:00.000Z', value: 2000 });
    // the stated issue time decides too: Zaltbommel's Z3 states 09:30Z though it was fetched at 08:50Z
    const zalt = id.zaltbommel as number;
    expect((await pubRead(zalt, T('2026-10-05T09:20:00Z')))?.run?.issuedAt).toBe('2026-10-05T09:05:00.000Z');
    expect((await pubRead(zalt, T('2026-10-05T09:30:00Z')))?.run).toMatchObject({
      issuedAt: '2026-10-05T09:30:00.000Z',
      issuedInferred: false,
      fetchedAt: '2026-10-05T08:50:00.000Z',
    });
  });

  it('is run null where the latest known run does not reach asof, never an older run that does', async () => {
    // (the route takes an asof up to now + 5 min: these are the reads of a clock later in the day)
    const eijsden = id.eijsdenQ as number;
    const reaches = await pubRead(eijsden, T('2026-10-05T11:00:00Z'));
    expect(reaches?.run?.fetchedAt).toBe('2026-10-05T08:00:00.000Z');
    expect(await pubRead(eijsden, T('2026-10-05T12:10:00Z'))).toEqual({
      series: eijsden,
      asof: '2026-10-05T12:10:00.000Z',
      run: null,
    });
    expect(await pubRead(eijsden, T('2026-10-05T07:00:00Z'))).toMatchObject({
      run: { fetchedAt: '2026-10-05T06:25:00.000Z' },
    });
  });

  it('lists a run that begins after asof with its own points from its first valid time', async () => {
    const got = await pubRead(id.soon as number, NOW);
    expect(got?.run).toMatchObject({ source: 'NL-1', stepSeconds: 3600, horizonEnd: '2026-10-06T12:00:00.000Z' });
    expect(got?.run?.points).toHaveLength(13);
    expect(got?.run?.points[0]).toMatchObject({ ts: '2026-10-06T00:00:00.000Z', value: 700 });
  });

  it('answers run null for a series that has no run, and undefined for an unknown id', async () => {
    expect(await pubRead(id.noRun as number, NOW)).toEqual({ series: id.noRun, asof: iso(NOW), run: null });
    expect(await readSeriesForecast(pub.db, 'public', 2_147_483_647, NOW)).toBeUndefined();
    expect(await readSeriesForecast(pub.db, 'public', 999_999, NOW)).toBeUndefined();
  });

  it('answers undefined for a series whose api channel is off or that is inactive, though it has a run', async () => {
    const zalt = id.zaltbommel as number;
    expect((await readSeriesForecast(pub.db, 'public', zalt, NOW))?.run).not.toBeNull();
    await q(`UPDATE series SET lic_override = '{"api": false}'::jsonb WHERE id = $1`, [zalt]);
    try {
      expect(await readSeriesForecast(pub.db, 'public', zalt, NOW)).toBeUndefined();
    } finally {
      await q('UPDATE series SET lic_override = NULL WHERE id = $1', [zalt]);
    }
    await q('UPDATE series SET active = false WHERE id = $1', [zalt]);
    try {
      expect(await readSeriesForecast(pub.db, 'public', zalt, NOW)).toBeUndefined();
    } finally {
      await q('UPDATE series SET active = true WHERE id = $1', [zalt]);
    }
    expect((await readSeriesForecast(pub.db, 'public', zalt, NOW))?.run).not.toBeNull();
  });

  it('owner: DE-2 with its segment end and the canary, DE-3 after it is superseded or when asof is later, never before it is known', async () => {
    const emmerich = id.emmerich as number;
    const de2 = await ownRead(emmerich, NOW);
    expect(SeriesForecast.safeParse(de2).success).toBe(true);
    expect(de2?.run).toMatchObject({
      source: 'DE-2',
      agency: 'BfG',
      issuedAt: FRIDAY.replace('Z', '.000Z'),
      issuedInferred: false,
      providerSegmentEnd: '2026-10-05T12:00:00.000Z',
      kind: 'deterministic',
      stepSeconds: 7200,
      bandKind: null,
      horizonEnd: '2026-10-06T05:00:00.000Z',
    });
    // Friday 05:00Z to Tuesday 05:00Z every two hours: 49 points, the canary at Monday 09:00Z (index 38)
    expect(de2?.run?.points).toHaveLength(49);
    expect(de2?.run?.points[38]).toMatchObject({ ts: '2026-10-05T09:00:00.000Z', value: Number(CANARIES.owner.real) });
    // superseded on Monday at 10:00Z: DE-3 (daily means), cut at asof + 48 h
    const late = await ownRead(emmerich, T('2026-10-05T10:00:00Z'));
    expect(late?.run).toMatchObject({ source: 'DE-3', kind: 'quantiles', stepSeconds: 86_400, bandKind: 'p10p90' });
    expect(late?.run?.horizonEnd).toBe('2026-10-07T10:00:00.000Z');
    expect(late?.run?.points.map((p) => p.ts)).toEqual([
      '2026-10-05T00:00:00.000Z',
      '2026-10-06T00:00:00.000Z',
      '2026-10-07T00:00:00.000Z',
    ]);
    expect(late?.run?.points[0]).toEqual({ ts: '2026-10-05T00:00:00.000Z', value: 500, lo: 480, hi: 520, flags: 0 });
    // Saturday: DE-3 was fetched on Monday morning, so it is not known; DE-2 is still the run
    const saturday = await ownRead(emmerich, T('2026-10-03T12:00:00Z'));
    expect(saturday?.run?.source).toBe('DE-2');
    // asof + 48 h, before the run's own end
    expect(saturday?.run?.horizonEnd).toBe('2026-10-05T12:00:00.000Z');
    // before Friday's run was fetched: nothing
    expect(await ownRead(emmerich, T('2026-10-02T04:00:00Z'))).toEqual({
      series: emmerich,
      asof: '2026-10-02T04:00:00.000Z',
      run: null,
    });
    // DE-3 alone on Köln
    expect((await ownRead(id.koeln as number, NOW))?.run).toMatchObject({ source: 'DE-3', bandKind: 'p10p90' });
  });

  it('owner: LU-3 cut at its display limit, the below-floor point with no number, no band', async () => {
    const got = await ownRead(id.diekirch as number, NOW, new Map([['lu.age.diekirch', 24]]));
    expect(got?.run).toMatchObject({
      source: 'LU-3',
      agency: 'AGE',
      kind: 'quantiles',
      stepSeconds: 3600,
      bandKind: 'p10p90',
      horizonEnd: '2026-10-06T06:00:00.000Z',
    });
    // 06:00Z to 06:00Z the next day: 25 hourly points
    expect(got?.run?.points).toHaveLength(25);
    expect(got?.run?.points[5]).toEqual({
      ts: '2026-10-05T11:00:00.000Z',
      value: null,
      lo: null,
      hi: null,
      flags: 1024,
    });
    expect(got?.run?.points[4]).toEqual({ ts: '2026-10-05T10:00:00.000Z', value: 54, lo: 44, hi: 64, flags: 0 });
    const free = await ownRead(id.diekirch as number, NOW, new Map());
    expect(free?.run?.points).toHaveLength(46);
    expect(free?.run?.horizonEnd).toBe('2026-10-07T03:00:00.000Z');
    // the owner canary's own run shows on its series in the owner family (ranked after every listed source)
    const canary = await ownRead(id.canaryOwner as number, NOW);
    expect(canary?.run?.source).toBe('CANARY-OWNER');
    expect(canary?.run?.points.every((p) => p.value === Math.fround(CANARIES.owner.value))).toBe(true);
  });
});

describe('the HTTP routes', { timeout: 120_000 }, () => {
  let clock = NOW;
  const app = () => createApp({ db: pub.db, window: display, now: () => new Date(clock) });
  const noDb = () => createApp({ window: display, now: () => new Date(clock) });
  type Got = { status: number; text: string; headers: Headers; cache: string | null; json: () => unknown };
  const get = async (a: ReturnType<typeof createApp>, path: string, init?: RequestInit): Promise<Got> => {
    const res = await a.request(path, init);
    const text = await res.text();
    publicTexts.push({ label: `GET ${path}`, text });
    return {
      status: res.status,
      text,
      headers: res.headers,
      cache: res.headers.get('cache-control'),
      json: () => JSON.parse(text) as unknown,
    };
  };
  /** P9b: every answer's attribution names exactly the sources its body names (the series' sources, a run's, a basis'). */
  const seriesSources = async (ids: number[]) =>
    (await q<{ source_id: string }>(`SELECT DISTINCT source_id FROM series WHERE id = ANY($1::int[])`, [ids])).map(
      (r) => r.source_id,
    );
  const sameSources = (attribution: { source: string }[], named: string[]) =>
    expect(new Set(attribution.map((a) => a.source))).toEqual(new Set(named));
  /** A snapshot answer without its attribution, which is checked here. */
  const snapBody = async (res: Got) => {
    const { attribution, ...body } = SnapshotAnswer.parse(res.json());
    const forecasts = body.forecasts ?? [];
    const series = [...body.values.map((v) => v.series), ...forecasts.map((f) => f.series)];
    const bases = [...body.values.flatMap((v) => [v.basis, v.area?.basis]), ...forecasts.map((f) => f.basis)];
    sameSources(attribution, [
      ...(await seriesSources(series)),
      ...forecasts.map((f) => f.source),
      ...bases.flatMap((b) => (b ? [b.source] : [])),
    ]);
    return body;
  };
  /** A /series/{id}/forecast answer without its attribution. */
  const forecastBody = async (res: Got) => {
    const { attribution, ...body } = SeriesForecastAnswer.parse(res.json());
    sameSources(attribution, [...(await seriesSources([body.series])), ...(body.run ? [body.run.source] : [])]);
    return body;
  };
  const snapshot = (when: string) => `/api/v1/snapshot?t=${when}`;
  const forecast = (series: number, query = '') => `/api/v1/series/${series}/forecast${query}`;

  it('refuses t beyond now + 48 h with 400 out_of_range, before any query and with no database at all', async () => {
    clock = NOW;
    const beyond = ['2026-10-07T09:10:00Z', '2026-10-07T09:00:01Z', '2026-10-08T09:00:00Z', '2030-01-01T00:00:00Z'];
    const connect = vi.spyOn(pub.pool, 'connect');
    const query = vi.spyOn(pub.pool, 'query');
    try {
      for (const a of [app(), noDb()])
        for (const when of beyond) {
          const res = await get(a, snapshot(when));
          expect([res.status, res.text, res.cache], when).toEqual([
            400,
            '{"error":"out_of_range","attribution":[]}',
            'no-store',
          ]);
        }
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
    // a valid future t with no database is not a refusal of the request: the service is unavailable
    const down = await get(noDb(), snapshot('2026-10-05T12:00:00Z'));
    expect([down.status, down.text, down.cache]).toEqual([503, '{"error":"unavailable","attribution":[]}', 'no-store']);
  });

  it('answers a future t with the forecasts, no observation and the short cache of the current bucket', async () => {
    clock = NOW;
    const res = await get(app(), snapshot('2026-10-05T09:35:00Z'));
    expect(res.status).toBe(200);
    expect(res.cache).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await snapBody(res);
    expect(body.t).toBe('2026-10-05T09:30:00.000Z');
    expect(body.values).toEqual([]);
    expect(body.forecasts?.length).toBeGreaterThan(0);
    expect(body.forecasts?.find((f) => f.series === id.lobithQ)).toMatchObject({ source: 'NL-1', value: 1019 });
    // exactly now + 48 h is accepted, a CH-4 series is still forecast there
    const edge = await get(app(), snapshot('2026-10-07T09:00:00Z'));
    expect(edge.status).toBe(200);
    expect((await snapBody(edge)).forecasts?.some((f) => f.series === id.chq)).toBe(true);
    // and a t in the current bucket is the present: the observation snapshot, with no `forecasts` key
    for (const when of ['2026-10-05T09:00:00Z', '2026-10-05T09:09:59Z']) {
      const present = await get(app(), snapshot(when));
      expect(present.status, when).toBe(200);
      expect('forecasts' in (present.json() as object), when).toBe(false);
      expect((await snapBody(present)).t).toBe('2026-10-05T09:00:00.000Z');
    }
  });

  it('answers a past t exactly as before P8b: no `forecasts` key', async () => {
    clock = NOW;
    for (const when of ['2026-10-05T08:00:00Z', '2026-10-04T09:00:00Z', '2026-10-01T00:00:00Z']) {
      const res = await get(app(), snapshot(when));
      expect(res.status, when).toBe(200);
      expect(Object.keys(res.json() as object).sort(), when).toEqual(['attribution', 't', 'values']);
      await snapBody(res);
    }
  });

  it("keys the future snapshot by now's bucket: the same bucket is one answer, the next bucket sees the newer run", async () => {
    const a = app();
    const path = snapshot('2026-10-05T09:40:00Z');
    const connect = vi.spyOn(pub.pool, 'connect');
    try {
      clock = T('2026-10-05T09:00:00Z');
      const first = await get(a, path);
      expect((await snapBody(first)).forecasts?.find((f) => f.series === id.lobithQ)?.value).toBe(1020);
      const asked = connect.mock.calls.length;
      expect(asked).toBeGreaterThan(0);
      // the rest of its minute: the cached answer, no query
      clock = T('2026-10-05T09:00:30Z');
      expect((await get(a, path)).text).toBe(first.text);
      expect(connect.mock.calls.length).toBe(asked);
      // 09:20: Lobith's run B is known, and the same URL answers from it
      clock = T('2026-10-05T09:20:00Z');
      const next = await get(a, path);
      expect((await snapBody(next)).forecasts?.find((f) => f.series === id.lobithQ)).toMatchObject({
        value: 2003,
        issuedAt: '2026-10-05T09:20:00.000Z',
      });
      expect(connect.mock.calls.length).toBeGreaterThan(asked);
    } finally {
      vi.restoreAllMocks();
      clock = NOW;
    }
  });

  it('/series/{id}/forecast: 200 with the cache of the forecast routes and a SeriesForecast body', async () => {
    clock = NOW;
    const res = await get(app(), forecast(id.lobithQ as number));
    expect(res.status).toBe(200);
    expect(res.cache).toBe('public, max-age=300');
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await forecastBody(res);
    expect(body).toMatchObject({ series: id.lobithQ, asof: iso(NOW) });
    expect(body.run).toMatchObject({ source: 'NL-1', fetchedAt: '2026-10-05T06:25:00.000Z' });
    expect(body.run?.points).toHaveLength(6 * 47);
    // a series with no run answers 200 with `run: null`, not a 404
    const none = await get(app(), forecast(id.noRun as number));
    expect([none.status, none.cache]).toEqual([200, 'public, max-age=300']);
    expect(await forecastBody(none)).toEqual({ series: id.noRun, asof: iso(NOW), run: null });
    // HEAD answers like GET without a body
    const head = await get(app(), forecast(id.lobithQ as number), { method: 'HEAD' });
    expect([head.status, head.text, head.cache]).toEqual([200, '', 'public, max-age=300']);
  });

  it('/series/{id}/forecast?asof= answers the run known then, floored to the grid; before display start it is out_of_range', async () => {
    clock = T('2026-10-05T09:25:00Z');
    try {
      const a = app();
      const run = async (query: string) => forecastBody(await get(a, forecast(id.lobithQ as number, query)));
      expect((await run('')).run?.fetchedAt).toBe('2026-10-05T09:20:00.000Z');
      expect((await run('')).asof).toBe('2026-10-05T09:20:00.000Z');
      expect((await run('?asof=2026-10-05T09:00:00Z')).run?.fetchedAt).toBe('2026-10-05T06:25:00.000Z');
      expect((await run('?asof=2026-10-05T09:19:59Z')).run?.fetchedAt).toBe('2026-10-05T06:25:00.000Z');
      expect(await run('?asof=2026-10-05T06:00:00Z')).toMatchObject({ asof: '2026-10-05T06:00:00.000Z', run: null });
      const before = await get(a, forecast(id.lobithQ as number, '?asof=2026-09-30T00:00:00Z'));
      expect([before.status, before.text, before.cache]).toEqual([
        400,
        '{"error":"out_of_range","attribution":[]}',
        'no-store',
      ]);
    } finally {
      clock = NOW;
    }
  });

  it('refuses an unknown parameter with 400 unknown_parameter, a bad id or asof with bad_parameter, no-store', async () => {
    clock = NOW;
    const connect = vi.spyOn(pub.pool, 'connect');
    try {
      const cases: [string, ReturnType<typeof forecast>, string][] = [
        ['an unknown parameter', forecast(id.lobithQ as number, '?foo=1'), 'unknown_parameter'],
        ['t instead of asof', forecast(id.lobithQ as number, '?t=2026-10-05T09:00:00Z'), 'unknown_parameter'],
        [
          'a repeated asof',
          forecast(id.lobithQ as number, '?asof=2026-10-05T09:00:00Z&asof=2026-10-05T08:00:00Z'),
          'repeated_parameter',
        ],
        ['a bad asof', forecast(id.lobithQ as number, '?asof=yesterday'), 'bad_parameter'],
        ['an id that is not a number', '/api/v1/series/abc/forecast', 'bad_parameter'],
        ['an id of zero', '/api/v1/series/0/forecast', 'bad_parameter'],
        ['an id past int4', '/api/v1/series/2147483648/forecast', 'bad_parameter'],
      ];
      for (const [label, path, code] of cases) {
        const res = await get(app(), path);
        expect([res.status, res.text, res.cache], label).toEqual([
          400,
          JSON.stringify({ error: code, attribution: [] }),
          'no-store',
        ]);
      }
      expect(connect).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('answers an unknown id, an inactive series, an api-off series and an owner series with the same uncached 404', async () => {
    clock = NOW;
    const zalt = id.zaltbommel as number;
    const notFound = (res: Got) =>
      expect([res.status, res.text, res.cache]).toEqual([404, '{"error":"not_found","attribution":[]}', 'no-store']);
    notFound(await get(app(), forecast(2_147_483_647)));
    notFound(await get(app(), forecast(999_999)));
    // the owner canary's series and the withheld one are not in the public api channel
    notFound(await get(app(), forecast(id.canaryOwner as number)));
    notFound(await get(app(), forecast(id.canaryWithheld as number)));
    await q(`UPDATE series SET lic_override = '{"api": false}'::jsonb WHERE id = $1`, [zalt]);
    try {
      notFound(await get(app(), forecast(zalt)));
    } finally {
      await q('UPDATE series SET lic_override = NULL WHERE id = $1', [zalt]);
    }
    await q('UPDATE series SET active = false WHERE id = $1', [zalt]);
    try {
      notFound(await get(app(), forecast(zalt)));
    } finally {
      await q('UPDATE series SET active = true WHERE id = $1', [zalt]);
    }
    // a 404 is not cached: the same app answers 200 once the series is back
    const a = app();
    notFound(await get(a, forecast(2_147_483_647)));
    await q('UPDATE series SET active = false WHERE id = $1', [zalt]);
    try {
      notFound(await get(a, forecast(zalt)));
    } finally {
      await q('UPDATE series SET active = true WHERE id = $1', [zalt]);
    }
    expect((await get(a, forecast(zalt))).status).toBe(200);
  });

  it('/series/{id}/forecast of a public series that an owner source forecasts is run null, with no trace of the owner run', async () => {
    clock = NOW;
    for (const key of ['emmerich', 'koeln', 'diekirch']) {
      const res = await get(app(), forecast(id[key] as number));
      expect(res.status, key).toBe(200);
      expect(await forecastBody(res), key).toEqual({ series: id[key], asof: iso(NOW), run: null });
      expect(res.text).not.toContain('777777');
    }
  });

  it('/meta lists the public forecast horizons and no owner source; the OpenAPI document names the new path', async () => {
    clock = NOW;
    const meta = await get(app(), '/api/v1/meta');
    expect(meta.status).toBe(200);
    const { attribution, ...metaBody } = MetaAnswer.parse(meta.json());
    expect(metaBody.forecastHorizons).toEqual([
      { source: 'CH-4', hours: 48 },
      { source: 'FR-4', hours: 48 },
      { source: 'NL-1', hours: 48 },
    ]);
    expect(metaBody.forecastHorizons).toEqual(forecastHorizons('public'));
    // P9b: the meta attribution names exactly the listed sources and the forecast sources.
    sameSources(attribution, [...metaBody.sources.map((s) => s.id), ...metaBody.forecastHorizons.map((f) => f.source)]);
    for (const word of OWNER_SOURCES) expect(meta.text, word).not.toContain(word);
    // The attribution duty of the public forecast sources whose runs sit on CH-1 and FR-1 series (P8b): listed beside
    // them with their rows; FR-4's text carries the update-date placeholder the page fills.
    const sources = new Map(metaBody.sources.map((s) => [s.id, s.attribution]));
    expect(sources.get('CH-4')?.length).toBeGreaterThan(0);
    expect(
      sources
        .get('FR-4')
        ?.map((a) => a.text)
        .join(' '),
    ).toContain('VIGICRUES');
    expect(sources.get('FR-4')?.some((a) => a.needsDate)).toBe(true);
    const doc = (await get(app(), '/api/v1/openapi.json')).json() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(Object.keys(doc.paths)).toContain('/api/v1/series/{id}/forecast');
    expect(Object.keys(doc.components.schemas)).toContain('SeriesForecast');
  });

  it('no public answer of this file holds an owner source, an owner run or a canary', () => {
    expect(publicTexts.length).toBeGreaterThan(40);
    for (const { label, text } of publicTexts) {
      for (const rendering of CANARY_RENDERINGS) expect(text, `${label}: ${rendering}`).not.toContain(rendering);
      expect(text, label).not.toContain('777777');
      for (const word of ['DE-2', 'DE-3', 'LU-3', 'CANARY', 'BfG'])
        expect(text, `${label}: ${word}`).not.toContain(word);
    }
  });
});

describe('the forecast coverage of the owner family', { timeout: 120_000 }, () => {
  const reach = (doc: Awaited<ReturnType<typeof forecastCoverage>>, reachId: string) => {
    const r = doc.reaches.find((x) => x.id === reachId);
    if (r === undefined) throw new Error(`no reach ${reachId}`);
    return r;
  };

  it('covers the reach Maxau to Emmerich from DE-3 alone, and leaves the public coverage unchanged', async () => {
    const [before, publicBefore] = [
      await forecastCoverage(own.db, 'owner', NOW),
      await forecastCoverage(pub.db, 'public', NOW),
    ];
    // Koblenz: a first-release Rhine station of the reach, with no DE-2 run in the database
    const none = await q('SELECT 1 FROM forecast_run WHERE series_id = $1 AND source_id = ANY($2)', [
      id.koblenz,
      ['DE-2', 'NL-1'],
    ]);
    expect(none).toHaveLength(0);
    await seedRun({
      series: id.koblenz as number,
      source: 'DE-3',
      issued: null,
      fetched: iso(NOW - 2 * H),
      kind: 'quantiles',
      stepS: 86_400,
      points: grid('2026-10-05T00:00:00Z', 15, 24 * H, (i) => ({ value: 400 + i, p10: 380 + i, p90: 420 + i })),
    });
    const [after, publicAfter] = [
      await forecastCoverage(own.db, 'owner', NOW),
      await forecastCoverage(pub.db, 'public', NOW),
    ];
    const was = reach(before, 'rhine-maxau-emmerich');
    const now = reach(after, 'rhine-maxau-emmerich');
    expect(now.covered).toBe(was.covered + 1);
    expect(now.stations).toBe(was.stations);
    expect(now.sources).toEqual(['DE-2', 'DE-3']);
    expect(now.no_official_forecast).toBe(false);
    expect(after.total.covered).toBe(before.total.covered + 1);
    expect(after.countries.find((c) => c.country === 'DE')?.covered).toBe(
      (before.countries.find((c) => c.country === 'DE')?.covered ?? -1) + 1,
    );
    // the denominator is the same, and no other reach moved
    for (const r of after.reaches) if (r.id !== 'rhine-maxau-emmerich') expect(r, r.id).toEqual(reach(before, r.id));
    // the public report is the same document with and without the DE-3 run, and says nothing of it
    expect(publicAfter).toEqual(publicBefore);
    // (this file's public run on Kaub covers one of its stations in both reports, with or without DE-3)
    expect(reach(publicAfter, 'rhine-maxau-emmerich')).toMatchObject({ sources: [], no_official_forecast: true });
    expect(JSON.stringify(publicAfter)).not.toMatch(/DE-2|DE-3|LU-3|CANARY/);
  });
});
