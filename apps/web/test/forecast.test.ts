import type { ApiStation, SeriesForecast, SeriesMeta, SnapshotForecast } from '@rws/contracts';
import { FORECAST_AHEAD_MS } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bandText, forecastDetail, forecastLine, forecastValue, issueText } from '../src/features/station/forecast.ts';
import { globalEnd, pageT, sliderEnd, stationHorizon } from '../src/lib/forecast.ts';
import { stationStates } from '../src/lib/stationStates.ts';
import { quantise } from '../src/lib/time/time.ts';

/** The after-now part of the station record (P10a: stationStates replaced stationLayer's forecastStates). */
const forecastStates = (stations: readonly ApiStation[], forecasts: ReadonlyMap<number, SnapshotForecast>) =>
  new Map(
    [...stationStates({ stations, values: new Map(), forecasts, changes: undefined, ownerSources: new Set() })].map(
      ([id, x]) => [id, { has: x.has, stale: x.stale, forecast: x.forecast, estimate: x.estimate }],
    ),
  );

// P8b, the pure parts of the forecast view: how far the slider reaches, which t the page shows, which marker a
// station gets after now, and the words of a forecast (agency, issue time, estimate, band, "no forecast").

const HOUR = 3_600_000;
const TEN_MIN = 600_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0); // 2026-10-26T12:00Z = 13:00 CET
const START = Date.UTC(2026, 7, 24);

describe('globalEnd', () => {
  it('is now plus the largest horizon of /meta', () => {
    expect(globalEnd(NOW, [])).toBe(NOW);
    expect(
      globalEnd(NOW, [
        { source: 'CH-4', hours: 24 },
        { source: 'NL-1', hours: 36 },
      ]),
    ).toBe(NOW + 36 * HOUR);
  });

  it('never reaches more than 48 hours', () => {
    expect(globalEnd(NOW, [{ source: 'NL-1', hours: 72 }])).toBe(NOW + 48 * HOUR);
  });
});

describe('sliderEnd', () => {
  const global = NOW + 48 * HOUR;

  it('is the global end with no selection or while the horizon is not known', () => {
    expect(sliderEnd(NOW, global, undefined)).toBe(global);
  });

  it('is now for a station none of whose series has a run', () => {
    expect(sliderEnd(NOW, global, null)).toBe(NOW);
  });

  it('is the station’s own horizon, on the 10-minute grid', () => {
    expect(sliderEnd(NOW, global, NOW + 30 * HOUR)).toBe(NOW + 30 * HOUR);
    expect(sliderEnd(NOW, global, NOW + 30 * HOUR + 7 * 60_000)).toBe(NOW + 30 * HOUR);
  });

  it('is capped at 48 hours and never before now', () => {
    expect(sliderEnd(NOW, global, NOW + 72 * HOUR)).toBe(NOW + 48 * HOUR);
    expect(sliderEnd(NOW, global, NOW - HOUR)).toBe(NOW);
  });

  it('property: always on the grid, between now and now + 48 h', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: NOW / TEN_MIN - 1000, max: NOW / TEN_MIN + 1000 }),
        fc.option(fc.integer({ min: -100, max: 100_000 }), { nil: undefined }),
        (n, station) => {
          const now = n * TEN_MIN;
          const end = sliderEnd(now, now + 48 * HOUR, station === undefined ? null : now + station * TEN_MIN);
          expect(end).toBeGreaterThanOrEqual(now);
          expect(end).toBeLessThanOrEqual(now + FORECAST_AHEAD_MS);
          expect(end).toBe(quantise(end));
        },
      ),
    );
  });
});

describe('pageT', () => {
  const end = NOW + 30 * HOUR;

  it('takes a t in the range as it is, in the past and in the forecast part', () => {
    expect(pageT(NOW - 3 * HOUR, START, NOW, end)).toBe(NOW - 3 * HOUR);
    expect(pageT(NOW, START, NOW, end)).toBe(NOW);
    expect(pageT(NOW + 20 * HOUR, START, NOW, end)).toBe(NOW + 20 * HOUR);
    expect(pageT(START, START, NOW, end)).toBe(START);
  });

  it('clamps a t beyond the selected station’s end to it, up to now + 48 h', () => {
    expect(pageT(NOW + 40 * HOUR, START, NOW, end)).toBe(end);
    expect(pageT(NOW + 48 * HOUR, START, NOW, end)).toBe(end);
    // A station without a forecast ends at now.
    expect(pageT(NOW + 40 * HOUR, START, NOW, NOW)).toBe(NOW);
  });

  it('treats a t before the first day, more than 48 h ahead or missing as no t: now', () => {
    expect(pageT(undefined, START, NOW, end)).toBe(NOW);
    expect(pageT(START - TEN_MIN, START, NOW, end)).toBe(NOW);
    expect(pageT(NOW + 48 * HOUR + TEN_MIN, START, NOW, end)).toBe(NOW);
  });
});

const run = (horizonEnd: string): SeriesForecast => ({
  series: 1,
  asof: '2026-10-26T12:00:00.000Z',
  run: {
    source: 'NL-1',
    agency: 'RWS',
    issuedAt: '2026-10-26T10:00:00.000Z',
    issuedInferred: false,
    fetchedAt: '2026-10-26T10:05:00.000Z',
    providerSegmentEnd: null,
    kind: 'deterministic',
    stepSeconds: 3600,
    bandKind: null,
    horizonEnd,
    points: [{ ts: '2026-10-26T10:00:00.000Z', value: 1, lo: null, hi: null, flags: 0 }],
  },
});

describe('stationHorizon', () => {
  it('is the latest horizon among the runs of the station’s series', () => {
    expect(stationHorizon([run('2026-10-27T10:00:00.000Z'), run('2026-10-27T18:00:00.000Z'), null])).toBe(
      Date.UTC(2026, 9, 27, 18),
    );
  });

  it('is null when no series has a run (a null answer, a run of null, or no series)', () => {
    expect(stationHorizon([])).toBeNull();
    expect(stationHorizon([null, { series: 2, asof: '2026-10-26T12:00:00.000Z', run: null }])).toBeNull();
  });
});

const series = (id: number, over: Partial<SeriesMeta> = {}): SeriesMeta => ({
  id,
  source: 'NL-1',
  quantity: 'H',
  valueKind: 'level',
  unit: 'cm',
  datum: 'NAP',
  nativeUnit: 'cm',
  expectedStepSeconds: 600,
  stalenessLimitSeconds: 1800,
  dataSince: null,
  ...over,
});
const station = (id: string, ids: number[]): ApiStation => ({
  id,
  name: id,
  waterName: null,
  country: 'NL',
  lon: 6.1,
  lat: 51.8,
  tier: 1,
  flags: { tidal: null, impounded: null },
  series: ids.map((n) => series(n)),
});
const forecast = (over: Partial<SnapshotForecast> = {}): SnapshotForecast => ({
  series: 1,
  source: 'NL-1',
  agency: 'RWS',
  ts: '2026-10-26T14:00:00.000Z',
  value: 340,
  flags: 0,
  estimate: false,
  issuedAt: '2026-10-26T11:00:00.000Z',
  issuedInferred: false,
  providerSegmentEnd: null,
  band: null,
  horizonEnd: '2026-10-27T18:00:00.000Z',
  state: 'normal',
  basis: null,
  ...over,
});

describe('forecastStates (the marker after now)', () => {
  const a = station('nl.rws.a', [1]);
  const two = station('nl.rws.two', [2, 3]);

  it('a station with a forecast has one; without, none: the map greys it', () => {
    const states = forecastStates([a, station('nl.rws.b', [9])], new Map([[1, forecast()]]));
    expect(states.get('nl.rws.a')).toEqual({ has: true, stale: false, forecast: true, estimate: false });
    expect(states.get('nl.rws.b')).toEqual({ has: false, stale: false, forecast: true, estimate: false });
  });

  it('an estimate marker needs every forecast of the station to be one', () => {
    const only = new Map([[2, forecast({ series: 2, estimate: true })]]);
    expect(forecastStates([two], only).get('nl.rws.two')).toMatchObject({ has: true, estimate: true });
    const mixed = new Map([...only, [3, forecast({ series: 3, estimate: false })]]);
    expect(forecastStates([two], mixed).get('nl.rws.two')).toMatchObject({ has: true, estimate: false });
  });

  it('answers once per station, in order', () => {
    expect([...forecastStates([a, two], new Map()).keys()]).toEqual(['nl.rws.a', 'nl.rws.two']);
  });
});

describe('forecast text', () => {
  const h = series(1);

  it('a value in its native unit; a missing one says why', () => {
    expect(forecastValue(forecast(), h, 'nl')).toBe('340 cm NAP');
    expect(forecastValue(forecast({ value: 1234.5 }), h, 'en')).toBe('1,234.5 cm NAP');
    expect(forecastValue(forecast({ value: null, flags: 1024 }), h, 'en')).toBe('below the forecastable range');
    expect(forecastValue(forecast({ value: null, flags: 128 }), h, 'nl')).toBe(
      'niet gepubliceerd (boven de limiet van de bron)',
    );
    expect(forecastValue(forecast({ value: null, flags: 0 }), h, 'nl')).toBe('Geen waarde op dit tijdstip');
  });

  it('the agency and the issue time in Amsterdam time, or fetched when the issue time is inferred', () => {
    // 11:00Z is 12:00 CET (winter time), 2026-07-01T10:00Z is 12:00 CEST.
    expect(issueText(forecast(), 'nl')).toMatch(/^RWS, uitgegeven .*26 okt.*12:00 CET$/);
    expect(issueText(forecast({ issuedInferred: true }), 'nl')).toMatch(/^RWS, opgehaald .*12:00 CET$/);
    expect(issueText(forecast({ issuedInferred: true }), 'en')).toMatch(/^RWS, fetched .*26 Oct.*12:00 CET$/);
    expect(issueText(forecast({ issuedAt: '2026-07-01T10:00:00.000Z' }), 'en')).toMatch(/^RWS, issued .*12:00 CEST$/);
  });

  it('the band as text: 10–90 % for most sources, 25–75 % for BAFU, nothing without one', () => {
    expect(bandText(forecast({ band: { kind: 'p10p90', lo: 320, hi: 365 } }), h, 'en')).toBe('10–90 %: 320–365 cm NAP');
    expect(bandText(forecast({ band: { kind: 'p25p75', lo: 1000, hi: 1500 } }), h, 'nl')).toBe(
      '25–75 %: 1.000–1.500 cm NAP',
    );
    expect(bandText(forecast(), h, 'nl')).toBeNull();
  });

  it('a popup line: value, forecast or estimate, issue, state and the basis label verbatim', () => {
    const hostile = {
      source: 'NL-4',
      kind: 'provider_class',
      measure: 'stage',
      ref: 'Licht verhoogd',
      label: '<img src=x onerror=alert(1)>',
    } as const;
    expect(forecastLine('Waterstand', forecast({ state: 'elevated', basis: hostile }), h, 'nl')).toBe(
      `Waterstand: 340 cm NAP, verwachting, ${issueText(forecast(), 'nl')}, verhoogd, RWS Waterinfo-legenda, geen officiële waarschuwing: <img src=x onerror=alert(1)>`,
    );
    expect(forecastLine('Water level', forecast({ estimate: true }), h, 'en')).toMatch(
      /^Water level: 340 cm NAP, estimate, RWS, issued .*, normal$/,
    );
  });

  it('a series without a forecast says so in words', () => {
    expect(forecastLine('Waterstand', undefined, h, 'nl')).toBe('Waterstand: Geen verwachting');
    expect(forecastLine('Water level', undefined, h, 'en')).toBe('Water level: No forecast');
  });

  it('the table cell: estimate, issue and band, in that order', () => {
    const f = forecast({ estimate: true, issuedInferred: true, band: { kind: 'p10p90', lo: 1, hi: 2 } });
    expect(forecastDetail(f, h, 'en')).toMatch(/^estimate; RWS, fetched .*12:00 CET; 10–90 %: 1–2 cm NAP$/);
    expect(forecastDetail(forecast(), h, 'nl')).toMatch(/^RWS, uitgegeven .*12:00 CET$/);
  });
});
