import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { combineRun, normalisePart } from '../../src/adapters/lu-3/normalise.ts';
import { parsePercentile } from '../../src/adapters/lu-3/parse.ts';
import { FORECAST_AT, VIEWS } from '../../src/db/audience.ts';
import { pruneStagedParts } from '../../src/load/forecasts.ts';
import { replay } from '../../src/load/replay.ts';
import { readMeta } from '../../src/load/store.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// P8a: LU-3 (AGE percentile forecasts, owner audience) through the real loader, the real adapter and the real
// registry, on synthetic files only (invariant 9): five files of a station and fetch hour make one quantile run of
// its LU-1 series, a run is one per (series, first valid time, hash), a replay writes nothing, Gemünd (withheld, off)
// and the LfU RLP gauges store nothing, and an LU-3 run is in the owner forecast views and in no public one.

// The loader's partitions end a few months after the real clock, so the synthetic files' steps are moved to the
// first days of October 2026 (the fixtures' own dates are in 2030).
const NOW = new Date('2026-10-03T03:00:00Z');
const HOUR = 3_600_000;
/** The first step of the files, UTC; the first group is fetched 105 minutes later. */
const FIRST = Date.parse('2026-10-02T21:00:00Z');
const AT = '2026-10-02T22:45:00Z';
const P = ['10', '30', '50', '70', '90'] as const;
const KEY = { diekirch: 'Diekirch', rosport: 'Rosport', bissen: 'Bissen', mersch: 'Mersch' } as const;

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(() => h.close());

type Row = Record<string, unknown>;
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(text, args)).rows;

type Data = [string, number][];
/** An AGE stamp: the instant with its +02:00 offset (CEST until 2026-10-25). */
const stamp = (ms: number) => new Date(ms + 2 * HOUR).toISOString().replace('Z', '+02:00');
/**
 * A synthetic percentile file of Diekirch (or of Perl): the values of the committed fixture on hourly steps from
 * FIRST, optionally without its first `skip` steps and with `bump` added to every value.
 */
const fixture = (p: string, o: { skip?: number; bump?: number; perl?: boolean } = {}) => {
  const name = `lu-3-percentile-${o.perl === true ? 'perl' : 'diekirch'}-p${p}.synthetic`;
  const doc = JSON.parse(rawFixture('LU-3', name).body.toString('utf8')) as { data: Data };
  const data = doc.data
    .map(([, v], i): [string, number] => [stamp(FIRST + i * HOUR), v + (o.bump ?? 0)])
    .slice(o.skip ?? 0);
  return Buffer.from(JSON.stringify({ ...doc, data }));
};
const put = (slug: string, p: string, at: string, body: Buffer) =>
  writePayload(h.archive, {
    source: 'LU-3',
    spec: 'lu-3-percentile',
    variant: `${slug}/${p}`,
    at: new Date(at),
    url: 'https://example.invalid/lu-3-percentile',
    body,
    retention: 'forever',
  });
const secs = (base: string, i: number) => new Date(Date.parse(base) + i * 1000).toISOString();
/** The five files of a station fetched in one hour, one second apart, in the order of `order`. */
async function group(
  slug: string,
  base: string,
  body: (p: string) => Buffer = (p) => fixture(p),
  order: readonly string[] = P,
) {
  for (const [i, p] of order.entries()) await put(slug, p, secs(base, i), body(p));
}
const tick = () => h.loader({ now: NOW }).tick();
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
});

const runsOf = (key: string) =>
  q(
    `SELECT r.id::text AS rid, r.first_valid, r.last_valid, r.fetched_at, r.issued_at, r.issued_inferred, r.kind,
            r.step::text AS step, r.provider_segment_end, encode(r.content_hash, 'hex') AS hash,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id) AS n
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE s.provider_key = $1 AND r.source_id = 'LU-3' ORDER BY r.first_valid, r.fetched_at`,
    [key],
  );
const batches = () =>
  q(
    `SELECT n_rows, n_new, n_changed, n_skipped, parse_status FROM ingest_batch
     WHERE spec_id = 'lu-3-percentile' ORDER BY id`,
  );
const staging = (slug: string) =>
  readMeta<{ groups: Record<string, { parts: Record<string, unknown> }> }>(h.load.db, `forecast_part:LU-3:${slug}`);
const counts = async () => ({
  runs: (await q('SELECT count(*)::int AS n FROM forecast_run'))[0]?.n,
  values: (await q('SELECT count(*)::int AS n FROM forecast_value'))[0]?.n,
});

/** What the adapter makes of the five synthetic Diekirch files: the points the first run must store. */
const expected = () => {
  const parts = P.map((p) => {
    const out = normalisePart(parsePercentile(fixture(p)), { variant: `diekirch/${p}`, keyOf: () => KEY.diekirch });
    return out.part as NonNullable<typeof out.part>;
  });
  return combineRun(parts).run?.points ?? [];
};

describe('LU-3 through the loader', { timeout: 300_000 }, () => {
  it('five files make one quantile run of the LU-1 series, whatever their order; Gemünd and Perl store nothing', async () => {
    // Diekirch: the 90 first and the 10 last. Rosport: in order. Gemünd: complete but withheld. Perl: not a seed slug.
    await group('diekirch', AT, (p) => fixture(p), ['90', '50', '30', '70', '10']);
    await group('rosport', secs(AT, 10));
    await group('gemund-our', secs(AT, 20));
    await put('perl', '50', secs(AT, 30), fixture('50', { perl: true }));
    expect(await tick()).toEqual({ lines: 16, loaded: 16 });

    const runs = await runsOf(KEY.diekirch);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      first_valid: new Date('2026-10-02T21:00:00Z'),
      last_valid: new Date('2026-10-04T18:00:00Z'),
      // No issue time in a file: the loader takes the earliest of the five fetches and says so.
      fetched_at: new Date(AT),
      issued_at: new Date(AT),
      issued_inferred: true,
      kind: 'quantiles',
      step: '01:00:00',
      provider_segment_end: null,
      n: 46,
    });
    expect((await runsOf(KEY.rosport)).map((r) => [r.n, r.fetched_at])).toEqual([[46, new Date(secs(AT, 10))]]);

    // The stored points are what the adapter's run states: p10 … p90 and `value` = p50, in float32.
    const points = expected();
    const rows = await q(
      `SELECT v.valid_ts, v.value, v.p10, v.p30, v.p50, v.p70, v.p90, v.p05, v.p25, v.p75, v.p95, v.vmin, v.vmax, v.flags
       FROM forecast_value v WHERE v.run_id = $1::bigint ORDER BY v.valid_ts`,
      [runs[0]?.rid],
    );
    expect(rows).toHaveLength(points.length);
    for (const [i, row] of rows.entries()) {
      const want = points[i] as (typeof points)[number];
      expect((row.valid_ts as Date).toISOString()).toBe(want.ts);
      for (const c of ['value', 'p10', 'p30', 'p50', 'p70', 'p90'] as const)
        expect([i, c, Math.fround(row[c] as number)]).toEqual([i, c, Math.fround(want[c] as number)]);
      for (const c of ['p05', 'p25', 'p75', 'p95', 'vmin', 'vmax']) expect(row[c]).toBeNull();
      expect(row.flags).toBe(want.flags);
    }

    // Withheld and out of scope: no run, nothing staged (Gemünd's series is off), Perl counted unknown.
    expect(await runsOf('Gemünd_Our')).toEqual([]);
    expect(await staging('gemund-our')).toBeUndefined();
    expect(await runsOf('Perl')).toEqual([]);
    expect(await staging('perl')).toBeUndefined();
    // The completed groups left the staging row empty.
    expect(await staging('diekirch')).toEqual({ groups: {} });

    const b = await batches();
    expect(b.filter((x) => x.n_new !== 0).map((x) => [x.n_rows, x.n_new, x.n_changed, x.n_skipped])).toEqual([
      [46, 46, 0, 0],
      [46, 46, 0, 0],
    ]);
    expect(b.at(-1)).toMatchObject({ n_rows: 0, n_new: 0, n_changed: 0, n_skipped: 1, parse_status: 'ok' });
    // Every other file only staged (or, for Gemünd, was set aside): counted nowhere, stored nowhere.
    expect(b.filter((x) => x.n_new === 0 && x.n_skipped === 0)).toHaveLength(13);
    expect(h.alerts.filter((a) => a.code === 'incomplete_run' || a.code === 'combine_drift')).toEqual([]);
  });

  it('a replay, twice, writes nothing', async () => {
    const before = await counts();
    const runs = await runsOf(KEY.diekirch);
    for (let round = 0; round < 2; round++) {
      const r = await replay(deps(), {
        source: 'LU-3',
        spec: null,
        from: '2026-10-02',
        to: '2026-10-03',
        dryRun: false,
      });
      expect(r).toMatchObject({ lines: 16, loaded: 16, quarantined: 0, n_new: 0, n_changed: 0 });
    }
    expect(await counts()).toEqual(before);
    expect(await runsOf(KEY.diekirch)).toEqual(runs);
    expect(await staging('diekirch')).toEqual({ groups: {} });
  });

  it('one run per (series, first valid time, hash): the same files an hour later are the same run, other values or another first step are others', async () => {
    // 23:45: the same five files (AGE re-served the window): the key is the same, the earliest fetch stays.
    await group('diekirch', '2026-10-02T23:45:00Z');
    // 00:45: the p90 file changed.
    await group('diekirch', '2026-10-03T00:45:00Z', (p) => fixture(p, p === '90' ? { bump: 1 } : {}));
    // 01:45: the window moved on by an hour (the first step is gone).
    await group('diekirch', '2026-10-03T01:45:00Z', (p) => fixture(p, { skip: 1 }));
    expect(await tick()).toEqual({ lines: 15, loaded: 15 });

    const runs = await runsOf(KEY.diekirch);
    expect(runs.map((r) => [r.first_valid, r.fetched_at, r.n])).toEqual([
      [new Date('2026-10-02T21:00:00Z'), new Date(AT), 46],
      [new Date('2026-10-02T21:00:00Z'), new Date('2026-10-03T00:45:00Z'), 46],
      [new Date('2026-10-02T22:00:00Z'), new Date('2026-10-03T01:45:00Z'), 45],
    ]);
    expect(new Set(runs.map((r) => r.hash)).size).toBe(3);
    // The same-run group was a confirmation: it wrote nothing (n_new 0, n_changed 0) but counted its 46 points.
    const b = await batches();
    expect(b.filter((x) => x.n_rows === 46 && x.n_new === 0)).toMatchObject([{ n_changed: 0, n_skipped: 0 }]);
    // A replay of everything is still a no-op.
    const before = await counts();
    const r = await replay(deps(), { source: 'LU-3', spec: null, from: '2026-10-02', to: '2026-10-03', dryRun: false });
    expect(r).toMatchObject({ lines: 31, loaded: 31, quarantined: 0, n_new: 0, n_changed: 0 });
    expect(await counts()).toEqual(before);
  });

  it('an LU-3 run is in the owner forecast views and in no public one (invariants 8 and 11)', async () => {
    const lu3 = await q(`SELECT id::text AS rid FROM forecast_run WHERE source_id = 'LU-3' ORDER BY id`);
    const ids = lu3.map((r) => r.rid as string);
    expect(ids).toHaveLength(4);
    const T = ['2026-10-03T03:00:00Z', '2026-10-03T03:00:00Z'];
    // A control: a public NL-1 run on a public series, so that the public views are shown to work and to hold only it.
    const control = (
      await q(
        `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                   content_hash, kind, step)
         SELECT s.id, 'NL-1', '2026-10-03T00:00:00Z', true, '2026-10-03T00:00:00Z', '2026-10-03T04:00:00Z',
                '2026-10-03T00:00:00Z', decode(repeat('ab', 32), 'hex'), 'deterministic', interval '1 hour'
         FROM series s WHERE s.provider_key = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007'
         RETURNING id::text AS rid`,
      )
    )[0]?.rid as string;
    await q(
      `INSERT INTO forecast_value (run_id, valid_ts, value)
       SELECT $1::bigint, t, 800 FROM generate_series('2026-10-03T00:00:00Z'::timestamptz, '2026-10-03T04:00:00Z', interval '1 hour') t`,
      [control],
    );
    // A public reader (api or publish), through every public forecast view and the public at-T function.
    for (const role of ['rws_api', 'rws_publish'] as const) {
      const db = h.dbAs(role, 1);
      const one = async (text: string, args: unknown[] = []) => (await db.pool.query(text, args)).rows;
      for (const view of [VIEWS.public.forecastRun, VIEWS.public.api.forecastRun])
        expect([role, view, (await one(`SELECT id::text AS rid FROM ${view}`)).map((r) => r.rid)]).toEqual([
          role,
          view,
          [control],
        ]);
      for (const view of [VIEWS.public.forecastValue, VIEWS.public.api.forecastValue])
        expect([role, view, await one(`SELECT run_id FROM ${view} WHERE run_id = ANY($1::bigint[])`, [ids])]).toEqual([
          role,
          view,
          [],
        ]);
      const atT = await one(`SELECT source_id FROM ${FORECAST_AT.public}($1::timestamptz, $2::timestamptz)`, T);
      expect([role, atT]).toEqual([role, [{ source_id: 'NL-1' }]]);
      await db.close();
    }
    // The owner reader sees all four runs, their 46 + 46 + 46 + 45 points and the run at T through the owner function.
    const owner = h.dbAs('rws_owner_api', 1);
    const one = async (text: string, args: unknown[] = []) => (await owner.pool.query(text, args)).rows;
    for (const view of [VIEWS.owner.forecastRun, VIEWS.owner.api.forecastRun]) {
      const rows = await one(`SELECT id::text AS rid, kind FROM ${view} WHERE source_id = 'LU-3' ORDER BY id`);
      expect([view, rows.map((r) => r.rid)]).toEqual([view, ids]);
      expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['quantiles']));
    }
    for (const view of [VIEWS.owner.forecastValue, VIEWS.owner.api.forecastValue]) {
      const rows = await one(
        `SELECT run_id, count(*)::int AS n FROM ${view} WHERE run_id = ANY($1::bigint[]) GROUP BY run_id ORDER BY run_id`,
        [ids],
      );
      expect([view, rows.map((r) => r.n)]).toEqual([view, [46, 46, 46, 45]]);
    }
    // As of 03:00 at 03:00 the latest Diekirch run is the 01:45 one (first step 22:00Z), stepped at 03:00Z.
    const atT = await one(
      `SELECT series_id, source_id, kind, issued_inferred, first_valid, valid_ts, p10, p30, p50, p70, p90, value, flags
       FROM ${FORECAST_AT.owner}($1::timestamptz, $2::timestamptz) WHERE source_id = 'LU-3' ORDER BY series_id`,
      T,
    );
    expect(atT).toHaveLength(2);
    for (const r of atT) {
      expect(r).toMatchObject({ source_id: 'LU-3', kind: 'quantiles', issued_inferred: true });
      expect((r.valid_ts as Date).toISOString()).toBe('2026-10-03T03:00:00.000Z');
      for (const c of ['p10', 'p30', 'p50', 'p70', 'p90']) expect(typeof r[c]).toBe('number');
      expect(r.value).toBe(r.p50);
    }
    expect(atT.map((r) => (r.first_valid as Date).toISOString()).sort()).toEqual([
      '2026-10-02T21:00:00.000Z',
      '2026-10-02T22:00:00.000Z',
    ]);
    await owner.close();
  });

  it('a group that never completes is staged, never a run, and the health pass drops it', async () => {
    for (const [i, p] of (['10', '30', '50', '70'] as const).entries())
      await put('bissen', p, secs('2026-10-03T02:45:00Z', i), fixture(p));
    expect(await tick()).toEqual({ lines: 4, loaded: 4 });
    expect(await runsOf(KEY.bissen)).toEqual([]);
    const staged = await staging('bissen');
    expect(Object.keys(staged?.groups ?? {})).toEqual(['2026-10-03T02']);
    expect(Object.keys(staged?.groups['2026-10-03T02']?.parts ?? {}).sort()).toEqual(['10', '30', '50', '70']);
    // Staged by the loader's clock at NOW: the pass three hours later drops it, once, counted incomplete_run.
    expect(await pruneStagedParts(h.load.db, new Date(NOW.getTime() + 3 * HOUR))).toEqual(new Map([['LU-3', 1]]));
    expect(await staging('bissen')).toEqual({ groups: {} });
    expect(await runsOf(KEY.bissen)).toEqual([]);
  });

  it('a staged part that is no longer a part is counted combine_drift and stores no run', async () => {
    const base = '2026-10-03T02:50:00Z';
    for (const [i, p] of (['10', '30', '50', '70'] as const).entries())
      await put('mersch', p, secs(base, i), fixture(p));
    expect(await tick()).toEqual({ lines: 4, loaded: 4 });
    // The staging row is the loader's own state; a hand edit (or a bug) must not become a run.
    await q(
      `UPDATE app_meta SET value = jsonb_set(value, '{groups,2026-10-03T02,parts,30,data}', '"x"')
       WHERE key = 'forecast_part:LU-3:mersch'`,
    );
    const before = h.alerts.length;
    await put('mersch', '90', secs(base, 4), fixture('90'));
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await runsOf(KEY.mersch)).toEqual([]);
    expect(h.alerts.slice(before)).toEqual([
      { code: 'combine_drift', fields: { source: 'LU-3', spec: 'lu-3-percentile', n: 1 } },
    ]);
    expect((await batches()).at(-1)).toMatchObject({ n_rows: 0, n_new: 0, n_skipped: 1, parse_status: 'ok' });
    expect(await staging('mersch')).toEqual({ groups: {} });
  });
});
