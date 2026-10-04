import { type CanonRun, checkRun, FORECAST_SOURCES, firstValid, lastValid } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { normalise } from '../../src/adapters/fr-4/normalise.ts';
import { parseDocument } from '../../src/adapters/fr-4/parse.ts';
import { FAMILY_ROLES, FORECAST_AT, VIEWS } from '../../src/db/audience.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { runHash } from '../../src/load/forecasts.ts';
import { replay } from '../../src/load/replay.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// FR-4 (Vigicrues forecasts, public) through the real loader and adapter (P8b), on the committed fixtures: the real
// recordings (a station FR-1 does not register, the national list) and synthetic bodies (the fixtures of
// apps/server/src/adapters/fr-4 and runs derived from them here; every value is invented). A run keeps its own key
// whatever the order of its captures, the v1.1 and legacy labels of one run, fetched with another `Scenario` file time,
// are one run, a replay writes nothing, the run sits on the station's FR-1 series and reaches the public family, and
// the envelope bodies (error: drift; no content, empty: nothing) behave as stated.

const NOW = new Date('2026-10-03T00:00:00Z');
const SPEC = 'fr-4';
const HOUR = 3_600_000;
const ENDPOINT = 'https://www.vigicrues.gouv.fr/services/v1.1/prevision.json';
const EPINAL = 'A443064001'; // La Moselle à Épinal: a primary FR-1 stage and discharge series
const STENAY = 'B315002001'; // La Meuse à Stenay: a primary FR-1 stage series
const BASEL = 'A021005050'; // the Rhine at Basel: FR-1 registers it as a mirror (CH-1's gauge), never a primary

const fixture = (name: string) => rawFixture('FR-4', name).body;
const V11 = fixture('fr-4-station-a443064001-h-v11.synthetic'); // issued 2026-10-02T08:52:05Z, 40 hourly points from 10:00Z
const LEGACY = fixture('fr-4-station-a443064001-h-legacy.synthetic'); // the same run, +00:00 labels, another file time
const NO_FORECAST = fixture('fr-4-no-forecast.synthetic');
const EMPTY = fixture('fr-4-station-a443064001-h-empty-prevs.synthetic');
const ERROR = fixture('fr-4-error.synthetic');
const UNKNOWN = fixture('fr-4-station-l800001020-h-20260930t1620z'); // real: Saumur, outside the FR-1 basins
const LIST = fixture('fr-4'); // real: the national list, variant H

type Doc = {
  Simul: { CdEntVigiCru: string; GrdSimul: string; DtProdSimul: string; Prevs: Record<string, unknown>[] };
};
const label = (ms: number) => `${new Date(ms + 2 * HOUR).toISOString().slice(0, 19)}+02:00`;
/** A body derived from a fixture: another station or parameter, later by `hours`, its values times `mul` plus `add`. */
function derive(
  body: Buffer,
  o: { code?: string; grd?: 'H' | 'Q'; hours?: number; add?: number; mul?: number },
): Buffer {
  const d = JSON.parse(body.toString('utf8')) as Doc;
  const by = (o.hours ?? 0) * HOUR;
  d.Simul.CdEntVigiCru = o.code ?? d.Simul.CdEntVigiCru;
  d.Simul.GrdSimul = o.grd ?? d.Simul.GrdSimul;
  d.Simul.DtProdSimul = label(Date.parse(d.Simul.DtProdSimul) + by);
  for (const p of d.Simul.Prevs) {
    p.DtPrev = label(Date.parse(p.DtPrev as string) + by);
    for (const k of ['ResMinPrev', 'ResMoyPrev', 'ResMaxPrev'])
      p[k] = Math.round(((p[k] as number) * (o.mul ?? 1) + (o.add ?? 0)) * 100) / 100;
  }
  return Buffer.from(JSON.stringify(d, null, 4));
}
const SECOND = derive(V11, { hours: 6, add: 0.1 }); // the next run, issued 14:52:05Z, with new values
const sibling = (b: Buffer) => derive(b, { code: STENAY, add: 1 }); // the same bodies for Stenay, one metre higher

type Capture = { variant: string; at: string; body: Buffer };
const at = (time: string) => `2026-10-02T${time}Z`;
const cap = (variant: string, when: string, body: Buffer): Capture => ({ variant, at: when, body });
// Epinal H in order (the first run, its capture under the legacy labels and another file time, then the next run);
// Stenay H the same three latest first; Epinal Q; a mirror; the two bodies that hold no forecast; the two real recordings.
const A_RUN1 = cap(`${EPINAL}/H`, at('11:20:06'), V11);
const A_LEGACY = cap(`${EPINAL}/H`, at('11:50:08'), LEGACY);
const A_RUN2 = cap(`${EPINAL}/H`, at('17:20:06'), SECOND);
const S_RUN2 = cap(`${STENAY}/H`, at('17:20:30'), sibling(SECOND));
const S_LEGACY = cap(`${STENAY}/H`, at('11:50:30'), sibling(LEGACY));
const S_RUN1 = cap(`${STENAY}/H`, at('11:20:30'), sibling(V11));
const Q = cap(`${EPINAL}/Q`, at('11:20:40'), derive(V11, { grd: 'Q', mul: 40 }));
const MIRROR = cap(`${BASEL}/H`, at('11:21:00'), derive(V11, { code: BASEL }));
const NONE = cap(`${EPINAL}/H`, at('12:20:06'), NO_FORECAST);
const EMPTY_PREVS = cap(`${EPINAL}/H`, at('12:50:06'), EMPTY);
const SAUMUR = cap('L800001020/H', '2026-09-30T16:20:06Z', UNKNOWN);
const NATIONAL = cap('H', '2026-09-29T13:43:26Z', LIST);
const CAPTURES: readonly Capture[] = [
  A_RUN1,
  A_LEGACY,
  A_RUN2,
  S_RUN2,
  S_LEGACY,
  S_RUN1,
  Q,
  MIRROR,
  NONE,
  EMPTY_PREVS,
  SAUMUR,
  NATIONAL,
];

/** The runs the captures make, from the pure adapter and the core alone: per series, first valid time and hash. */
function expectedRun(c: Capture) {
  const [r] = normalise(parseDocument(c.body), { variant: c.variant }).forecasts ?? [];
  const run = checkRun(r as NonNullable<typeof r>, Date.parse(c.at), FORECAST_SOURCES['FR-4']).run as CanonRun;
  return {
    series: (r as NonNullable<typeof r>).series,
    first: new Date(firstValid(run)),
    last: new Date(lastValid(run)),
    hash: runHash(run).toString('hex'),
    n: run.points.length,
  };
}

type Row = Record<string, unknown>;
const clients: pg.Client[] = [];
const q =
  (x: Harness) =>
  async (text: string, args: unknown[] = []): Promise<Row[]> =>
    (await x.t.admin.query(text, args)).rows;

const put = (x: Harness, c: Capture) =>
  writePayload(x.archive, {
    source: 'FR-4',
    spec: SPEC,
    variant: c.variant,
    at: new Date(c.at),
    url: `${ENDPOINT}?FormatDate=iso`,
    body: c.body,
    retention: 'forever',
  });
const deps = (x: Harness) => ({
  db: x.load.db,
  reader: x.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => x.alerts.push({ code, fields }),
  now: () => NOW,
  adapters: LOAD_ADAPTERS,
});
const tick = (x: Harness) => x.loader({ now: NOW }).tick();

/** Every stored FR-4 run with its points, in a fixed order, without ids. */
const stored = (x: Harness) =>
  q(x)(
    `SELECT s.source_id AS series_source, s.provider_key, r.source_id, r.first_valid, r.last_valid, r.fetched_at,
            r.issued_at, r.issued_inferred, encode(r.content_hash, 'hex') AS hash, r.kind, r.step::text AS step,
            r.provider_segment_end,
            (SELECT jsonb_agg(jsonb_build_array(v.valid_ts, v.value, v.p10, v.p50, v.p90, v.flags) ORDER BY v.valid_ts)
             FROM forecast_value v WHERE v.run_id = r.id) AS points
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     ORDER BY s.provider_key, r.first_valid, r.id`,
  );
const runsOf = (x: Harness, key: string) =>
  q(x)(
    `SELECT r.id::text AS id, r.first_valid, r.last_valid, r.fetched_at, r.issued_at, r.issued_inferred,
            encode(r.content_hash, 'hex') AS hash, r.kind, r.step::text AS step, r.provider_segment_end,
            (SELECT count(*)::int FROM forecast_value v WHERE v.run_id = r.id) AS n
     FROM forecast_run r JOIN series s ON s.id = r.series_id
     WHERE s.provider_key = $1 AND s.source_id = 'FR-1' AND r.source_id = 'FR-4' ORDER BY r.first_valid, r.id`,
    [key],
  );
const batches = (x: Harness) =>
  q(x)(
    `SELECT n_rows, n_new, n_changed, n_skipped, parse_status, error FROM ingest_batch WHERE spec_id = $1 ORDER BY id`,
    [SPEC],
  );
const counts = (rows: Row[]) => rows.map((b) => [b.n_rows, b.n_new, b.n_changed, b.n_skipped]);

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.end()));
  await h.close();
});

describe('the expected runs (from the adapter alone)', () => {
  it('are five runs of three registered series: the legacy capture is the first run again, the rest hold none', () => {
    const keys = [A_RUN1, A_LEGACY, A_RUN2, S_RUN2, S_LEGACY, S_RUN1, Q].map((c) => {
      const e = expectedRun(c);
      return `${e.series}|${e.first.toISOString()}|${e.hash}`;
    });
    expect(new Set(keys).size).toBe(5);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[4]).toBe(keys[5]);
    expect(expectedRun(A_RUN2).first).toEqual(new Date('2026-10-02T16:00:00Z'));
    for (const c of [NONE, EMPTY_PREVS, NATIONAL])
      expect(normalise(parseDocument(c.body), { variant: c.variant }).forecasts).toBeUndefined();
  });
});

describe('FR-4 runs through the loader', { timeout: 300_000 }, () => {
  it('captures in order and in reverse give the same runs, keyed by series, first valid time and hash', async () => {
    for (const c of CAPTURES) await put(h, c);
    expect(await tick(h)).toEqual({ lines: 12, loaded: 12 });
    // Epinal H: the legacy capture is the first run again (another file time, other labels: one run); the next run is a
    // second. Stenay H, captured latest first, has the same two, each held as its earliest capture.
    const epinal = await runsOf(h, `${EPINAL}/H`);
    const stenay = await runsOf(h, `${STENAY}/H`);
    const e = (c: Capture) => expectedRun(c);
    expect(epinal.map((r) => [r.first_valid, r.last_valid, r.hash, r.n])).toEqual(
      [A_RUN1, A_RUN2].map((c) => [e(c).first, e(c).last, e(c).hash, e(c).n]),
    );
    expect(stenay.map((r) => [r.first_valid, r.last_valid, r.hash, r.n])).toEqual(
      [S_RUN1, S_RUN2].map((c) => [e(c).first, e(c).last, e(c).hash, e(c).n]),
    );
    expect(epinal.map((r) => r.fetched_at)).toEqual([new Date(A_RUN1.at), new Date(A_RUN2.at)]);
    expect(stenay.map((r) => r.fetched_at)).toEqual([new Date(S_RUN1.at), new Date(S_RUN2.at)]);
    expect(await runsOf(h, `${EPINAL}/Q`)).toHaveLength(1);
    // The run count is the number of unique keys: 7 run-bearing captures, 5 runs, 40 points each.
    expect(await h.count('forecast_run')).toBe(5);
    expect(await h.count('forecast_value')).toBe(200);
    // The loader reads the manifest day by day (the list of 29 September, Saumur's of 30 September), then as written.
    expect(counts(await batches(h))).toEqual([
      [0, 0, 0, 0], // the list
      [0, 0, 0, 1], // Saumur: FR-1 does not register it, counted and kept for a replay
      [40, 40, 0, 0], // Epinal H, first run
      [40, 0, 0, 0], // the legacy capture of it: nothing new
      [40, 40, 0, 0], // the next run
      [40, 40, 0, 0], // Stenay, the next run first
      [40, 40, 0, 0], // its first run
      [40, 0, 1, 0], // the earlier capture of that run, loaded last: the same run, fetched_at lowered
      [40, 40, 0, 0], // Epinal Q
      [0, 0, 0, 0], // the Basel mirror: no run
      [0, 0, 0, 0], // no content
      [0, 0, 0, 0], // an empty Prevs
    ]);
    expect((await batches(h)).every((b) => b.parse_status === 'ok' && b.error === null)).toBe(true);
    // Nothing alerts: not an unregistered station, not a mirror, not the bodies that hold no forecast.
    expect(h.alerts).toEqual([]);
  });

  it('a fully reversed archive (a second database) stores the same runs, points and fetch times', async () => {
    const x = await harness();
    try {
      for (const c of [...CAPTURES].reverse()) await put(x, c);
      expect(await tick(x)).toEqual({ lines: 12, loaded: 12 });
      expect(await stored(x)).toEqual(await stored(h));
      expect(x.alerts).toEqual([]);
    } finally {
      await x.close();
    }
  }, 120_000);

  it('a replay, twice, writes nothing', async () => {
    const before = await stored(h);
    for (let round = 0; round < 2; round++) {
      const r = await replay(deps(h), {
        source: 'FR-4',
        spec: null,
        from: '2026-09-29',
        to: '2026-10-04',
        dryRun: false,
      });
      expect(r).toEqual({ lines: 12, loaded: 12, quarantined: 0, skipped: 0, n_new: 0, n_changed: 0 });
    }
    expect(await stored(h)).toEqual(before);
    expect(await h.count('forecast_run')).toBe(5);
    expect(h.alerts).toEqual([]);
  });

  it('a run is its provider’s: issued as stated, quantiles, no step, p10 / p50 / p90 in cm (H) or m3/s (Q) with value = p50', async () => {
    const [first, second] = await runsOf(h, `${EPINAL}/H`);
    expect(first).toMatchObject({
      kind: 'quantiles',
      step: null,
      issued_at: new Date('2026-10-02T08:52:05Z'),
      issued_inferred: false,
      first_valid: new Date('2026-10-02T10:00:00Z'),
      last_valid: new Date('2026-10-04T01:00:00Z'),
      provider_segment_end: null,
      n: 40,
    });
    expect(second).toMatchObject({
      issued_at: new Date('2026-10-02T14:52:05Z'),
      first_valid: new Date('2026-10-02T16:00:00Z'),
    });
    const points = await q(h)(
      `SELECT valid_ts, value, p05, p10, p25, p30, p50, p70, p75, p90, p95, vmin, vmax, flags
       FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts LIMIT 2`,
      [first?.id],
    );
    // 2.36, 2.40, 2.44 m at the first valid time: metres times 100, stored as float32; the columns FR-4 has not are null.
    expect(points[0]).toEqual({
      valid_ts: new Date('2026-10-02T10:00:00Z'),
      value: 240,
      p05: null,
      p10: 236,
      p25: null,
      p30: null,
      p50: 240,
      p70: null,
      p75: null,
      p90: 244,
      p95: null,
      vmin: null,
      vmax: null,
      flags: 0,
    });
    const [discharge] = await runsOf(h, `${EPINAL}/Q`);
    const [qp] = await q(h)(
      `SELECT value, p10, p50, p90 FROM forecast_value WHERE run_id = $1::bigint ORDER BY valid_ts LIMIT 1`,
      [discharge?.id],
    );
    // 2.36 / 2.40 / 2.44 times 40, as m3/s with the factor 1.
    expect(qp).toEqual({ value: 96, p10: 94.4, p50: 96, p90: 97.6 });
  });

  it('the run attaches to the station’s FR-1 primary series: one source on the series, its run in the FR-1 registry', async () => {
    const rows = await q(h)(
      `SELECT s.source_id AS series_source, s.role, s.quantity, r.source_id AS run_source, count(*)::int AS n
       FROM forecast_run r JOIN series s ON s.id = r.series_id GROUP BY 1, 2, 3, 4 ORDER BY 1, 3`,
    );
    expect(rows).toEqual([
      { series_source: 'FR-1', role: 'primary', quantity: 'H', run_source: 'FR-4', n: 4 },
      { series_source: 'FR-1', role: 'primary', quantity: 'Q', run_source: 'FR-4', n: 1 },
    ]);
  });

  it('a run on a public FR-1 series from a public source is in the public forecast views and functions, as in the owner’s', async () => {
    for (const role of FAMILY_ROLES.public) {
      const pub = await h.t.connectAs(role);
      clients.push(pub);
      const runs = await pub.query(`SELECT source_id, count(*)::int AS n FROM ${VIEWS.public.forecastRun} GROUP BY 1`);
      expect([role, runs.rows]).toEqual([role, [{ source_id: 'FR-4', n: 5 }]]);
      const values = await pub.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.forecastValue}`);
      expect([role, values.rows]).toEqual([role, [{ n: 200 }]]);
      for (const view of [VIEWS.public.api.forecastRun, VIEWS.public.api.forecastValue])
        expect(Number((await pub.query(`SELECT count(*)::int AS n FROM ${view}`)).rows[0]?.n)).toBeGreaterThan(0);
      // Q2 at noon on 2 October: the first run of each of the three series (Stenay's was fetched 11:20:30Z); at 17:30Z the
      // second run of the two H series and, still, the one run of Epinal Q.
      const asOf = (t: string) =>
        pub.query(
          `SELECT series_id, source_id, issued_at, kind, value, p10, p50, p90 FROM ${FORECAST_AT.public}($1::timestamptz, $1::timestamptz) ORDER BY series_id`,
          [t],
        );
      const noon = await asOf('2026-10-02T12:00:00Z');
      expect(noon.rows).toHaveLength(3);
      expect(noon.rows.every((r) => r.source_id === 'FR-4' && r.kind === 'quantiles' && r.value === r.p50)).toBe(true);
      expect(noon.rows.every((r) => r.p10 < r.p50 && r.p50 < r.p90)).toBe(true);
      const late = await asOf('2026-10-02T17:30:00Z');
      expect(late.rows).toHaveLength(3);
      const epinalH = await h.t.admin.query(`SELECT id FROM series WHERE provider_key = $1 AND source_id = 'FR-1'`, [
        `${EPINAL}/H`,
      ]);
      expect(late.rows.find((r) => r.series_id === epinalH.rows[0]?.id)?.issued_at).toEqual(
        new Date('2026-10-02T14:52:05Z'),
      );
      // A run is no forecast beyond its end, and the older run that reaches further is never shown instead: at 02:00 on
      // 4 October Epinal Q (ended 01:00Z) has none, the two H series their second run (to 07:00Z), at 08:00Z none has.
      expect((await asOf('2026-10-04T02:00:00Z')).rows.map((r) => r.issued_at)).toEqual([
        new Date('2026-10-02T14:52:05Z'),
        new Date('2026-10-02T14:52:05Z'),
      ]);
      expect((await asOf('2026-10-04T08:00:00Z')).rows).toEqual([]);
    }
    const owner = await h.t.connectAs(FAMILY_ROLES.owner[0]);
    clients.push(owner);
    expect((await owner.query(`SELECT 1 FROM ${VIEWS.owner.forecastRun}`)).rowCount).toBe(5);
  });

  it('a station FR-1 does not register is unknown (counted, kept, nothing stored); a mirror takes no run', async () => {
    const series = await q(h)(
      `SELECT provider_key FROM series WHERE provider_key IN ('L800001020/H', $1) OR provider_key LIKE 'Y210002001%'`,
      [`${BASEL}/H`],
    );
    // Basel is a registered mirror row of FR-1: it has a series, and no run.
    expect(series).toEqual([{ provider_key: `${BASEL}/H` }]);
    expect(
      await q(h)(`SELECT 1 FROM forecast_run r JOIN series s ON s.id = r.series_id WHERE s.provider_key = $1`, [
        `${BASEL}/H`,
      ]),
    ).toEqual([]);
    expect((await batches(h)).filter((b) => b.n_skipped === 1)).toHaveLength(1);
  });

  it('a recovered line (no variant) loads: the body names its station and parameter', async () => {
    await put(h, { variant: '', at: at('18:20:06'), body: SECOND });
    expect(await tick(h)).toEqual({ lines: 1, loaded: 1 });
    expect((await batches(h)).at(-1)).toMatchObject({ n_rows: 40, n_new: 0, n_changed: 0, parse_status: 'ok' });
    expect(await runsOf(h, `${EPINAL}/H`)).toHaveLength(2);
  });

  it('an error body, a body for another station, a malformed variant and an issue time ahead of the fetch are quarantined with a fixed code', async () => {
    await put(h, { variant: `${EPINAL}/H`, at: at('13:20:06'), body: ERROR });
    await put(h, { variant: 'L800001020/H', at: at('13:30:06'), body: V11 });
    await put(h, { variant: 'epinal', at: at('13:40:06'), body: V11 });
    // issued 2026-10-02T08:52:05Z, fetched more than 15 minutes before
    await put(h, { variant: `${EPINAL}/H`, at: at('08:20:06'), body: V11 });
    const before = h.alerts.length;
    // (a quarantined line is processed, not loaded)
    expect(await tick(h)).toEqual({ lines: 4, loaded: 0 });
    // Lines are loaded in the order of their manifest: by the day of the fetch, then as written.
    expect((await batches(h)).slice(-4)).toMatchObject([
      { parse_status: 'quarantined', error: 'provider_error' },
      { parse_status: 'quarantined', error: 'variant_mismatch' },
      { parse_status: 'quarantined', error: 'bad_variant' },
      { parse_status: 'quarantined', error: 'future_issue' },
    ]);
    expect(h.alerts.slice(before)).toEqual([
      { code: 'quarantined', fields: { source: 'FR-4', spec: SPEC, code: 'provider_error' } },
      { code: 'quarantined', fields: { source: 'FR-4', spec: SPEC, code: 'variant_mismatch' } },
      { code: 'quarantined', fields: { source: 'FR-4', spec: SPEC, code: 'bad_variant' } },
      { code: 'quarantined', fields: { source: 'FR-4', spec: SPEC, code: 'future_issue' } },
    ]);
    expect(await h.count('forecast_run')).toBe(5);
    expect(await h.count('forecast_value')).toBe(200);
  });
});
