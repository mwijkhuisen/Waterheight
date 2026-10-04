import { FORECAST_PRECEDENCE, Meta, SnapshotForecast } from '@rws/contracts';
import { FORECAST_FLAGS, FORECAST_SOURCES } from '@rws/core';
import { describe, expect, it } from 'vitest';
import {
  type ForecastRules,
  forecastHorizons,
  type HeldRow,
  heldForecast,
  horizonEnd,
  pickHeld,
} from '../../src/api/forecast-at.ts';
import { AGENCY } from '../../src/api/forecast-latest.ts';

// The pure rules of the future snapshot (P8b, A§8 Q2, A§9.2) on hand-made rows: which run shows at t (precedence, a
// superseded DE-2 run, the horizon, the LU-3 display limit), how a held row is shown (estimate, below floor, band,
// inferred issue time) and the per-source horizons of /meta. The database read has its own integration test. The
// values are made up (no provider data).

const H = 3_600_000;
const T = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString();
const FLAGS = FORECAST_FLAGS;
// Monday 2026-10-05, 11:00 in Berlin: DE-2's Friday run is still the current one (Monday's deadline is 10:00Z).
const NOW = T('2026-10-05T09:00:00Z');
const FRIDAY = T('2026-10-02T05:00:00Z');
const NO_BAND = { p10: null, p90: null, p25: null, p75: null, p30: null, p70: null, vmin: null, vmax: null };

let n = 0;
type RowIn = Partial<Omit<HeldRow, 'point'>> & { point?: Partial<HeldRow['point']> };
/** A held row: an NL-1 run of series 1 that reaches two days past NOW, its point at the run's first valid time. */
const row = (o: RowIn = {}): HeldRow => {
  const { point, ...run } = o;
  const base = {
    id: String(++n),
    series: 1,
    source: 'NL-1',
    issued: null,
    issuedInferred: true,
    fetched: T('2026-10-05T06:25:00Z'),
    firstValid: T('2026-10-05T06:20:00Z'),
    lastValid: T('2026-10-07T06:20:00Z'),
    kind: 'deterministic' as const,
    stepS: 600,
    segmentEnd: null,
    ...run,
  };
  return { ...base, point: { ts: base.firstValid, value: 100, flags: 0, ...NO_BAND, ...point } };
};
const de2 = (o: RowIn = {}) =>
  row({
    source: 'DE-2',
    issued: FRIDAY,
    issuedInferred: false,
    fetched: FRIDAY + 12 * 60_000,
    firstValid: FRIDAY,
    lastValid: T('2026-10-06T05:00:00Z'),
    stepS: 7200,
    ...o,
  });
const de3 = (o: RowIn = {}) =>
  row({
    source: 'DE-3',
    kind: 'quantiles',
    fetched: T('2026-10-05T07:00:00Z'),
    firstValid: T('2026-10-05T00:00:00Z'),
    lastValid: T('2026-10-19T00:00:00Z'),
    stepS: 86_400,
    ...o,
  });

const rules = (o: Partial<ForecastRules> = {}): ForecastRules => ({
  now: NOW,
  ruhrortCm: null,
  limitsH: new Map(),
  stationOf: () => undefined,
  ...o,
});
const pick = (rows: HeldRow[], t: number, r: ForecastRules = rules()) => pickHeld(rows, t, r);
const sources = (rows: HeldRow[]) => rows.map((r) => r.source);
const SHOWN: Pick<SnapshotForecast, 'state' | 'basis'> = { state: 'no_ref', basis: null };
/** The answer for a row, checked against the contract. */
const shown = (r: HeldRow, rl: ForecastRules = rules(), state = SHOWN): SnapshotForecast =>
  SnapshotForecast.parse(heldForecast(r, rl, state));

describe('pickHeld: one source per series by FORECAST_PRECEDENCE, never blended', () => {
  it('shows DE-2 where DE-2 and DE-3 both forecast the series, and NL-1 before both', () => {
    const t = NOW + H;
    expect(sources(pick([de3(), de2()], t))).toEqual(['DE-2']);
    expect(sources(pick([de2(), de3()], t))).toEqual(['DE-2']);
    expect(sources(pick([de3(), de2(), row()], t))).toEqual(['NL-1']);
    // the whole order of the display rule, whatever the order of the rows
    const all = FORECAST_PRECEDENCE.map((source) => row({ source, lastValid: T('2026-10-19T00:00:00Z') }));
    expect(sources(pick([...all].reverse(), t))).toEqual(['NL-1']);
    for (let i = 0; i < all.length; i++)
      expect(sources(pick(all.slice(i), t)), FORECAST_PRECEDENCE[i]).toEqual([FORECAST_PRECEDENCE[i]]);
  });

  it('falls back to DE-3 where the DE-2 run was superseded: its due day passed without a newer run', () => {
    const t = T('2026-10-05T11:00:00Z');
    // 10:00Z is 12:00 in Berlin: Monday's deadline has passed, Friday's run is no forecast any more (C4)
    const late = rules({ now: T('2026-10-05T10:00:00Z') });
    expect(sources(pick([de2(), de3()], t, late))).toEqual(['DE-3']);
    // a minute earlier it is still the current run
    expect(sources(pick([de2(), de3()], t, rules({ now: T('2026-10-05T09:59:00Z') })))).toEqual(['DE-2']);
    // DE-2 alone: no forecast, never the held run
    expect(pick([de2()], t, late)).toEqual([]);
  });

  it('a DE-2 run on a weekend follows Ruhrort: due below 4 m (superseded), not due above it or unknown', () => {
    const saturday = T('2026-10-31T14:00:00Z');
    const friday = T('2026-10-30T05:00:00Z');
    const run = de2({ issued: friday, fetched: friday + 12 * 60_000, firstValid: friday, lastValid: friday + 96 * H });
    const at = (ruhrortCm: number | null) => pick([run], saturday + H, rules({ now: saturday, ruhrortCm }));
    expect(at(null)).toHaveLength(1);
    expect(at(450)).toHaveLength(1);
    expect(at(350)).toHaveLength(0);
  });

  it('falls back to DE-3 where the DE-2 run ended before t', () => {
    // DE-2 reaches Tuesday 05:00Z, DE-3 two weeks: at Tuesday 09:00Z only DE-3 forecasts
    const t = T('2026-10-06T09:00:00Z');
    expect(sources(pick([de2(), de3()], t))).toEqual(['DE-3']);
    expect(sources(pick([de2(), de3()], T('2026-10-06T05:00:00Z')))).toEqual(['DE-2']);
  });

  it('shows no forecast where no run reaches t, and none for a t past now + 48 h', () => {
    const r = row({ lastValid: T('2026-10-08T00:00:00Z') });
    expect(pick([r], T('2026-10-07T09:00:00Z'))).toHaveLength(1);
    expect(pick([r], T('2026-10-07T09:00:00Z') + 1)).toHaveLength(0);
    // a run that reaches a week ahead is capped by the 48-hour rule (D8)
    const long = de3();
    expect(pick([long], NOW + 48 * H)).toHaveLength(1);
    expect(pick([long], NOW + 48 * H + 1)).toHaveLength(0);
    // past the run's own end
    expect(pick([row({ lastValid: NOW + H })], NOW + H + 1)).toHaveLength(0);
    expect(pick([row({ lastValid: NOW + H })], NOW + H)).toHaveLength(1);
  });

  it('cuts an LU-3 run at its station display limit, counted from the run start', () => {
    const start = T('2026-10-05T06:00:00Z');
    const lu3 = row({ source: 'LU-3', kind: 'quantiles', firstValid: start, lastValid: start + 46 * H, stepS: 3600 });
    const cut = rules({ limitsH: new Map([['lu.age.diekirch', 24]]), stationOf: () => 'lu.age.diekirch' });
    expect(pick([lu3], start + 24 * H, cut)).toHaveLength(1);
    expect(pick([lu3], start + 24 * H + 1, cut)).toHaveLength(0);
    expect(pick([lu3], start + 40 * H, cut)).toHaveLength(0);
    // another station, or one with no limit, is not cut
    expect(
      pick([lu3], start + 40 * H, rules({ limitsH: cut.limitsH, stationOf: () => 'lu.age.rosport' })),
    ).toHaveLength(1);
    expect(pick([lu3], start + 40 * H, rules({ stationOf: () => 'lu.age.diekirch' }))).toHaveLength(1);
    // the limit belongs to LU-3: another source on that station is not cut by it
    const nl = row({ firstValid: start, lastValid: start + 46 * H });
    expect(pick([nl], start + 40 * H, cut)).toHaveLength(1);
  });

  it('ranks a source outside FORECAST_PRECEDENCE after every listed one', () => {
    const t = NOW + H;
    expect(sources(pick([row({ source: 'CANARY-OWNER' }), de3()], t))).toEqual(['DE-3']);
    expect(sources(pick([row({ source: 'CANARY-OWNER' })], t))).toEqual(['CANARY-OWNER']);
  });

  it('answers one row per series, ordered by series, each series on its own', () => {
    const t = NOW + H;
    const rows = [
      row({ series: 9 }),
      de3({ series: 3 }),
      de2({ series: 3 }),
      row({ series: 5, lastValid: NOW }),
      de3({ series: 5 }),
      row({ series: 7, source: 'XX-9' }),
    ];
    const got = pick(rows, t);
    expect(got.map((r) => [r.series, r.source])).toEqual([
      [3, 'DE-2'],
      [5, 'DE-3'],
      [7, 'XX-9'],
      [9, 'NL-1'],
    ]);
    expect(pick([], t)).toEqual([]);
  });
});

describe('horizonEnd', () => {
  const none = { limitsH: new Map<string, number>(), stationOf: () => undefined };

  it('is the earliest of the run end, from + 48 h and the LU-3 limit', () => {
    const r = row({ firstValid: NOW, lastValid: NOW + 30 * H });
    expect(horizonEnd(r, NOW, none)).toBe(NOW + 30 * H);
    expect(horizonEnd(row({ firstValid: NOW, lastValid: NOW + 90 * H }), NOW, none)).toBe(NOW + 48 * H);
    // `from` is the instant the answer is made at (now, or asof)
    expect(horizonEnd(row({ firstValid: NOW, lastValid: NOW + 90 * H }), NOW - 10 * H, none)).toBe(NOW + 38 * H);
    const lu3 = row({ source: 'LU-3', firstValid: NOW, lastValid: NOW + 46 * H });
    const limit = { limitsH: new Map([['lu.age.diekirch', 24]]), stationOf: () => 'lu.age.diekirch' };
    expect(horizonEnd(lu3, NOW, limit)).toBe(NOW + 24 * H);
    expect(horizonEnd(lu3, NOW, { ...limit, limitsH: new Map([['lu.age.diekirch', 48]]) })).toBe(NOW + 46 * H);
    expect(horizonEnd(lu3, NOW, none)).toBe(NOW + 46 * H);
    expect(horizonEnd(lu3, NOW, { ...limit, stationOf: () => undefined })).toBe(NOW + 46 * H);
  });
});

describe('heldForecast: how a picked row is shown', () => {
  it('states the value, the source and its agency, the held valid time and the horizon end', () => {
    const r = row({ point: { ts: T('2026-10-05T10:20:00Z'), value: 123.5 } });
    const got = shown(r);
    expect(got).toEqual({
      series: 1,
      source: 'NL-1',
      agency: 'RWS',
      ts: '2026-10-05T10:20:00.000Z',
      value: 123.5,
      flags: 0,
      estimate: false,
      issuedAt: '2026-10-05T06:25:00.000Z',
      issuedInferred: true,
      providerSegmentEnd: null,
      band: null,
      horizonEnd: iso(r.lastValid),
      state: 'no_ref',
      basis: null,
    });
    // the horizon end is the run's own end, or now + 48 h, whichever is first
    const long = row({ lastValid: NOW + 90 * H });
    expect(shown(long).horizonEnd).toBe(iso(NOW + 48 * H));
    expect(shown(long, rules({ now: NOW - 10 * H })).horizonEnd).toBe(iso(NOW + 38 * H));
    for (const [source, agency] of [
      ['DE-2', 'BfG'],
      ['DE-3', 'BfG'],
      ['LU-3', 'AGE'],
      ['CH-4', 'BAFU'],
      ['FR-4', 'Vigicrues'],
    ] as const)
      expect(shown(row({ source }), rules()).agency, source).toBe(agency);
  });

  it('carries the classifier state and basis through unchanged', () => {
    const basis = { source: 'DE-1', kind: 'statistical', measure: 'stage', ref: 'MNW', label: 'WSV MNW' } as const;
    expect(shown(row(), rules(), { state: 'low', basis })).toMatchObject({ state: 'low', basis });
  });

  it('marks an estimate from the ESTIMATE flag, and from a valid time after the provider segment end', () => {
    const end = T('2026-10-05T12:00:00Z');
    const at = (ts: number, flags = 0) => shown(de2({ segmentEnd: end, point: { ts, flags } }));
    expect(at(end - 2 * H).estimate).toBe(false);
    expect(at(end).estimate).toBe(false);
    expect(at(end + 1).estimate).toBe(true);
    expect(at(end + 2 * H).estimate).toBe(true);
    // the flag alone is enough, with or without a segment end
    expect(shown(de2({ segmentEnd: end, point: { ts: end - 2 * H, flags: FLAGS.ESTIMATE } })).estimate).toBe(true);
    expect(shown(row({ point: { flags: FLAGS.ESTIMATE } })).estimate).toBe(true);
    // no segment end and no flag: a forecast, never an estimate
    expect(shown(row({ segmentEnd: null, point: { ts: NOW + 40 * H } })).estimate).toBe(false);
    expect(shown(de2({ segmentEnd: end })).providerSegmentEnd).toBe(iso(end));
    // review F4: the segment's last point held at a t past the segment end is an estimate there
    const last = de2({ segmentEnd: end, point: { ts: end } });
    expect(heldForecast(last, rules(), SHOWN, end).estimate).toBe(false);
    expect(heldForecast(last, rules(), SHOWN, end + H).estimate).toBe(true);
  });

  it('shows a below-floor point with no value and no band, its flag kept', () => {
    const got = shown(
      row({
        source: 'LU-3',
        kind: 'quantiles',
        point: { value: 55, p10: 40, p90: 60, p25: 45, p75: 58, flags: FLAGS.BELOW_FLOOR },
      }),
    );
    expect(got.value).toBeNull();
    expect(got.band).toBeNull();
    expect(got.flags).toBe(FLAGS.BELOW_FLOOR);
    // a censored point keeps its own null and its flag
    expect(shown(row({ point: { value: null, flags: FLAGS.CENSORED } }))).toMatchObject({
      value: null,
      flags: FLAGS.CENSORED,
      band: null,
    });
  });

  it('shows the p10-p90 band where both are stated, else BAFU p25-p75, else none', () => {
    expect(shown(row({ point: { p10: 80, p90: 120 } })).band).toEqual({ kind: 'p10p90', lo: 80, hi: 120 });
    expect(shown(row({ point: { p25: 90, p75: 110, vmin: 70, vmax: 130 } })).band).toEqual({
      kind: 'p25p75',
      lo: 90,
      hi: 110,
    });
    // both pairs: p10-p90 wins; vmin and vmax alone are no band
    expect(shown(row({ point: { p10: 80, p90: 120, p25: 90, p75: 110 } })).band).toEqual({
      kind: 'p10p90',
      lo: 80,
      hi: 120,
    });
    expect(shown(row({ point: { vmin: 70, vmax: 130 } })).band).toBeNull();
    // half a pair is no band; the other full pair is
    expect(shown(row({ point: { p10: 80 } })).band).toBeNull();
    expect(shown(row({ point: { p90: 120 } })).band).toBeNull();
    expect(shown(row({ point: { p10: 80, p25: 90, p75: 110 } })).band).toEqual({ kind: 'p25p75', lo: 90, hi: 110 });
    expect(shown(row()).band).toBeNull();
    // a zero is a value, not a missing one
    expect(shown(row({ point: { p10: 0, p90: 0 } })).band).toEqual({ kind: 'p10p90', lo: 0, hi: 0 });
  });

  it('infers the issue time from the fetch where the provider states none', () => {
    const stated = shown(de2());
    expect(stated).toMatchObject({ issuedAt: iso(FRIDAY), issuedInferred: false });
    // no stated time: issuedAt is the fetch time, whatever the stored flag says
    const unstated = shown(row({ issued: null, issuedInferred: false }));
    expect(unstated).toMatchObject({ issuedAt: iso(row().fetched), issuedInferred: true });
    // the database holds issued_at = fetched_at and issued_inferred = true for an inferred time
    const stored = shown(row({ issued: T('2026-10-05T06:25:00Z'), issuedInferred: true }));
    expect(stored).toMatchObject({ issuedAt: '2026-10-05T06:25:00.000Z', issuedInferred: true });
  });

  it('every answer passes SnapshotForecast, and the contract refuses what the rules never build', () => {
    for (const source of FORECAST_PRECEDENCE)
      for (const point of [
        {},
        { p10: 1, p90: 2 },
        { flags: FLAGS.BELOW_FLOOR, value: null },
        { flags: FLAGS.ESTIMATE },
      ])
        expect(SnapshotForecast.safeParse(heldForecast(row({ source, point }), rules(), SHOWN)).success).toBe(true);
    const ok = heldForecast(row(), rules(), SHOWN);
    expect(SnapshotForecast.safeParse({ ...ok, source: 'CANARY-OWNER' }).success).toBe(false);
    expect(SnapshotForecast.safeParse({ ...ok, flags: 2 }).success).toBe(false);
    expect(SnapshotForecast.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe('forecastHorizons: the /meta list of a family', () => {
  it('the public family lists CH-4, FR-4 and NL-1 at 48 hours, and no owner source', () => {
    expect(forecastHorizons('public')).toEqual([
      { source: 'CH-4', hours: 48 },
      { source: 'FR-4', hours: 48 },
      { source: 'NL-1', hours: 48 },
    ]);
  });

  it('the owner family adds DE-2, DE-3 and LU-3, and never a source that does not forecast (the canary)', () => {
    expect(forecastHorizons('owner')).toEqual([
      { source: 'CH-4', hours: 48 },
      { source: 'DE-2', hours: 48 },
      { source: 'DE-3', hours: 48 },
      { source: 'FR-4', hours: 48 },
      { source: 'LU-3', hours: 48 },
      { source: 'NL-1', hours: 48 },
    ]);
    expect(JSON.stringify(forecastHorizons('owner'))).not.toContain('CANARY');
  });

  it('is a valid /meta field: whole hours from 1 to 48 of a catalogue source', () => {
    const meta = {
      now: '2026-10-05T09:00:00.000Z',
      dataEpoch: '2026-10-02T00:00:00.000Z',
      displayStart: '2026-10-01T00:00:00.000Z',
      build: 'dev',
      sources: [],
    };
    for (const family of ['public', 'owner'] as const)
      expect(Meta.safeParse({ ...meta, forecastHorizons: forecastHorizons(family) }).success, family).toBe(true);
    expect(Meta.safeParse({ ...meta, forecastHorizons: [{ source: 'NL-1', hours: 49 }] }).success).toBe(false);
  });
});

describe('the sources that forecast', () => {
  it('FORECAST_PRECEDENCE, the loader declarations and the agency names list the same sources (one that is missing from the precedence would never show)', () => {
    const declared = Object.keys(FORECAST_SOURCES).sort();
    expect([...FORECAST_PRECEDENCE].sort()).toEqual(declared);
    expect(Object.keys(AGENCY).sort()).toEqual(declared);
  });
});
