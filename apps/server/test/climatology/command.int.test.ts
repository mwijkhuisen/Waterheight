import { SnapshotAnswer, type Snapshot as SnapshotDoc, StationRecent, stateCode } from '@rws/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classCoverage, HourMemo, readHourStates, readStates, StaticCache } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { climatologyMain } from '../../src/climatology/cli.ts';
import type { Db } from '../../src/db/pool.ts';
import { renderStation } from '../../src/publish/render/series.ts';
import { type Harness, harness, KAUB_W } from '../load/harness.ts';
import { ctxFor } from '../publish/s2-ctx.ts';
import { doyRows, seedHourly } from './seed.ts';

// P14f: the `climatology` command against a real PostgreSQL 18 as the real rws_migrator login, and the readers as
// rws_api and rws_publish. Ten synthetic UTC years of hourly values (2010-2019) on public NL-1 discharge and level
// series give 730 rows each (2 kinds × 365 day keys); nine years give none; a stage series, a tidal and an impounded
// station and a series without the history_export channel are not eligible. A re-run that changes nothing writes
// nothing, a changed history closes and reopens, and the state in /snapshot, in the frames and in the coverage comes
// from the rows only from the run's start on.

const H = 3_600_000;
const RUN1 = new Date('2026-10-25T00:00:00Z');
const NOW = new Date('2026-10-26T12:00:00Z');
const T_NOW = NOW.getTime();
const TEN_YEARS = { from: '2010-01-01T00:00:00Z', to: '2020-01-01T00:00:00Z' };
const SHAPE = { base: 100, amp: 40 };

let h: Harness;
let apiDb: Db['db'];
let publishDb: Db;
let app: ReturnType<typeof createApp>;
const id: Record<string, number> = {};
const station: Record<string, string> = {};
const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;

/** NL-1 public primary series of a quantity at non-tidal, non-impounded stations, tier 1 first, one per station. */
async function pickSeries(quantity: 'H' | 'Q', n: number): Promise<{ id: number; station: string }[]> {
  const kind = quantity === 'H' ? "AND s.value_kind = 'level'" : '';
  const rows = await q<{ id: number; station_id: string }>(
    `SELECT DISTINCT ON (s.station_id) s.id, s.station_id, st.tier
     FROM series s JOIN series_eff e ON e.series_id = s.id JOIN station st ON st.id = s.station_id
     WHERE s.source_id = 'NL-1' AND s.quantity = $1 ${kind} AND e.audience = 'public' AND e.role = 'primary'
       AND e.lic_history_export AND s.active AND st.id NOT LIKE 'nl.canary.%'
       AND COALESCE((st.flags->>'tidal')::boolean, false) = false
       AND COALESCE((st.flags->>'impounded')::boolean, false) = false
     ORDER BY s.station_id, s.id`,
    [quantity],
  );
  const sorted = rows.sort((a, b) => Number((a as { tier?: number }).tier) - Number((b as { tier?: number }).tier));
  if (sorted.length < n) throw new Error(`only ${sorted.length} NL-1 ${quantity} series`);
  return sorted.slice(0, n).map((r) => ({ id: r.id, station: r.station_id }));
}

const logLines: string[] = [];
async function run(argv: string[], now: Date | (() => Date) = RUN1) {
  logLines.length = 0;
  const code = await climatologyMain(argv, { DATABASE_URL: h.t.urlFor('rws_migrator') }, (l) => logLines.push(l), {
    now: typeof now === 'function' ? now : () => now,
  });
  return { code, log: [...logLines] };
}
const ownIds = () => Object.values(id).join(',');
const countRows = async (series: number, open = true) =>
  (
    await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM reference_value
       WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY') ${open ? 'AND upper_inf(valid)' : ''}`,
      [series],
    )
  )[0]?.n;
const snapshotAt = async (t: Date): Promise<SnapshotDoc> => {
  const res = await app.request(`/api/v1/snapshot?t=${t.toISOString()}`);
  expect(res.status).toBe(200);
  const { attribution: _a, ...snap } = SnapshotAnswer.parse(await res.json());
  return snap;
};
const valueFor = (snap: SnapshotDoc, series: number) => snap.values.find((v) => v.series === series);
const hasDoy = (v: ReturnType<typeof valueFor>) => v?.basis?.ref.split('/').some((k) => k.endsWith('_DOY')) ?? false;

beforeAll(async () => {
  h = await harness();
  const a = h.t.admin;
  await a.query(`SELECT ensure_history_partitions('2009-01-01', '2021-01-01')`);
  await a.query(`SELECT ensure_partitions('2026-09-01', '2026-11-01')`);
  await a.query(`UPDATE app_meta SET value = to_jsonb('2026-10-01T00:00:00Z'::text) WHERE key = 'display_start'`);
  const qs = await pickSeries('Q', 6);
  const ls = await pickSeries('H', 1);
  const keys = ['a', 'nine', 'tidal', 'impounded', 'noHistory', 'spare'];
  keys.forEach((k, i) => {
    id[k] = (qs[i] as { id: number }).id;
    station[k] = (qs[i] as { station: string }).station;
  });
  id.level = (ls[0] as { id: number }).id;
  station.level = (ls[0] as { station: string }).station;
  const kaub = await q<{ id: number; station_id: string }>(
    `SELECT id, station_id FROM series WHERE provider_key = $1`,
    [KAUB_W],
  );
  id.stage = (kaub[0] as { id: number }).id;
  station.stage = (kaub[0] as { station_id: string }).station_id;
  await a.query(`UPDATE station SET flags = COALESCE(flags, '{}'::jsonb) || '{"tidal": true}' WHERE id = $1`, [
    station.tidal,
  ]);
  await a.query(`UPDATE station SET flags = COALESCE(flags, '{}'::jsonb) || '{"impounded": true}' WHERE id = $1`, [
    station.impounded,
  ]);
  await a.query(`UPDATE series SET lic_override = '{"history_export": false}' WHERE id = $1`, [id.noHistory]);

  for (const k of ['a', 'tidal', 'impounded', 'noHistory', 'level', 'stage']) {
    await seedHourly(a, id[k] as number, TEN_YEARS, SHAPE);
  }
  await seedHourly(a, id.nine as number, { from: '2010-01-01T00:00:00Z', to: '2019-01-01T00:00:00Z' }, SHAPE);
  // A value above the day's P90 now, and the same at a past instant (before the first run).
  for (const k of ['a', 'nine']) {
    await a.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 400, 1, 1), ($1, $3, 400, 1, 1)`,
      [id[k], '2026-10-26T11:50:00Z', '2026-10-20T11:50:00Z'],
    );
  }

  const api = h.dbAs('rws_api', 4);
  apiDb = api.db;
  publishDb = h.dbAs('rws_publish', 2);
  const window = new DisplayWindow(api.db);
  expect(await window.refresh()).toBe(true);
  app = createApp({ db: api.db, window, now: () => NOW });
}, 300_000);
afterAll(() => h.close());

describe('usage and configuration', { timeout: 120_000 }, () => {
  it('rejects bad arguments with 64 and a missing database with 78', async () => {
    for (const argv of [
      ['--family', 'both'],
      ['--family'],
      ['--series', '1,x'],
      ['--series', '0'],
      ['--dry-run', '--dry-run'],
      ['--family', 'public', '--family', 'owner'],
      ['extra'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(64);
    }
    const none: string[] = [];
    expect(await climatologyMain([], {}, (l) => none.push(l))).toBe(78);
    expect(none.join()).toMatch(/RWS_DB_HOST/);
  });
});

describe('the public family', { timeout: 300_000 }, () => {
  it('a dry run writes nothing and counts what a run would write', async () => {
    const r = await run(['--dry-run', '--family', 'public', '--series', ownIds()]);
    expect(r.code).toBe(0);
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toMatch(
      /\(dry run\).*with a set 2, years per set 10-10, rows new 1460, changed 0, unchanged 0, closed 0/,
    );
    expect(await countRows(id.a as number, false)).toBe(0);
  });

  it('eligible series get 730 rows with the plan shape; nine years, stage, tidal, impounded and no history get none', async () => {
    const r = await run(['--family', 'public', '--series', ownIds()]);
    expect(r.code).toBe(0);
    // a and the level series are the two with a set; nine, noHistory... are counted as considered, not eligible
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toMatch(/with a set 2, years per set 10-10, rows new 1460, changed 0, unchanged 0, closed 0/);
    expect(await countRows(id.a as number)).toBe(730);
    expect(await countRows(id.level as number)).toBe(730);
    for (const k of ['nine', 'tidal', 'impounded', 'noHistory', 'stage', 'spare'])
      expect(await countRows(id[k] as number, false), k).toBe(0);
    const rows = await q<Record<string, unknown>>(
      `SELECT source_id, unit, semantics, percentile_convention, priority, basis_label, batch_id, seen_batch,
              period::text AS period, season_from_md, season_to_md, lower(valid) AS lo, upper_inf(valid) AS open
       FROM reference_value WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY')`,
      [id.a],
    );
    expect(new Set(rows.map((x) => x.source_id))).toEqual(new Set(['NL-1']));
    expect(new Set(rows.map((x) => x.unit))).toEqual(new Set(['m³/s']));
    expect(new Set(rows.map((x) => x.semantics))).toEqual(new Set(['statistical']));
    expect(new Set(rows.map((x) => x.percentile_convention))).toEqual(new Set(['non_exceedance']));
    expect(new Set(rows.map((x) => x.priority))).toEqual(new Set([0]));
    expect(new Set(rows.map((x) => x.basis_label))).toEqual(new Set(['DOY P10-P90, 2010-2019, 31 d/yr']));
    expect(new Set(rows.map((x) => x.period))).toEqual(new Set(['[2010-01-01,2020-01-01)']));
    expect(new Set(rows.map((x) => x.batch_id))).toEqual(new Set([null]));
    expect(rows.every((x) => x.season_from_md === x.season_to_md && x.open)).toBe(true);
    expect(rows.every((x) => (x.lo as Date).getTime() === RUN1.getTime())).toBe(true);
    // 365 keys and no 29 February; the level series is in cm
    const keys = new Set(rows.map((x) => x.season_from_md));
    expect(keys.size).toBe(365);
    expect(keys.has(229)).toBe(false);
    expect(
      (
        await q<{ unit: string }>(
          `SELECT DISTINCT unit FROM reference_value WHERE series_id = $1 AND kind = 'P10_DOY'`,
          [id.level],
        )
      )[0]?.unit,
    ).toBe('cm');
    const dirty = await q<{ n: number }>(`SELECT count(*)::int AS n FROM publish_dirty WHERE kind = 'reference'`);
    expect(dirty[0]?.n).toBeGreaterThan(0);
  });

  it('prints counts only: no id, station or source of a series', async () => {
    const r = await run(['--dry-run', '--series', ownIds()]);
    const text = r.log.join('\n');
    for (const needle of [...Object.values(station), 'NL-1', 'DE-1', 'be.spw']) expect(text).not.toContain(needle);
    expect(r.log).toHaveLength(2);
    expect(r.log.map((l) => l.split(':')[1]?.trim())).toEqual(['family public (dry run)', 'family owner (dry run)']);
  });

  it('/snapshot states the DOY basis from the run on: 10 years yes, 9 years no, before the run no', async () => {
    const now = await snapshotAt(NOW);
    const a = valueFor(now, id.a as number);
    expect(a?.state).toBe('elevated');
    expect(a?.basis).toMatchObject({ source: 'NL-1', kind: 'statistical', ref: 'P90_DOY' });
    expect(a?.basis?.label).toBe('DOY P10/P90 2010–2019');
    expect(hasDoy(valueFor(now, id.nine as number))).toBe(false);
    // 400 is above every day's P90, but the instant is before the run's start: not DOY
    expect(hasDoy(valueFor(await snapshotAt(new Date('2026-10-20T12:00:00Z')), id.a as number))).toBe(false);
  });

  it('a forecast instant gets the rows of its own day', async () => {
    const t = Date.parse('2026-10-27T12:00:00Z');
    const read = await readStates(apiDb, 'public', t, {
      now: T_NOW,
      current: false,
      sections: new Map(),
      forecast: new Map([[id.a as number, { ts: t, value: 400 }]]),
    });
    const a = read.series.find((s) => s.series === id.a);
    expect(a?.classified.basis?.ref).toBe('P90_DOY');
  });

  it('the frames hour state equals the snapshot state at the end of that hour, over midnight', async () => {
    const from = Date.parse('2026-10-25T22:00:00Z');
    const hours = 6;
    const md = (ms: number) => Number(new Date(ms).toISOString().slice(5, 10).replace('-', ''));
    const bounds = new Map<number, { p10: number; p90: number }>();
    const rows = await doyRows(h.t.admin, id.a as number);
    for (const key of [1025, 1026]) {
      bounds.set(key, {
        p10: rows.find((r) => r.kind === 'P10_DOY' && r.md === key)?.value as number,
        p90: rows.find((r) => r.kind === 'P90_DOY' && r.md === key)?.value as number,
      });
    }
    const vlast: number[] = [];
    for (let i = 0; i < hours; i++) {
      const b = bounds.get(md(from + i * H)) as { p10: number; p90: number };
      const value = [b.p10 - 1, (b.p10 + b.p90) / 2, b.p90 + 1][i % 3] as number;
      vlast.push(value);
      await h.t.admin.query(`INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 1, 1)`, [
        id.a,
        new Date(from + i * H + 50 * 60_000).toISOString(),
        value,
      ]);
    }
    const frames = { ids: [id.a as number], vlast: [vlast] };
    const cache = new StaticCache(60_000, () => T_NOW);
    const cached = await readHourStates(apiDb, 'public', frames, from, from + hours * H, {
      now: T_NOW,
      sections: new Map(),
      cache,
    });
    const fresh = await readHourStates(apiDb, 'public', frames, from, from + hours * H, {
      now: T_NOW,
      sections: new Map(),
      memo: new HourMemo(),
      versionOf: () => 1,
    });
    expect(fresh).toEqual(cached);
    const codes = new Set<number | null | undefined>();
    for (let i = 0; i < hours; i++) {
      const t = from + (i + 1) * H - 1;
      const s = (
        await readStates(apiDb, 'public', t, { now: T_NOW, current: false, sections: new Map(), cache })
      ).series.find((x) => x.series === id.a);
      const expected = stateCode(
        (s as NonNullable<typeof s>).classified.state,
        (s as NonNullable<typeof s>).classified.section,
      );
      expect(cached[0]?.[i], `hour ${i}`).toBe(expected);
      codes.add(cached[0]?.[i]);
    }
    // low, normal and elevated all occur: the equality is not a coincidence of one state
    expect(codes.size).toBe(3);
  });

  it('the coverage counts the stations with a set and those whose basis is one', async () => {
    const read = await readStates(apiDb, 'public', T_NOW, { now: T_NOW, current: true, sections: new Map() });
    const c = classCoverage(read);
    // a is at a tier-1 station; the level series has no current value, so it has a set but no basis
    expect(c.tier1.climatology).toBeGreaterThanOrEqual(1);
    expect(c.tier1.by_climatology).toBeGreaterThanOrEqual(1);
    expect(c.tier1.by_climatology).toBeLessThanOrEqual(c.tier1.climatology);
    expect(c.tier1.by_climatology).toBeLessThanOrEqual(c.tier1.classed);
    const nl = c.countries.find((x) => x.country === 'NL');
    expect(nl?.tier1.climatology).toBe(c.tier1.climatology);
    // before the run: no set, no climatology basis
    const before = classCoverage(
      await readStates(apiDb, 'public', Date.parse('2026-10-20T12:00:00Z'), {
        now: T_NOW,
        current: false,
        sections: new Map(),
      }),
    );
    expect(before.tier1).toMatchObject({ climatology: 0, by_climatology: 0 });
  });

  it('recent.json carries no day-of-year row, although rows are valid now', async () => {
    const valid = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM reference_value WHERE series_id = $1 AND kind = 'P90_DOY' AND valid @> $2::timestamptz`,
      [id.a, NOW.toISOString()],
    );
    expect(valid[0]?.n).toBe(365);
    const recent = StationRecent.parse(
      await renderStation(await ctxFor(publishDb, 'public', { now: T_NOW }), station.a as string),
    );
    const refs = recent.series.flatMap((s) => s.references);
    expect(JSON.stringify(refs)).not.toContain('_DOY');
  });
});

describe('re-runs', { timeout: 300_000 }, () => {
  const marks = () =>
    q<{ n: number; sum: string }>(
      `SELECT (SELECT count(*)::int FROM publish_dirty) AS n,
              (SELECT md5(string_agg(series_id || kind || season_from_md || value || valid::text, ',' ORDER BY series_id, kind, season_from_md, lower(valid)))
               FROM reference_value WHERE kind IN ('P10_DOY', 'P90_DOY')) AS sum`,
    ).then((r) => r[0] as { n: number; sum: string });

  it('a re-run that changes nothing writes nothing, the dirty log included', async () => {
    const before = await marks();
    const r = await run(['--series', ownIds()], new Date(RUN1.getTime() + H));
    expect(r.code).toBe(0);
    expect(r.log[0]).toMatch(/rows new 0, changed 0, unchanged 1460, closed 0/);
    expect(await marks()).toEqual(before);
  });

  it('a changed history closes the old rows at the run and opens new ones', async () => {
    await q(`UPDATE obs SET value = value + 500 WHERE series_id = $1 AND ts >= '2015-01-01' AND ts < '2016-01-01'`, [
      id.a,
    ]);
    const second = new Date(RUN1.getTime() + 2 * 86_400_000);
    // the clock moves a minute after the run's start: the dirty range ends at the write, not at the start (R1-10)
    let ticks = 0;
    const r = await run(['--series', ownIds()], () => new Date(second.getTime() + (ticks++ === 0 ? 0 : 60_000)));
    expect(r.code).toBe(0);
    const dirty = await q<{ from_ts: Date; to_ts: Date }>(
      `SELECT from_ts, to_ts FROM publish_dirty WHERE kind = 'reference' AND family = 'public' AND from_ts = $1`,
      [second.toISOString()],
    );
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty.every((d) => d.to_ts.getTime() === second.getTime() + 60_000)).toBe(true);
    const m = /rows new 0, changed (\d+), unchanged (\d+), closed 0/.exec(r.log[0] ?? '');
    expect(m).not.toBeNull();
    const changed = Number(m?.[1]);
    expect(changed).toBeGreaterThan(0);
    expect(Number(m?.[2]) + changed).toBe(1460);
    expect(await countRows(id.a as number)).toBe(730);
    const closed = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM reference_value
       WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY') AND NOT upper_inf(valid) AND upper(valid) = $2`,
      [id.a, second.toISOString()],
    );
    expect(closed[0]?.n).toBe(changed);
    const reopened = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM reference_value
       WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY') AND upper_inf(valid) AND lower(valid) = $2`,
      [id.a, second.toISOString()],
    );
    expect(reopened[0]?.n).toBe(changed);
  });

  it('a series that is no longer eligible has its open rows closed and states no DOY basis', async () => {
    await q(`UPDATE station SET flags = COALESCE(flags, '{}'::jsonb) || '{"tidal": true}' WHERE id = $1`, [station.a]);
    const third = new Date(RUN1.getTime() + 3 * 86_400_000);
    const r = await run(['--family', 'public', '--series', ownIds()], third);
    expect(r.code).toBe(0);
    expect(r.log[0]).toMatch(/rows new 0, changed 0, unchanged 730, closed 730/);
    expect(await countRows(id.a as number)).toBe(0);
    expect(await countRows(id.a as number, false)).toBeGreaterThan(730);
  });

  it('a deactivated series has its open rows closed (R1-2)', async () => {
    expect(await countRows(id.level as number)).toBe(730);
    await q(`UPDATE series SET active = false WHERE id = $1`, [id.level]);
    const fourth = new Date(RUN1.getTime() + 4 * 86_400_000);
    const r = await run(['--family', 'public', '--series', ownIds()], fourth);
    expect(r.code).toBe(0);
    expect(r.log[0]).toMatch(/with a set 0, years per set none, rows new 0, changed 0, unchanged 0, closed 730/);
    expect(await countRows(id.level as number)).toBe(0);
    expect(await countRows(id.level as number, false)).toBe(730);
  });
});
