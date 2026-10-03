import { createHash } from 'node:crypto';
import { CANARIES, CANARY_RENDERINGS, ForecastLatest, OwnerForecastLatest } from '@rws/contracts';
import { FORECAST_FLAGS, RUHRORT_W } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUHRORT_STATION } from '../../src/api/forecast.ts';
import { readForecastLatest } from '../../src/api/forecast-latest.ts';
import type { Db } from '../../src/db/pool.ts';
import { type Harness, harness, KAUB_W } from '../load/harness.ts';

// forecast/latest.json through the real database roles: runs seeded as the superuser on real registry series are read
// as `rws_api` (public family) and as `rws_owner_api` (owner family). The public document never holds an owner run
// (DE-2 or LU-3 on a public series, the owner canary) or the withheld canary; the owner document does hold the owner
// ones. A superseded DE-2 run (C4) is no forecast, the LU-3 display limit cuts, a below-floor point has no number.

const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const T = (s: string) => Date.parse(s);
const H = 3_600_000;
// Monday 2026-10-05; DE-2's Friday run is still the current one at 09:00Z and superseded from 10:00Z (12:00 local).
const NOW = T('2026-10-05T09:00:00Z');
const DE2_ISSUED = '2026-10-02T05:00:00Z';

let h: Harness;
let pub: Db;
let own: Db;
const id: Record<string, number> = {};

type Col = 'value' | 'p10' | 'p30' | 'p50' | 'p70' | 'p90';
type Pt = { ts: string; flags?: number } & Partial<Record<Col, number | null>>;
const q = async (text: string, args: unknown[] = []) => (await h.t.admin.query(text, args)).rows;

async function seriesOf(source: string, key: string): Promise<number> {
  const rows = await q('SELECT id FROM series WHERE source_id = $1 AND provider_key = $2', [source, key]);
  if (rows[0] === undefined) throw new Error(`no series ${source} ${key}`);
  return (rows[0] as { id: number }).id;
}

async function seedRun(o: {
  series: number;
  source: string;
  issued: string | null;
  fetched: string;
  kind: string;
  stepS: number;
  segmentEnd?: string;
  points: Pt[];
}): Promise<void> {
  const first = o.points[0]?.ts;
  const last = o.points.at(-1)?.ts;
  await q('SELECT ensure_partitions($1::timestamptz, $2::timestamptz)', [first, last]);
  const [run] = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                               content_hash, kind, step, provider_segment_end)
     VALUES ($1::int, $2::text, COALESCE($3::timestamptz, $4::timestamptz), $3::timestamptz IS NULL, $5::timestamptz,
             $6::timestamptz, $4::timestamptz, decode($7::text, 'hex'), $8::text, make_interval(secs => $9::int),
             $10::timestamptz)
     RETURNING id`,
    [
      o.series,
      o.source,
      o.issued,
      o.fetched,
      first,
      last,
      createHash('md5').update(`${o.source}/${o.series}/${first}/${o.fetched}`).digest('hex'),
      o.kind,
      o.stepS,
      o.segmentEnd ?? null,
    ],
  );
  for (const p of o.points) {
    await q(
      `INSERT INTO forecast_value (run_id, valid_ts, value, p10, p30, p50, p70, p90, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        (run as { id: string }).id,
        p.ts,
        p.value ?? null,
        p.p10 ?? null,
        p.p30 ?? null,
        p.p50 ?? null,
        p.p70 ?? null,
        p.p90 ?? null,
        p.flags ?? 0,
      ],
    );
  }
}

/** n points every `stepMs` from `from`. */
const grid = (from: string, n: number, stepMs: number, at: (i: number) => Omit<Pt, 'ts'> = () => ({})): Pt[] =>
  Array.from({ length: n }, (_, i) => ({ ts: new Date(T(from) + i * stepMs).toISOString(), value: 100 + i, ...at(i) }));

/** Ruhrort's latest observation (cm) at `ts`: the row the DE-2 schedule reads. */
async function ruhrort(ts: string, cm: number | null): Promise<void> {
  await q('DELETE FROM obs_latest WHERE series_id = $1', [id.ruhrort]);
  if (cm === null) return;
  await q('INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 1, 1)', [
    id.ruhrort,
    ts,
    cm,
  ]);
}

const LU3_LIMIT = new Map([['lu.age.diekirch', 24]]);
const read = (db: Db, family: 'public' | 'owner', at = NOW) =>
  readForecastLatest(db.db, family, at, { limitsH: LU3_LIMIT });

beforeAll(async () => {
  h = await harness();
  pub = h.dbAs('rws_api', 2);
  own = h.dbAs('rws_owner_api', 2);
  id.lobith = await seriesOf('NL-1', LOBITH_Q);
  id.kaub = await seriesOf('DE-1', KAUB_W);
  id.ruhrort = await seriesOf('DE-1', RUHRORT_W);
  id.diekirch = await seriesOf('LU-1', 'Diekirch');

  // The canary station and a withheld one, as the audience fixture has them (the real registry holds neither).
  await q(`INSERT INTO station (id, name, country, tier) VALUES ('nl.canary.owner', 'owner canary', 'NL', 2),
                                                               ('nl.canary.withheld', 'withheld canary', 'NL', 2)`);
  for (const [key, station, source, audience] of [
    ['canary-owner', 'nl.canary.owner', 'CANARY-OWNER', null],
    ['canary-withheld', 'nl.canary.withheld', 'NL-1', 'off'],
  ] as const) {
    const [row] = await q(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, audience)
       VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary', $4::audience)
       RETURNING id`,
      [station, source, key, audience],
    );
    id[key] = (row as { id: number }).id;
  }

  // NL-1 (public): 10-minute steps for two days, the capture of 06:25Z; its issue time is inferred.
  await seedRun({
    series: id.lobith as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:25:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:20:00Z', 6 * 47, 600_000, (i) => ({ value: 1000 + i })),
  });
  // DE-2 (owner) on a public DE-1 series, Friday's run: 49 points two hours apart to Tuesday, an estimate after 48 h,
  // one of them holding the owner canary.
  await seedRun({
    series: id.kaub as number,
    source: 'DE-2',
    issued: DE2_ISSUED,
    fetched: '2026-10-02T05:12:00Z',
    kind: 'deterministic',
    stepS: 7200,
    segmentEnd: '2026-10-04T05:00:00Z',
    points: grid(DE2_ISSUED, 49, 2 * H, (i) => ({
      value: i === 3 ? CANARIES.owner.value : 300 + i,
      flags: i > 24 ? FORECAST_FLAGS.ESTIMATE : 0,
    })),
  });
  // LU-3 (owner) on a public LU-1 series: 46 hourly steps with a band; one point below the provider's floor.
  await seedRun({
    series: id.diekirch as number,
    source: 'LU-3',
    issued: null,
    fetched: '2026-10-05T07:45:00Z',
    kind: 'quantiles',
    stepS: 3600,
    points: grid('2026-10-05T06:00:00Z', 46, H, (i) => ({
      value: 50 + i,
      p10: 40 + i,
      p30: 45 + i,
      p50: 50 + i,
      p70: 55 + i,
      p90: 60 + i,
      flags: i === 5 ? FORECAST_FLAGS.BELOW_FLOOR : 0,
    })),
  });
  // The owner canary source on its own series, and a withheld NL-1 series holding the withheld canary.
  await seedRun({
    series: id['canary-owner'] as number,
    source: 'CANARY-OWNER',
    issued: null,
    fetched: '2026-10-05T06:30:00Z',
    kind: 'deterministic',
    stepS: 3600,
    points: grid('2026-10-05T06:00:00Z', 4, H, () => ({ value: CANARIES.owner.value })),
  });
  await seedRun({
    series: id['canary-withheld'] as number,
    source: 'NL-1',
    issued: null,
    fetched: '2026-10-05T06:30:00Z',
    kind: 'deterministic',
    stepS: 600,
    points: grid('2026-10-05T06:00:00Z', 20, 600_000, () => ({ value: CANARIES.withheld.value })),
  });
  await ruhrort('2026-10-05T08:50:00Z', 600);
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe('forecast/latest.json through the database roles', { timeout: 300_000 }, () => {
  it('the public document holds the public NL-1 run only: no owner run, no canary, no owner agency', async () => {
    const doc = await read(pub, 'public');
    expect(ForecastLatest.safeParse(doc).success).toBe(true);
    expect(doc.now).toBe(new Date(NOW).toISOString());
    expect(doc.runs.map((r) => [r.series, r.source, r.agency])).toEqual([[id.lobith, 'NL-1', 'RWS']]);
    const text = JSON.stringify(doc);
    for (const rendering of CANARY_RENDERINGS) expect(text, rendering).not.toContain(rendering);
    for (const word of ['DE-2', 'LU-3', 'CANARY', 'BfG', 'AGE', 'private']) expect(text, word).not.toContain(word);
    const [run] = doc.runs;
    expect(run).toMatchObject({
      issuedAt: '2026-10-05T06:25:00.000Z',
      issuedInferred: true,
      fetchedAt: '2026-10-05T06:25:00.000Z',
      providerSegmentEnd: null,
      kind: 'deterministic',
      stepSeconds: 600,
      band: null,
    });
    // values reach now + 48 h (the run has 47 hours of points): all of them, from the first valid time
    expect(run?.validTs).toHaveLength(6 * 47);
    expect(run?.validTs[0]).toBe('2026-10-05T06:20:00.000Z');
    expect(run?.value[0]).toBe(1000);
  });

  it('the owner document also holds the DE-2, LU-3 and canary runs, columnar and cut as the rules say', async () => {
    const doc = await read(own, 'owner');
    expect(OwnerForecastLatest.safeParse(doc).success).toBe(true);
    // the public schema refuses the canary's source: a public document could never carry it
    expect(ForecastLatest.safeParse(doc).success).toBe(false);
    const by = (source: string) => doc.runs.find((r) => r.source === source);
    expect(doc.runs.map((r) => r.source).sort()).toEqual(['CANARY-OWNER', 'DE-2', 'LU-3', 'NL-1']);
    expect(doc.runs.map((r) => r.series)).toEqual([...doc.runs.map((r) => r.series)].sort((a, b) => a - b));
    // the owner canary is in the owner document (as `real`) and the withheld one is nowhere
    const text = JSON.stringify(doc);
    expect(text).toContain(CANARIES.owner.real);
    expect(text).not.toContain(CANARIES.withheld.real);
    expect(text).not.toContain(CANARIES.withheld.text);
    expect(by('NL-1')?.validTs).toHaveLength(6 * 47);

    const de2 = by('DE-2');
    expect(de2).toMatchObject({
      series: id.kaub,
      agency: 'BfG',
      issuedAt: '2026-10-02T05:00:00.000Z',
      issuedInferred: false,
      providerSegmentEnd: '2026-10-04T05:00:00.000Z',
      stepSeconds: 7200,
    });
    // up to now + 48 h = Wednesday 09:00Z, the run ends Tuesday 05:00Z: all 49 points
    expect(de2?.validTs).toHaveLength(49);
    expect(de2?.flags.filter((f) => f === FORECAST_FLAGS.ESTIMATE)).toHaveLength(24);
    expect(de2?.flags.slice(0, 25).every((f) => f === 0)).toBe(true);
    expect(de2?.value[3]).toBe(Number(CANARIES.owner.real));

    const lu3 = by('LU-3');
    expect(lu3).toMatchObject({
      series: id.diekirch,
      agency: 'AGE',
      kind: 'quantiles',
      stepSeconds: 3600,
      issuedInferred: true,
    });
    // the injected 24 h limit: first_valid 06:00Z to 06:00Z the next day, 25 hourly points
    expect(lu3?.validTs).toHaveLength(25);
    expect(lu3?.validTs.at(-1)).toBe('2026-10-06T06:00:00.000Z');
    expect(lu3?.band?.p10?.[0]).toBe(40);
    expect(lu3?.band?.p90?.[2]).toBe(62);
    expect(lu3?.band?.p30?.[1]).toBe(46);
    expect(lu3?.band?.p70?.[1]).toBe(56);
    // the point below the floor: no number anywhere, its flag kept
    expect(lu3?.flags[5]).toBe(FORECAST_FLAGS.BELOW_FLOOR);
    expect(lu3?.value[5]).toBeNull();
    expect(lu3?.band?.p10[5]).toBeNull();
    expect(lu3?.band?.p90[5]).toBeNull();
    expect(lu3?.value[4]).toBe(54);
    // without a limit nothing is cut
    const free = await readForecastLatest(own.db, 'owner', NOW, { limitsH: new Map() });
    expect(free.runs.find((r) => r.source === 'LU-3')?.validTs).toHaveLength(46);
  });

  it('C4: Ruhrort is the DE-1 stage the schedule reads, and a superseded DE-2 run is left out of the owner document', async () => {
    const [station] = await q('SELECT station_id FROM series WHERE id = $1', [id.ruhrort]);
    expect((station as { station_id: string }).station_id).toBe(RUHRORT_STATION);
    // 10:00Z Monday is 12:00 local: Monday's deadline has passed without a newer run
    const late = T('2026-10-05T10:00:00Z');
    await ruhrort('2026-10-05T09:50:00Z', 600);
    const doc = await read(own, 'owner', late);
    // (the canary's own run ended at 09:00Z)
    expect(doc.runs.map((r) => r.source).sort()).toEqual(['LU-3', 'NL-1']);
    // a minute earlier it is still the current run
    expect((await read(own, 'owner', late - 60_000)).runs.map((r) => r.source)).toContain('DE-2');
  });

  it('C4: a weekend run is due only while Ruhrort is below 4 m; an unknown or stale stage is no false drop', async () => {
    const sources = async (hhmm: string) =>
      (await read(own, 'owner', T(`2026-10-03T${hhmm}:00Z`))).runs.map((r) => r.source);
    // Saturday 2026-10-03 (a holiday too): its deadline is 12:00 local = 10:00Z
    await ruhrort('2026-10-03T09:20:00Z', 350);
    expect(await sources('09:30')).toEqual(['DE-2']);
    await ruhrort('2026-10-03T10:20:00Z', 350);
    expect(await sources('10:30')).toEqual([]);
    await ruhrort('2026-10-03T10:20:00Z', 450);
    expect(await sources('10:30')).toEqual(['DE-2']);
    // an observation older than the series' staleness window is unknown, and so is none at all
    await ruhrort('2026-10-03T08:00:00Z', 350);
    expect(await sources('10:30')).toEqual(['DE-2']);
    await ruhrort('2026-10-03T10:20:00Z', null);
    expect(await sources('10:30')).toEqual(['DE-2']);
  });

  it('answers with no runs before anything is known and never an older run that is not known yet', async () => {
    const early = await read(own, 'owner', T('2026-09-01T00:00:00Z'));
    expect(early).toEqual({ schemaVersion: 1, now: '2026-09-01T00:00:00.000Z', runs: [] });
    // 2026-10-04: only DE-2's Friday run is known (the others were fetched on the 5th)
    await ruhrort('2026-10-04T08:50:00Z', 600);
    const sunday = await read(own, 'owner', T('2026-10-04T09:00:00Z'));
    expect(sunday.runs.map((r) => r.source)).toEqual(['DE-2']);
    expect(await read(pub, 'public', T('2026-10-04T09:00:00Z'))).toMatchObject({ runs: [] });
  });
});
