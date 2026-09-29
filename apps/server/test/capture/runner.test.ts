import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { ManifestLine } from '../../src/archive/manifest.ts';
import { Archive } from '../../src/archive/writer.ts';
import { runSpec } from '../../src/capture/runner.ts';
import type { SpecState } from '../../src/capture/state.ts';
import type { Transport } from '../../src/http/types.ts';
import { fixture, runDeps, spec } from './helpers.ts';

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

describe('FR-1 walks (C4, S8)', () => {
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

  it('a 3-day gap is walked a day at a time; a walk the cap stops keeps its window', async () => {
    const c = clock('2026-10-10T12:01:00Z');
    const deps = runDeps({ now: c.now });
    await lastSuccess(deps, '2026-10-07T12:00:00.000Z');
    const asked = hubeau({ pages: Number.POSITIVE_INFINITY });
    const s = spec('fr-1-obs');
    const first = await runSpec(s, deps);
    expect(first).toMatchObject({ requests: 11, capped: true });
    expect(asked[0]).toEqual({ from: '2026-10-07T11:00:00Z', to: '2026-10-08T11:00:00Z', cursor: null });
    c.advance(15 * 60_000);
    await runSpec(s, deps);
    expect(asked[11]).toEqual({ from: '2026-10-07T11:00:00Z', to: '2026-10-08T11:00:00Z', cursor: null });
    // A walk that completes moves the window to its end; the next run takes the next day.
    const done = hubeau({ pages: 3 });
    c.advance(15 * 60_000);
    expect(await runSpec(s, deps)).toMatchObject({ requests: 3, capped: false });
    c.advance(15 * 60_000);
    await runSpec(s, deps);
    expect(done[3]).toEqual({ from: '2026-10-08T10:00:00Z', to: '2026-10-09T10:00:00Z', cursor: null });
  });

  it('a `next` that repeats a URL is fetched once, and ends the walk', async () => {
    const deps = runDeps({ now: () => new Date('2026-10-10T12:01:00Z') });
    const asked = hubeau({ pages: 0, loop: `${OBS}?code_entite=A*&cursor=same&size=20000` });
    expect(await runSpec(spec('fr-1-obs'), deps)).toMatchObject({ requests: 2, capped: false });
    expect(asked.map((a) => a.cursor)).toEqual([null, 'same']);
  });
});

describe('stage-2 requests', () => {
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
    fail = false;
    deps.client.politeness.success('download.data.public.lu');
    got.length = 0;
    await runSpec(s, deps);
    expect(got).toEqual([first]);
    expect((await deps.state.read<SpecState>('lu-5-cap'))?.seen).toHaveLength(page.data.length);
  });
});
