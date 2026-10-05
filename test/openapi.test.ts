import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from '../apps/server/src/api/channels.ts';
import { ApiError, VERSION_RE } from '../packages/contracts/src/api.ts';
import { buildOpenApi, openApiDocument } from '../packages/contracts/src/openapi.ts';
import { canonical, FILES } from '../scripts/gen-openapi.ts';

// P9b: the OpenAPI documents are snapshots. The committed files are what the generator writes, the paths are the
// route table's (a route added to `ROUTES` that the document lacks fails here), and the documents say what the API does.

type Op = {
  parameters?: { name: string; schema: { pattern?: string } }[];
  responses: Record<string, { headers?: Record<string, unknown>; content?: Record<string, unknown> }>;
  requestBody?: { content: Record<string, unknown> };
};
type Doc = {
  info: { description: string; title: string };
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

const pub = openApiDocument() as Doc;
const owner = FILES[1].build() as Doc;

describe('the snapshots', () => {
  it.each(FILES)('$path is what the generator writes, byte for byte', ({ path, build }) => {
    expect(readFileSync(path, 'utf8')).toBe(canonical(build()));
  });

  it('keys are sorted at every depth, with 2-space indent and a final newline', () => {
    const text = readFileSync(FILES[0].path, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "components"');
    expect(canonical(JSON.parse(text))).toBe(text);
    expect(canonical({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 1 } })).toBe(
      '{\n  "a": {\n    "c": 1,\n    "d": [\n      {\n        "x": 2,\n        "y": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('a schema with one more property gives another document', () => {
    const components = Object.fromEntries(
      Object.keys(pub.components.schemas).map((name) => [name, z.strictObject({})]),
    ) as unknown as Parameters<typeof buildOpenApi>[0];
    const base = canonical(buildOpenApi(components, 'T'));
    const more = canonical(buildOpenApi({ ...components, ApiError: ApiError.extend({ extra: z.string() }) }, 'T'));
    expect(more).not.toBe(base);
    expect(more).toContain('"extra"');
  });
});

describe('the paths are the route table', () => {
  const have = (doc: Doc) =>
    Object.entries(doc.paths)
      .flatMap(([path, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
  const want = ROUTES.filter((r) => !r.planned)
    .map((r) => `${r.method} ${r.path.replaceAll(/:([a-z]+)/g, '{$1}')}`)
    .sort();

  it('the public document lists every non-planned route and the method of each', () => {
    expect(have(pub)).toEqual(want);
  });
  it('the owner document lists the same operations', () => {
    expect(have(owner)).toEqual(want);
  });
  it('a planned route is not documented', () => {
    for (const r of ROUTES.filter((x) => x.planned))
      expect(pub.paths[r.path.replaceAll(/:([a-z]+)/g, '{$1}')]).toBeUndefined();
  });
});

describe('what the document says', () => {
  it('starts "Unofficial, no SLA." and states the rules', () => {
    const d = pub.info.description;
    expect(d.startsWith('Unofficial, no SLA.')).toBe(true);
    expect(d).toMatch(/[Rr]ate-limited/);
    expect(d).toMatch(/not an official warning service/i);
    expect(d).toMatch(/unknown or repeated query parameters are a 400/i);
    // The public document names no owner channel (review F7).
    expect(d).not.toMatch(/owner/i);
  });

  it('every data route answers 400, 405, 429 and 503, the last two with Retry-After', () => {
    for (const [path, item] of Object.entries(pub.paths))
      for (const method of Object.keys(item)) {
        const r = item[method]?.responses ?? {};
        for (const code of ['400', '405', '429', '503']) expect(r[code], `${method} ${path} ${code}`).toBeDefined();
        for (const code of ['429', '503']) expect(r[code]?.headers, `${path} ${code}`).toHaveProperty('Retry-After');
      }
  });

  it('404 only where a series is looked up', () => {
    for (const [path, item] of Object.entries(pub.paths))
      expect(item.get?.responses['404'] !== undefined, path).toBe(path.startsWith('/api/v1/series/'));
  });

  it('/snapshot and /series/{id} take v with the contract pattern; the forecast does not', () => {
    for (const path of ['/api/v1/snapshot', '/api/v1/series/{id}']) {
      const v = pub.paths[path]?.get?.parameters?.find((p) => p.name === 'v');
      expect(v?.schema.pattern, path).toBe(VERSION_RE.source);
    }
    const forecast = pub.paths['/api/v1/series/{id}/forecast']?.get?.parameters ?? [];
    expect(forecast.map((p) => p.name)).not.toContain('v');
    for (const path of ['/api/v1/meta', '/api/v1/stations']) expect(pub.paths[path]?.get?.parameters).toBeUndefined();
  });

  it('POST /beacon takes the three content types and answers 204, 400, 413, 415 and 429', () => {
    const op = pub.paths['/api/v1/beacon']?.post;
    expect(Object.keys(op?.requestBody?.content ?? {}).sort()).toEqual([
      'application/csp-report',
      'application/json',
      'application/reports+json',
    ]);
    for (const code of ['204', '400', '413', '415', '429']) expect(op?.responses[code], code).toBeDefined();
  });

  it('every answer body schema carries attribution', () => {
    for (const name of ['Meta', 'Stations', 'Snapshot', 'SeriesForecast', 'Health', 'HealthSources']) {
      const schema = pub.components.schemas[name];
      expect(schema?.properties, name).toHaveProperty('attribution');
    }
    // Series is a union of the two resolutions.
    const series = pub.components.schemas.Series as {
      oneOf?: { properties: object }[];
      anyOf?: { properties: object }[];
    };
    for (const branch of series.oneOf ?? series.anyOf ?? []) expect(branch.properties).toHaveProperty('attribution');
    expect((series.oneOf ?? series.anyOf ?? []).length).toBeGreaterThan(0);
  });
});

describe('the owner document', () => {
  it('names audience in its answer schemas and the public one does not', () => {
    for (const name of ['Meta', 'Stations', 'Snapshot', 'SeriesForecast'])
      expect(owner.components.schemas[name]?.properties, name).toHaveProperty('audience');
    for (const [name, schema] of Object.entries(pub.components.schemas))
      expect(schema.properties ?? {}, name).not.toHaveProperty('audience');
    expect(JSON.stringify(pub.components)).not.toContain('audience');
    expect(owner.info.title).not.toBe(pub.info.title);
  });

  it('has the paths, parameters and responses of the public one', () => {
    expect(JSON.stringify(owner.paths)).toBe(JSON.stringify(pub.paths));
    expect(owner.info.description.startsWith(pub.info.description)).toBe(true);
    expect(owner.info.description).toContain('audience: "owner"');
  });
});
