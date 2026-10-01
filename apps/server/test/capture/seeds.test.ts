import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { runSeeds, SEED_RETRY_MS, type SeedState, seedRecords, startSeeds } from '../../src/capture/seeds.ts';
import type { LoadedSpec, Registry } from '../../src/capture/specs.ts';
import type { SpecState } from '../../src/capture/state.ts';
import { fixture, registry, runDeps, spec } from './helpers.ts';

// The §0.1b day-0 harvest (code-review item 8): idempotent, paced, resumable,
// off the main queue; seed-report.json public only (LU-2 in the owner status).

const only = (...ids: string[]): Registry => ({ ...registry, specs: ids.map(spec) });
const paths = (root: string) => ({ rawDir: root, statusDir: `${root}/s`, ownerStatusDir: `${root}/o` });

afterEach(() => {
  vi.useRealTimers();
});

describe('seeds', () => {
  it('run once: a second start does nothing and says so', async () => {
    let calls = 0;
    server.use(
      http.get('https://www.hydrodaten.admin.ch/plots/p_q_40days/:file', () => {
        calls += 1;
        return new HttpResponse(fixture('CH-3', 'ch-3-40d').body);
      }),
    );
    const infos: string[] = [];
    // A fixed clock: the same body of all 11 stations in one second is one content-addressed object.
    const deps = runDeps({
      now: () => new Date('2026-10-02T06:00:00Z'),
      log: { info: (_o: unknown, m?: string) => void infos.push(String(m)), warn: () => {}, error: () => {} },
    });
    await runSeeds(only('ch-3-40d'), deps, paths(deps.root));
    expect(calls).toBe(11);
    const [rec] = await seedRecords(only('ch-3-40d'), deps);
    expect(rec).toMatchObject({ spec: 'ch-3-40d', series: 11, files: 1 });
    expect(rec?.days_covered).toBeGreaterThan(38);
    await runSeeds(only('ch-3-40d'), deps, paths(deps.root));
    expect(calls).toBe(11);
    expect(infos).toContain('seed already done');
  });

  it('pace FR-1 at ≥ 2 s per request, day by day, within one month', async () => {
    const sleeps: number[] = [];
    const windows: string[] = [];
    const page = JSON.parse(fixture('FR-1', 'fr-1-obs').body.toString()) as { next?: unknown };
    page.next = null;
    server.use(
      http.get('https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr', ({ request }) => {
        const u = new URL(request.url);
        windows.push(`${u.searchParams.get('date_debut_obs')}..${u.searchParams.get('date_fin_obs')}`);
        return HttpResponse.json(page);
      }),
    );
    const now = new Date('2026-10-02T06:00:00Z');
    const deps = runDeps({ now: () => now, sleep: async (ms) => void sleeps.push(ms) });
    await runSeeds(only('fr-1-obs'), deps, paths(deps.root));
    expect(windows).toHaveLength(30);
    expect(windows[0]).toBe('2026-09-02T07:00:00Z..2026-09-03T07:00:00Z');
    expect(sleeps.length).toBeGreaterThanOrEqual(29);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(2000);
    const st = await deps.state.read<SeedState>('seeds/fr-1-obs');
    expect(st?.done).toHaveLength(30);
    expect(st?.done_at).toBeDefined();
  });

  it.each([503, 429])('resume the LU-5 harvest after a file %i, fetching every dump by its own url', async (status) => {
    const all = Array.from({ length: 6 }, (_, i) => ({
      id: `0ebe38da-f4fa-4132-8fc0-47074d9186d${i}`,
      title: `dump-alert.179068836${i}.xml`,
      url: `https://download.data.public.lu/resources/alertes-du-systeme-lu-alert/20260929-13300${i}/dump-alert.179068836${i}.xml`,
    }));
    const base = 'https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/';
    let down = true;
    const fetched: string[] = [];
    server.use(
      http.get(base, ({ request }) => {
        const p = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return HttpResponse.json({
          data: all.slice((p - 1) * 3, p * 3),
          next_page: p === 1 ? `${base}?page=2&page_size=20` : null,
        });
      }),
      http.get('https://download.data.public.lu/resources/*', ({ request }) => {
        if (down && request.url.endsWith('88365.xml')) return new HttpResponse('busy', { status });
        fetched.push(request.url);
        return new HttpResponse(fixture('LU-5', 'lu-5-file').body);
      }),
    );
    const deps = runDeps();
    await runSeeds(only('lu-5-cap'), deps, paths(deps.root));
    expect((await deps.state.read<SeedState>('seeds/lu-5-cap'))?.done_at).toBeUndefined();
    expect(fetched).toHaveLength(5);
    // The seed's item stays open, though the run counts and names the file (#39).
    expect((await deps.state.read<SeedState>('seeds/lu-5-cap'))?.done).toEqual([]);
    expect((await deps.state.read<SpecState>('lu-5-cap'))?.failed_items).toEqual([`file/${all[5]?.id}`]);
    down = false;
    deps.client.politeness.success('download.data.public.lu');
    await runSeeds(only('lu-5-cap'), deps, paths(deps.root));
    expect(fetched).toHaveLength(6);
    expect(fetched.every((u) => all.some((a) => a.url === u))).toBe(true);
    const st = await deps.state.read<SeedState>('seeds/lu-5-cap');
    expect(st).toMatchObject({ files: 6 });
    expect(st?.done_at).toBeDefined();
  });

  it('report public seeds in seed-report.json, and the LU-2 first capture only in the owner status', async () => {
    server.use(
      http.get(
        'https://inondations.public.lu/content/dam/inondations/ctie/datas/:file',
        () => new HttpResponse(fixture('LU-2', 'lu-2-json').body),
      ),
      http.get(
        'https://inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv',
        () => new HttpResponse(fixture('LU-1', 'lu-1-csv').body),
      ),
    );
    const deps = runDeps();
    await runSeeds(only('lu-1-csv', 'lu-2-json'), deps, paths(deps.root));
    const report = readFileSync(join(deps.root, '_reports', 'seed-report.json'), 'utf8');
    expect(report).toContain('lu-1-csv');
    expect(report).not.toContain('lu-2');
    const recs = await seedRecords(only('lu-1-csv', 'lu-2-json'), deps);
    expect(recs.find((r) => r.spec === 'lu-2-json')).toMatchObject({ audience: 'owner', series: 39 });
    expect(recs.find((r) => r.spec === 'lu-1-csv')?.days_covered).toBeGreaterThanOrEqual(4);
  });
});

describe('seed completeness (C5, S8)', () => {
  const OBS = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr';
  const page = JSON.parse(fixture('FR-1', 'fr-1-obs').body.toString()) as { next: string | null };

  it.each([
    ['a 503', () => new HttpResponse('busy', { status: 503 })],
    ['a 404', () => new HttpResponse('gone', { status: 404 })],
    ['an invalid body', () => HttpResponse.html('<html><body>Maintenance</body></html>')],
  ])(
    'a day whose second page answered %s is not done, and the next round, an hour later, completes it (#42)',
    async (_, fail) => {
      vi.useFakeTimers({ now: new Date('2026-10-02T06:00:00Z') });
      let failures = 1;
      let requests = 0;
      const roots: string[] = [];
      server.use(
        http.get(OBS, ({ request }) => {
          requests += 1;
          const cursor = new URL(request.url).searchParams.get('cursor');
          if (cursor === null) roots.push(new URL(request.url).searchParams.get('date_debut_obs') as string);
          if (cursor !== null && failures > 0) {
            failures -= 1;
            return fail();
          }
          return HttpResponse.json({
            ...page,
            next: cursor === null ? `${OBS}?code_entite=A*&cursor=1&size=20000` : null,
          });
        }),
      );
      const deps = runDeps({ now: () => new Date() });
      const rounds: number[] = [];
      const harvest = startSeeds(only('fr-1-obs'), deps, paths(deps.root), async () => {
        rounds.push(requests);
      });
      await vi.waitFor(() => expect(rounds).toHaveLength(1), { timeout: 15_000 });
      const st = await deps.state.read<SeedState>('seeds/fr-1-obs');
      expect(st?.done).not.toContain('day0');
      expect(st?.done).toHaveLength(29);
      expect(st?.done_at).toBeUndefined();
      await vi.advanceTimersByTimeAsync(SEED_RETRY_MS);
      await vi.waitFor(() => expect(rounds).toHaveLength(2), { timeout: 15_000 });
      expect(rounds[1] as number).toBe((rounds[0] as number) + 2); // only day 0 again, both pages
      expect(roots.at(-1)).toBe(roots[0]); // the same window as in the first round, an hour earlier
      expect((await deps.state.read<SeedState>('seeds/fr-1-obs'))?.done_at).toBeDefined();
      await vi.advanceTimersByTimeAsync(3 * SEED_RETRY_MS);
      expect(rounds).toHaveLength(2); // done: no more rounds
      harvest.stop();
    },
  );

  it('a day whose walk ends in an empty page is done, with no alert (#42)', async () => {
    server.use(
      http.get(OBS, ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === null
          ? HttpResponse.json({ ...page, next: `${OBS}?code_entite=A*&cursor=1&size=20000` }, { status: 206 })
          : HttpResponse.json({ ...page, count: 0, data: [], next: null }),
      ),
    );
    const deps = runDeps();
    expect(await runSeeds(only('fr-1-obs'), deps, paths(deps.root))).toBe(true);
    const st = await deps.state.read<SeedState>('seeds/fr-1-obs');
    expect(st?.done).toHaveLength(30);
    expect(st?.done_at).toBeDefined();
    expect(deps.counters.alerts).toEqual({});
  });

  it.each([403, 451])('a row a WAF answers with %i is not done, and gets another round (N5)', async (status) => {
    server.use(
      http.get('https://www.hydrodaten.admin.ch/plots/p_q_40days/:file', () => new HttpResponse('no', { status })),
    );
    const s = spec('ch-3-40d');
    const deps = runDeps();
    expect(await runSeeds({ ...registry, specs: [{ ...s, rows: s.rows.slice(0, 1) }] }, deps, paths(deps.root))).toBe(
      false,
    );
    expect(await deps.state.read<SeedState>('seeds/ch-3-40d')).toMatchObject({ done: [] });
  });

  it('ends its rounds 31 days after the first one, and reports the seed as incomplete (N3)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T06:00:00Z') });
    let requests = 0;
    server.use(
      http.get(OBS, () => {
        requests += 1;
        return new HttpResponse('busy', { status: 503 });
      }),
    );
    const warnings: string[] = [];
    const deps = runDeps({
      now: () => new Date(),
      log: { info: () => {}, warn: (_o: unknown, m?: string) => void warnings.push(String(m)), error: () => {} },
    });
    // The first round began 31 days less one hour ago; every round since failed.
    await deps.state.update<SeedState>('seeds/fr-1-obs', () => ({
      done: [],
      files: 0,
      series: 1,
      coverage: null,
      started: '2026-09-01T07:00:00.000Z',
    }));
    const rounds: number[] = [];
    const harvest = startSeeds(only('fr-1-obs'), deps, paths(deps.root), async () => {
      rounds.push(requests);
    });
    await vi.waitFor(() => expect(rounds).toHaveLength(1), { timeout: 15_000 });
    expect(rounds[0]).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(SEED_RETRY_MS);
    await vi.waitFor(() => expect(rounds).toHaveLength(2), { timeout: 15_000 });
    expect(rounds[1]).toBe(rounds[0]); // 31 days are up: nothing is asked any more
    expect(warnings).toContain('seed incomplete after 31 days: no more rounds');
    expect(deps.counters.alerts['2026-10-02']).toMatchObject([{ spec: 'fr-1-obs', kind: 'seed_incomplete' }]);
    await vi.advanceTimersByTimeAsync(3 * SEED_RETRY_MS);
    expect(rounds).toHaveLength(2);
    expect(await seedRecords(only('fr-1-obs'), deps)).toEqual([]);
    harvest.stop();
  });

  it('sends no conditional header, so a 304 cannot mark a row done without data', async () => {
    const s = spec('de-1-series');
    const conditional: string[] = [];
    server.use(
      http.get(
        'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/:uuid/:ts/measurements.json',
        ({ request }) => {
          const tag = request.headers.get('if-none-match');
          if (tag !== null) {
            conditional.push(tag);
            return new HttpResponse(null, { status: 304 });
          }
          return new HttpResponse(fixture('DE-1', 'de-1-series').body, { headers: { etag: '"v2"' } });
        },
      ),
    );
    const deps = runDeps();
    const variant = `${s.rows[0]?.uuid}/${s.rows[0]?.ts}`;
    await deps.state.update<SpecState>(s.id, () => ({
      enabled_since: '2026-10-01T00:00:00.000Z',
      variants: { [variant]: { etag: '"v1"' } },
      seen: [],
      pending_page: [],
    }));
    const one: LoadedSpec = { ...s, rows: s.rows.slice(0, 1) };
    await runSeeds({ ...registry, specs: [one] }, deps, paths(deps.root));
    expect(conditional).toEqual([]);
    expect(await deps.state.read<SeedState>('seeds/de-1-series')).toMatchObject({ files: 1 });
  });

  it('caps the FR-1 pages for the whole seed, not per day window, and does not retry past the cap', async () => {
    let requests = 0;
    server.use(
      http.get(OBS, ({ request }) => {
        requests += 1;
        const n = Number(new URL(request.url).searchParams.get('cursor') ?? 0) + 1;
        return HttpResponse.json({ ...page, next: `${OBS}?code_entite=A*&cursor=${n}&size=20000` });
      }),
    );
    const s = spec('fr-1-obs');
    const capped: LoadedSpec = { ...s, seed: { ...(s.seed as NonNullable<LoadedSpec['seed']>), page_cap: 12 } };
    const deps = runDeps();
    expect(await runSeeds({ ...registry, specs: [capped] }, deps, paths(deps.root))).toBe(true);
    expect(requests).toBe(12);
    // The scheduled window anchor is not moved by a seed.
    expect((await deps.state.read<SpecState>('fr-1-obs'))?.variants.default?.last_success).toBeUndefined();
  });

  const LU5 = 'https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/';
  /** The LU-5 list: six dumps on two pages of three; page 2 answers `ctl.fail()` while it is set. */
  function lu5() {
    const all = Array.from({ length: 6 }, (_, i) => ({
      id: `0ebe38da-f4fa-4132-8fc0-47074d9186d${i}`,
      title: `dump-alert.179068836${i}.xml`,
      url: `https://download.data.public.lu/resources/alertes-du-systeme-lu-alert/20260929-13300${i}/dump-alert.179068836${i}.xml`,
    }));
    const ctl: { fail: (() => Response) | null; requests: number; fetched: string[] } = {
      fail: null,
      requests: 0,
      fetched: [],
    };
    server.use(
      http.get(LU5, ({ request }) => {
        ctl.requests += 1;
        const p = Number(new URL(request.url).searchParams.get('page') ?? '1');
        if (p === 2 && ctl.fail !== null) return ctl.fail();
        return HttpResponse.json({
          data: all.slice((p - 1) * 3, p * 3),
          next_page: p === 1 ? `${LU5}?page=2&page_size=20` : null,
        });
      }),
      http.get('https://download.data.public.lu/resources/*', ({ request }) => {
        ctl.requests += 1;
        ctl.fetched.push(request.url);
        return new HttpResponse(fixture('LU-5', 'lu-5-file').body);
      }),
    );
    return { all, ctl };
  }

  it('an LU-5 seed whose list page 2 answered a 404 is not done, and the next round completes it (#42)', async () => {
    const { all, ctl } = lu5();
    ctl.fail = () => new HttpResponse('gone', { status: 404 });
    const deps = runDeps();
    expect(await runSeeds(only('lu-5-cap'), deps, paths(deps.root))).toBe(false);
    let st = await deps.state.read<SeedState>('seeds/lu-5-cap');
    expect(st?.done_at).toBeUndefined();
    expect(st?.done).toEqual([]);
    ctl.fail = null;
    expect(await runSeeds(only('lu-5-cap'), deps, paths(deps.root))).toBe(true);
    st = await deps.state.read<SeedState>('seeds/lu-5-cap');
    expect(st?.done_at).toBeDefined();
    expect(ctl.fetched.sort()).toEqual(all.map((a) => a.url).sort());
  });

  it('caps the LU-5 requests for the whole seed, rounds included, and does not retry past the cap', async () => {
    const { ctl } = lu5();
    ctl.fail = () => new HttpResponse('gone', { status: 404 });
    const s = spec('lu-5-cap');
    const capped: LoadedSpec = { ...s, seed: { ...(s.seed as NonNullable<LoadedSpec['seed']>), page_cap: 8 } };
    const deps = runDeps();
    const rounds: boolean[] = [];
    while (rounds.at(-1) !== true && rounds.length < 10) {
      rounds.push(await runSeeds({ ...registry, specs: [capped] }, deps, paths(deps.root)));
      expect(ctl.requests).toBeLessThanOrEqual(8);
    }
    expect(rounds.at(-1)).toBe(true);
    expect((await deps.state.read<SeedState>('seeds/lu-5-cap'))?.done_at).toBeUndefined();
  });
});
