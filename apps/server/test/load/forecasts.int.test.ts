import { emptyNormalised, type ForecastRunIn, type StagedPart } from '@rws/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import type { LoadAdapter } from '../../src/load/adapters.ts';
import { pruneStagedParts } from '../../src/load/forecasts.ts';
import { replay } from '../../src/load/replay.ts';
import { readMeta } from '../../src/load/store.ts';
import { type Harness, harness, KAUB_W } from './harness.ts';

// P8a: forecast runs through the loader (load/forecasts.ts, the pipeline hooks) against PostgreSQL 18 as rws_load,
// with stand-in adapters that state runs directly (the real NL-1, DE-2 and LU-3 adapters have their own tests):
// captures of one run that drop its head are one run in any order, a replay writes nothing, a source without head
// drops keys runs by (series, first valid time, hash) only, and LU-3's five files are staged until they make a run.

const MIB = 1024 * 1024;
const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const LOBITH_H = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
const NOW = new Date('2026-10-03T12:00:00Z');
const STEP = 10 * 60_000;

type Fake = { target?: string; series: string; issuedAt?: string; seg?: string; points: [string, number, number?][] };
const body = (x: unknown) => Buffer.from(JSON.stringify(x));
const parse = (b: Uint8Array) => JSON.parse(Buffer.from(b).toString('utf8'));
const toRun = (f: Fake, stepMs: number, kind: ForecastRunIn['kind']): ForecastRunIn => ({
  ...(f.target === undefined ? {} : { target: f.target }),
  series: f.series,
  kind,
  stepMs,
  issuedAt: f.issuedAt ?? null,
  providerSegmentEnd: f.seg ?? null,
  points: f.points.map(([ts, value, flags]) => ({ ts, value, flags: flags ?? 0 })),
});
const LU3_KEYS: Record<string, string> = { diekirch: 'Diekirch', 'gemund-our': 'Gemünd_Our' };

const ADAPTERS: Readonly<Record<string, LoadAdapter>> = {
  'NL-1': {
    version: 1,
    specs: {
      'nl-1-fc-1h': {
        maxBytes: MIB,
        needsVariant: false,
        run: (b) => ({ ...emptyNormalised(), forecasts: [toRun(parse(b), STEP, 'deterministic')] }),
      },
    },
  },
  'DE-2': {
    version: 1,
    specs: {
      'de-2-wv': {
        maxBytes: MIB,
        needsVariant: true,
        refTarget: ['DE-1'],
        run: (b) => ({ ...emptyNormalised(), forecasts: [toRun(parse(b), 2 * 3_600_000, 'deterministic')] }),
      },
    },
  },
  'LU-3': {
    version: 1,
    specs: {
      'lu-3-percentile': {
        maxBytes: MIB,
        needsVariant: true,
        refTarget: ['LU-1'],
        run: (b, ctx) => {
          const [slug, p] = ctx.variant.split('/') as [string, string];
          return {
            ...emptyNormalised(),
            forecastPart: {
              target: 'LU-1',
              series: LU3_KEYS[slug] ?? 'unknown',
              slot: slug,
              group: new Date(ctx.fetchedAt).toISOString().slice(0, 13),
              part: p,
              data: parse(b),
            },
          };
        },
        combine: {
          parts: 5,
          run: (parts: readonly StagedPart[]) => {
            const by = Object.fromEntries(parts.map((x) => [x.part, x.data as [string, number][]]));
            const p50 = by['50'] as [string, number][];
            return {
              runs: [
                {
                  target: 'LU-1',
                  series: 'Diekirch',
                  kind: 'quantiles',
                  stepMs: 3_600_000,
                  issuedAt: null,
                  providerSegmentEnd: null,
                  points: p50.map(([ts, v], i) => ({
                    ts,
                    value: v,
                    p10: (by['10'] as [string, number][])[i]?.[1] ?? null,
                    p30: (by['30'] as [string, number][])[i]?.[1] ?? null,
                    p50: v,
                    p70: (by['70'] as [string, number][])[i]?.[1] ?? null,
                    p90: (by['90'] as [string, number][])[i]?.[1] ?? null,
                    flags: 0,
                  })),
                },
              ],
              dropped: {},
            };
          },
        },
      },
    },
  },
};

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(() => h.close());

type Row = Record<string, unknown>;
const q = async (text: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(text, args)).rows;
const put = (source: string, spec: string, variant: string, at: string, payload: unknown) =>
  writePayload(h.archive, {
    source,
    spec,
    variant,
    at: new Date(at),
    url: `https://example.invalid/${spec}`,
    body: body(payload),
    retention: 'forever',
  });
const tick = () => h.loader({ adapters: ADAPTERS, now: NOW }).tick();
const runsOf = (key: string, source: string) =>
  q(
    `SELECT r.first_valid, r.last_valid, r.fetched_at, r.issued_at, r.issued_inferred, encode(r.content_hash, 'hex') AS hash,
            r.kind, r.step::text AS step, r.provider_segment_end,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id) AS n
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE s.provider_key = $1 AND r.source_id = $2 ORDER BY r.first_valid`,
    [key, source],
  );
const batches = (spec: string) =>
  q(
    `SELECT fetched_at, n_rows, n_new, n_changed, n_skipped, parse_status FROM ingest_batch WHERE spec_id = $1
     ORDER BY id`,
    [spec],
  );
const deps = () => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => NOW,
  adapters: ADAPTERS,
});

/** n points every 10 minutes from `from`; value = base + i. */
const steps = (from: string, n: number, base: number): [string, number][] =>
  Array.from({ length: n }, (_, i) => [new Date(Date.parse(from) + i * STEP).toISOString(), base + i]);
const RUN1 = steps('2026-10-01T05:20:00Z', 20, 100);
const RUN2 = steps('2026-10-02T05:20:00Z', 20, 300);

describe('forecast runs through the loader', { timeout: 300_000 }, () => {
  it('captures that drop the head of one run are one run, keyed by the earliest capture', async () => {
    await put('NL-1', 'nl-1-fc-1h', 'lobith/Q', '2026-10-01T05:25:00Z', { series: LOBITH_Q, points: RUN1 });
    await put('NL-1', 'nl-1-fc-1h', 'lobith/Q', '2026-10-01T06:25:00Z', { series: LOBITH_Q, points: RUN1.slice(6) });
    await put('NL-1', 'nl-1-fc-1h', 'lobith/Q', '2026-10-01T07:25:00Z', { series: LOBITH_Q, points: RUN1.slice(12) });
    await put('NL-1', 'nl-1-fc-1h', 'lobith/Q', '2026-10-02T05:25:00Z', { series: LOBITH_Q, points: RUN2 });
    // the same run of the H series in reverse order: the latest capture first, the earliest last
    await put('NL-1', 'nl-1-fc-1h', 'lobith/H', '2026-10-01T07:25:30Z', { series: LOBITH_H, points: RUN1.slice(12) });
    await put('NL-1', 'nl-1-fc-1h', 'lobith/H', '2026-10-01T06:25:30Z', { series: LOBITH_H, points: RUN1.slice(6) });
    await put('NL-1', 'nl-1-fc-1h', 'lobith/H', '2026-10-01T05:25:30Z', { series: LOBITH_H, points: RUN1 });
    expect(await tick()).toEqual({ lines: 7, loaded: 7 });

    const q1 = await runsOf(LOBITH_Q, 'NL-1');
    expect(q1).toHaveLength(2);
    expect(q1[0]).toMatchObject({
      first_valid: new Date('2026-10-01T05:20:00Z'),
      last_valid: new Date('2026-10-01T08:30:00Z'),
      fetched_at: new Date('2026-10-01T05:25:00Z'),
      issued_at: new Date('2026-10-01T05:25:00Z'),
      issued_inferred: true,
      kind: 'deterministic',
      step: '00:10:00',
      n: 20,
    });
    expect(q1[1]).toMatchObject({ first_valid: new Date('2026-10-02T05:20:00Z'), n: 20 });
    const h1 = await runsOf(LOBITH_H, 'NL-1');
    expect(h1).toHaveLength(1);
    // the same points give the same key whatever the order they were loaded in
    expect(h1[0]).toMatchObject({ first_valid: q1[0]?.first_valid, hash: q1[0]?.hash, n: 20 });
    expect(h1[0]?.fetched_at).toEqual(new Date('2026-10-01T05:25:30Z'));
    // (the 2026-10-02 capture is in the next day's manifest file, so it loads last)
    expect((await batches('nl-1-fc-1h')).map((b) => [b.n_rows, b.n_new, b.n_changed])).toEqual([
      [20, 20, 0],
      [14, 0, 0],
      [8, 0, 0],
      [8, 8, 0],
      [14, 6, 1],
      [20, 6, 1],
      [20, 20, 0],
    ]);
  });

  it('a replay, twice, writes nothing', async () => {
    const before = await q('SELECT count(*)::int AS n FROM forecast_value');
    for (let round = 0; round < 2; round++) {
      const r = await replay(deps(), {
        source: 'NL-1',
        spec: null,
        from: '2026-10-01',
        to: '2026-10-31',
        dryRun: false,
      });
      expect(r).toMatchObject({ lines: 7, loaded: 7, quarantined: 0, n_new: 0, n_changed: 0 });
    }
    expect(await q('SELECT count(*)::int AS n FROM forecast_value')).toEqual(before);
  });

  it('a source without head drops keys a run by its first valid time and hash; a later copy lowers fetched_at', async () => {
    const kaub = (n: number) => steps('2026-10-01T05:00:00Z', n, 200).map(([ts, v]) => [ts, v] as [string, number]);
    const run = { target: 'DE-1', series: KAUB_W, issuedAt: '2026-10-01T07:00:00+02:00', points: kaub(5) };
    await put('DE-2', 'de-2-wv', 'kaub', '2026-10-01T08:12:00Z', run);
    await put('DE-2', 'de-2-wv', 'kaub', '2026-10-01T07:12:00Z', run);
    // a truncated copy of the same run is a run of its own (DE-2 captures never drop a head)
    await put('DE-2', 'de-2-wv', 'kaub', '2026-10-01T09:12:00Z', { ...run, points: kaub(5).slice(2) });
    // a value past initialized + 96 h + 1 h is dropped and alerted
    await put('DE-2', 'de-2-wv', 'kaub', '2026-10-01T10:12:00Z', {
      ...run,
      issuedAt: '2026-10-01T08:00:00Z',
      points: [...kaub(3), ['2026-10-05T09:00:01Z', 1]],
    });
    expect(await tick()).toEqual({ lines: 4, loaded: 4 });
    const runs = await runsOf(KAUB_W, 'DE-2');
    expect(runs.map((r) => [r.first_valid, r.n, r.issued_inferred])).toEqual([
      [new Date('2026-10-01T05:00:00Z'), 5, false],
      [new Date('2026-10-01T05:00:00Z'), 3, false],
      [new Date('2026-10-01T05:20:00Z'), 3, false],
    ]);
    const first = runs.find((r) => r.n === 5);
    expect(first).toMatchObject({
      fetched_at: new Date('2026-10-01T07:12:00Z'),
      issued_at: new Date('2026-10-01T05:00:00Z'),
    });
    const b = await batches('de-2-wv');
    expect(b.map((x) => [x.n_new, x.n_changed, x.n_skipped])).toEqual([
      [5, 0, 0],
      [0, 1, 0],
      [3, 0, 0],
      [3, 0, 1],
    ]);
    expect(h.alerts.filter((a) => a.code === 'beyond_horizon')).toEqual([
      { code: 'beyond_horizon', fields: { source: 'DE-2', spec: 'de-2-wv', n: 1 } },
    ]);
  });

  it('a series no registry has is unknown: counted, kept for a replay, nothing stored', async () => {
    await put('NL-1', 'nl-1-fc-1h', 'nope/Q', '2026-10-03T05:25:00Z', {
      series: 'nope/Q/NVT/x',
      points: steps('2026-10-03T05:20:00Z', 20, 100),
    });
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await batches('nl-1-fc-1h')).at(-1)).toMatchObject({ n_rows: 0, n_new: 0, n_skipped: 1 });
  });

  it('a value more than two days before the issue time is withheld: counted, alerted, the rest stored (review SEC-1)', async () => {
    const before = h.alerts.length;
    await put('DE-2', 'de-2-wv', 'kaub', '2026-10-02T05:12:00Z', {
      target: 'DE-1',
      series: KAUB_W,
      issuedAt: '2026-10-02T07:00:00+02:00',
      points: [['2026-09-29T05:00:00Z', 1], ...steps('2026-10-02T05:00:00Z', 3, 200)],
    });
    expect(await tick()).toEqual({ lines: 1, loaded: 1 });
    expect((await batches('de-2-wv')).at(-1)).toMatchObject({ n_rows: 3, n_new: 3, n_skipped: 1 });
    expect((await runsOf(KAUB_W, 'DE-2')).at(-1)).toMatchObject({
      first_valid: new Date('2026-10-02T05:00:00Z'),
      n: 3,
    });
    expect(h.alerts.slice(before)).toEqual([
      { code: 'before_window', fields: { source: 'DE-2', spec: 'de-2-wv', n: 1 } },
    ]);
  });
});

describe('LU-3 parts staged until the run is complete', { timeout: 300_000 }, () => {
  const hours = (from: string, n: number, base: number): [string, number][] =>
    Array.from({ length: n }, (_, i) => [new Date(Date.parse(from) + i * 3_600_000).toISOString(), base + i]);
  const parts = (slug: string, at: string, ps = ['10', '30', '50', '70', '90']) =>
    ps.map((p, i) =>
      put(
        'LU-3',
        'lu-3-percentile',
        `${slug}/${p}`,
        new Date(Date.parse(at) + i * 1000).toISOString(),
        hours(at, 4, Number(p)),
      ),
    );

  it('five files make one quantile run, at the earliest file’s fetch; a replay stores nothing again', async () => {
    // out of order within the hour: the 90 first
    await put('LU-3', 'lu-3-percentile', 'diekirch/90', '2026-10-01T07:45:04Z', hours('2026-10-01T07:45:00Z', 4, 90));
    for (const p of parts('diekirch', '2026-10-01T07:45:00Z', ['10', '30', '50', '70'])) await p;
    for (const p of parts('gemund-our', '2026-10-01T07:45:10Z')) await p;
    expect(await tick()).toEqual({ lines: 10, loaded: 10 });
    const runs = await runsOf('Diekirch', 'LU-3');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'quantiles',
      fetched_at: new Date('2026-10-01T07:45:00Z'),
      issued_inferred: true,
      n: 4,
    });
    const v = await q(
      `SELECT v.value, v.p10, v.p30, v.p50, v.p70, v.p90 FROM forecast_value v JOIN forecast_run r ON r.id = v.run_id
       WHERE r.source_id = 'LU-3' ORDER BY v.valid_ts LIMIT 1`,
    );
    expect(v[0]).toEqual({ value: 50, p10: 10, p30: 30, p50: 50, p70: 70, p90: 90 });
    // Gemünd (withheld, off) stores nothing and stages nothing
    expect(await runsOf('Gemünd_Our', 'LU-3')).toEqual([]);
    expect(await readMeta(h.load.db, 'forecast_part:LU-3:gemund-our')).toBeUndefined();
    expect(await readMeta(h.load.db, 'forecast_part:LU-3:diekirch')).toEqual({ groups: {} });
    const r = await replay(deps(), { source: 'LU-3', spec: null, from: '2026-10-01', to: '2026-10-31', dryRun: false });
    expect(r).toMatchObject({ loaded: 10, quarantined: 0, n_new: 0, n_changed: 0 });
    expect(await runsOf('Diekirch', 'LU-3')).toHaveLength(1);
  });

  it('a group that never completes is dropped by the health pass, and a fifth group evicts the oldest', async () => {
    for (const p of parts('diekirch', '2026-10-01T09:45:00Z', ['10', '30', '50', '70'])) await p;
    expect(await tick()).toEqual({ lines: 4, loaded: 4 });
    const later = new Date(NOW.getTime() + 3 * 3_600_000);
    expect(await pruneStagedParts(h.load.db, later)).toEqual(new Map([['LU-3', 1]]));
    expect(await readMeta(h.load.db, 'forecast_part:LU-3:diekirch')).toEqual({ groups: {} });
    expect(await pruneStagedParts(h.load.db, later)).toEqual(new Map());

    for (const hour of ['10', '11', '12', '13', '14'])
      await put(
        'LU-3',
        'lu-3-percentile',
        'diekirch/10',
        `2026-10-01T${hour}:45:00Z`,
        hours(`2026-10-01T${hour}:45:00Z`, 4, 1),
      );
    const before = h.alerts.length;
    expect(await tick()).toEqual({ lines: 5, loaded: 5 });
    expect(h.alerts.slice(before)).toEqual([
      { code: 'incomplete_run', fields: { source: 'LU-3', spec: 'lu-3-percentile', n: 1 } },
    ]);
    const staged = await readMeta<{ groups: Record<string, unknown> }>(h.load.db, 'forecast_part:LU-3:diekirch');
    expect(Object.keys(staged?.groups ?? {})).toHaveLength(4);
    expect((await batches('lu-3-percentile')).at(-1)).toMatchObject({ n_skipped: 1 });
  });
});
