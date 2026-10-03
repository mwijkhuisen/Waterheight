import type { ApiStation, SeriesMeta, Snapshot } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { markerStates, stationPoints } from '../src/features/map/stationLayer.ts';
import { chartSpan } from '../src/lib/data/api.ts';
import { quantise } from '../src/lib/time/time.ts';

// The pure parts of the page that no DOM is needed for: what a marker shows
// at t, what reaches the map renderer, and which span the chart asks for.

const STEP = 600; // expectedStepSeconds of the test series

const series = (id: number, over: Partial<SeriesMeta> = {}): SeriesMeta => ({
  id,
  source: 'NL-1',
  quantity: 'H',
  valueKind: 'level',
  unit: 'cm',
  datum: 'NAP',
  nativeUnit: 'cm',
  expectedStepSeconds: STEP,
  stalenessLimitSeconds: 3 * STEP,
  dataSince: null,
  ...over,
});

const station = (id: string, ids: number[], over: Partial<ApiStation> = {}): ApiStation => ({
  id,
  name: `Name of ${id}`,
  waterName: 'Rijn',
  country: 'NL',
  lon: 6.1,
  lat: 51.8,
  tier: 1,
  flags: { tidal: null, impounded: null },
  series: ids.map((n) => series(n)),
  ...over,
});

const value = (id: number, ageSeconds: number): [number, Snapshot['values'][number]] => [
  id,
  {
    series: id,
    ts: '2026-10-25T01:30:00Z',
    value: 100,
    qc: 0,
    ageSeconds,
    state: 'no_ref',
    basis: null,
    section: false,
  },
];

describe('markerStates', () => {
  const a = station('nl.rws.a', [1]);

  it('has no value: hollow, not stale', () => {
    expect(markerStates([a], new Map()).get('nl.rws.a')).toEqual({ has: false, stale: false });
  });

  it('a value up to twice the step old is a current one', () => {
    expect(markerStates([a], new Map([value(1, 0)])).get('nl.rws.a')).toEqual({ has: true, stale: false });
    expect(markerStates([a], new Map([value(1, 2 * STEP)])).get('nl.rws.a')).toEqual({ has: true, stale: false });
  });

  it('only older values: stale', () => {
    expect(markerStates([a], new Map([value(1, 2 * STEP + 1)])).get('nl.rws.a')).toEqual({ has: true, stale: true });
  });

  it('two series, one fresh: not stale', () => {
    const two = station('nl.rws.two', [1, 2]);
    expect(markerStates([two], new Map([value(1, 5 * STEP), value(2, 0)])).get('nl.rws.two')).toEqual({
      has: true,
      stale: false,
    });
    expect(markerStates([two], new Map([value(1, 5 * STEP), value(2, 6 * STEP)])).get('nl.rws.two')).toEqual({
      has: true,
      stale: true,
    });
    // A series without a value does not make the station stale.
    expect(markerStates([two], new Map([value(2, 0)])).get('nl.rws.two')).toEqual({ has: true, stale: false });
  });

  it('judges each value by the step of its own series', () => {
    const slow = station('nl.rws.slow', [1], { series: [series(1, { expectedStepSeconds: 3600 })] });
    expect(markerStates([slow], new Map([value(1, 2 * 3600)])).get('nl.rws.slow')).toEqual({ has: true, stale: false });
  });

  it('answers once per station', () => {
    const states = markerStates([a, station('nl.rws.b', [2])], new Map([value(2, 0)]));
    expect([...states.keys()]).toEqual(['nl.rws.a', 'nl.rws.b']);
  });
});

describe('stationPoints', () => {
  it('leaves out a station with no position and carries only the id', () => {
    const points = stationPoints([
      station('nl.rws.a', [1]),
      station('nl.rws.nolon', [2], { lon: null }),
      station('nl.rws.nolat', [3], { lat: null }),
      station('nl.rws.b', [4], {
        lon: 5.5,
        lat: 52.1,
        name: '<img src=x onerror=alert(1)>',
        waterName: '<svg onload=alert(2)>',
      }),
    ]);
    expect(points.type).toBe('FeatureCollection');
    expect(points.features.map((f) => f.properties)).toEqual([{ id: 'nl.rws.a' }, { id: 'nl.rws.b' }]);
    expect(points.features.map((f) => f.geometry.coordinates)).toEqual([
      [6.1, 51.8],
      [5.5, 52.1],
    ]);
    // No name, water name or other text of a provider reaches the renderer.
    const json = JSON.stringify(points);
    expect(json).not.toMatch(/Name of|onerror|onload|Rijn/);
  });
});

describe('chartSpan', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const utc = (year: number, month: number, day: number, hour = 0, minute = 0) =>
    Date.UTC(year, month, day, hour, minute);
  const displayStart = utc(2026, 7, 24);
  const serverNow = utc(2026, 9, 26, 12, 3);

  it('ends at the next 6-hour UTC boundary after t and starts 7 days earlier', () => {
    const t = utc(2026, 9, 25, 1, 30);
    expect(chartSpan(t, displayStart, serverNow)).toEqual({
      from: utc(2026, 9, 18, 6, 0),
      to: utc(2026, 9, 25, 6, 0),
    });
    // On a boundary the span moves on to the next one, so t stays inside [from, to).
    const onBoundary = utc(2026, 9, 25, 6, 0);
    expect(chartSpan(onBoundary, displayStart, serverNow).to).toBe(utc(2026, 9, 25, 12, 0));
  });

  it('never ends past the API’s limit for `to`: the server’s now + 10 minutes, floored', () => {
    const t = utc(2026, 9, 26, 7, 0);
    const now = utc(2026, 9, 26, 7, 5);
    const span = chartSpan(t, displayStart, now);
    expect(span.to).toBe(utc(2026, 9, 26, 7, 10));
    expect(span.from).toBe(span.to - 7 * DAY);
  });

  it('holds the limit when the browser’s clock runs ahead of the server’s (CR-5)', () => {
    // The API at 12:09, the browser at 12:11: the page's newest t is 12:10, and `to` must stay ≤ 12:19.
    const api = utc(2026, 9, 26, 12, 9);
    const browser = utc(2026, 9, 26, 12, 11);
    const end = quantise(Math.min(browser, api + 5 * 60_000));
    expect(end).toBe(utc(2026, 9, 26, 12, 10));
    expect(chartSpan(end, displayStart, api).to).toBe(utc(2026, 9, 26, 12, 10));
    // Any skew, any t up to the page's end: never past the server's now + 10 minutes.
    for (let skew = -30 * 60_000; skew <= 30 * 60_000; skew += 60_000)
      for (let now = utc(2026, 9, 26, 11, 0); now <= utc(2026, 9, 26, 13, 0); now += 7 * 60_000) {
        const last = quantise(Math.min(now + skew, now + 5 * 60_000));
        for (const t of [last, last - 600_000, last - 6 * HOUR])
          expect(chartSpan(t, displayStart, now).to).toBeLessThanOrEqual(now + 10 * 60_000);
      }
  });

  it('never starts before the display window', () => {
    const t = utc(2026, 7, 25, 3, 0);
    const span = chartSpan(t, displayStart, serverNow);
    expect(span.from).toBe(displayStart);
    expect(span.to).toBe(utc(2026, 7, 25, 6, 0));
  });

  it('holds t, is at most 7 days, and is the same for every step inside six hours', () => {
    const end = quantise(serverNow);
    for (let t = displayStart; t <= end; t += 7 * 600_000 + 123_000) {
      const q = quantise(t);
      const { from, to } = chartSpan(q, displayStart, serverNow);
      expect(from).toBeLessThan(to);
      expect(q).toBeGreaterThanOrEqual(from);
      expect(q).toBeLessThan(to);
      expect(to - from).toBeLessThanOrEqual(7 * DAY);
      expect(from).toBeGreaterThanOrEqual(displayStart);
      expect(to % 600_000).toBe(0);
    }
    const spans = new Set<string>();
    for (let t = utc(2026, 9, 25, 6, 0); t < utc(2026, 9, 25, 12, 0); t += 600_000)
      spans.add(JSON.stringify(chartSpan(t, displayStart, serverNow)));
    expect(spans.size).toBe(1);
  });
});
