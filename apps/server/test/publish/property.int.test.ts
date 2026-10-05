import { type ForecastRun, pickRun, SnapshotFile, StaticForecastLatest, toSnapshot } from '@rws/contracts';
import { FORECAST_FLAGS } from '@rws/core';
import { holdForecasts } from '@rws/core/forecast-hold';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSnapshot } from '../../src/api/data.ts';
import { StaticCache } from '../../src/api/states.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import type { RenderCtx } from '../../src/publish/cycle.ts';
import { attributionRows } from '../../src/publish/render/attribution.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { type Harness, harness } from '../load/harness.ts';

// P9a (plan §4.10, "Property test, 200 T"). Past t: the published SnapshotFile equals an independent reference (base
// tables, the visibility rules spelt out, LOCF `ts > t − staleness AND ts <= t`) on generated observations, stale
// series and the boundary cases `ts = t − staleness` (out) and `ts = t` (in); it is rendered at a clock where t was the
// current bucket too (§9 C3: a recent file never depends on the clock). Future t: holdForecasts over the published
// forecast/latest.json equals a naive latest-run-per-source Q2 over the base tables, plus pickRun's precedence.

const NOW = Date.parse('2026-10-04T12:00:00Z'); // on the hour: the 48 h horizon ends on a point
const T0 = Date.parse('2026-10-01T00:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const STALENESS_MIN = [10, 30, 45, 60, 120] as const;
const SOURCES = ['NL-1', 'FR-4', 'CH-4'] as const;
type Kind = 'a' | 'b' | 'c' | 'nodisplay' | 'off' | 'owner' | 'twin' | 'inactive';
const KINDS: Kind[] = ['a', 'b', 'c', 'nodisplay', 'off', 'owner', 'twin', 'inactive'];
const VISIBLE: Kind[] = ['a', 'b', 'c'];

let h: Harness;
let ids: Record<Kind, number>;
let db: ReturnType<Harness['dbAs']>;
const seen = { boundaryOut: 0, boundaryIn: 0, stale: 0, held: 0, noRun: 0, precedence: 0 };
let counter = 0;

const q = (text: string, values: unknown[] = []) => h.t.admin.query(text, values);
const iso = (ms: number) => new Date(ms).toISOString();

async function mk(kind: Kind): Promise<number> {
  const station = `nl.prop.${kind}`;
  await q("INSERT INTO station (id, name, country, tier) VALUES ($1, $1, 'NL', 2)", [station]);
  const audience = kind === 'off' ? 'off' : kind === 'owner' ? 'owner' : null;
  const override = kind === 'nodisplay' ? '{"display": false}' : null;
  const r = await q(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, audience, lic_override, active)
     VALUES ($1, 'NL-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', '10 min', '10 min', '45 min', $3, $4::audience, $5::jsonb, $6)
     RETURNING id`,
    [station, `prop-${kind}`, kind === 'twin' ? 'twin' : 'primary', audience, override, kind !== 'inactive'],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  h = await harness();
  await q(`SELECT ensure_partitions('2026-09-28'::timestamptz, '2026-10-08'::timestamptz)`);
  ids = {} as Record<Kind, number>;
  for (const k of KINDS) ids[k] = await mk(k);
  db = h.dbAs('rws_publish', 3);
}, 120_000);
afterAll(async () => {
  await h.close();
});

function ctx(now: number, cache = new StaticCache(60_000, () => now)): Promise<RenderCtx> {
  return attributionRows(db.db, 'public').then((attribution) => ({
    db: db.db,
    family: 'public',
    now,
    window: { dataEpochMs: T0 - 86_400_000, displayStartMs: T0 },
    build: 'dev',
    sections: vigicruesSections(),
    cache,
    inputs: undefined,
    attribution,
  }));
}

// --- past t ---------------------------------------------------------------------------------------------------

type SeriesSpec = {
  staleIdx: number;
  offsets: number[];
  edgeIn: boolean;
  edgeOut: boolean;
  values: number[];
  qcs: number[];
};
const seriesSpec = fc.record({
  staleIdx: fc.integer({ min: 0, max: STALENESS_MIN.length - 1 }),
  // Observation times in 10-minute steps relative to t.
  offsets: fc.uniqueArray(fc.integer({ min: -14, max: 2 }), { maxLength: 6 }),
  edgeIn: fc.boolean(),
  edgeOut: fc.boolean(),
  values: fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 12, maxLength: 12 }),
  qcs: fc.array(fc.constantFrom(0, 0, 1), { minLength: 12, maxLength: 12 }),
});

/** The reference: the base tables only, every visibility rule written out (no view, no function of the schema). */
async function reference(t: number): Promise<string[]> {
  const { rows } = await q(
    `SELECT s.id, o.ts, o.value, o.qc
     FROM series s
     JOIN source src ON src.id = s.source_id
     CROSS JOIN LATERAL (
       SELECT x.ts, x.value, x.qc FROM obs x
       WHERE x.series_id = s.id AND x.ts <= $1::timestamptz AND x.ts > $1::timestamptz - s.staleness_limit
       ORDER BY x.ts DESC LIMIT 1) o
     WHERE s.id = ANY($2::int[])
       AND s.active AND s.role = 'primary'
       AND src.audience::text = 'public' AND COALESCE(s.audience::text, 'public') = 'public'
       AND src.lic_display AND COALESCE((s.lic_override ->> 'display')::boolean, true)`,
    [iso(t), Object.values(ids)],
  );
  return rows.map((r) => `${r.id}|${r.ts.getTime()}|${r.value}|${r.qc}`).sort();
}

const published = (file: SnapshotFile): string[] =>
  toSnapshot(file)
    .values.map((v) => `${v.series}|${Date.parse(v.ts)}|${v.value}|${v.qc}`)
    .sort();

async function seed(t: number, specs: Record<Kind, SeriesSpec>) {
  const row = { id: [] as number[], ts: [] as string[], value: [] as number[], qc: [] as number[] };
  for (const kind of KINDS) {
    const spec = specs[kind];
    const staleness = STALENESS_MIN[spec.staleIdx] as number;
    const at = new Set(spec.offsets.map((o) => t + o * 10 * MIN));
    if (spec.edgeIn) at.add(t);
    if (spec.edgeOut) at.add(t - staleness * MIN);
    [...at].forEach((ms, i) => {
      row.id.push(ids[kind]);
      row.ts.push(iso(ms));
      row.value.push((spec.values[i % 12] as number) / 2);
      row.qc.push(spec.qcs[i % 12] as number);
    });
  }
  await q(`DELETE FROM obs WHERE series_id = ANY($1::int[])`, [Object.values(ids)]);
  await q(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::real[], $4::smallint[], array_fill(0::bigint, ARRAY[$5::int]))`,
    [row.id, row.ts, row.value, row.qc, row.id.length],
  );
  await q(
    `UPDATE series SET staleness_limit = (v.m || ' minutes')::interval FROM
       (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS m) v WHERE series.id = v.id`,
    [KINDS.map((k) => ids[k]), KINDS.map((k) => STALENESS_MIN[specs[k].staleIdx])],
  );
}

describe('the published snapshot equals the reference', { timeout: 600_000 }, () => {
  it('property: 200 instants over generated observations, staleness and boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 400 }),
        fc.record(Object.fromEntries(KINDS.map((k) => [k, seriesSpec])) as Record<Kind, typeof seriesSpec>),
        fc.boolean(),
        async (step, specs, wasCurrent) => {
          const t = T0 + step * 10 * MIN;
          await seed(t, specs as Record<Kind, SeriesSpec>);
          const expected = await reference(t);
          // The renderer at the instant after the bucket began (t was the current bucket then) or long after.
          const c = await ctx(wasCurrent ? t + MIN : NOW);
          const file = SnapshotFile.parse(await RENDERERS.snapshot(c, t));
          expect(published(file)).toEqual(expected);
          // Counters: the generated data reached both edges and the stale case.
          for (const k of VISIBLE) {
            const s = (specs as Record<Kind, SeriesSpec>)[k];
            const stale = (STALENESS_MIN[s.staleIdx] as number) * MIN;
            if (s.edgeOut && !expected.some((e) => e.startsWith(`${ids[k]}|${t - stale}|`))) seen.boundaryOut++;
            if (s.edgeIn && expected.some((e) => e.startsWith(`${ids[k]}|${t}|`))) seen.boundaryIn++;
            if (!expected.some((e) => e.startsWith(`${ids[k]}|`))) seen.stale++;
          }
        },
      ),
      { numRuns: 200 },
    );
    expect(seen.boundaryOut).toBeGreaterThan(5);
    expect(seen.boundaryIn).toBeGreaterThan(5);
    expect(seen.stale).toBeGreaterThan(5);
  });

  it('the edges by hand: ts = t − staleness is out, ts = t is in, one step older is stale', async () => {
    const t = T0 + 20 * HOUR;
    const spec = (offsets: number[], edgeIn: boolean, edgeOut: boolean): SeriesSpec => ({
      staleIdx: 2, // 45 min
      offsets,
      edgeIn,
      edgeOut,
      values: Array(12).fill(10),
      qcs: Array(12).fill(0),
    });
    const none = spec([], false, false);
    await seed(t, {
      a: spec([], false, true), // only t − 45 min: out
      b: spec([], true, false), // only t: in
      c: spec([-4], false, false), // t − 40 min: in (LOCF)
      nodisplay: spec([0], true, false),
      off: spec([0], true, false),
      owner: spec([0], true, false),
      twin: spec([0], true, false),
      inactive: none,
    });
    const file = SnapshotFile.parse(await RENDERERS.snapshot(await ctx(NOW), t));
    expect(file.series).toEqual([ids.b, ids.c]);
    expect(published(file)).toEqual(await reference(t));
    expect(file.ageSeconds).toEqual([0, 2400]);
  });

  it('a bucket that was the current one at an earlier clock is rendered without the clock (§9 C3)', async () => {
    const t = T0 + 30 * HOUR;
    await seed(t, {
      ...Object.fromEntries(
        KINDS.map((k) => [
          k,
          {
            staleIdx: 3,
            offsets: [0],
            edgeIn: false,
            edgeOut: false,
            values: Array(12).fill(40),
            qcs: Array(12).fill(0),
          },
        ]),
      ),
    } as Record<Kind, SeriesSpec>);
    const station = 'nl.prop.a';
    // A provider class on the station, from a source whose last successful fetch is long past.
    await q(
      `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, level_norm)
       VALUES ('station', $1, $2, 'CH-1', '3', 4)`,
      [station, iso(t - HOUR)],
    );
    await q(
      `INSERT INTO source_health (source_id, last_fetch_ok, status) VALUES ('CH-1', $1, 'degraded')
       ON CONFLICT (source_id) DO UPDATE SET last_fetch_ok = EXCLUDED.last_fetch_ok`,
      [iso(t - 10 * HOUR)],
    );
    const state = (file: SnapshotFile) => file.state[file.series.indexOf(ids.a)];
    // At the clock t + 1 min the bucket is the current one: the API judges the class by the last fetch (stale: ignored).
    const apiNow = await readSnapshot(db.db, 'public', t, {
      now: t + MIN,
      sections: vigicruesSections(),
      cache: new StaticCache(60_000, () => 0),
    });
    const asCurrent = apiNow.values.find((v) => v.series === ids.a)?.state;
    const asPast = (
      await readSnapshot(db.db, 'public', t, {
        now: t + 3 * HOUR,
        sections: vigicruesSections(),
        cache: new StaticCache(60_000, () => 0),
      })
    ).values.find((v) => v.series === ids.a)?.state;
    expect(asPast).not.toBe(asCurrent); // the fixture makes the two readings differ
    // The published file is the past reading at any clock.
    for (const now of [t + MIN, t + 3 * HOUR, NOW]) {
      const file = SnapshotFile.parse(await RENDERERS.snapshot(await ctx(now + counter++), t));
      expect(state(file), `at the clock ${iso(now)}`).toBe(asPast);
    }
    await q('DELETE FROM class_obs');
  });
});

// --- future t -------------------------------------------------------------------------------------------------

type RunSpec = {
  issuedH: number;
  lagMin: number;
  inferred: boolean;
  firstH: number;
  lenH: number;
  belowAt: number | null;
};
const runSpec = fc.record({
  issuedH: fc.integer({ min: -30, max: 2 }),
  lagMin: fc.integer({ min: 0, max: 90 }),
  inferred: fc.boolean(),
  firstH: fc.integer({ min: -6, max: 0 }),
  lenH: fc.integer({ min: 1, max: 60 }),
  belowAt: fc.option(fc.integer({ min: 0, max: 59 }), { nil: null }),
});
const runsFor = fc.array(runSpec, { maxLength: 2 });
const FC_KINDS: Kind[] = ['a', 'b', 'c', 'nodisplay', 'off', 'owner', 'twin'];

async function seedRuns(plan: Record<string, RunSpec[]>) {
  await q('DELETE FROM forecast_value');
  await q('DELETE FROM forecast_run');
  let n = 0;
  for (const kind of FC_KINDS)
    for (const source of SOURCES)
      for (const r of plan[`${kind}/${source}`] ?? []) {
        n++;
        const first = NOW + r.firstH * HOUR;
        const issued = NOW + r.issuedH * HOUR;
        const fetched = issued + r.lagMin * MIN;
        const run = await q(
          `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                     content_hash, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, decode(md5($8), 'hex'), 'deterministic') RETURNING id`,
          [
            ids[kind],
            source,
            r.inferred ? null : iso(issued),
            r.inferred,
            iso(first),
            iso(first + (r.lenH - 1) * HOUR),
            iso(fetched),
            `run-${n}`,
          ],
        );
        await q(
          `INSERT INTO forecast_value (run_id, valid_ts, value, flags)
           SELECT $1, $2::timestamptz + k * interval '1 hour', 100 * $4::int + k, CASE WHEN k = $3 THEN ${FORECAST_FLAGS.BELOW_FLOOR} ELSE 0 END
           FROM generate_series(0, $5::int - 1) k`,
          [run.rows[0].id, iso(first), r.belowAt ?? -1, SOURCES.indexOf(source) + 1, r.lenH],
        );
      }
}

type Held = { series: number; source: string; ts: number; value: number | null };

/** Naive Q2 over the base tables: per visible series and source the latest run known at `now` that reaches t. */
async function naiveQ2(now: number, t: number): Promise<Held[]> {
  const { rows } = await q(
    `SELECT s.id AS series, r.source_id AS source, r.first_valid, r.last_valid, v.valid_ts, v.value, v.flags
     FROM series s
     JOIN source fs0 ON fs0.id = s.source_id
     JOIN LATERAL (
       SELECT DISTINCT ON (x.source_id) x.* FROM forecast_run x
       WHERE x.series_id = s.id AND COALESCE(x.issued_at, x.fetched_at) <= $1::timestamptz AND x.fetched_at <= $1::timestamptz
       ORDER BY x.source_id, COALESCE(x.issued_at, x.fetched_at) DESC, x.fetched_at DESC, x.id DESC) r ON true
     JOIN source fs ON fs.id = r.source_id
     JOIN LATERAL (
       SELECT y.valid_ts, y.value, y.flags FROM forecast_value y
       WHERE y.run_id = r.id AND y.valid_ts >= r.first_valid AND y.valid_ts <= $2::timestamptz
       ORDER BY y.valid_ts DESC LIMIT 1) v ON true
     WHERE s.id = ANY($3::int[]) AND s.active AND s.role = 'primary'
       AND fs0.audience::text = 'public' AND COALESCE(s.audience::text, 'public') = 'public'
       AND fs0.lic_display AND COALESCE((s.lic_override ->> 'display')::boolean, true)
       AND fs.audience::text = 'public' AND fs.lic_display
       AND r.first_valid <= $2::timestamptz AND r.last_valid >= $2::timestamptz
     ORDER BY s.id`,
    [iso(now), iso(t), Object.values(ids)],
  );
  const bySeries = new Map<number, typeof rows>();
  for (const r of rows) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r]);
  return [...bySeries].map(([series, list]) => {
    const pick = pickRun(
      list.map((r) => ({ ...r, source: r.source as string })),
      () => true,
    ) as (typeof rows)[number];
    return {
      series,
      source: pick.source,
      ts: pick.valid_ts.getTime(),
      value: (pick.flags & FORECAST_FLAGS.BELOW_FLOOR) !== 0 ? null : pick.value,
    };
  });
}

describe('the published forecast holds what the naive Q2 gives', { timeout: 600_000 }, () => {
  it('property: 200 future instants over generated runs, sources and issue times', async () => {
    const keys = FC_KINDS.flatMap((k) => SOURCES.map((s) => `${k}/${s}`));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 288 }),
        fc.record(Object.fromEntries(keys.map((k) => [k, runsFor]))),
        async (step, plan) => {
          const now = NOW + counter++; // forecastOnce memoises per clock; each run is its own cycle
          const t = NOW + step * 10 * MIN;
          await seedRuns(plan as Record<string, RunSpec[]>);
          const c = await ctx(now);
          const file = StaticForecastLatest.parse(await RENDERERS.forecast(c));
          const held = holdForecasts(file.runs as readonly ForecastRun[], t).map(
            (x): Held => ({ series: x.series, source: x.source, ts: Date.parse(x.ts), value: x.value }),
          );
          const expected = await naiveQ2(now, t);
          expect(held).toEqual(expected);
          seen.held += expected.length;
          if (expected.length === 0) seen.noRun++;
          // Two sources reached t on one series: the precedence chose.
          const multi = new Map<number, Set<string>>();
          for (const r of file.runs) multi.set(r.series, new Set([...(multi.get(r.series) ?? []), r.source]));
          if ([...multi.values()].some((s) => s.size > 1)) seen.precedence++;
        },
      ),
      { numRuns: 200 },
    );
    expect(seen.held).toBeGreaterThan(20);
    expect(seen.noRun).toBeGreaterThan(0);
    expect(seen.precedence).toBeGreaterThan(0);
  });
});
