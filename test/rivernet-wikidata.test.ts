import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  groupCandidates,
  type Label,
  LookupError,
  lookup,
  parseLabels,
  parseSparql,
  run,
  WIKIDATA_ENDPOINT,
} from '../tools/geo/rivernet/lookup-wikidata.ts';
import { server } from './msw.setup.ts';

// The opt-in Wikidata lookup (P6a): offline, against one recorded response (Wikidata is CC0).

const dir = new URL('../tools/geo/fixtures/wikidata/', import.meta.url);
const sample = readFileSync(new URL('sparql-sample.json', dir), 'utf8');
const empty = JSON.stringify({ head: { vars: ['item'] }, results: { bindings: [] } });
const labels = (n: number): Label[] => Array.from({ length: n }, (_, i) => ({ lang: 'nl', label: `Rivier${i}` }));
const deps = { userAgent: 'test-agent', sleep: async () => {}, now: () => 0 };

describe('Wikidata lookup', () => {
  it('parses the recorded response to the golden candidates (Nahe and Lys resolved by mouth)', () => {
    const bindings = parseSparql(sample);
    const seen = new Map(bindings.map((b) => [`${b.label?.['xml:lang']}:${b.label?.value}`, b.label] as const));
    const ls = [...seen.values()].map((l) => ({ lang: l?.['xml:lang'] ?? '', label: l?.value ?? '' }));
    const got = groupCandidates(ls, bindings);
    expect(got).toEqual(JSON.parse(readFileSync(new URL('sparql-sample.golden.json', dir), 'utf8')));
    const nahe = got.find((r) => r.label === 'Nahe')?.candidates.find((c) => c.qid === 'Q168696');
    expect(nahe).toMatchObject({ osm_relation: 406638, mouth_qid: 'Q584', mouth_en: 'Rhine' });
  });

  it('batches 30 labels per request: 31 labels make 2', async () => {
    const queries: string[] = [];
    server.use(
      http.get(WIKIDATA_ENDPOINT, ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('query') ?? '');
        expect(request.headers.get('user-agent')).toBe('test-agent');
        expect(request.headers.get('accept')).toBe('application/sparql-results+json');
        return new HttpResponse(empty);
      }),
    );
    const out = await lookup(labels(31), deps);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.match(/"Rivier\d+"@nl/g)).toHaveLength(30);
    expect(queries[1]?.match(/"Rivier\d+"@nl/g)).toHaveLength(1);
    expect(out).toHaveLength(31);
  });

  it('stops before the first request when the budget is too small', async () => {
    let n = 0;
    server.use(
      http.get(WIKIDATA_ENDPOINT, () => {
        n++;
        return new HttpResponse(empty);
      }),
    );
    await expect(lookup(labels(31), { ...deps, maxRequests: 1 })).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(n).toBe(0);
  });

  it('waits between requests, never before the first', async () => {
    server.use(http.get(WIKIDATA_ENDPOINT, () => new HttpResponse(empty)));
    const waits: number[] = [];
    await lookup(labels(61), { ...deps, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1000, 1000]);
  });

  it('refuses another host or scheme, and a redirect', async () => {
    await expect(lookup(labels(1), { ...deps, endpoint: 'https://example.org/sparql' })).rejects.toMatchObject({
      code: 'bad_endpoint',
    });
    await expect(lookup(labels(1), { ...deps, endpoint: 'http://query.wikidata.org/sparql' })).rejects.toMatchObject({
      code: 'bad_endpoint',
    });
    server.use(
      http.get(
        WIKIDATA_ENDPOINT,
        () => new HttpResponse(null, { status: 302, headers: { location: 'https://example.org/x' } }),
      ),
    );
    await expect(lookup(labels(1), deps)).rejects.toBeInstanceOf(LookupError);
  });

  it('refuses an oversize body, a bad shape, a bad status and a bad value', async () => {
    const answer = (res: () => Response) => server.use(http.get(WIKIDATA_ENDPOINT, res));
    answer(() => new HttpResponse(new Uint8Array(8 * 1024 * 1024 + 1)));
    await expect(lookup(labels(1), deps)).rejects.toMatchObject({ code: 'body_too_large' });
    answer(() => new HttpResponse('{"head":{"vars":[]},"results":{"bindings":[{"a":{"type":"uri","value":1}}]}}'));
    await expect(lookup(labels(1), deps)).rejects.toMatchObject({ code: 'bad_shape' });
    answer(() => new HttpResponse(empty, { status: 429 }));
    await expect(lookup(labels(1), deps)).rejects.toMatchObject({ code: 'http_status' });
    const bad = {
      item: { type: 'uri', value: 'http://evil.example/Q1' },
      label: { type: 'literal', value: 'x', 'xml:lang': 'nl' },
    };
    answer(() => HttpResponse.json({ head: { vars: [] }, results: { bindings: [bad] } }));
    await expect(lookup(labels(1), deps)).rejects.toMatchObject({ code: 'bad_value' });
  });

  it('escapes a label so it cannot leave its string literal', () => {
    const q = buildQuery([{ lang: 'fr', label: 'a" } . ?x \\' }]);
    expect(q).toContain('VALUES ?label { "a\\" } . ?x \\\\"@fr }');
    expect(() => parseLabels('nl:a\u0007b')).toThrow(LookupError);
    expect(() => parseLabels(`nl:${'x'.repeat(81)}`)).toThrow(LookupError);
    expect(parseLabels('# c\n\nde:Nahe\nde:Nahe\nfr:Lys')).toEqual([
      { lang: 'de', label: 'Nahe' },
      { lang: 'fr', label: 'Lys' },
    ]);
  });

  it('refuses under CI, without usage and without the contact environment', async () => {
    const log = () => {};
    const env = { RWS_DOMAIN: 'example.org', RWS_CONTACT_EMAIL: 'a@example.org' };
    expect(await run(['--out', 'x.json'], { ...env, CI: 'true' }, deps, log)).toBe(64);
    expect(await run([], env, deps, log)).toBe(64);
    expect(await run(['--out', 'x.json'], {}, deps, log)).toBe(78);
  });

  it('property: valid result documents parse; arbitrary JSON throws only LookupError', () => {
    const term = fc.record({ type: fc.constantFrom('uri', 'literal'), value: fc.string({ maxLength: 40 }) });
    const doc = fc.record({
      head: fc.record({ vars: fc.array(fc.string({ maxLength: 10 }), { maxLength: 8 }) }),
      results: fc.record({
        bindings: fc.array(fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), term), { maxLength: 5 }),
      }),
    });
    fc.assert(
      fc.property(doc, (d) => {
        expect(parseSparql(JSON.stringify(d))).toHaveLength(d.results.bindings.length);
      }),
    );
    fc.assert(
      fc.property(fc.oneof(fc.json(), fc.string()), (text) => {
        try {
          parseSparql(text);
        } catch (e) {
          expect(e).toBeInstanceOf(LookupError);
        }
      }),
    );
  });
});
