import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { BASINS } from '../../src/adapters/fr-4/capture.ts';
import { ManifestLine } from '../../src/archive/manifest.ts';
import { Archive } from '../../src/archive/writer.ts';
import { runSpec } from '../../src/capture/runner.ts';
import type { SpecState } from '../../src/capture/state.ts';
import { buildStatus, isFresh } from '../../src/capture/status.ts';
import type { Transport } from '../../src/http/types.ts';
import { fixture, registry, runDeps, spec } from './helpers.ts';

// dup_of, 204/304, gates and windows (issue #16 criteria "The manifest
// round-trips its Zod schema. An identical body produces dup_of and no new
// object", and code-review items 2, 4 and 11).

const lines = (root: string) => {
  const dir = join(root, '_manifest');
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
    .map((l) => ManifestLine.parse(JSON.parse(l)));
};
const objects = (root: string, source: string) =>
  readdirSync(join(root, source), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;

function clock(start: string) {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

describe('dup_of and line-only captures', () => {
  it('an identical body gives dup_of and no new object; a changed body is stored again', async () => {
    const c = clock('2026-10-02T12:08:00Z');
    const deps = runDeps({ now: c.now });
    let body = fixture('DE-6', 'de-6-stations').body;
    server.use(http.get('https://api.hochwasserzentralen.de/public/v1/data/stations', () => new HttpResponse(body)));
    const s = spec('de-6-stations');
    await runSpec(s, deps);
    c.advance(600_000);
    await runSpec(s, deps);
    let l = lines(deps.root);
    expect(l[0]?.key).toMatch(/^raw\/DE-6\/de-6-stations\/2026\/10\/02\/120800Z-[0-9a-f]{16}\.zst$/);
    expect(l[1]?.key).toBeNull();
    expect(l[1]?.dup_of).toBe(l[0]?.key);
    expect(objects(deps.root, 'DE-6')).toBe(1);
    body = Buffer.from(body.toString().replace('"status":"success"', '"status":"success","x":1'));
    c.advance(600_000);
    await runSpec(s, deps);
    l = lines(deps.root);
    expect(l[2]?.dup_of).toBeNull();
    expect(l[2]?.key).not.toBeNull();
    expect(objects(deps.root, 'DE-6')).toBe(2);
    expect(deps.counters.days['2026-10-02']?.['DE-6']).toMatchObject({ scheduled: 3, ok: 3 });
  });

  it('a 304 (If-None-Match) and an RWS 204 give a line and no object', async () => {
    const deps = runDeps();
    const body = fixture('DE-6', 'de-6-stations').body;
    server.use(
      http.get('https://api.hochwasserzentralen.de/public/v1/data/stations', ({ request }) =>
        request.headers.get('if-none-match') === '"v1"'
          ? new HttpResponse(null, { status: 304 })
          : new HttpResponse(body, { headers: { etag: '"v1"' } }),
      ),
      http.post(
        'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await runSpec(spec('de-6-stations'), deps);
    await runSpec(spec('de-6-stations'), deps);
    const s = spec('nl-1-obs-key');
    await runSpec(s, deps, { rows: s.rows.slice(0, 1) });
    const l = lines(deps.root);
    expect(l.map((x) => [x.status, x.key === null])).toEqual([
      [200, false],
      [304, true],
      [204, true],
    ]);
    expect(l[2]?.validity).toBeNull();
    const st = await deps.state.read<SpecState>('nl-1-obs-key');
    expect(st?.last_success).toBeDefined();
  });

  it('a 204 is a success only where allow_status has it (C7)', async () => {
    const deps = runDeps();
    server.use(
      http.get(
        'https://api.hochwasserzentralen.de/public/v1/data/stations',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    expect(await runSpec(spec('de-6-stations'), deps)).toMatchObject({ ok: 0, firstFailure: 'invalid' });
    expect(lines(deps.root)[0]).toMatchObject({ status: 204, key: null, validity: { ok: false, reason: 'empty' } });
    expect(Object.values(deps.counters.days)[0]?.['DE-6']).toMatchObject({ ok: 0, other: 1 });
    expect((await deps.state.read<SpecState>('de-6-stations'))?.last_success).toBeUndefined();
  });

  it('a page-alert spec pages on an invalid body too (C9)', async () => {
    const deps = runDeps();
    server.use(
      http.get('https://rijkswaterstaatdata.nl/waterdata/', () =>
        HttpResponse.html('<html><body>Deze pagina is verhuisd.</body></html>\n'),
      ),
    );
    await runSpec(spec('nl-4-page'), deps);
    expect((await deps.state.read<SpecState>('nl-4-page'))?.pending_page).toEqual(['nl4_new_file:invalid']);
  });

  it('never treats the same body of another variant as a duplicate', async () => {
    const deps = runDeps();
    const body = fixture('BE-3', 'be-3-values').body;
    server.use(http.get('https://hydrometrie.wallonie.be/services/KiWIS/KiWIS', () => new HttpResponse(body)));
    await runSpec(spec('be-3-values'), deps);
    const l = lines(deps.root);
    expect(l).toHaveLength(2);
    expect(l.map((x) => x.variant)).toEqual(['1962373', '1962340']);
    expect(l.every((x) => x.dup_of === null && x.key !== null)).toBe(true);
  });
});

describe('one manifest line per request, whatever the provider does (S7)', () => {
  const body = fixture('BE-3', 'be-3-values').body;

  it('a status outside 100–599 gets a line with status null and bad_status, and the run goes on', async () => {
    let n = 0;
    const transport: Transport = async () => {
      n += 1;
      return { status: n === 1 ? 799 : 200, headers: {}, body: Readable.from(n === 1 ? [] : [body]) };
    };
    const deps = runDeps({ client: { transport } });
    await runSpec(spec('be-3-values'), deps);
    expect(lines(deps.root).map((l) => [l.status, l.error, l.key !== null])).toEqual([
      [null, 'bad_status', false],
      [200, null, true],
    ]);
  });

  it.each([403, 451])('a %i is transient like a 429, and still counts as other (N5)', async (status) => {
    const deps = runDeps();
    server.use(
      http.get(
        'https://api.hochwasserzentralen.de/public/v1/data/stations',
        () => new HttpResponse('blocked', { status }),
      ),
    );
    expect(await runSpec(spec('de-6-stations'), deps)).toMatchObject({ ok: 0, transient: true, firstFailure: status });
    expect(Object.values(deps.counters.days)[0]?.['DE-6']).toMatchObject({ scheduled: 1, other: 1 });
  });

  it('a failed manifest append skips that request and still persists the rest of the run', async () => {
    const deps = runDeps();
    let appends = 0;
    deps.archive = new (class extends Archive {
      override append(line: ManifestLine): Promise<void> {
        appends += 1;
        return appends === 1 ? Promise.reject(new Error('disk full')) : super.append(line);
      }
    })(deps.root);
    server.use(http.get('https://hydrometrie.wallonie.be/services/KiWIS/KiWIS', () => new HttpResponse(body)));
    const summary = await runSpec(spec('be-3-values'), deps);
    expect(summary).toMatchObject({ requests: 2, ok: 1, transient: true, firstFailure: 'manifest' });
    expect(lines(deps.root).map((l) => l.variant)).toEqual(['1962340']);
    const st = await deps.state.read<SpecState>('be-3-values');
    expect(Object.keys(st?.variants ?? {})).toEqual(['1962340']);
  });
});

describe('change gates', () => {
  it('FR-5 stores InfoVigiCru only when DtHrInfoVigiCru changes, or when it cannot be read', async () => {
    const c = clock('2026-10-02T12:02:00Z');
    const deps = runDeps({ now: c.now });
    let doc = {
      DtHrInfoVigiCru: '2026-10-02T09:57:13+00:00',
      features: Array.from({ length: 120 }, (_, i) => ({ i })),
    };
    server.use(http.get('https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson', () => HttpResponse.json(doc)));
    const s = spec('fr-5-vigilance');
    await runSpec(s, deps); // stored
    doc = { ...doc, features: [...doc.features, { i: 999 }] }; // other bytes, same issue time
    c.advance(900_000);
    await runSpec(s, deps); // gate closed
    doc = { ...doc, DtHrInfoVigiCru: '2026-10-02T12:10:00+00:00' };
    c.advance(900_000);
    await runSpec(s, deps); // stored
    const { DtHrInfoVigiCru: _, ...unreadable } = doc;
    doc = unreadable as typeof doc;
    c.advance(900_000);
    await runSpec(s, deps); // field missing: stored
    const l = lines(deps.root);
    expect(l.map((x) => x.gate?.open)).toEqual([true, false, true, true]);
    expect(l.map((x) => x.key !== null)).toEqual([true, false, true, true]);
    expect(l[1]?.dup_of).toBeNull();
  });

  it('CH-4 opens its gate on a new Last-Modified or run start', async () => {
    const c = clock('2026-10-02T12:35:00Z');
    const deps = runDeps({ now: c.now });
    const body = fixture('CH-4', 'ch-4-forecast').body;
    let lastModified = 'Fri, 02 Oct 2026 10:00:00 GMT';
    server.use(
      http.get(
        'https://www.hydrodaten.admin.ch/plots/q_forecast/:file',
        () => new HttpResponse(body, { headers: { 'last-modified': lastModified } }),
      ),
    );
    const s = spec('ch-4-forecast');
    const rows = s.rows.slice(0, 1);
    await runSpec(s, deps, { rows });
    c.advance(3_600_000);
    await runSpec(s, deps, { rows });
    lastModified = 'Fri, 02 Oct 2026 12:00:00 GMT';
    c.advance(3_600_000);
    await runSpec(s, deps, { rows });
    expect(lines(deps.root).map((x) => x.gate?.open)).toEqual([true, false, true]);
  });
});

describe('gap-stretch windows', () => {
  const rwsBodies: string[] = [];
  const rws = () =>
    http.post(
      'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
      async ({ request }) => {
        rwsBodies.push(await request.text());
        return new HttpResponse(fixture('NL-1', 'nl-1-obs-key').body);
      },
    );

  it('NL-1: now − 3 h normally; after an outage back to the last success − 1 h; never past P31D', async () => {
    const c = clock('2026-10-02T12:01:00Z');
    const deps = runDeps({ now: c.now });
    server.use(rws());
    const s = spec('nl-1-obs-key');
    const rows = s.rows.slice(0, 1);
    await runSpec(s, deps, { rows });
    expect(JSON.parse(rwsBodies.at(-1) as string).Periode).toEqual({
      Begindatumtijd: '2026-10-02T09:01:00Z',
      Einddatumtijd: '2026-10-02T12:01:00Z',
    });
    c.advance(5 * 3_600_000); // five hours down
    await runSpec(s, deps, { rows });
    expect(JSON.parse(rwsBodies.at(-1) as string).Periode.Begindatumtijd).toBe('2026-10-02T11:01:00Z');
    c.advance(60 * 86_400_000); // two months down
    await runSpec(s, deps, { rows });
    expect(JSON.parse(rwsBodies.at(-1) as string).Periode.Begindatumtijd).toBe('2026-10-31T17:01:00Z');
  });

  it('NL-1 forecasts: T−10 min … T+48 h in UTC, with ProcesType and Hoedanigheid', async () => {
    const deps = runDeps({ now: () => new Date('2026-10-02T12:25:00Z') });
    server.use(rws());
    const s = spec('nl-1-fc-1h');
    await runSpec(s, deps, { rows: s.rows.filter((r) => r.quantity === 'H').slice(0, 1) });
    const b = JSON.parse(rwsBodies.at(-1) as string);
    expect(b.Periode).toEqual({ Begindatumtijd: '2026-10-02T12:15:00Z', Einddatumtijd: '2026-10-04T12:25:00Z' });
    expect(b.AquoPlusWaarnemingMetadata.AquoMetadata).toEqual({
      Compartiment: { Code: 'OW' },
      Grootheid: { Code: 'WATHTE' },
      Hoedanigheid: { Code: 'NAP' },
      ProcesType: 'verwachting',
    });
  });

  it('DE-1: PT6H normally, stretched after an outage, capped at P30D', async () => {
    const c = clock('2026-10-02T12:40:00Z');
    const deps = runDeps({ now: c.now });
    const starts: string[] = [];
    server.use(
      http.get(
        'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/:uuid/:ts/measurements.json',
        ({ request }) => {
          starts.push(new URL(request.url).searchParams.get('start') ?? '');
          return new HttpResponse(fixture('DE-1', 'de-1-series').body);
        },
      ),
    );
    const s = spec('de-1-series');
    const rows = s.rows.slice(0, 1);
    await runSpec(s, deps, { rows });
    c.advance(10 * 3_600_000);
    await runSpec(s, deps, { rows });
    c.advance(40 * 86_400_000);
    await runSpec(s, deps, { rows });
    expect(starts).toEqual(['PT6H', 'PT11H', 'P30D']);
  });

  it('FR-1: from the last success − 60 min, at least 75 min back, under one month', async () => {
    const c = clock('2026-10-02T12:01:00Z');
    const deps = runDeps({ now: c.now });
    const from: string[] = [];
    server.use(
      http.get('https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr', ({ request }) => {
        from.push(new URL(request.url).searchParams.get('date_debut_obs') ?? '');
        return new HttpResponse(
          fixture('FR-1', 'fr-1-obs')
            .body.toString()
            .replace(/"next":"[^"]*"/, '"next":null'),
        );
      }),
    );
    const s = spec('fr-1-obs');
    await runSpec(s, deps);
    c.advance(15 * 60_000);
    await runSpec(s, deps);
    c.advance(45 * 86_400_000);
    await runSpec(s, deps);
    expect(from).toEqual(['2026-10-02T10:46:00Z', '2026-10-02T11:01:00Z', '2026-10-17T13:16:00Z']);
  });
});

describe('FR-1 walks (C4, S8, N2)', () => {
  const OBS = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr';
  const page = JSON.parse(fixture('FR-1', 'fr-1-obs').body.toString()) as { next: string | null };
  /** Pages with a `next` up to `pages` per walk (cursor 1, 2, …), or a fixed `loop` URL. */
  function hubeau(opts: { pages: number; loop?: string }) {
    const asked: { from: string | null; to: string | null; cursor: string | null }[] = [];
    server.use(
      http.get(OBS, ({ request }) => {
        const u = new URL(request.url);
        const cursor = u.searchParams.get('cursor');
        asked.push({ from: u.searchParams.get('date_debut_obs'), to: u.searchParams.get('date_fin_obs'), cursor });
        const n = Number(cursor ?? 0) + 1;
        const next = opts.loop ?? (n < opts.pages ? `${OBS}?code_entite=A*&cursor=${n}&size=20000` : null);
        return HttpResponse.json({ ...page, next }, { status: next === null ? 200 : 206 });
      }),
    );
    return asked;
  }
  const lastSuccess = async (deps: ReturnType<typeof runDeps>, at: string) =>
    deps.state.update<SpecState>('fr-1-obs', () => ({
      enabled_since: '2026-10-01T00:00:00.000Z',
      variants: { default: { last_success: at } },
      seen: [],
      pending_page: [],
    }));

  it('a 3-day gap is walked a day at a time; a completed walk moves the window to its end', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    const asked = hubeau({ pages: 3 });
    const s = spec('fr-1-obs');
    expect(await runSpec(s, deps)).toMatchObject({ requests: 3, capped: false });
    expect(asked[0]).toEqual({ from: '2026-10-07T11:00:00Z', to: '2026-10-08T11:00:00Z', cursor: null });
    c.advance(15 * 60_000);
    await runSpec(s, deps);
    expect(asked[3]).toEqual({ from: '2026-10-08T10:00:00Z', to: '2026-10-09T10:00:00Z', cursor: null });
  });

  /**
   * Hub'Eau over a window, newest first: page n holds two observations 30 min apart, n × 30 min below the
   * window's end, down to its start; `stuck` pages hold the same two times and never end.
   */
  function slices(stuck?: string[]) {
    const roots: { from: string | null; to: string | null }[] = [];
    server.use(
      http.get(OBS, ({ request }) => {
        const u = new URL(request.url);
        const from = u.searchParams.get('date_debut_obs') as string;
        const to = u.searchParams.get('date_fin_obs') as string;
        const n = Number(u.searchParams.get('cursor') ?? 0);
        if (n === 0) roots.push({ from, to });
        const newest = Date.parse(to) - n * 1_800_000;
        const oldest = Math.max(Date.parse(from), newest - 1_800_000);
        const times = stuck ?? [newest, oldest].map((t) => new Date(t).toISOString());
        const next =
          stuck !== undefined || oldest > Date.parse(from)
            ? `${OBS}?date_debut_obs=${from}&date_fin_obs=${to}&cursor=${n + 1}`
            : null;
        return HttpResponse.json(
          { count: times.length, data: times.map((date_obs) => ({ date_obs })), next },
          { status: next === null ? 200 : 206 },
        );
      }),
    );
    return roots;
  }

  it('a flood day of 48 pages goes on below the oldest time fetched, and completes (N2)', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    const roots = slices();
    const s = spec('fr-1-obs');
    const runs = [];
    for (let i = 0; i < 4; i += 1) {
      runs.push(await runSpec(s, deps));
      // Every run made progress, so the spec stays fresh.
      expect((await deps.state.read<SpecState>('fr-1-obs'))?.last_success).toBe(c.now().toISOString());
      c.advance(15 * 60_000);
    }
    expect(runs.map((r) => [r.requests, r.capped])).toEqual([
      [21, true],
      [21, true],
      [7, false],
      [21, true], // the next day: a flood too
    ]);
    expect(roots).toEqual([
      { from: '2026-10-07T11:00:00Z', to: '2026-10-08T11:00:00Z' },
      { from: '2026-10-07T11:00:00Z', to: '2026-10-08T00:31:00Z' }, // 21 pages lower, plus one minute
      { from: '2026-10-07T11:00:00Z', to: '2026-10-07T14:02:00Z' },
      // The walk completed: the window moves to the end of the whole day, not of its last part.
      { from: '2026-10-08T10:00:00Z', to: '2026-10-09T10:00:00Z' },
    ]);
  });

  it('a capped walk that gets no older is no success, so the spec goes stale and pages (N2)', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    const roots = slices(['2026-10-08T10:00:00Z', '2026-10-08T09:00:00Z']);
    const s = spec('fr-1-obs');
    const first = c.now().toISOString();
    for (let i = 0; i < 4; i += 1) {
      expect(await runSpec(s, deps)).toMatchObject({ requests: 21, capped: true });
      c.advance(15 * 60_000);
    }
    expect(roots.map((r) => r.to)).toEqual([
      '2026-10-08T11:00:00Z',
      '2026-10-08T09:01:00Z', // the first run got down to 09:00; no run after it got older
      '2026-10-08T09:01:00Z',
      '2026-10-08T09:01:00Z',
    ]);
    const st = await deps.state.read<SpecState>('fr-1-obs');
    expect(st?.last_success).toBe(first);
    expect(isFresh(s, st, new Date(Date.parse(first) + 46 * 60_000))).toBe(false);
  });

  it('a 429 on page #2 is no success, and the next run asks the same window again (C4, N2, #39)', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    let throttle = true;
    const roots: (string | null)[] = [];
    server.use(
      http.get(OBS, ({ request }) => {
        const u = new URL(request.url);
        const cursor = u.searchParams.get('cursor');
        if (cursor === null) roots.push(u.searchParams.get('date_debut_obs'));
        if (cursor !== null && throttle) return new HttpResponse('slow down', { status: 429 });
        const next = cursor === null ? `${OBS}?code_entite=A*&cursor=1&size=20000` : null;
        return HttpResponse.json({ ...page, next }, { status: next === null ? 200 : 206 });
      }),
    );
    const s = spec('fr-1-obs');
    expect(await runSpec(s, deps)).toMatchObject({ requests: 2, ok: 1, transient: true, firstFailure: 429 });
    const st = await deps.state.read<SpecState>('fr-1-obs');
    expect(st?.last_success).toBeUndefined();
    expect(st?.variants.default?.last_success).toBe('2026-10-07T12:00:00.000Z');
    expect(st?.failed_items).toEqual([]); // a page is not an item
    throttle = false;
    c.advance(15 * 60_000);
    await runSpec(s, deps);
    expect(roots).toEqual(['2026-10-07T11:00:00Z', '2026-10-07T11:00:00Z']);
  });

  /** A root with a `next`, then a last page #2 that answers `ctl.fail()` while it is set. */
  function twoPages() {
    const roots: (string | null)[] = [];
    const ctl: { fail: (() => Response) | null } = { fail: null };
    server.use(
      http.get(OBS, ({ request }) => {
        const u = new URL(request.url);
        const cursor = u.searchParams.get('cursor');
        if (cursor === null) roots.push(u.searchParams.get('date_debut_obs'));
        if (cursor !== null && ctl.fail !== null) return ctl.fail();
        const next = cursor === null ? `${OBS}?code_entite=A*&cursor=1&size=20000` : null;
        return HttpResponse.json({ ...page, next }, { status: next === null ? 200 : 206 });
      }),
    );
    return { roots, ctl };
  }

  it.each([
    ['a 404', () => new HttpResponse('gone', { status: 404 }), 404],
    ['a 200 HTML page', () => HttpResponse.html('<html><body>Maintenance</body></html>'), 'invalid'],
  ] as const)(
    '%s on page #2 is no success and keeps the window; the run after recovery moves it (#42)',
    async (_, fail, code) => {
      const c = clock('2026-10-10T12:01:00Z');
      const deps = runDeps({ now: c.now });
      await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
      const { roots, ctl } = twoPages();
      ctl.fail = fail;
      const s = spec('fr-1-obs');
      expect(await runSpec(s, deps)).toMatchObject({
        requests: 2,
        ok: 1,
        transient: false,
        incomplete: true,
        firstFailure: code,
      });
      let st = await deps.state.read<SpecState>('fr-1-obs');
      expect(st?.last_success).toBeUndefined();
      expect(st?.variants.default?.last_success).toBe('2026-10-07T12:00:00.000Z');
      ctl.fail = null;
      c.advance(15 * 60_000);
      expect(await runSpec(s, deps)).toMatchObject({ requests: 2, ok: 2, incomplete: false });
      st = await deps.state.read<SpecState>('fr-1-obs');
      expect(st?.last_success).toBe(c.now().toISOString());
      c.advance(15 * 60_000);
      await runSpec(s, deps);
      expect(roots).toEqual(['2026-10-07T11:00:00Z', '2026-10-07T11:00:00Z', '2026-10-08T10:00:00Z']);
    },
  );

  it('a page that keeps failing keeps the window, so the spec goes stale and pages (#42)', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    const { roots, ctl } = twoPages();
    const s = spec('fr-1-obs');
    await runSpec(s, deps); // T0: the whole walk came in, so the window moved
    const t0 = c.now().toISOString();
    ctl.fail = () => new HttpResponse('gone', { status: 404 });
    for (let i = 0; i < 4; i += 1) {
      c.advance(15 * 60_000);
      expect(await runSpec(s, deps)).toMatchObject({ ok: 1, incomplete: true });
    }
    expect(roots.slice(1)).toEqual(Array(4).fill('2026-10-08T10:00:00Z'));
    const st = await deps.state.read<SpecState>('fr-1-obs');
    expect(st).toMatchObject({ last_success: t0, last_failure_status: 404 });
    expect(isFresh(s, st, new Date(Date.parse(t0) + 46 * 60_000))).toBe(false);
  });

  it("an empty last page (Hub'Eau over a closed window) ends the walk: a success, and no alert (#42)", async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    const roots: (string | null)[] = [];
    let pages = 2;
    server.use(
      http.get(OBS, ({ request }) => {
        const u = new URL(request.url);
        const n = Number(u.searchParams.get('cursor') ?? 0) + 1;
        if (n === 1) roots.push(u.searchParams.get('date_debut_obs'));
        if (n === pages) return HttpResponse.json({ ...page, count: 0, data: [], next: null });
        return HttpResponse.json({ ...page, next: `${OBS}?code_entite=A*&cursor=${n}&size=20000` }, { status: 206 });
      }),
    );
    const s = spec('fr-1-obs');
    expect(await runSpec(s, deps)).toMatchObject({ requests: 2, ok: 2, incomplete: false, firstFailure: null });
    expect((await deps.state.read<SpecState>('fr-1-obs'))?.last_success).toBe(c.now().toISOString());
    pages = 3; // the next day: page #2 holds data this time, and page #3 is empty
    c.advance(15 * 60_000);
    expect(await runSpec(s, deps)).toMatchObject({ requests: 3, ok: 3 });
    expect(roots).toEqual(['2026-10-07T11:00:00Z', '2026-10-08T10:00:00Z']);
    const empty = lines(deps.root).filter((l) => l.status === 200);
    expect(empty.map((l) => [l.variant, l.validity, l.shape])).toEqual([
      ['default#2', { ok: true, reason: null, count: 0 }, null],
      ['default#3', { ok: true, reason: null, count: 0 }, null],
    ]);
    expect(deps.counters.alerts).toEqual({}); // no `invalid`, and no `shape_changed` on `default#2`
  });

  it('an empty root is still invalid: no success, and the window stays (#42)', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    server.use(http.get(OBS, () => HttpResponse.json({ ...page, count: 0, data: [], next: null })));
    expect(await runSpec(spec('fr-1-obs'), deps)).toMatchObject({ ok: 0, firstFailure: 'invalid' });
    const st = await deps.state.read<SpecState>('fr-1-obs');
    expect(st?.last_success).toBeUndefined();
    expect(st?.variants.default?.last_success).toBe('2026-10-07T12:00:00.000Z');
    expect(deps.counters.alerts).toEqual({
      '2026-10-10': [{ spec: 'fr-1-obs', kind: 'invalid', at: '2026-10-10T12:01:00.000Z' }],
    });
  });

  it('a `next` that repeats a URL is fetched once, and ends the walk', async () => {
    const deps = runDeps({ now: () => new Date('2026-10-10T12:01:00Z') });
    const asked = hubeau({ pages: 0, loop: `${OBS}?code_entite=A*&cursor=same&size=20000` });
    expect(await runSpec(spec('fr-1-obs'), deps)).toMatchObject({ requests: 2, capped: false });
    expect(asked.map((a) => a.cursor)).toEqual([null, 'same']);
  });
});

describe('stage-2 requests', () => {
  const LU5 = 'https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/';
  const dump = (i: number) => ({
    id: `0ebe38da-f4fa-4132-8fc0-47074d9186d${i}`,
    title: `dump-alert.179068836${i}.xml`,
    url: `https://download.data.public.lu/resources/alertes-du-systeme-lu-alert/20260929-13300${i}/dump-alert.179068836${i}.xml`,
  });

  it('FR-4 fetches each listed station (codes checked, the list Link never followed)', async () => {
    const deps = runDeps();
    const seen: string[] = [];
    const list = {
      ListEntVigiCru: [
        { CdEntVigiCru: 'A850061001', TypEntVigiCru: '7', Link: 'https://evil.example/x' },
        { CdEntVigiCru: '../../etc', TypEntVigiCru: '7' },
        { CdEntVigiCru: 'LO18', TypEntVigiCru: '8' },
      ],
    };
    server.use(
      http.get('https://www.vigicrues.gouv.fr/services/v1.1/prevision.json', ({ request }) => {
        const u = new URL(request.url);
        if (!u.searchParams.has('CdEntVigiCru')) return HttpResponse.json(list);
        seen.push(`${u.searchParams.get('CdEntVigiCru')}/${u.searchParams.get('GrdSimul')}`);
        return new HttpResponse(fixture('FR-4', 'fr-4-station').body);
      }),
    );
    await runSpec(spec('fr-4'), deps);
    expect(seen.sort()).toEqual(['A850061001/H', 'A850061001/Q']);
    expect(
      lines(deps.root)
        .filter((l) => l.variant.startsWith('A850061001'))
        .every((l) => l.validity?.ok),
    ).toBe(true);
  });

  it('FR-4 fetches only the stations of the basins FR-1 captures; the recorded national list has none (#39)', async () => {
    const codes = ['A850061001', 'B540001001', 'D021000101', 'E128000101', 'E240041201', 'E320001001'];
    const elsewhere = ['E432000101', 'K490003010', 'Y345401001'];
    let list: object = {
      ListEntVigiCru: [...elsewhere, ...codes].map((CdEntVigiCru) => ({ CdEntVigiCru, TypEntVigiCru: '7' })),
    };
    const seen: string[] = [];
    server.use(
      http.get('https://www.vigicrues.gouv.fr/services/v1.1/prevision.json', ({ request }) => {
        const u = new URL(request.url);
        if (!u.searchParams.has('CdEntVigiCru')) return HttpResponse.json(list);
        seen.push(`${u.searchParams.get('CdEntVigiCru')}/${u.searchParams.get('GrdSimul')}`);
        return new HttpResponse(fixture('FR-4', 'fr-4-station').body);
      }),
    );
    await runSpec(spec('fr-4'), runDeps());
    expect(seen.sort()).toEqual(codes.flatMap((c) => [`${c}/H`, `${c}/Q`]).sort());
    // The basin list is fr-1-obs's code_entite: the two cannot drift apart.
    const entite = new URL(spec('fr-1-obs').request.url).searchParams.get('code_entite') ?? '';
    expect(BASINS).toEqual(entite.split(',').map((p) => p.replace(/\*$/, '')));
    // The national list recorded on 2026-09-29: 27 stations (Loire, Garonne, Adour, …), none NL-bound.
    list = JSON.parse(fixture('FR-4', 'fr-4').body.toString());
    seen.length = 0;
    const deps = runDeps();
    expect(await runSpec(spec('fr-4'), deps)).toMatchObject({ requests: 2, ok: 2 });
    expect(seen).toEqual([]);
    expect(lines(deps.root).every((l) => l.key !== null && l.validity?.count === 27)).toBe(true); // archived in full
  });

  it('LU-5 follows the list while a page still holds an unseen dump (C6)', async () => {
    const got: string[] = [];
    server.use(
      http.get(LU5, ({ request }) => {
        const second = new URL(request.url).searchParams.get('page') === '2';
        return HttpResponse.json(
          second
            ? { data: [dump(2)], next_page: null }
            : { data: [dump(0), dump(1)], next_page: `${LU5}?page=2&page_size=20` },
        );
      }),
      http.get('https://download.data.public.lu/resources/*', ({ request }) => {
        got.push(request.url);
        return new HttpResponse(fixture('LU-5', 'lu-5-file').body);
      }),
    );
    const deps = runDeps();
    // dump 0 was fetched before; dump 2 failed then and has moved to page 2 since.
    await deps.state.update<SpecState>('lu-5-cap', () => ({
      enabled_since: '2026-10-01T00:00:00.000Z',
      variants: {},
      seen: [dump(0).id],
      pending_page: [],
    }));
    await runSpec(spec('lu-5-cap'), deps);
    expect(got.sort()).toEqual([dump(1).url, dump(2).url]);
  });

  it('LU-5: a list page that fails is no success; a file on the first page still comes in (#42)', async () => {
    const got: string[] = [];
    server.use(
      http.get(LU5, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? new HttpResponse('gone', { status: 404 })
          : HttpResponse.json({ data: [dump(0)], next_page: `${LU5}?page=2&page_size=20` }),
      ),
      http.get('https://download.data.public.lu/resources/*', ({ request }) => {
        got.push(request.url);
        return new HttpResponse(fixture('LU-5', 'lu-5-file').body);
      }),
    );
    const deps = runDeps();
    expect(await runSpec(spec('lu-5-cap'), deps)).toMatchObject({
      requests: 3,
      ok: 2,
      incomplete: true,
      firstFailure: 404,
    });
    expect(got).toEqual([dump(0).url]);
    const st = await deps.state.read<SpecState>('lu-5-cap');
    expect(st?.seen).toContain(dump(0).id);
    expect(st?.last_success).toBeUndefined();
    expect(st?.failed_items).toEqual([]); // a list page is not an item
  });

  it('LU-5 fetches only new dumps, marks an id seen only after its file arrived, and remembers across runs', async () => {
    const deps = runDeps();
    const page = JSON.parse(fixture('LU-5', 'lu-5-cap').body.toString()) as { data: { id: string; url: string }[] };
    const file = fixture('LU-5', 'lu-5-file').body;
    const first = page.data[0]?.url as string;
    let fail = true;
    const got: string[] = [];
    server.use(
      http.get('https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/', () =>
        HttpResponse.json(page),
      ),
      http.get('https://download.data.public.lu/resources/*', ({ request }) => {
        got.push(request.url);
        if (request.url === first && fail) return new HttpResponse('busy', { status: 503 });
        return new HttpResponse(file);
      }),
    );
    const s = spec('lu-5-cap');
    await runSpec(s, deps);
    const st1 = await deps.state.read<SpecState>('lu-5-cap');
    expect(st1?.seen).toHaveLength(page.data.length - 1);
    expect(st1?.seen).not.toContain(page.data[0]?.id);
    // The other files came in: the run counts, and names the failed file (#39).
    expect(st1?.last_success).toBeDefined();
    expect(st1?.failed_items).toEqual([`file/${page.data[0]?.id}`]);
    fail = false;
    deps.client.politeness.success('download.data.public.lu');
    got.length = 0;
    await runSpec(s, deps);
    expect(got).toEqual([first]);
    const st2 = await deps.state.read<SpecState>('lu-5-cap');
    expect(st2?.seen).toHaveLength(page.data.length);
    expect(st2?.failed_items).toEqual([]); // replaced by every finished run
  });
});

describe('partial runs (#39)', () => {
  const FR4 = 'https://www.vigicrues.gouv.fr/services/v1.1/prevision.json';
  /** H and Q lists of `n` NL-bound stations (A850060000, A850060001, …); `fail(key)` answers 429 (`list/H`, `<code>/Q`). */
  function vigicrues(n: number, fail: (key: string) => boolean) {
    const list = {
      ListEntVigiCru: Array.from({ length: n }, (_, i) => ({
        CdEntVigiCru: `A85006${String(i).padStart(4, '0')}`,
        TypEntVigiCru: '7',
      })),
    };
    let stations = 0;
    server.use(
      http.get(FR4, ({ request }) => {
        const u = new URL(request.url);
        const code = u.searchParams.get('CdEntVigiCru');
        if (code !== null) stations += 1;
        if (fail(`${code ?? 'list'}/${u.searchParams.get('GrdSimul')}`))
          return new HttpResponse('Too Many Requests', { status: 429, headers: { 'retry-after': '1' } });
        return code === null ? HttpResponse.json(list) : new HttpResponse(fixture('FR-4', 'fr-4-station').body);
      }),
    );
    return { stations: () => stations };
  }

  it('one throttled station: the run counts, names it and honours Retry-After', async () => {
    const waits: number[] = [];
    const deps = runDeps({ client: { sleep: async (ms) => void waits.push(ms) } });
    vigicrues(3, (key) => key === 'A850060001/H');
    const s = spec('fr-4');
    const summary = await runSpec(s, deps);
    expect(summary).toMatchObject({ requests: 8, ok: 7, transient: true, firstFailure: 429 });
    const st = await deps.state.read<SpecState>('fr-4');
    expect(st?.last_success).toBeDefined();
    expect(st).toMatchObject({ last_failure_status: 429, failed_items: ['A850060001/H'] });
    expect(isFresh(s, st, new Date())).toBe(true);
    const l = lines(deps.root);
    expect(l).toHaveLength(summary.requests);
    expect(l.find((x) => x.variant === 'A850060001/H')).toMatchObject({ status: 429, headers: { 'retry-after': '1' } });
    expect(waits.some((ms) => ms > 900 && ms <= 1000)).toBe(true);
  });

  it('every station throttled (the breaker opens after 5): no success, stale, 20 named in the status', async () => {
    const deps = runDeps();
    const { stations } = vigicrues(12, (key) => !key.startsWith('list/'));
    const s = spec('fr-4');
    expect(await runSpec(s, deps)).toMatchObject({ requests: 26, ok: 2, transient: true, firstFailure: 429 });
    expect(stations()).toBe(5);
    expect(lines(deps.root).filter((x) => x.error === 'breaker_open')).toHaveLength(19);
    const st = (await deps.state.read<SpecState>('fr-4')) as SpecState;
    expect(st.last_success).toBeUndefined();
    expect(isFresh(s, st, new Date())).toBe(false);
    expect(st.failed_items).toHaveLength(24);
    const status = buildStatus('public', {
      registry,
      states: new Map([['fr-4', st]]),
      counters: deps.counters,
      seeds: [],
      nextDue: () => null,
      now: new Date(),
    });
    expect(status.specs.find((x) => x.spec === 'fr-4')?.failed_items).toEqual(st.failed_items?.slice(0, 20));
  });

  it('a throttled list is no success, and is not named as an item', async () => {
    const deps = runDeps();
    vigicrues(1, (key) => key === 'list/H');
    expect(await runSpec(spec('fr-4'), deps)).toMatchObject({ requests: 3, ok: 2, transient: true });
    const st = await deps.state.read<SpecState>('fr-4');
    expect(st?.last_success).toBeUndefined();
    expect(st).toMatchObject({ last_failure_status: 429, failed_items: [] });
  });
});
