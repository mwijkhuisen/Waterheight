import {
  type CanonRun,
  checkRun,
  FORECAST_SOURCES,
  type ForecastRunIn,
  firstValid,
  float32,
  lastValid,
} from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNlForecastFixtureArchive, NL_FORECAST_FIXTURES, recorded } from '../../../../scripts/fixture-archive.ts';
import { normaliseForecast } from '../../src/adapters/nl-1/normalise.ts';
import { parseWaarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { runHash } from '../../src/load/forecasts.ts';
import { replay } from '../../src/load/replay.ts';
import { registryOf } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// P8a criterion "replay rebuilds runs without duplicates" for NL-1, with the REAL captures through the real loader
// (the real NL-1 adapter, the pipeline, forecast_run / forecast_value as rws_load): the P1a recording and the captures
// exported from the production archive (scripts/fixture-archive.ts NL_FORECAST_FIXTURES) load in order, reversed and
// shuffled to the same runs, one per (series, first valid time, hash), each held as the earliest capture of its run; a
// second pass (a replay, twice) writes nothing; and `replay` over the built archive loads it the first time and
// writes nothing the second.

const NOW = new Date('2026-10-03T12:00:00Z');
const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const DRIEL_H = 'driel.beneden/WATHTE/NAP/other:F007';
const DECL = FORECAST_SOURCES['NL-1'];
const registry = registryOf('NL-1');
const ALL = NL_FORECAST_FIXTURES.map((_, i) => i);

// The captures by index: 0 the P1a recording (2026-09-29, a run of its own), 1-4 Lobith Q (04:25Z and 05:25Z of one
// run, 06:25Z and 07:25Z of the next), 5-7 Driel beneden H (03:45Z, then 06:45Z and 09:45Z of the next run), 8 the
// all-gap Alblasserdam list (unregistered).
const ORDERS: Readonly<Record<string, readonly number[]>> = {
  'in order': ALL,
  reversed: [...ALL].reverse(),
  shuffled: [0, 4, 1, 3, 2, 7, 5, 8, 6],
};

type Expected = {
  series: string;
  first: number;
  last: number;
  hash: string;
  n: number;
  fetchedAt: number;
  run: CanonRun;
};

/** The runs the captures make, from the pure adapter alone: per (series, end) the earliest capture, fetched at the first. */
function expectedRuns(): Expected[] {
  const byEnd = new Map<string, Expected>();
  for (const f of NL_FORECAST_FIXTURES) {
    const { body, at } = recorded(f.name, 'NL-1');
    const fetchedAt = at.getTime();
    for (const r of normaliseForecast(parseWaarnemingen(body), { registry, fetchedAt }).forecasts ?? []) {
      const checked = checkRun(r as ForecastRunIn, fetchedAt, DECL);
      const run = checked.run as CanonRun;
      const key = `${r.series}|${lastValid(run)}`;
      const held = byEnd.get(key);
      const entry = {
        series: r.series,
        first: firstValid(run),
        last: lastValid(run),
        hash: runHash(run).toString('hex'),
        n: run.points.length,
        fetchedAt,
        run,
      };
      if (held === undefined) byEnd.set(key, entry);
      else
        byEnd.set(key, {
          ...(entry.first < held.first ? entry : held),
          fetchedAt: Math.min(held.fetchedAt, fetchedAt),
        });
    }
  }
  return [...byEnd.values()].sort((a, b) => (a.series === b.series ? a.first - b.first : a.series < b.series ? -1 : 1));
}
const EXPECTED = expectedRuns();
const TOTAL_POINTS = EXPECTED.reduce((n, e) => n + e.n, 0);

type Row = Record<string, unknown>;
let h: Harness;
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(text, args)).rows;

/** Every stored NL-1 run with its points, in a fixed order. */
async function stored() {
  const runs = await q(
    `SELECT r.id::text AS id, s.provider_key AS series, r.first_valid, r.last_valid, r.fetched_at, r.issued_at,
            r.issued_inferred, encode(r.content_hash, 'hex') AS hash, r.kind, r.step::text AS step,
            r.provider_segment_end
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE r.source_id = 'NL-1' ORDER BY s.provider_key, r.first_valid`,
  );
  const out: (Row & { points: Row[] })[] = [];
  for (const r of runs) {
    const points = await q(
      'SELECT valid_ts, value, flags FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts',
      [r.id],
    );
    out.push({ ...r, id: undefined, points });
  }
  return out;
}

/** What the loader must have stored: the earliest capture of each run, fetched at the first, issued then (inferred). */
function assertRuns(actual: Awaited<ReturnType<typeof stored>>): void {
  expect(actual.map((r) => [r.series, r.first_valid, r.last_valid, r.hash, r.points.length])).toEqual(
    EXPECTED.map((e) => [e.series, new Date(e.first), new Date(e.last), e.hash, e.n]),
  );
  for (const [i, r] of actual.entries()) {
    const e = EXPECTED[i] as Expected;
    expect(r).toMatchObject({
      fetched_at: new Date(e.fetchedAt),
      issued_at: new Date(e.fetchedAt),
      issued_inferred: true,
      kind: 'deterministic',
      step: '00:10:00',
      provider_segment_end: null,
    });
    // Every value as float32, in time order, with no flags: the earliest capture's own points.
    expect(r.points.map((p) => [(p.valid_ts as Date).getTime(), Math.fround(p.value as number), p.flags])).toEqual(
      e.run.points.map((p) => [p.ms, float32(p.v[0] as number), 0]),
    );
  }
}

const batches = (spec: string) =>
  q('SELECT n_rows, n_new, n_changed, n_skipped, parse_status FROM ingest_batch WHERE spec_id = $1 ORDER BY id', [
    spec,
  ]);
const numbers = (rows: Row[]) => rows.map((r) => [r.n_rows, r.n_new, r.n_changed, r.n_skipped]);
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
});
const REPLAY = { source: 'NL-1', spec: null, from: '2026-09-29', to: '2026-10-31', dryRun: false } as const;

describe('the expected runs (from the adapter alone)', () => {
  it('are four runs of two registered series; the all-gap list at an unregistered location is none', () => {
    expect(EXPECTED.map((e) => [e.series, e.n])).toEqual([
      [DRIEL_H, 153],
      [DRIEL_H, 279],
      [LOBITH_Q, 237],
      [LOBITH_Q, 149],
      [LOBITH_Q, 281],
    ]);
    expect(TOTAL_POINTS).toBe(153 + 279 + 237 + 149 + 281);
  });
});

for (const [label, order] of Object.entries(ORDERS)) {
  describe(`the captures loaded ${label}`, { timeout: 300_000 }, () => {
    beforeAll(async () => {
      h = await harness();
    }, 120_000);
    afterAll(() => h.close());

    it('make the same runs: one per (series, first valid time, hash), the earliest capture of each', async () => {
      const lines = await buildNlForecastFixtureArchive(h.raw, order);
      expect(lines).toHaveLength(NL_FORECAST_FIXTURES.length);
      expect(await h.loader({ now: NOW }).tick()).toEqual({ lines: lines.length, loaded: lines.length });
      expect(await q("SELECT 1 FROM ingest_batch WHERE parse_status <> 'ok'")).toEqual([]);
      assertRuns(await stored());
      // A value nobody stated is never stored: the points held are exactly the runs' points.
      expect(await h.count('forecast_value')).toBe(TOTAL_POINTS);
      expect(await h.count('forecast_run')).toBe(EXPECTED.length);
      // Only the unregistered list is skipped (a replay after a registry change could still load it).
      expect(
        h.alerts.filter((a) => a.code === 'quarantined' || a.code === 'load_stalled' || a.code === 'beyond_horizon'),
      ).toEqual([]);
    });

    it('count their points once: n_new over the batches is the points held, whatever the order', async () => {
      const all = [...(await batches('nl-1-fc-1h')), ...(await batches('nl-1-fc-3h-0'))];
      expect(all.reduce((n, b) => n + (b.n_new as number), 0)).toBe(TOTAL_POINTS);
      // Every capture that is a tail of a run already held, or whose own tail is held, is the same run: the
      // unregistered list is the only batch with a skipped series.
      expect(all.filter((b) => (b.n_skipped as number) > 0)).toEqual([
        { n_rows: 0, n_new: 0, n_changed: 0, n_skipped: 1, parse_status: 'ok' },
      ]);
    });

    it('a second pass, a replay twice, writes nothing and changes nothing', async () => {
      const before = await stored();
      for (let round = 0; round < 2; round++) {
        expect(await replay(deps(), REPLAY)).toEqual({
          lines: NL_FORECAST_FIXTURES.length,
          loaded: NL_FORECAST_FIXTURES.length,
          quarantined: 0,
          skipped: 0,
          n_new: 0,
          n_changed: 0,
        });
      }
      expect(await stored()).toEqual(before);
      assertRuns(await stored());
    });
  });
}

describe('the load order shows in the batches', { timeout: 300_000 }, () => {
  it('in order a later capture of a run is a confirmation; reversed an earlier one extends the run by its heads', async () => {
    const run = async (order: readonly number[]) => {
      h = await harness();
      try {
        await buildNlForecastFixtureArchive(h.raw, order);
        await h.loader({ now: NOW }).tick();
        return { hourly: numbers(await batches('nl-1-fc-1h')), tier: numbers(await batches('nl-1-fc-3h-0')) };
      } finally {
        await h.close();
      }
    };
    // [n_rows, n_new, n_changed, n_skipped]; the P1a recording (09-29) is a file of its own and loads first.
    expect(await run(ALL)).toEqual({
      hourly: [
        [237, 237, 0, 0],
        [149, 149, 0, 0],
        [143, 0, 0, 0],
        [281, 281, 0, 0],
        [275, 0, 0, 0],
      ],
      tier: [
        [153, 153, 0, 0],
        [279, 279, 0, 0],
        [261, 0, 0, 0],
        [0, 0, 0, 1],
      ],
    });
    // Reversed: the last capture of a run first, then the captures that had dropped less: each adds the six hourly
    // heads (the 3-hour tier: eighteen) and changes the run it extends, nothing else.
    expect(await run([8, 7, 6, 5, 4, 3, 2, 1, 0])).toEqual({
      hourly: [
        [237, 237, 0, 0],
        [275, 275, 0, 0],
        [281, 6, 1, 0],
        [143, 143, 0, 0],
        [149, 6, 1, 0],
      ],
      tier: [
        [0, 0, 0, 1],
        [261, 261, 0, 0],
        [279, 18, 1, 0],
        [153, 153, 0, 0],
      ],
    });
  });
});

describe('replay over the fixture archive', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    h = await harness();
  }, 120_000);
  afterAll(() => h.close());

  it('loads the runs the first time and writes nothing the second (n_new 0, n_changed 0)', async () => {
    const lines = await buildNlForecastFixtureArchive(h.raw);
    // Dry run first: counts the lines, writes nothing.
    expect(await replay(deps(), { ...REPLAY, dryRun: true })).toMatchObject({ lines: lines.length, loaded: 0 });
    expect(await h.count('forecast_run')).toBe(0);
    const first = await replay(deps(), REPLAY);
    expect(first).toEqual({
      lines: lines.length,
      loaded: lines.length,
      quarantined: 0,
      skipped: 0,
      n_new: TOTAL_POINTS,
      n_changed: 0,
    });
    assertRuns(await stored());
    const second = await replay(deps(), REPLAY);
    expect(second).toEqual({
      lines: lines.length,
      loaded: lines.length,
      quarantined: 0,
      skipped: 0,
      n_new: 0,
      n_changed: 0,
    });
    assertRuns(await stored());
    // By spec: the 1-hour captures alone, then the 3-hour tier alone, change nothing either.
    for (const spec of ['nl-1-fc-1h', 'nl-1-fc-3h-0']) {
      expect(await replay(deps(), { ...REPLAY, spec })).toMatchObject({ quarantined: 0, n_new: 0, n_changed: 0 });
    }
    expect(await h.count('forecast_value')).toBe(TOTAL_POINTS);
  });

  it('the tail then loads nothing new either: its cursor is its own, the batches are the replay’s', async () => {
    expect(await h.loader({ now: NOW }).tick()).toMatchObject({ lines: NL_FORECAST_FIXTURES.length });
    assertRuns(await stored());
    expect(await h.count('forecast_value')).toBe(TOTAL_POINTS);
  });
});
