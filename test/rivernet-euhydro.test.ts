import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  type Bbox,
  compareDirections,
  type Edge,
  EUHYDRO_CODES,
  type EuHydroConfig,
  EuHydroError,
  fetchSegments,
  getBody,
  main,
  PAGE_SIZE,
  parsePage,
  queryUrl,
  type Segment,
} from '../tools/geo/rivernet/euhydro.ts';
import { server } from './msw.setup.ts';

const FIX = join(import.meta.dirname, '..', 'tools', 'geo', 'fixtures', 'euhydro');
const body = (name: string) => readFileSync(join(FIX, `${name}.json`), 'utf8');
const CFG: EuHydroConfig = {
  base_url: 'https://eu.test/arcgis/MapServer',
  layers: [12],
  max_requests: 10,
  min_interval_ms: 250,
  timeout_ms: 5000,
  max_body_bytes: 1 << 20,
};
const BBOX: Bbox = [5.98, 51.85, 6.12, 51.92];
const UA = 'rivierstanden/0.1.0 (+https://example.test/over; t@example.test)';
const noSleep = async () => {};
const deps = () => ({ userAgent: UA, sleep: noSleep });
const QUERY = `${CFG.base_url}/:layer/query`;
const serve = (text: string, init?: ResponseInit) => http.get(QUERY, () => new HttpResponse(text, init));

// Goldens are written only with UPDATE_GOLDENS=1 and committed; a missing golden fails.
function golden(name: string, value: unknown) {
  const file = join(FIX, `${name}.golden.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDENS === '1') writeFileSync(file, text);
  expect(existsSync(file), `${name}.golden.json`).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(text);
}
// The 445-feature layer-7 page: its count, first and last segment and a sha256 of the whole parse.
const digest = (value: ReturnType<typeof outcome>) =>
  'segments' in value
    ? {
        exceeded: value.exceeded,
        count: value.segments.length,
        first: value.segments[0],
        last: value.segments.at(-1),
        sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      }
    : value;
const outcome = (text: string) => {
  try {
    return parsePage(text);
  } catch (e) {
    return { error: (e as EuHydroError).code };
  }
};

describe('euhydro parsePage: real recorded bodies', () => {
  for (const name of ['l12-pannerdensche-kop', 'l12-empty', 'l99-error', 'l7-page1']) {
    it(`golden ${name}`, () => golden(name, name === 'l7-page1' ? digest(outcome(body(name))) : outcome(body(name))));
  }
  it('reads the normal body', () => {
    const page = parsePage(body('l12-pannerdensche-kop'));
    expect(page.segments).toHaveLength(9);
    expect(page.segments[0]).toMatchObject({ objectId: 'RL26021212', nextDownId: 'RL26021204', strahler: 8 });
    expect(page.exceeded).toBe(false);
  });
  it('an empty result is no segment, an ArcGIS error is a fixed code', () => {
    expect(parsePage(body('l12-empty')).segments).toEqual([]);
    expect(outcome(body('l99-error'))).toEqual({ error: 'euhydro_error' });
  });
});

describe('euhydro fetchSegments', () => {
  it('pages by resultOffset while exceededTransferLimit is true', async () => {
    const seen: URL[] = [];
    let ua: string | null = null;
    const first = JSON.parse(body('l7-page1'));
    first.exceededTransferLimit = true; // the real page, flagged: the recorded bbox held under 1000 features
    server.use(
      http.get(QUERY, ({ request }) => {
        const url = new URL(request.url);
        seen.push(url);
        ua = request.headers.get('user-agent');
        return HttpResponse.text(
          url.searchParams.get('resultOffset') === '0' ? JSON.stringify(first) : body('l12-pannerdensche-kop'),
        );
      }),
    );
    const r = await fetchSegments(BBOX, { ...CFG, layers: [7] }, deps());
    expect(seen.map((u) => u.searchParams.get('resultOffset'))).toEqual(['0', String(PAGE_SIZE)]);
    expect(r).toMatchObject({ requests: 2, complete: true, layers_done: [7] });
    expect(r.error).toBeUndefined();
    expect(r.segments).toHaveLength(445 + 9);
    expect(ua).toBe(UA);
    const q = Object.fromEntries(seen[0]?.searchParams ?? []);
    expect(q).toMatchObject({
      where: '1=1',
      geometry: '5.98,51.85,6.12,51.92',
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECT_ID,NEXTDOWNID,STRAHLER',
      returnGeometry: 'true',
      outSR: '4326',
      maxAllowableOffset: '0.0002',
      geometryPrecision: '6',
      orderByFields: 'OBJECTID',
      resultRecordCount: '1000',
      f: 'json',
    });
    expect(seen[0]?.pathname).toBe('/arcgis/MapServer/7/query');
  });

  it('walks every layer and sleeps the interval between requests only', async () => {
    const sleeps: number[] = [];
    server.use(serve(body('l12-pannerdensche-kop')));
    const r = await fetchSegments(
      BBOX,
      { ...CFG, layers: [10, 11, 12] },
      { userAgent: UA, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(r).toMatchObject({ requests: 3, complete: true, layers_done: [10, 11, 12] });
    expect(sleeps).toEqual([250, 250]);
  });

  it('stops at the budget: complete false and no extra request', async () => {
    let calls = 0;
    const flagged = JSON.stringify({ ...JSON.parse(body('l12-empty')), exceededTransferLimit: true });
    server.use(
      http.get(QUERY, () => {
        calls++;
        return HttpResponse.text(flagged);
      }),
    );
    const r = await fetchSegments(BBOX, { ...CFG, max_requests: 3 }, deps());
    expect(calls).toBe(3);
    expect(r).toMatchObject({ requests: 3, complete: false, layers_done: [] });
    expect(r.error).toBeUndefined();
  });

  it('a failed request ends the QA incomplete with its code and keeps the earlier layers', async () => {
    server.use(
      http.get(QUERY, ({ params }) =>
        params.layer === '12' ? HttpResponse.text(body('l99-error')) : HttpResponse.text(body('l12-pannerdensche-kop')),
      ),
    );
    const r = await fetchSegments(BBOX, { ...CFG, layers: [11, 12, 10] }, deps());
    expect(r).toMatchObject({ complete: false, layers_done: [11], error: 'euhydro_error', requests: 2 });
    expect(r.segments).toHaveLength(9);
  });

  const failing: [string, () => void, string][] = [
    ['a non-200 status', () => server.use(serve('{}', { status: 503 })), 'euhydro_http'],
    ['a non-200 status with a valid body', () => server.use(serve(body('l12-empty'), { status: 500 })), 'euhydro_http'],
    ['an ArcGIS error object', () => server.use(serve(body('l99-error'))), 'euhydro_error'],
    [
      'a redirect',
      () =>
        server.use(
          http.get(QUERY, () => new HttpResponse(null, { status: 302, headers: { location: 'https://evil.test/x' } })),
        ),
      'euhydro_http',
    ],
    ['not JSON', () => server.use(serve('<html>nope</html>')), 'euhydro_bad_json'],
    [
      'a wrong shape',
      () => server.use(serve('{"features":[{"attributes":{"OBJECT_ID":1},"geometry":{"paths":[]}}]}')),
      'euhydro_bad_shape',
    ],
    ['no features', () => server.use(serve('{"hello":1}')), 'euhydro_bad_shape'],
    ['a network error', () => server.use(http.get(QUERY, () => HttpResponse.error())), 'euhydro_http'],
  ];
  for (const [title, arrange, code] of failing) {
    it(`${title} is ${code}`, async () => {
      arrange();
      const r = await fetchSegments(BBOX, CFG, deps());
      expect(r).toMatchObject({ complete: false, error: code, requests: 1 });
    });
  }

  it('refuses an oversize body, streamed and declared', async () => {
    server.use(serve(body('l12-pannerdensche-kop')));
    expect((await fetchSegments(BBOX, { ...CFG, max_body_bytes: 500 }, deps())).error).toBe('euhydro_body_too_large');
    const declared = new Response('x', { headers: { 'content-length': '999999' } });
    await expect(
      getBody(queryUrl(CFG, 12, BBOX, 0), { ...CFG, max_body_bytes: 10 }, { ...deps(), fetch: async () => declared }),
    ).rejects.toMatchObject({
      code: 'euhydro_body_too_large',
    });
  });

  it('refuses a response from another host', async () => {
    const res = new Response(body('l12-empty'));
    Object.defineProperty(res, 'url', { value: 'https://elsewhere.test/arcgis/MapServer/12/query' });
    await expect(getBody(queryUrl(CFG, 12, BBOX, 0), CFG, { ...deps(), fetch: async () => res })).rejects.toMatchObject(
      { code: 'euhydro_http' },
    );
  });

  it('asks with redirect error and a timeout signal', async () => {
    let init: RequestInit | undefined;
    await getBody(queryUrl(CFG, 12, BBOX, 0), CFG, {
      ...deps(),
      fetch: async (_u, i) => {
        init = i;
        return new Response(body('l12-empty'));
      },
    });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('euhydro compareDirections', () => {
  const M_LON = 111_195 * Math.cos((52 * Math.PI) / 180); // metres per degree of longitude at 52 N
  const line = (lon0: number, lon1: number, lat = 52, n = 20): [number, number][] =>
    Array.from({ length: n + 1 }, (_, i) => [Number((lon0 + ((lon1 - lon0) * i) / n).toFixed(6)), lat]);
  const seg = (objectId: string, path: [number, number][], nextDownId: string | null = null): Segment => ({
    objectId,
    nextDownId,
    strahler: 8,
    paths: [path],
  });
  const edge = (id: string, coords: [number, number][]): Edge => ({ id, way: 1, rivers: ['rhine'], coords });
  const east = line(5, 5.02);

  it('same direction agrees, reversed disagrees with the segment ids', () => {
    const segs = [seg('S1', east, 'S2')];
    const r = compareDirections([edge('a', east), edge('b', [...east].reverse())], segs);
    expect(r).toMatchObject({ agree: 1, disagree: 1, unmatched: 0, agreement_pct: 50 });
    expect(r.disagreements).toEqual([{ edge: 'b', way: 1, rivers: ['rhine'], segments: ['S1'], next_down: ['S2'] }]);
  });

  it('an edge 300 m away is unmatched', () => {
    const north = east.map(([x, y]) => [x, y + 300 / 111_195] as [number, number]);
    const r = compareDirections([edge('a', north)], [seg('S1', east)]);
    expect(r).toMatchObject({ agree: 0, disagree: 0, unmatched: 1, agreement_pct: null, disagreements: [] });
  });

  it('a long edge half matched: two thirds decide it, a quarter is unmatched', () => {
    const long = line(5, 5.04, 52, 40);
    expect(M_LON * 0.04).toBeGreaterThan(2500);
    expect(compareDirections([edge('a', long)], [seg('S', line(5, 5.025))])).toMatchObject({ agree: 1, unmatched: 0 });
    expect(compareDirections([edge('a', long)], [seg('S', line(5, 5.01))])).toMatchObject({ agree: 0, unmatched: 1 });
    expect(compareDirections([edge('a', [...long].reverse())], [seg('S', line(5, 5.025).reverse())])).toMatchObject({
      agree: 1,
    });
  });

  it('a short edge gets one sample at its midpoint', () => {
    const tiny = line(5.005, 5.0055, 52, 2);
    expect(compareDirections([edge('a', tiny)], [seg('S', east)])).toMatchObject({ agree: 1 });
  });

  it('a bifurcation: both branches agree with their own segment', () => {
    const dLat = (0.02 * M_LON) / 111_195;
    const node: [number, number] = [5.02, 52];
    const ne = [
      node,
      ...line(5.02, 5.04, 52, 10)
        .slice(1)
        .map(([x], i) => [x, 52 + (dLat * (i + 1)) / 10] as [number, number]),
    ];
    const se = ne.map(([x, y]) => [x, 104 - y] as [number, number]);
    const segs = [seg('A', east, 'B'), seg('B', ne, 'X'), seg('C', se, 'X')];
    const edges = [edge('e1', east), edge('e2', ne), edge('e3', se)];
    expect(compareDirections(edges, segs)).toMatchObject({ agree: 3, disagree: 0, unmatched: 0, agreement_pct: 100 });
  });

  it('is deterministic and sorts disagreements by edge id', () => {
    const segs = [seg('S1', east)];
    const edges = ['z', 'a', 'm'].map((id) => edge(id, [...east].reverse()));
    const r = compareDirections(edges, segs);
    expect(r.disagreements.map((d) => d.edge)).toEqual(['a', 'm', 'z']);
    expect(compareDirections(edges, segs)).toEqual(r);
  });

  it('works on the real Pannerdensche Kop segment, and reversed it disagrees', () => {
    const segs = parsePage(body('l12-pannerdensche-kop')).segments;
    const first = segs[0] as Segment;
    const along = (first.paths[0] as [number, number][]).filter((_, i) => i % 2 === 0);
    const r = compareDirections([edge('fwd', along)], segs);
    expect(r).toMatchObject({ agree: 1, disagree: 0 });
    const rev = compareDirections([edge('rev', [...along].reverse())], segs);
    expect(rev).toMatchObject({ agree: 0, disagree: 1 });
    expect(rev.disagreements[0]?.segments).toContain(first.objectId);
    expect(rev.disagreements[0]?.next_down).toContain(first.nextDownId);
  });
});

describe('euhydro property tests', () => {
  const coord = fc.tuple(fc.double({ min: 2, max: 11, noNaN: true }), fc.double({ min: 46, max: 53, noNaN: true }));
  const segment = fc.record({
    objectId: fc.stringMatching(/^[A-Z]{2}[0-9]{1,10}$/),
    nextDownId: fc.option(fc.stringMatching(/^[A-Z]{2}[0-9]{1,10}$/), { nil: null }),
    strahler: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
    paths: fc.array(fc.array(coord, { minLength: 2, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
  });

  it('a valid ArcGIS response parses to the same segments', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), fc.boolean(), (segs, exceeded) => {
        const text = JSON.stringify({
          displayFieldName: 'x',
          features: segs.map((s) => ({
            attributes: { OBJECT_ID: s.objectId, NEXTDOWNID: s.nextDownId, STRAHLER: s.strahler, nameText: 'ignored' },
            geometry: { paths: s.paths },
          })),
          ...(exceeded ? { exceededTransferLimit: true } : {}),
        });
        expect(parsePage(text)).toEqual({ segments: segs, exceeded });
      }),
    );
  });

  it('anything else is a fixed-code error, never another throw', () => {
    const check = (text: string) => {
      try {
        parsePage(text);
      } catch (e) {
        expect(e).toBeInstanceOf(EuHydroError);
        expect(EUHYDRO_CODES).toContain((e as EuHydroError).code);
      }
    };
    fc.assert(fc.property(fc.jsonValue(), (v) => check(JSON.stringify(v))));
    fc.assert(fc.property(fc.string(), check));
    fc.assert(fc.property(fc.jsonValue(), (v) => check(JSON.stringify({ features: [v] }))));
  });
});

describe('euhydro CLI', () => {
  const CONTACT = { RWS_DOMAIN: 'rk.example.org', RWS_CONTACT_EMAIL: 'owner@example.org' };
  const QUIET = { cfg: CFG, deps: { sleep: noSleep } };
  const work = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'euhydro-'));
    const seg = (parsePage(body('l12-pannerdensche-kop')).segments[0] as Segment).paths[0] as [number, number][];
    const feature = (id: string, coordinates: [number, number][], way: number) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { id, way, rivers: ['rhine'], length_m: 1 },
    });
    writeFileSync(
      join(dir, 'reaches.geojson'),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [feature('w1.0', seg, 1), feature('w2.0', [...seg].reverse(), 2)],
      }),
    );
    writeFileSync(
      join(dir, 'build-report.json'),
      JSON.stringify({ schema_version: 1, rivers: [], graph: { nodes: 2 } }),
    );
    return dir;
  };

  it('exits 78 without the contact variables, as a child process too', () => {
    expect(
      spawnSync(process.execPath, [join(FIX, '..', '..', 'rivernet', 'euhydro.ts'), '--dir', '/nonexistent'], {
        env: {},
      }).status,
    ).toBe(78);
    return expect(main(['--dir', '/nonexistent'], {}, QUIET)).resolves.toBe(78);
  });

  it('exits 64 on bad usage', async () => {
    for (const argv of [
      [],
      ['--dir'],
      ['--dir', 'a', '--budget', '0'],
      ['--dir', 'a', '--record', 'b'],
      ['--bogus', 'x'],
      ['--record', 'd', '--layer', '12'],
    ]) {
      expect(await main(argv, CONTACT, QUIET)).toBe(64);
    }
  });

  it('exits 1 on unreadable input', async () => {
    expect(await main(['--dir', join(tmpdir(), 'euhydro-missing-dir')], CONTACT, QUIET)).toBe(1);
  });

  it('writes a sorted qa-report with verdicts and no geometry', async () => {
    const dir = work();
    server.use(serve(body('l12-pannerdensche-kop')));
    expect(await main(['--dir', dir], CONTACT, QUIET)).toBe(0);
    const text = readFileSync(join(dir, 'qa-report.json'), 'utf8');
    const report = JSON.parse(text);
    expect(Object.keys(report)).toEqual(['build', 'euhydro', 'schema_version']);
    expect(report.build).toEqual({ graph: { nodes: 2 }, rivers: [], schema_version: 1 });
    expect(report.euhydro).toMatchObject({
      requests: 1,
      complete: true,
      layers: [12],
      agree: 1,
      disagree: 1,
      unmatched: 0,
      agreement_pct: 50,
      endorsement: 'No endorsement by the European Union is implied',
    });
    expect(report.euhydro.source).toContain('© European Union, Copernicus Land Monitoring Service');
    expect(report.euhydro.disagreements[0]).toMatchObject({ edge: 'w2.0', way: 2, rivers: ['rhine'] });
    expect(Object.keys(report.euhydro)).toEqual([...Object.keys(report.euhydro)].sort());
    expect(text).not.toContain('paths');
    expect(text).not.toContain('6.044387'); // no EU-Hydro vertex
  });

  it('an incomplete QA still exits 0 and records the error code', async () => {
    const dir = work();
    server.use(serve('{}', { status: 500 }));
    expect(await main(['--dir', dir, '--budget', '5'], CONTACT, QUIET)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'qa-report.json'), 'utf8')).euhydro).toMatchObject({
      complete: false,
      error: 'euhydro_http',
      agreement_pct: null,
    });
  });

  it('--record writes one raw body, and refuses under CI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'euhydro-rec-'));
    server.use(serve(body('l12-empty')));
    const argv = ['--record', dir, '--layer', '12', '--bbox', '3.0,53.5,3.1,53.6', '--name', 'x.json'];
    expect(await main(argv, { ...CONTACT, CI: 'true' }, QUIET)).toBe(64);
    expect(existsSync(join(dir, 'x.json'))).toBe(false);
    expect(await main(argv, CONTACT, QUIET)).toBe(0);
    expect(readFileSync(join(dir, 'x.json'), 'utf8')).toBe(body('l12-empty'));
  });
});
