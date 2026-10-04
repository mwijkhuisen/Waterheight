import { z } from 'zod';
import {
  ApiError,
  INSTANT_MAX_LENGTH,
  INSTANT_RE,
  Meta,
  RESOLUTIONS,
  SERIES_ID_RE,
  Series,
  SeriesForecast,
  Snapshot,
  Stations,
} from './api.ts';
import { Health, HealthSources, HealthUnavailable } from './health.ts';

// The OpenAPI 3.1 document of the public API (GET /api/v1/openapi.json). The
// paths are written out here; every body schema is generated from the same Zod
// schema the API validates its answers against (z.toJSONSchema; OpenAPI 3.1
// uses JSON Schema 2020-12). No version of any software appears in it.

const COMPONENTS = {
  ApiError,
  Meta,
  Stations,
  Snapshot,
  Series,
  SeriesForecast,
  Health,
  HealthSources,
  HealthUnavailable,
} as const;
type Component = keyof typeof COMPONENTS;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'throw' });
  return rest;
}

const ref = (name: Component) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: Component, description: string) => ({
  description,
  content: { 'application/json': { schema: ref(name) } },
});
const ERRORS = {
  '400': json('ApiError', 'A parameter is unknown, repeated, malformed or out of range'),
  '405': json('ApiError', 'Only GET and HEAD are allowed'),
  '503': json('ApiError', 'The data is unavailable for now'),
} as const;

const instant = (name: string, description: string) => ({
  name,
  in: 'query',
  required: true,
  description: `${description} RFC 3339 with an offset (\`Z\` or \`%2B01:00\`), at most ${INSTANT_MAX_LENGTH} characters; floored to the 10-minute UTC grid.`,
  schema: { type: 'string', maxLength: INSTANT_MAX_LENGTH, pattern: INSTANT_RE.source },
});

/** `more` adds responses, or replaces one of ERRORS. */
const get = (summary: string, ok: ReturnType<typeof json>, parameters: unknown[] = [], more = {}) => ({
  get: { summary, ...(parameters.length > 0 ? { parameters } : {}), responses: { '200': ok, ...ERRORS, ...more } },
});
/** The health routes keep their own 503 body. */
const HEALTH_503 = { '503': json('HealthUnavailable', 'The health documents are unavailable for now') };

/** The document, built once per process. */
export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Waterheight public API',
      version: '1',
      description:
        'Read-only river levels and discharge for the rivers flowing into the Netherlands. Not an official warning service. Unknown or repeated query parameters are a 400.',
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
        [instant('t', 'The instant, from displayStart to now + 48 hours.')],
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
        ],
        { '404': json('ApiError', 'No such series in the api channel') },
      ),
      '/api/v1/series/{id}/forecast': get(
        'The official forecast run of one series current at asof (one source, never blended)',
        json('SeriesForecast', 'SeriesForecast'),
        [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: SERIES_ID_RE.source } },
          {
            ...instant('asof', 'What was known at this instant, from displayStart to now; by default now.'),
            required: false,
          },
        ],
        { '404': json('ApiError', 'No such series in the api channel') },
      ),
      '/api/v1/health': get('Loader and source health (public sources)', json('Health', 'Health'), [], HEALTH_503),
      '/api/v1/health/sources': get('Health per public source', json('HealthSources', 'HealthSources'), [], HEALTH_503),
      '/api/v1/openapi.json': {
        get: {
          summary: 'This document',
          responses: { '200': { description: 'OpenAPI 3.1', content: { 'application/json': { schema: {} } } } },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(Object.entries(COMPONENTS).map(([name, schema]) => [name, jsonSchema(schema)])),
    },
  };
}
