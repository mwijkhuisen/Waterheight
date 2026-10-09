import { dayOf } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { type Fetcher, loadMeta, loadSnapshot, loadStations } from '../src/lib/data/chain.ts';
import { snapshotSource, versionKey } from '../src/lib/data/static.ts';

// P9a: which file serves a t, and the static-first chain over an injected fetch.

const NOW = '2026-10-26T12:00:00.000Z';
const T = (iso: string) => Date.parse(iso);
const meta = (over: { now?: string; dayVersions?: Record<string, number> } = {}) => ({
  now: over.now ?? NOW,
  dayVersions: over.dayVersions ?? {},
});

describe('snapshotSource', () => {
  it('latest for now, recent for unsettled days, settled with the day version', () => {
    expect(snapshotSource(T(NOW), meta())).toEqual({ kind: 'latest' });
    expect(snapshotSource(T('2026-10-26T11:50:00Z'), meta())).toEqual({
      kind: 'recent',
      path: 'recent/2026-10-26/1150.json',
    });
    // 2026-10-24 ends 2026-10-25T00:00Z, which is after now − 48 h (2026-10-24T12:00Z): still recent.
    expect(snapshotSource(T('2026-10-24T00:00:00Z'), meta()).kind).toBe('recent');
    // 2026-10-23 ends 2026-10-24T00:00Z ≤ 2026-10-24T12:00Z: settled, version 1 when absent.
    expect(snapshotSource(T('2026-10-23T23:50:00Z'), meta())).toEqual({
      kind: 'settled',
      path: 'settled/2026-10-23/v1/2350.json',
      version: 1,
    });
    expect(snapshotSource(T('2026-10-23T23:50:00Z'), meta({ dayVersions: { '2026-10-23': 3 } }))).toMatchObject({
      path: 'settled/2026-10-23/v3/2350.json',
      version: 3,
    });
  });

  it('settles at the 48 h boundary, evaluated against meta.now', () => {
    const t = T('2026-10-24T12:00:00Z'); // day 2026-10-24
    expect(snapshotSource(t, meta({ now: '2026-10-26T23:59:59Z' })).kind).toBe('recent');
    expect(snapshotSource(t, meta({ now: '2026-10-27T00:00:00Z' })).kind).toBe('settled');
  });

  it('the API for the future, an unavailable day (0) and anything off the grid', () => {
    expect(snapshotSource(T('2026-10-26T12:10:00Z'), meta())).toEqual({ kind: 'api' });
    expect(snapshotSource(T('2026-10-23T12:00:00Z'), meta({ dayVersions: { '2026-10-23': 0 } }))).toEqual({
      kind: 'api',
    });
    expect(snapshotSource(T('2026-10-25T12:03:00Z'), meta())).toEqual({ kind: 'api' });
    expect(snapshotSource(Number.NaN, meta())).toEqual({ kind: 'api' });
  });

  it('2026-10-25 has 144 distinct buckets (the DST night), recent or settled', () => {
    const buckets = Array.from({ length: 144 }, (_, i) => T('2026-10-25T00:00:00Z') + i * 600_000);
    expect(new Set(buckets.map((t) => dayOf(t))).size).toBe(1);
    for (const now of [NOW, '2026-10-28T12:00:00.000Z']) {
      const paths = buckets.map((t) => {
        const s = snapshotSource(t, meta({ now }));
        return s.kind === 'recent' || s.kind === 'settled' ? s.path : s.kind;
      });
      expect(new Set(paths).size).toBe(144);
      expect(paths[0]).toMatch(now === NOW ? /^recent\// : /^settled\//);
    }
  });

  it('keys by what the answer depends on', () => {
    expect(versionKey({ kind: 'latest' }, 5)).toBe('latest:5');
    expect(versionKey({ kind: 'recent', path: 'x' }, 5)).toBe('recent');
    expect(versionKey({ kind: 'settled', path: 'x', version: 2 }, 5)).toBe('v2');
    expect(versionKey({ kind: 'api' }, 5)).toBe('api');
  });
});

// ---- the chain

const file = (t: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  t,
  series: [2, 5],
  ageSeconds: [0, 600],
  value: [10, 20],
  qc: [1, 1],
  state: ['normal', 'no_ref'],
  basis: [0, null],
  bases: [{ source: 'NL-4', kind: 'provider_class', measure: 'stage', ref: 'x', label: 'x' }],
  section: [false, false],
  area: [null, null],
  nap: [null, null],
  zero: [null, null],
  attribution: [],
  ...over,
});
const latest = (t: string, hash = 'aaaaaaaaaaaaaaaa') => ({
  ...file(t),
  generatedAt: t,
  seriesHash: hash,
  dh24: [null, null],
  dh1: [null, null],
  lapsed: [],
  lapsedAge: [],
});
const apiSnapshot = (t: string) => ({ t, values: [], attribution: [] });
const run = {
  series: 2,
  source: 'NL-1',
  agency: 'RWS',
  issuedAt: '2026-10-26T10:00:00Z',
  issuedInferred: false,
  fetchedAt: '2026-10-26T10:00:00Z',
  providerSegmentEnd: null,
  kind: 'deterministic',
  stepSeconds: 3600,
  validTs: ['2026-10-26T12:00:00Z', '2026-10-26T13:00:00Z', '2026-10-26T14:00:00Z'],
  value: [100, 110, 120],
  band: null,
  flags: [0, 0, 0],
};
const forecastFile = { schemaVersion: 1, now: NOW, runs: [run], attribution: [] };

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | 'network';
/** A fetcher over a table of path → reply; everything else is a 404. It records the paths asked. */
function fake(table: Record<string, Reply>) {
  const asked: string[] = [];
  const f: Fetcher = async (path) => {
    asked.push(path);
    const r = table[path];
    if (r === 'network') throw new TypeError('network');
    if (r === undefined) return new Response('', { status: 404 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { f, asked };
}

describe('loadSnapshot', () => {
  const m = meta();
  it('now reads latest.json when its hash is the stations file, through toSnapshot', async () => {
    const { f, asked } = fake({ '/data/v1/latest.json': { body: latest(NOW) } });
    const s = await loadSnapshot(f, T(NOW), m, 'aaaaaaaaaaaaaaaa');
    expect(asked).toEqual(['/data/v1/latest.json']);
    expect(s).toMatchObject({ t: NOW, standIn: false, degraded: false });
    expect(s.values.map((v) => [v.series, v.ts, v.basis?.label ?? null])).toEqual([
      [2, NOW, 'x'],
      [5, '2026-10-26T11:50:00.000Z', null],
    ]);
  });

  it('latest.json gives the age of the newest value of each lapsed series (KG-233)', async () => {
    const body = { ...latest(NOW), lapsed: [7, 8], lapsedAge: [5400, null] };
    const s = await loadSnapshot(fake({ '/data/v1/latest.json': { body } }).f, T(NOW), m, 'aaaaaaaaaaaaaaaa');
    expect(s.lastAge).toEqual(
      new Map([
        [7, 5400],
        [8, null],
      ]),
    );
  });

  it('a latest.json of another series hash goes to the API', async () => {
    const { f, asked } = fake({
      '/data/v1/latest.json': { body: latest(NOW, 'bbbbbbbbbbbbbbbb') },
      '/api/v1/snapshot?t=2026-10-26T12:00Z': { body: apiSnapshot(NOW) },
    });
    const s = await loadSnapshot(f, T(NOW), m, 'aaaaaaaaaaaaaaaa');
    expect(asked).toEqual(['/data/v1/latest.json', '/api/v1/snapshot?t=2026-10-26T12:00Z']);
    expect(s.standIn).toBe(false);
  });

  it('a past t reads its recent or settled file; a 404, a 5xx, a network error or bad JSON falls back to the API', async () => {
    const recent = '/data/v1/recent/2026-10-26/1150.json';
    const api = { '/api/v1/snapshot?t=2026-10-26T11:50Z': { body: apiSnapshot('2026-10-26T11:50:00.000Z') } };
    const t = T('2026-10-26T11:50:00Z');
    const ok = fake({ [recent]: { body: file('2026-10-26T11:50:00.000Z') } });
    expect((await loadSnapshot(ok.f, t, m, null)).values).toHaveLength(2);
    expect(ok.asked).toEqual([recent]);
    for (const reply of [{ status: 404 }, { status: 503 }, 'network', { body: { nope: 1 } }] as Reply[]) {
      const g = fake({ [recent]: reply, ...api });
      expect((await loadSnapshot(g.f, t, m, null)).values).toEqual([]);
      expect(g.asked).toEqual([recent, '/api/v1/snapshot?t=2026-10-26T11:50Z']);
    }
    const settled = fake({ '/data/v1/settled/2026-10-23/v2/1200.json': { body: file('2026-10-23T12:00:00.000Z') } });
    await loadSnapshot(settled.f, T('2026-10-23T12:00:00Z'), meta({ dayVersions: { '2026-10-23': 2 } }), null);
    expect(settled.asked).toEqual(['/data/v1/settled/2026-10-23/v2/1200.json']);
  });

  it('a file for another t is not taken', async () => {
    const g = fake({
      '/data/v1/recent/2026-10-26/1150.json': { body: file('2026-10-26T11:40:00.000Z') },
      '/api/v1/snapshot?t=2026-10-26T11:50Z': { body: apiSnapshot('2026-10-26T11:50:00.000Z') },
    });
    expect((await loadSnapshot(g.f, T('2026-10-26T11:50:00Z'), m, null)).t).toBe('2026-10-26T11:50:00.000Z');
    expect(g.asked).toHaveLength(2);
  });

  it('X-Degraded is a stand-in under its own t, never the requested one', async () => {
    const g = fake({
      '/data/v1/recent/2026-10-26/1150.json': { status: 503 },
      '/api/v1/snapshot?t=2026-10-26T11:50Z': { body: latest(NOW), headers: { 'x-degraded': '1' } },
    });
    const s = await loadSnapshot(g.f, T('2026-10-26T11:50:00Z'), m, null);
    expect(s).toMatchObject({ t: NOW, standIn: true, degraded: true });
    expect(s.values).toHaveLength(2);
  });

  it("an X-Degraded latest.json keeps its lapsed series' ages (KG-233)", async () => {
    const body = { ...latest(NOW), lapsed: [7, 8], lapsedAge: [5400, null] };
    const g = fake({
      '/data/v1/recent/2026-10-26/1150.json': { status: 503 },
      '/api/v1/snapshot?t=2026-10-26T11:50Z': { body, headers: { 'x-degraded': '1' } },
    });
    const s = await loadSnapshot(g.f, T('2026-10-26T11:50:00Z'), m, null);
    expect(s.standIn).toBe(true);
    expect(s.lastAge).toEqual(
      new Map([
        [7, 5400],
        [8, null],
      ]),
    );
  });

  it('a future t asks the API first (states); on failure or a stand-in, the held forecast file without states', async () => {
    const future = '2026-10-26T13:20:00.000Z';
    const path = '/api/v1/snapshot?t=2026-10-26T13:20Z';
    const forecast = { '/data/v1/forecast/latest.json': { body: forecastFile } };
    const live = fake({ [path]: { body: { t: future, values: [], attribution: [] } }, ...forecast });
    expect((await loadSnapshot(live.f, T(future), m, null)).degraded).toBe(false);
    expect(live.asked).toEqual([path]);
    for (const reply of [
      { status: 503 },
      'network',
      { body: latest(NOW), headers: { 'x-degraded': '1' } },
    ] as Reply[]) {
      const g = fake({ [path]: reply, ...forecast });
      const s = await loadSnapshot(g.f, T(future), m, null);
      expect(g.asked).toEqual([path, '/data/v1/forecast/latest.json']);
      expect(s).toMatchObject({ t: future, values: [], standIn: false, degraded: true });
      expect(s.forecasts).toEqual([
        expect.objectContaining({
          series: 2,
          source: 'NL-1',
          ts: '2026-10-26T13:00:00Z',
          value: 110,
          state: null,
          basis: null,
        }),
      ]);
    }
    // Both gone: the error stands.
    await expect(loadSnapshot(fake({ [path]: { status: 503 } }).f, T(future), m, null)).rejects.toThrow();
  });

  it('an aborted request is not retried against the API', async () => {
    const c = new AbortController();
    const g = fake({});
    const f: Fetcher = (p, s) => {
      c.abort();
      return g.f(p, s).then(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    };
    await expect(loadSnapshot(f, T('2026-10-26T11:50:00Z'), m, null, c.signal)).rejects.toThrow('aborted');
    expect(g.asked).toHaveLength(1);
  });
});

describe('loadMeta and loadStations', () => {
  const apiMeta = {
    now: NOW,
    dataEpoch: '2026-10-24T00:00:00Z',
    displayStart: '2026-10-24T00:00:00Z',
    build: 'dev',
    sources: [],
    forecastHorizons: [],
    attribution: [],
  };
  it("meta: static first; the API's meta has no day versions and is not degraded", async () => {
    const { f } = fake({ '/api/v1/meta': { body: apiMeta } });
    expect(await loadMeta(f)).toEqual({ ...apiMeta, dayVersions: {}, degraded: false });
    const fromStatic = fake({
      '/data/v1/meta.json': {
        body: {
          ...apiMeta,
          schemaVersion: 1,
          generatedAt: NOW,
          dayVersions: { '2026-10-23': 0 },
          degraded: true,
          latestFrom: null,
          attribution: [],
        },
      },
    });
    expect(await loadMeta(fromStatic.f)).toMatchObject({ dayVersions: { '2026-10-23': 0 }, degraded: true });
    expect(fromStatic.asked).toEqual(['/data/v1/meta.json']);
  });
  it('stations: static with its hash, else the API with none', async () => {
    const st = {
      id: 'nl.a.b',
      name: 'A',
      waterName: null,
      country: 'NL',
      lon: 5,
      lat: 52,
      tier: 1,
      flags: { tidal: null, impounded: null },
      series: [
        {
          id: 1,
          source: 'NL-1',
          quantity: 'H',
          valueKind: 'level',
          unit: 'cm',
          datum: 'NAP',
          nativeUnit: 'cm',
          expectedStepSeconds: 600,
          stalenessLimitSeconds: 1800,
          dataSince: null,
        },
      ],
    };
    const a = fake({
      '/data/v1/stations.json': {
        body: {
          schemaVersion: 2,
          seriesHash: 'aaaaaaaaaaaaaaaa',
          stations: [{ ...st, series: st.series.map((s) => ({ ...s, api: true })) }],
          attribution: [],
        },
      },
    });
    expect((await loadStations(a.f)).seriesHash).toBe('aaaaaaaaaaaaaaaa');
    const b = fake({
      '/data/v1/stations.json': { status: 500 },
      '/api/v1/stations': { body: { stations: [st], attribution: [] } },
    });
    expect(await loadStations(b.f)).toMatchObject({ seriesHash: null, stations: [{ id: 'nl.a.b' }] });
    // A cached v1 file (no `api`, schemaVersion 1) no longer parses: the page reads the API instead.
    const c = fake({
      '/data/v1/stations.json': {
        body: { schemaVersion: 1, seriesHash: 'aaaaaaaaaaaaaaaa', stations: [st], attribution: [] },
      },
      '/api/v1/stations': { body: { stations: [st], attribution: [] } },
    });
    expect(await loadStations(c.f)).toMatchObject({ seriesHash: null });
    expect(c.asked).toEqual(['/data/v1/stations.json', '/api/v1/stations']);
  });
});
