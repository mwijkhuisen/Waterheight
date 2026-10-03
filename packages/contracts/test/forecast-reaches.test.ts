import { describe, expect, it } from 'vitest';
import { ForecastCoverage, ForecastReach, ForecastReaches, ReachMatch } from '../src/forecast.ts';

// The reach matrix and its coverage report (P8a; catalogue §0.5): strict schemas, the bounds of a match, and the
// sums a coverage report must keep. (The registry file itself is pinned by test/forecast-reaches.test.ts.)

const reach = {
  id: 'upper-rhine',
  names: { nl: 'Boven-Rijn', en: 'Upper Rhine' },
  match: [{ rivers: ['rhine'], countries: ['DE'], km_max: 362.3 }],
  sources: [],
  after_permission: ['LUBW'],
  none_publishes: [],
};

describe('ReachMatch', () => {
  const ok = (m: unknown) => ReachMatch.safeParse(m).success;

  it('names rivers or countries, and a km bound belongs to a river', () => {
    expect(ok({ countries: ['CH'] })).toBe(true);
    expect(ok({ rivers: ['rhine'] })).toBe(true);
    expect(ok({ rivers: ['rhine'], countries: ['DE'], km_min: 362.3, km_max: 852 })).toBe(true);
    expect(ok({})).toBe(false);
    expect(ok({ km_max: 10 })).toBe(false);
    expect(ok({ countries: ['DE'], km_max: 10 })).toBe(false);
  });

  it('km_min must be below km_max; a river is a slug and a country one of the six', () => {
    expect(ok({ rivers: ['rhine'], km_min: 5, km_max: 5 })).toBe(false);
    expect(ok({ rivers: ['rhine'], km_min: 6, km_max: 5 })).toBe(false);
    expect(ok({ rivers: ['Rhine'] })).toBe(false);
    expect(ok({ rivers: [] })).toBe(false);
    expect(ok({ countries: ['AT'] })).toBe(false);
    expect(ok({ rivers: ['rhine'], x: 1 })).toBe(false);
  });
});

describe('ForecastReach and ForecastReaches', () => {
  it('accepts a row, rejects an unknown key (there is no stations override) and an owner-looking source id', () => {
    expect(ForecastReach.safeParse(reach).success).toBe(true);
    expect(ForecastReach.safeParse({ ...reach, stations: ['nl.rws.lobith'] }).success).toBe(false);
    expect(ForecastReach.safeParse({ ...reach, sources: ['CANARY-OWNER'] }).success).toBe(false);
    expect(ForecastReach.safeParse({ ...reach, sources: ['de-2'] }).success).toBe(false);
    expect(ForecastReach.safeParse({ ...reach, match: [] }).success).toBe(false);
    expect(ForecastReach.safeParse({ ...reach, after_permission: ['<b>x</b>'] }).success).toBe(false);
    expect(ForecastReach.safeParse({ ...reach, names: { nl: 'x' } }).success).toBe(false);
  });

  it('refuses a duplicate id and an unknown version', () => {
    expect(ForecastReaches.safeParse({ version: 1, reaches: [reach] }).success).toBe(true);
    expect(ForecastReaches.safeParse({ version: 1, reaches: [reach, reach] }).success).toBe(false);
    expect(ForecastReaches.safeParse({ version: 2, reaches: [reach] }).success).toBe(false);
    expect(ForecastReaches.safeParse({ version: 1, reaches: [] }).success).toBe(false);
  });
});

describe('ForecastCoverage', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ems-vecht',
    names: { nl: 'Eems, Vecht', en: 'Ems, Vecht' },
    stations: 4,
    covered: 3,
    sources: ['NL-1'],
    no_official_forecast: false,
    after_permission: [],
    none_publishes: ['NLWKN'],
    ...over,
  });
  const report = (over: Record<string, unknown> = {}) => ({
    t: '2026-10-03T12:00:00.000Z',
    total: { stations: 5, covered: 3 },
    countries: [{ country: 'NL', stations: 5, covered: 3 }],
    reaches: [row()],
    other: { stations: 1, covered: 0 },
    ...over,
  });
  const ok = (v: unknown) => ForecastCoverage.safeParse(v).success;

  it('accepts a report whose sums hold, with an empty matrix too', () => {
    expect(ok(report())).toBe(true);
    expect(
      ok(
        report({ total: { stations: 0, covered: 0 }, countries: [], reaches: [], other: { stations: 0, covered: 0 } }),
      ),
    ).toBe(true);
  });

  it('total is the sum over the countries and over the reaches plus other, for stations and covered', () => {
    expect(ok(report({ total: { stations: 6, covered: 3 } }))).toBe(false);
    expect(ok(report({ total: { stations: 5, covered: 4 } }))).toBe(false);
    expect(ok(report({ countries: [{ country: 'NL', stations: 4, covered: 3 }] }))).toBe(false);
    expect(ok(report({ other: { stations: 0, covered: 0 } }))).toBe(false);
  });

  it('covered never exceeds stations', () => {
    expect(
      ok(
        report({
          reaches: [row({ covered: 5 })],
          total: { stations: 5, covered: 5 },
          countries: [{ country: 'NL', stations: 5, covered: 5 }],
          other: { stations: 1, covered: 0 },
        }),
      ),
    ).toBe(false);
  });

  it('no_official_forecast is true exactly when the reach lists no source', () => {
    const none = (over: Record<string, unknown>) => report({ reaches: [row(over)] });
    expect(ok(none({ sources: [], no_official_forecast: true }))).toBe(true);
    expect(ok(none({ sources: [], no_official_forecast: false }))).toBe(false);
    expect(ok(none({ sources: ['NL-1'], no_official_forecast: true }))).toBe(false);
  });

  it('is strict at every level and takes UTC instants only', () => {
    expect(ok(report({ x: 1 }))).toBe(false);
    expect(ok(report({ reaches: [row({ x: 1 })] }))).toBe(false);
    expect(ok(report({ total: { stations: 5, covered: 3, ratio: 0.6 } }))).toBe(false);
    expect(ok(report({ t: '2026-10-03T12:00:00+02:00' }))).toBe(false);
    expect(ok(report({ countries: [{ country: 'AT', stations: 5, covered: 3 }] }))).toBe(false);
  });
});
