import { z } from 'zod';
import {
  ApiError,
  INSTANT_MAX_LENGTH,
  INSTANT_RE,
  MetaAnswer,
  RESOLUTIONS,
  SERIES_ID_RE,
  SeriesAnswer,
  SeriesForecastAnswer,
  SnapshotAnswer,
  StationsAnswer,
  VERSION_RE,
} from './api.ts';
import { HealthAnswer, HealthSourcesAnswer, HealthUnavailable } from './health.ts';

// The OpenAPI 3.1 document of the public API (GET /api/v1/openapi.json). The
// paths are written out here; every body schema is generated from the same Zod
// schema the API validates its answers against (z.toJSONSchema; OpenAPI 3.1
// uses JSON Schema 2020-12). No version of any software appears in it. P9b:
// `packages/contracts/openapi.json` (and `openapi-owner.json`) are the committed
// snapshots of this builder (scripts/gen-openapi.ts; test/openapi.test.ts).

const COMPONENTS = {
  ApiError,
  Meta: MetaAnswer,
  Stations: StationsAnswer,
  Snapshot: SnapshotAnswer,
  Series: SeriesAnswer,
  SeriesForecast: SeriesForecastAnswer,
  Health: HealthAnswer,
  HealthSources: HealthSourcesAnswer,
  HealthUnavailable,
} as const;
type Component = keyof typeof COMPONENTS;
/** The body schemas of one API (P9b): the public ones here, the owner API's in api-owner.ts. */
export type OpenApiComponents = Readonly<Record<Component, z.ZodType>>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'throw' });
  return rest;
}

const ref = (name: Component) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: Component, description: string, headers?: Record<string, unknown>) => ({
  description,
  ...(headers === undefined ? {} : { headers }),
  content: { 'application/json': { schema: ref(name) } },
});
const RETRY_AFTER = {
  'Retry-After': {
    description: 'Seconds to wait before the request is tried again (an integer, at least 1).',
    schema: { type: 'integer', minimum: 1 },
  },
};
const ALLOW = (methods: string) => ({
  Allow: { description: 'The methods this path takes.', schema: { type: 'string', const: methods } },
});
/** The error responses every route can give: a fixed code, `attribution: []` and no echo of the request. */
const errors = (allow = 'GET, HEAD') => ({
  '400': json('ApiError', 'A parameter is unknown, repeated, malformed or out of range, or the query is too long'),
  '405': json('ApiError', `Only ${allow} is allowed`, ALLOW(allow)),
  '429': json('ApiError', 'Too many requests from this client: wait for Retry-After', RETRY_AFTER),
  '503': json('ApiError', 'The data is unavailable or busy for now', RETRY_AFTER),
});
const NOT_FOUND = { '404': json('ApiError', 'No such series in the api channel') };

const VERSION_PARAM = {
  name: 'v',
  in: 'query',
  required: false,
  description:
    'The day version from `meta.dayVersions` (absent there means 1). An answer is immutable only when v is current for every day it spans and they are settled; otherwise it is cached for a short time only.',
  schema: { type: 'string', pattern: VERSION_RE.source },
};

const instant = (name: string, description: string) => ({
  name,
  in: 'query',
  required: true,
  description: `${description} RFC 3339 with an offset (\`Z\` or \`%2B01:00\`), at most ${INSTANT_MAX_LENGTH} characters; floored to the 10-minute UTC grid.`,
  schema: { type: 'string', maxLength: INSTANT_MAX_LENGTH, pattern: INSTANT_RE.source },
});

/** `more` adds responses, or replaces one of the errors. */
const get = (summary: string, ok: Record<string, unknown>, parameters: unknown[] = [], more = {}) => ({
  get: { summary, ...(parameters.length > 0 ? { parameters } : {}), responses: { '200': ok, ...errors(), ...more } },
});
/** The health routes answer a database failure with their own 503 body, and a busy server with the API's. */
const HEALTH_503 = {
  '503': {
    description: 'The health documents are unavailable (`HealthUnavailable`) or the server is busy (`ApiError`)',
    headers: RETRY_AFTER,
    content: { 'application/json': { schema: { oneOf: [ref('HealthUnavailable'), ref('ApiError')] } } },
  },
};

// POST /api/v1/beacon: three body shapes, written as plain JSON Schema (the server's strict schemas are not imported).
const text = { type: 'string', maxLength: 2000 };
const BEACON_BODIES = {
  'application/csp-report': {
    schema: {
      description: 'A legacy CSP violation report: one `csp-report` object of the standard fields, all optional.',
      type: 'object',
      additionalProperties: false,
      required: ['csp-report'],
      properties: {
        'csp-report': {
          type: 'object',
          additionalProperties: false,
          properties: {
            'document-uri': text,
            referrer: text,
            'violated-directive': text,
            'effective-directive': text,
            'original-policy': text,
            disposition: text,
            'blocked-uri': text,
            'line-number': { type: 'integer', minimum: 0 },
            'column-number': { type: 'integer', minimum: 0 },
            'source-file': text,
            'status-code': { type: 'integer', minimum: 0 },
            'script-sample': text,
          },
        },
      },
    },
  },
  'application/reports+json': {
    schema: {
      description:
        'A Reporting API batch: 1 to 20 reports of `type`, `age` (ms), `url`, `user_agent` and a flat `body`.',
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'age', 'url', 'user_agent', 'body'],
        properties: {
          type: { type: 'string', maxLength: 64 },
          age: { type: 'integer', minimum: 0 },
          url: text,
          user_agent: { type: 'string', maxLength: 500 },
          body: {
            type: 'object',
            maxProperties: 30,
            additionalProperties: { oneOf: [text, { type: 'number' }, { type: 'null' }] },
          },
        },
      },
    },
  },
  'application/json': {
    schema: {
      description: "The page's own client error report.",
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message', 'url'],
      properties: { kind: { const: 'client_error' }, message: text, url: text },
    },
  },
};
const BEACON = {
  post: {
    summary:
      'A browser report (CSP violation, Reporting API batch or a client error): logged with control characters removed and cut, never stored',
    description:
      'No query string. The body is at most 8,192 bytes and the content type one of the three below (parameters ignored).',
    requestBody: { required: true, content: BEACON_BODIES },
    responses: {
      '204': { description: 'Accepted: no body' },
      ...errors('POST'),
      '413': json('ApiError', 'The body is longer than 8,192 bytes'),
      '415': json('ApiError', 'The content type is none of the three'),
    },
  },
};

/** The document of the public API, built once per process. */
export const openApiDocument = (): Record<string, unknown> => buildOpenApi(COMPONENTS, 'Waterheight public API');

/** The document over `components` (the owner API passes its own schemas and title). */
export function buildOpenApi(components: OpenApiComponents, title: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title,
      version: '1',
      description:
        'Unofficial, no SLA. Read-only river levels and discharge for the rivers flowing into the Netherlands. Rate-limited per client (429 with Retry-After). Not an official warning service. Unknown or repeated query parameters are a 400. Every 200 body carries an `attribution` array that lists exactly the sources it names. The owner API (`api-owner`, owner view only) serves the same paths with `audience: "owner"`.',
    },
    paths: {
      '/api/v1/meta': get(
        'The display window, the build and the public sources with their attribution',
        json('Meta', 'Meta'),
      ),
      '/api/v1/stations': get('Stations and their series', json('Stations', 'Stations')),
      '/api/v1/snapshot': get(
        'The value of every series at t: up to now the last observation carried forward within its staleness limit; after now only official forecasts (`forecasts`), each series from one source',
        json('Snapshot', 'Snapshot'),
        [instant('t', 'The instant, from displayStart to now + 48 hours.'), VERSION_PARAM],
      ),
      '/api/v1/series/{id}': get(
        'One series over [from, to)',
        json('Series', 'Series'),
        [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: SERIES_ID_RE.source } },
          instant('from', 'The start (inclusive), from displayStart.'),
          instant('to', 'The end (exclusive), at most 10 minutes after now.'),
          {
            name: 'res',
            in: 'query',
            required: false,
            description: 'raw up to 14 days, 1h up to 366 days, 1d up to 3660 days; by default the finest that fits.',
            schema: { type: 'string', enum: [...RESOLUTIONS] },
          },
          VERSION_PARAM,
        ],
        NOT_FOUND,
      ),
      '/api/v1/series/{id}/forecast': get(
        'The official forecast run of one series current at asof (one source, never blended); `v` is not accepted (400)',
        json('SeriesForecast', 'SeriesForecast'),
        [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: SERIES_ID_RE.source } },
          {
            ...instant('asof', 'What was known at this instant, from displayStart to now; by default now.'),
            required: false,
          },
        ],
        NOT_FOUND,
      ),
      '/api/v1/health': get('Loader and source health (public sources)', json('Health', 'Health'), [], HEALTH_503),
      '/api/v1/health/sources': get('Health per public source', json('HealthSources', 'HealthSources'), [], HEALTH_503),
      '/api/v1/openapi.json': get('This document', {
        description: 'OpenAPI 3.1',
        content: { 'application/json': { schema: {} } },
      }),
      '/api/v1/beacon': BEACON,
    },
    components: {
      schemas: Object.fromEntries(Object.entries(components).map(([name, schema]) => [name, jsonSchema(schema)])),
    },
  };
}
