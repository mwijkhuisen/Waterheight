import type { ApiStation } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DH_COLOUR, dhBin, LADDER, levelOf, qSize, STATE_COLOUR } from '../src/features/legend/palette.ts';
import { OWNER_CONTRACTS } from '../src/features/owner/contracts.ts';
import { type Fetcher, loadMeta, loadRecent, loadSources, loadStations, loadWarnings } from '../src/lib/data/chain.ts';
import { changesAt, historySource } from '../src/lib/data/change.ts';
import { PUBLIC_CONTRACTS } from '../src/lib/data/contracts.ts';
import { validAt, warningsAt, warningsSource } from '../src/lib/data/warnings.ts';
import { HIDE_AFTER_S, hiddenKey, lapses, stationStates, visibleStations } from '../src/lib/stationStates.ts';

// P10a, the lead's pure parts: the warnings at t, the 24-hour change, the history source, the palette bins, the
// station feature-state record and the owner record's hidden canary.

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-10-26T12:00:00Z');
const feature = (over: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  geometry: null,
  properties: {
    source: 'DE-6',
    area: 'a1',
    name: 'Rhein',
    level: 3,
    levelRaw: '4',
    label: 'x',
    from: '2026-10-25T00:00:00Z',
    to: null as string | null,
    issuedAt: null,
    ...over,
  },
});
const warningsFile = (features: unknown[], day: string | null = null) => ({
  type: 'FeatureCollection',
  schemaVersion: 1,
  generatedAt: '2026-10-26T12:00:00Z',
  day,
  features,
  attribution: [],
});

function fake(table: Record<string, { status?: number; body?: unknown }>) {
  const asked: string[] = [];
  const f: Fetcher = async (path) => {
    asked.push(path);
    const r = table[path];
    if (r === undefined) return new Response('', { status: 404 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { f, asked };
}

describe('warnings at t', () => {
  it('chooses latest for the current bucket, the dated file for an ended day, latest marked incomplete otherwise', () => {
    expect(warningsSource(NOW, NOW, true)).toEqual({ kind: 'latest', incomplete: false });
    expect(warningsSource(T('2026-10-25T23:50:00Z'), NOW, true)).toEqual({ kind: 'dated', path: '2026-10-25.json' });
    expect(warningsSource(T('2026-10-26T00:00:00Z'), NOW, true)).toEqual({ kind: 'latest', incomplete: true });
    // The owner family has no dated files: a past day is latest, incomplete.
    expect(warningsSource(T('2026-10-25T23:50:00Z'), NOW, false)).toEqual({ kind: 'latest', incomplete: true });
  });

  it('holds from ≤ t < to, an open to never ends, one row per (source, area), the latest from wins', () => {
    const p = { from: '2026-10-25T00:00:00Z', to: '2026-10-25T12:00:00Z' };
    expect(validAt(p, T(p.from))).toBe(true);
    expect(validAt(p, T(p.to))).toBe(false);
    expect(validAt(p, T(p.from) - 1)).toBe(false);
    expect(validAt({ ...p, to: null }, T('2030-01-01T00:00:00Z'))).toBe(true);
    const older = feature({ from: '2026-10-24T00:00:00Z', to: '2026-10-25T06:00:00Z', level: 2 });
    const newer = feature({ from: '2026-10-25T06:00:00Z', level: 4 });
    const other = feature({ area: 'a2', from: '2026-10-20T00:00:00Z' }); // issued on an earlier day, still valid
    const out = warningsAt({ features: [older, newer, other] }, T('2026-10-25T08:00:00Z'), false);
    expect(out.features.map((f) => [f.properties.area, f.properties.level])).toEqual([
      ['a1', 4],
      ['a2', 3],
    ]);
    expect(warningsAt({ features: [older] }, T('2026-10-25T06:00:00Z'), true)).toEqual({
      features: [],
      incomplete: true,
    });
  });

  it('a missing dated file falls back to latest, marked incomplete; the owner record drops the canary', async () => {
    const { f, asked } = fake({
      '/data/v1/warnings/latest.geojson': {
        body: warningsFile([feature(), feature({ source: 'CANARY-OWNER', area: 'c' })].slice(0, 1)),
      },
    });
    const w = await loadWarnings(f, T('2026-10-25T12:00:00Z'), { now: '2026-10-26T12:00:00Z' });
    expect(asked).toEqual(['/data/v1/warnings/2026-10-25.json', '/data/v1/warnings/latest.geojson']);
    expect(w.incomplete).toBe(true);
    expect(w.features).toHaveLength(1);
    const owner = fake({
      '/data/v1/warnings/latest.geojson': {
        body: warningsFile([feature(), feature({ source: 'CANARY-OWNER', area: 'c' })]),
      },
    });
    const o = await loadWarnings(owner.f, NOW, { now: '2026-10-26T12:00:00Z' }, undefined, OWNER_CONTRACTS);
    expect(o.features.map((x) => x.properties.source)).toEqual(['DE-6']);
    expect(owner.asked).toEqual(['/data/v1/warnings/latest.geojson']);
  });

  it('a dated file that fails otherwise is an error, not a silent fallback', async () => {
    const { f } = fake({ '/data/v1/warnings/2026-10-25.json': { status: 500 } });
    await expect(loadWarnings(f, T('2026-10-25T12:00:00Z'), { now: '2026-10-26T12:00:00Z' })).rejects.toThrow();
  });
});

describe('the 24-hour change', () => {
  const quantity = new Map<number, 'H' | 'Q'>([
    [1, 'H'],
    [2, 'Q'],
  ]);

  it('is value(t) − value(t − 24 h) with core dead band, null without both values', () => {
    const now = [
      { series: 1, value: 512 },
      { series: 2, value: 1000 },
    ];
    const out = changesAt(quantity, now, [
      { series: 1, value: 500 },
      { series: 2, value: 985 },
    ]);
    expect(out.get(1)).toEqual({ dh: 12, trend: 'rising' });
    // Q: the band is max(1, 2 % of 985) = 19.7 m³/s.
    expect(out.get(2)).toEqual({ dh: 15, trend: 'steady' });
    expect(changesAt(quantity, now, []).get(1)).toBeNull();
    expect(changesAt(quantity, [{ series: 9, value: 1 }], []).has(9)).toBe(false);
  });

  it("takes latest.json's dh24 when given (its null stays null)", () => {
    const out = changesAt(
      quantity,
      [
        { series: 1, value: 500 },
        { series: 2, value: 10 },
      ],
      undefined,
      new Map([
        [1, -2],
        [2, null],
      ]),
    );
    expect(out.get(1)).toEqual({ dh: -2, trend: 'steady' });
    expect(out.get(2)).toBeNull();
  });

  it('chooses the history source: recent within 7 days, the API only for an api series', () => {
    const week = 7 * 86_400_000;
    expect(historySource(NOW, NOW, false)).toBe('recent');
    expect(historySource(NOW + 3_600_000, NOW, false)).toBe('recent');
    expect(historySource(NOW - week, NOW, false)).toBe('recent');
    expect(historySource(NOW - week - 600_000, NOW, true)).toBe('api');
    expect(historySource(NOW - week - 600_000, NOW, false)).toBe('none');
  });
});

describe('palette', () => {
  it('has one colour per state on the ladder and no red–green pair', () => {
    expect(LADDER.map(levelOf)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.keys(STATE_COLOUR).sort()).toEqual([...LADDER].sort());
    for (const hex of [...Object.values(STATE_COLOUR), ...Object.values(DH_COLOUR)]) {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      // A saturated red (r ≫ g, b) or green (g ≫ r, b) never appears.
      expect(r - Math.max(g, b) > 120 || g - Math.max(r, b) > 120, hex).toBe(false);
    }
  });

  it('bins Δh at ±2 (core band), 10 and 50 cm, and a discharge by its trend only', () => {
    expect(dhBin({ dh: 1.9, trend: 'steady' }, 'H')).toBe(0);
    expect(dhBin({ dh: 5, trend: 'rising' }, 'H')).toBe(1);
    expect(dhBin({ dh: 10, trend: 'rising' }, 'H')).toBe(1);
    expect(dhBin({ dh: 10.5, trend: 'rising' }, 'H')).toBe(2);
    expect(dhBin({ dh: 51, trend: 'rising' }, 'H')).toBe(3);
    expect(dhBin({ dh: -60, trend: 'falling' }, 'H')).toBe(-3);
    expect(dhBin({ dh: 500, trend: 'rising' }, 'Q')).toBe(1);
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), (dh) => {
        const trend = dh > 2 ? 'rising' : dh < -2 ? 'falling' : 'steady';
        expect(Math.sign(dhBin({ dh, trend }, 'H'))).toBe(trend === 'rising' ? 1 : trend === 'falling' ? -1 : 0);
      }),
    );
  });

  it('sizes discharge in log10 classes', () => {
    expect([0, -5, 9.9, 10, 99, 100, 999, 1000, 12_000].map(qSize)).toEqual([0, 0, 1, 2, 2, 3, 3, 4, 4]);
    expect(qSize(Number.NaN)).toBe(0);
  });
});

const series = (id: number, quantity: 'H' | 'Q', source = 'NL-1') => ({
  id,
  source,
  quantity,
  valueKind: quantity === 'H' ? ('level' as const) : null,
  unit: quantity === 'H' ? ('cm' as const) : ('m³/s' as const),
  datum: null,
  nativeUnit: quantity === 'H' ? ('cm' as const) : ('m3/s' as const),
  expectedStepSeconds: 600,
  stalenessLimitSeconds: 3600,
  dataSince: null,
});
const station = (id: string, s: ReturnType<typeof series>[]): ApiStation =>
  ({
    id,
    name: id,
    waterName: null,
    country: 'NL',
    lon: 5,
    lat: 52,
    tier: 1,
    flags: { tidal: null, impounded: null },
    series: s,
  }) as unknown as ApiStation;
const value = (id: number, over: Record<string, unknown> = {}) => ({
  series: id,
  ts: '2026-10-26T12:00:00Z',
  value: 100,
  qc: 1,
  ageSeconds: 0,
  state: 'normal' as const,
  basis: null,
  section: false,
  ...over,
});

describe('stationStates', () => {
  const st = station('nl.a.b', [series(1, 'H'), series(2, 'Q', 'BE-3')]);

  it('takes the highest state, the section of it, suspect bits, stale, Δh of H, Q size and owner', () => {
    const values = new Map([
      [1, value(1, { state: 'elevated', section: true, qc: 1 | 16, ageSeconds: 3000 })],
      [2, value(2, { state: 'normal', value: 250, ageSeconds: 1300 })],
    ]);
    const changes = new Map([
      [1, { dh: 30, trend: 'rising' as const }],
      [2, null],
    ]);
    const out = stationStates({
      stations: [st],
      values: values as never,
      forecasts: undefined,
      changes,
      ownerSources: new Set(['BE-3']),
    }).get('nl.a.b');
    expect(out).toEqual({
      has: true,
      stale: true,
      forecast: false,
      estimate: false,
      level: 3,
      section: true,
      suspect: true,
      dhBin: 2,
      qSize: 3,
      owner: true,
      hidden: false,
    });
  });

  // KG-233: latest.json's age of the newest value of a series with none at t. Series 1 and 2 have a 3600 s limit.
  describe('lapsed series (KG-233)', () => {
    const states = (ages: [number, number | null][], values = new Map<number, never>()) => {
      const lastAges = new Map(ages);
      const lapsed = lapses([st], values, lastAges);
      return {
        lapsed,
        out: stationStates({
          stations: [st],
          values,
          forecasts: undefined,
          changes: undefined,
          ownerSources: new Set(),
          lapsed,
        }).get('nl.a.b'),
      };
    };

    it('stale past the limit, hidden after 25 hours; never, or within the limit, is neither', () => {
      const { lapsed } = states([
        [1, 3601],
        [2, HIDE_AFTER_S + 1],
      ]);
      expect(lapsed.get(1)).toEqual({ hidden: false, ageSeconds: 3601 });
      expect(lapsed.get(2)).toEqual({ hidden: true, ageSeconds: HIDE_AFTER_S + 1 });
      // The DB keeps a value only while ts > t − limit: an age of exactly the limit is lapsed, one second less is not.
      expect(
        states([
          [1, 3600],
          [2, HIDE_AFTER_S],
        ]).lapsed,
      ).toEqual(
        new Map([
          [1, { hidden: false, ageSeconds: 3600 }],
          [2, { hidden: false, ageSeconds: HIDE_AFTER_S }],
        ]),
      );
      expect(states([[1, 3599]]).lapsed.size).toBe(0);
      expect(
        states([
          [1, null],
          [2, null],
        ]).lapsed.size,
      ).toBe(0);
      expect(lapses([st], new Map(), undefined).size).toBe(0);
    });

    it('a series with a value is never lapsed', () => {
      expect(states([[1, HIDE_AFTER_S + 1]], new Map([[1, value(1)]]) as never).lapsed.size).toBe(0);
    });

    it('a station with no value is stale while a series is under 25 hours old, hidden once all are over', () => {
      expect(
        states([
          [1, 7200],
          [2, null],
        ]).out,
      ).toMatchObject({ has: false, stale: true, hidden: false });
      expect(
        states([
          [1, HIDE_AFTER_S + 1],
          [2, HIDE_AFTER_S + 1],
        ]).out,
      ).toMatchObject({ stale: false, hidden: true });
      // A series that never had a value keeps the station on the map: it is only empty.
      expect(
        states([
          [1, HIDE_AFTER_S + 1],
          [2, null],
        ]).out,
      ).toMatchObject({ hidden: false });
    });

    it('a station with a value is never hidden, whatever its other series', () => {
      const out = states([[2, HIDE_AFTER_S + 1]], new Map([[1, value(1)]]) as never).out;
      expect(out).toMatchObject({ has: true, hidden: false });
    });

    it('the visible list changes only with the hidden set (the map rebuilds its source on a new list)', () => {
      const other = station('nl.c.d', [series(3, 'H')]);
      const at = (ages: [number, number | null][]) =>
        hiddenKey(
          stationStates({
            stations: [st, other],
            values: new Map(),
            forecasts: undefined,
            changes: undefined,
            ownerSources: new Set(),
            lapsed: lapses([st, other], new Map(), new Map(ages)),
          }),
        );
      const gone: [number, number | null][] = [
        [1, HIDE_AFTER_S + 1],
        [2, HIDE_AFTER_S + 1],
      ];
      // Two snapshots with other ages but the same hidden set: the same key, so the same memoised list.
      expect(at(gone)).toBe(at([...gone, [3, 7200]]));
      expect(at(gone)).toBe('nl.a.b');
      expect(at([])).toBe('');
      const list = [st, other];
      expect(visibleStations(list, '')).toBe(list);
      expect(visibleStations(list, at(gone))).toEqual([other]);
    });
  });

  it('a gauge class wins a tie with an area (section) class of the same level, in either order', () => {
    for (const order of [
      [1, 2],
      [2, 1],
    ]) {
      const values = new Map([
        [1, value(1, { state: 'elevated', section: false })],
        [2, value(2, { state: 'elevated', section: true })],
      ]);
      const sorted = { ...st, series: order.map((id) => (id === 1 ? series(1, 'H') : series(2, 'Q'))) };
      const out = stationStates({
        stations: [sorted as ApiStation],
        values: values as never,
        forecasts: undefined,
        changes: undefined,
        ownerSources: new Set(),
      }).get('nl.a.b');
      expect(out).toMatchObject({ level: 3, section: false });
    }
    // A higher area class still wins, with its badge.
    const higher = new Map([
      [1, value(1, { state: 'elevated', section: false })],
      [2, value(2, { state: 'high', section: true })],
    ]);
    expect(
      stationStates({
        stations: [st],
        values: higher as never,
        forecasts: undefined,
        changes: undefined,
        ownerSources: new Set(),
      }).get('nl.a.b'),
    ).toMatchObject({ level: 4, section: true });
  });

  it('has nothing without values; no Q series is null, a Q series without a value is 0', () => {
    const none = stationStates({
      stations: [st, station('nl.c.d', [series(3, 'H')])],
      values: new Map(),
      forecasts: undefined,
      changes: undefined,
      ownerSources: new Set(),
    });
    expect(none.get('nl.a.b')).toMatchObject({ has: false, level: 0, qSize: 0, dhBin: null, owner: false });
    expect(none.get('nl.c.d')?.qSize).toBeNull();
  });

  it('after now: the forecasts, their highest state, estimate only when every one is', () => {
    const out = stationStates({
      stations: [st],
      values: new Map(),
      forecasts: new Map([
        [1, { estimate: true, state: 'high' as const }],
        [2, { estimate: false, state: null }],
      ]),
      changes: undefined,
      ownerSources: new Set(),
    }).get('nl.a.b');
    expect(out).toMatchObject({ has: true, forecast: true, estimate: false, level: 4, dhBin: null, qSize: null });
  });
});

describe('the owner record (plan C1)', () => {
  it('hides the owner canary only; the public record hides nothing', () => {
    expect(OWNER_CONTRACTS.hidden('CANARY-OWNER')).toBe(true);
    expect(OWNER_CONTRACTS.hidden('BE-3')).toBe(false);
    expect(PUBLIC_CONTRACTS.hidden('CANARY-OWNER')).toBe(false);
    expect(OWNER_CONTRACTS.datedWarnings).toBe(false);
  });

  it('drops canary stations, series, meta sources and credits on read', async () => {
    const attribution: never[] = [];
    const meta = {
      now: '2026-10-26T12:00:00Z',
      dataEpoch: '2026-08-01T00:00:00Z',
      displayStart: '2026-08-01T00:00:00Z',
      build: 'dev',
      sources: [
        { id: 'BE-3', attribution: [] },
        { id: 'CANARY-OWNER', attribution: [] },
      ],
      forecastHorizons: [],
      audience: 'owner',
      attribution,
    };
    const { f } = fake({ '/api/v1/meta': { body: meta } });
    const m = await loadMeta(f, undefined, OWNER_CONTRACTS);
    expect(m.sources.map((s) => s.id)).toEqual(['BE-3']);
    // The public record refuses the canary's spelling outright (the static file and the API alike).
    await expect(loadMeta(f)).rejects.toThrow();

    const stations = {
      stations: [
        station('be.spw.x', [series(1, 'H', 'BE-3')]),
        station('nl.canary.x', [series(2, 'H', 'CANARY-OWNER')]),
        station('nl.mixed.x', [series(3, 'H', 'NL-1'), series(4, 'H', 'CANARY-OWNER')]),
      ],
      audience: 'owner',
      attribution,
    };
    const s = await loadStations(fake({ '/api/v1/stations': { body: stations } }).f, undefined, OWNER_CONTRACTS);
    expect(s.stations.map((x) => [x.id, x.series.map((y) => y.id)])).toEqual([
      ['be.spw.x', [1]],
      ['nl.mixed.x', [3]],
    ]);
  });

  it('reads the owner sources.json with each audience and private basis, canary dropped', async () => {
    const entry = (id: string, audience: 'public' | 'owner') => ({
      id,
      name: id,
      provider: 'p',
      licence: { kind: null, url: null },
      attribution: [],
      dateKind: null,
      date: null,
      dateText: null,
      audience,
      privateBasis:
        audience === 'owner' ? { clause: 'personal use', url: 'https://example.org/t', retrieved: '2026-09-01' } : null,
    });
    const body = {
      schemaVersion: 1,
      generatedAt: '2026-10-26T12:00:00Z',
      sources: [entry('NL-1', 'public'), entry('BE-3', 'owner'), entry('CANARY-OWNER', 'owner')],
      attribution: [],
    };
    const { f } = fake({ '/data/v1/sources.json': { body } });
    const out = await loadSources(f, undefined, OWNER_CONTRACTS);
    expect(out.sources.map((s) => [s.id, s.audience])).toEqual([
      ['NL-1', 'public'],
      ['BE-3', 'owner'],
    ]);
    await expect(loadSources(f)).rejects.toThrow();
  });

  it("drops a hidden source's series, run and references from recent.json", async () => {
    const run = null;
    const body = {
      schemaVersion: 1,
      station: 'nl.mixed.x',
      from: '2026-10-19T12:00:00Z',
      to: '2026-10-26T12:00:00Z',
      series: [
        {
          id: 3,
          source: 'NL-1',
          ts: [],
          value: [],
          qc: [],
          run,
          references: [
            { source: 'CANARY-OWNER', kind: 'X', value: 1, unit: 'cm', priority: 0, label: null },
            { source: 'NL-4', kind: 'NL4_FROM', value: 1, unit: 'cm', priority: 0, label: null },
          ],
        },
        { id: 4, source: 'CANARY-OWNER', ts: [], value: [], qc: [], run, references: [] },
      ],
      attribution: [],
    };
    const { f, asked } = fake({ '/data/v1/series/nl.mixed.x/recent.json': { body } });
    const out = await loadRecent(f, 'nl.mixed.x', undefined, OWNER_CONTRACTS);
    expect(asked).toEqual(['/data/v1/series/nl.mixed.x/recent.json']);
    expect(out.series.map((s) => [s.id, s.references.map((r) => r.source)])).toEqual([[3, ['NL-4']]]);
  });
});
