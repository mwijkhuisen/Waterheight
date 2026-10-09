import { gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../apps/server/src/api/channels.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { CANARIES, StaticStations, type Stations } from '../packages/contracts/src/index.ts';
import {
  CHECKS,
  checkApiSweep,
  checkSettledSweep,
  decodedBody,
  grepPage,
  type Page,
  pacedGet,
  readStatic,
  runApiSweep,
  runSettledSweep,
  STATIC_CACHE,
  SWEEP_ENCODINGS,
  SWEEP_MAX_RETRIES,
  SWEEP_MAX_SERIES,
  SWEEP_PACE_MS,
  SWEEP_SETTLED_FRAMES,
  SWEEP_SETTLED_SNAPSHOTS,
  type SweepAsk,
  type SweepIo,
  settledSample,
  staticLeakTerms,
  sweepAsks,
  sweepTerms,
} from '../scripts/verify-prod.ts';

// P9b: the api sweep and the settled sweep of verify-prod (issue #24 [agent-prod]). Pure functions over fake pages,
// a fake clock and a fake transport: no network.

const registry = loadRegistry();
const terms = sweepTerms(registry);
const NOW = '2026-11-20T12:34:56Z';

const page = (body: string, over: Partial<Page> = {}): Page => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body,
  ...over,
});
const gz = (body: string): Page =>
  page('', { headers: { 'content-encoding': 'gzip' }, bytes: gzipSync(Buffer.from(body)) });
const zst = (body: string): Page =>
  page('', { headers: { 'content-encoding': 'zstd' }, bytes: zstdCompressSync(Buffer.from(body)) });
/** The page a server would send for `body` under the encoding asked for. */
const served = (body: string, enc: string): Page =>
  enc === 'gzip' ? gz(body) : enc === 'zstd' ? zst(body) : page(body);

const series = (id: number, source: string) => ({ id, source }) as never;
const stations = (): Stations =>
  ({
    stations: [
      { id: 'a', series: [series(3, 'NL-1'), series(4, 'NL-1')] },
      { id: 'b', series: [series(9, 'DE-1')] },
      { id: 'c', series: [series(7, 'CH-1'), series(8, 'DE-1')] },
    ],
  }) as never;

describe('terms', () => {
  it('are the static leak terms, both canary renderings, the canary station and source ids', () => {
    for (const t of [
      CANARIES.owner.text,
      CANARIES.owner.real,
      CANARIES.withheld.text,
      'nl.canary.owner',
      'CANARY-OWNER',
    ])
      expect(terms).toContain(t);
    for (const t of staticLeakTerms(registry)) expect(terms).toContain(t);
    expect(terms).toContain('BE-3');
  });
});

describe('decodedBody and grepPage', () => {
  it('reads identity, gzip and zstd as the client does', () => {
    expect(decodedBody(page('plain'))).toBe('plain');
    expect(decodedBody(gz('zipped'))).toBe('zipped');
    expect(decodedBody(zst('zstd'))).toBe('zstd');
  });
  it('is undefined for a body that does not decompress or an encoding it does not know', () => {
    expect(
      decodedBody(page('x', { headers: { 'content-encoding': 'gzip' }, bytes: Buffer.from('not gzip') })),
    ).toBeUndefined();
    expect(decodedBody(page('x', { headers: { 'content-encoding': 'br' } }))).toBeUndefined();
  });
  it('finds a term in every encoding and none in a clean body', () => {
    for (const enc of SWEEP_ENCODINGS) {
      expect(grepPage('/x', served('{"a":1}', enc), enc, terms), enc).toEqual([]);
      for (const secret of [CANARIES.owner.real, 'nl.canary.owner', 'BE-3', CANARIES.withheld.text])
        expect(grepPage('/x', served(`{"v":"${secret}"}`, enc), enc, terms), `${enc} ${secret}`).toEqual([
          `/x (${enc}): found ${secret}`,
        ]);
    }
  });
  it('asked for identity, a compressed answer is a problem', () => {
    expect(grepPage('/x', gz('{}'), 'identity', terms)).toEqual(['/x (identity): content-encoding gzip']);
  });
});

describe('sweepAsks', () => {
  const r = sweepAsks(stations(), NOW);
  it('covers every non-planned GET route of ROUTES and names none it does not know', () => {
    expect(r?.unknown).toEqual([]);
    const paths = (r?.asks ?? []).map((a) => a.path.split('?')[0]);
    for (const route of ROUTES.filter((x) => !x.planned && x.method === 'GET')) {
      const re = new RegExp(`^${route.path.replaceAll(/:[a-z]+/g, '[^/]+')}$`);
      expect(
        paths.some((p) => re.test(p ?? '')),
        route.path,
      ).toBe(true);
    }
  });
  it('asks the first series of each source, in source order', () => {
    const ids = (r?.asks ?? []).flatMap((a) => /^\/api\/v1\/series\/(\d+)\?/.exec(a.path)?.[1] ?? []);
    expect(ids).toEqual(['7', '9', '3']);
  });
  it('takes the instants from the server clock: now, 6 h and 3 d back, 6 h ahead; a raw span', () => {
    const snaps = (r?.asks ?? []).filter((a) => a.path.startsWith('/api/v1/snapshot')).map((a) => a.path);
    expect(snaps).toEqual([
      '/api/v1/snapshot?t=2026-11-20T12:30Z',
      '/api/v1/snapshot?t=2026-11-20T06:30Z',
      '/api/v1/snapshot?t=2026-11-17T12:30Z',
      '/api/v1/snapshot?t=2026-11-20T18:30Z',
    ]);
    expect((r?.asks ?? []).find((a) => a.path.startsWith('/api/v1/series/7?'))?.path).toBe(
      '/api/v1/series/7?from=2026-11-20T09:30Z&to=2026-11-20T12:30Z&res=raw',
    );
  });
  it('marks the series and frames routes heavy and the rest not', () => {
    for (const a of r?.asks ?? [])
      expect(a.heavy, a.path).toBe(a.path.startsWith('/api/v1/series/') || a.path.startsWith('/api/v1/frames'));
  });
  it('asks /frames for the last 3 whole hours, step 1h', () => {
    expect((r?.asks ?? []).filter((a) => a.path.startsWith('/api/v1/frames')).map((a) => a.path)).toEqual([
      '/api/v1/frames?from=2026-11-20T09:00Z&to=2026-11-20T12:00Z&step=1h',
    ]);
  });
  it('takes at most SWEEP_MAX_SERIES ids', () => {
    const many: Stations = {
      stations: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, series: [series(i + 1, `X-${i}`)] })),
    } as never;
    const ids = sweepAsks(many, NOW)?.asks.filter((a) => /^\/api\/v1\/series\/\d+\?/.test(a.path)) ?? [];
    expect(ids).toHaveLength(SWEEP_MAX_SERIES);
  });
  it('is undefined for a clock that is no instant', () => {
    expect(sweepAsks(stations(), 'soon')).toBeUndefined();
  });
});

describe('pacedGet', () => {
  /** A fake clock: sleeping advances it, and a request takes 10 ms. */
  const rig = (reply: (path: string, call: number) => Page | string) => {
    let t = 1000;
    const log: { path: string; at: number; headers: Record<string, string> }[] = [];
    const sleeps: number[] = [];
    const io: SweepIo = {
      get: async (path, headers) => {
        log.push({ path, at: t, headers: { ...headers } });
        t += 10;
        return reply(path, log.length);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    };
    return { io, log, sleeps };
  };
  const heavy = (n: number): SweepAsk => ({ label: `h${n}`, path: `/api/v1/series/${n}`, heavy: true });
  const light = (n: number): SweepAsk => ({ label: `l${n}`, path: `/api/v1/meta?${n}`, heavy: false });

  it('starts heavy requests at least 250 ms apart and light ones without waiting', async () => {
    const { io, log } = rig(() => page('{}'));
    const get = pacedGet(io);
    for (const a of [heavy(1), heavy(2), heavy(3)]) await get(a, 'identity');
    for (const a of [light(1), light(2)]) await get(a, 'gzip');
    const heavyAt = log.filter((l) => l.path.startsWith('/api/v1/series')).map((l) => l.at);
    expect((heavyAt[1] ?? 0) - (heavyAt[0] ?? 0)).toBeGreaterThanOrEqual(SWEEP_PACE_MS);
    expect((heavyAt[2] ?? 0) - (heavyAt[1] ?? 0)).toBeGreaterThanOrEqual(SWEEP_PACE_MS);
    const lightAt = log.filter((l) => l.path.startsWith('/api/v1/meta')).map((l) => l.at);
    expect((lightAt[1] ?? 0) - (lightAt[0] ?? 0)).toBe(10);
    expect(log.map((l) => l.headers['accept-encoding'])).toEqual(['identity', 'identity', 'identity', 'gzip', 'gzip']);
  });

  it('waits out a Retry-After once and asks again; the answer of the second ask is returned', async () => {
    const { io, log, sleeps } = rig((_p, call) =>
      call === 1 ? page('{}', { status: 429, headers: { 'retry-after': '3' } }) : page('{"ok":1}'),
    );
    const got = await pacedGet(io)(light(1), 'identity');
    expect(sleeps).toEqual([3000]);
    expect(log).toHaveLength(2);
    expect(got).toMatchObject({ status: 200 });
  });

  it('a second 429 for the same request is returned as it is, and a bad or huge Retry-After is bounded', async () => {
    const r1 = rig(() => page('{}', { status: 429, headers: { 'retry-after': 'soon' } }));
    expect(await pacedGet(r1.io)(light(1), 'identity')).toMatchObject({ status: 429 });
    expect(r1.sleeps).toEqual([2000]);
    expect(r1.log).toHaveLength(2);
    const r2 = rig(() => page('{}', { status: 429, headers: { 'retry-after': '9999' } }));
    await pacedGet(r2.io)(light(1), 'identity');
    expect(r2.sleeps).toEqual([30_000]);
  });

  it('stops waiting after SWEEP_MAX_RETRIES retries in one sweep', async () => {
    const { io, sleeps } = rig(() => page('{}', { status: 429, headers: { 'retry-after': '1' } }));
    const get = pacedGet(io);
    for (let i = 0; i < SWEEP_MAX_RETRIES + 2; i += 1) await get(light(i), 'identity');
    expect(sleeps).toHaveLength(SWEEP_MAX_RETRIES);
  });

  it('a network error is returned as the text', async () => {
    const { io } = rig(() => 'timeout');
    expect(await pacedGet(io)(light(1), 'identity')).toBe('timeout');
  });
});

describe('api sweep', () => {
  const asked = sweepAsks(stations(), NOW);
  const run = (body: (path: string) => string, status = 200) =>
    runApiSweep(asked?.asks ?? [], async (a, enc) => ({ ...served(body(a.path), enc), status }), terms);

  it('passes on clean bodies in every encoding', async () => {
    const out = await run(() => '{"values":[]}');
    expect(out.problems).toEqual([]);
    expect(out.requests).toBe((asked?.asks.length ?? 0) * SWEEP_ENCODINGS.length);
    expect(checkApiSweep(asked, out, terms.length)).toMatchObject({ check: 'api sweep', ok: true });
  });

  it.each([
    ['the owner canary as real', CANARIES.owner.real],
    ['the owner canary as text', CANARIES.owner.text],
    ['the withheld canary', CANARIES.withheld.real],
    ['the canary station', 'nl.canary.owner'],
    ['an owner source id', 'BE-3'],
  ])('fails on %s in one body, plain, gzip or zstd', async (_n, secret) => {
    for (const enc of SWEEP_ENCODINGS) {
      const out = await runApiSweep(
        asked?.asks ?? [],
        async (a, e) => served(a.path.startsWith('/api/v1/stations') && e === enc ? `{"x":"${secret}"}` : '{}', e),
        terms,
      );
      expect(out.problems, enc).toEqual([`/api/v1/stations (${enc}): found ${secret}`]);
      expect(checkApiSweep(asked, out, terms.length)).toMatchObject({
        ok: false,
        detail: new RegExp(`found ${secret}`),
      });
    }
  });

  it('fails on a 5xx, a 400, a network error and a 429 that stayed; a 404 passes only on a series route', async () => {
    expect((await run(() => '{}', 503)).problems[0]).toMatch(/status 503/);
    expect((await run(() => '{}', 400)).problems[0]).toMatch(/status 400/);
    const net = await runApiSweep(asked?.asks ?? [], async () => 'timeout', terms);
    expect(net.problems[0]).toMatch(/timeout/);
    const notFound = await run(() => '{}', 404);
    expect(notFound.problems.every((p) => !p.includes('/api/v1/series/'))).toBe(true);
    expect(notFound.problems.some((p) => p.includes('/api/v1/meta'))).toBe(true);
  });

  it('fails when the sources of the ids are not known or a route has no sweep', () => {
    expect(checkApiSweep(undefined, undefined, 3)).toMatchObject({ ok: false });
    const out = { requests: 0, problems: [] };
    expect(
      checkApiSweep({ asks: [{ label: 'x', path: '/x', heavy: false }], unknown: ['/api/v1/new'] }, out, 3),
    ).toMatchObject({
      ok: false,
      detail: /no sweep for the route \/api\/v1\/new/,
    });
  });
});

describe('settled sweep', () => {
  const meta = (over: Record<string, unknown> = {}) =>
    ({
      now: '2026-10-30T12:00:00Z',
      displayStart: '2026-10-20T06:00:00Z',
      dayVersions: {},
      ...over,
    }) as never;

  it('samples settled snapshots and frames, deterministically, from the display window to the newest settled day', () => {
    const s = settledSample(meta());
    expect(settledSample(meta())).toEqual(s);
    expect(s.snapshots).toHaveLength(SWEEP_SETTLED_SNAPSHOTS);
    expect(s.frames.length).toBeGreaterThan(0);
    expect(s.frames.length).toBeLessThanOrEqual(SWEEP_SETTLED_FRAMES);
    for (const p of s.snapshots) {
      expect(p).toMatch(/^settled\/2026-10-(2\d|30)\/v1\/\d{4}\.json$/);
      // The newest settled day at 2026-10-30T12:00Z is 2026-10-27 (D + 1 d <= now - 48 h).
      expect(p.slice(8, 18) <= '2026-10-27').toBe(true);
      expect(p.slice(8, 18) >= '2026-10-20').toBe(true);
    }
    expect(s.snapshots.join()).not.toContain('2026-10-20/v1/0000');
  });

  it('takes the version of meta.dayVersions (absent 1) and skips a day of version 0', () => {
    const s = settledSample(meta({ dayVersions: { '2026-10-22': 3, '2026-10-23': 0 } }));
    const all = [...s.snapshots, ...s.frames].join('\n');
    expect(all).not.toContain('2026-10-23');
    expect(all).toMatch(/2026-10-22\/v3/);
    expect(all).not.toMatch(/2026-10-22\/v1/);
  });

  it('is empty, and the check n/a, while no settled day is complete', () => {
    for (const m of [
      meta({ now: '2026-10-21T12:00:00Z' }),
      meta({ dayVersions: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`2026-10-${20 + i}`, 0])) }),
    ]) {
      const s = settledSample(m);
      expect(s).toEqual({ snapshots: [], frames: [] });
      expect(checkSettledSweep(s, undefined, 3)).toMatchObject({ check: 'settled sweep', ok: 'n/a' });
    }
    expect(checkSettledSweep(undefined, undefined, 3)).toMatchObject({ ok: false });
  });

  const sample = settledSample(meta());
  it('passes on clean bodies in every encoding, and a 404 is a file not rendered', async () => {
    const out = await runSettledSweep(sample, async (_p, enc) => served('{"series":[]}', enc), terms);
    expect(out).toMatchObject({ problems: [], found: sample.snapshots.length + sample.frames.length });
    expect(checkSettledSweep(sample, out, terms.length)).toMatchObject({ ok: true });
    const none = await runSettledSweep(sample, async () => page('', { status: 404 }), terms);
    expect(none.found).toBe(0);
    expect(checkSettledSweep(sample, none, terms.length)).toMatchObject({
      ok: 'n/a',
      detail: /none of \d+ sampled files/,
    });
  });

  it.each(SWEEP_ENCODINGS)('fails on a canary or an owner id in a %s body', async (enc) => {
    for (const secret of [CANARIES.owner.real, 'nl.canary.owner', 'CANARY-OWNER', 'LU-4']) {
      const target = sample.snapshots[3] ?? '';
      const out = await runSettledSweep(
        sample,
        async (p, e) => served(p === target && e === enc ? `{"a":"${secret}"}` : '{}', e),
        terms,
      );
      expect(out.problems, secret).toEqual([`${target} (${enc}): found ${secret}`]);
      expect(checkSettledSweep(sample, out, terms.length)).toMatchObject({ ok: false });
    }
  });

  it('fails on a 5xx and on a frames file with a term', async () => {
    const out = await runSettledSweep(sample, async () => page('', { status: 502 }), terms);
    expect(out.problems[0]).toMatch(/status 502/);
    const frames = sample.frames[0] ?? '';
    const leak = await runSettledSweep(
      sample,
      async (p, e) => served(p === frames ? CANARIES.owner.text : '{}', e),
      terms,
    );
    expect(leak.problems).toHaveLength(SWEEP_ENCODINGS.length);
  });
});

describe('stations.json schemaVersion 2 (C18)', () => {
  const file = (version: number, api?: boolean) => {
    const s = {
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
      ...(api === undefined ? {} : { api }),
    };
    const body = {
      schemaVersion: version,
      seriesHash: '0'.repeat(16),
      attribution: [],
      stations: [
        {
          id: 'nl.a.b',
          name: 'A',
          waterName: null,
          country: 'NL',
          lon: 5,
          lat: 52,
          tier: 1,
          flags: { tidal: null, impounded: null },
          series: [s],
        },
      ],
    };
    return page(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': STATIC_CACHE.slow },
    });
  };
  it('verify-prod reads v2 with api and refuses v1 or a file without api', () => {
    expect(readStatic(file(2, true), StaticStations, STATIC_CACHE.slow).problems).toEqual([]);
    expect(readStatic(file(2, false), StaticStations, STATIC_CACHE.slow).problems).toEqual([]);
    expect(readStatic(file(1, true), StaticStations, STATIC_CACHE.slow).problems).toEqual([
      'not the contract document',
    ]);
    expect(readStatic(file(2), StaticStations, STATIC_CACHE.slow).problems).toEqual(['not the contract document']);
  });
});

describe('the dry-run list', () => {
  it('names both sweeps once, after the owner checks and before the interval', () => {
    for (const n of ['api sweep', 'settled sweep'])
      expect(
        CHECKS.filter((c) => c.startsWith(`${n}:`)),
        n,
      ).toHaveLength(1);
  });
});
