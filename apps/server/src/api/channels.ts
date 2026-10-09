import { type ChannelAudience, VIEWS } from '../db/audience.ts';
import { coded } from './util.ts';

// The one route table of the API (P9b, catalogue §0.7, A§9.2): each route's licence channel and rate class. A route
// reads its views only through `channelViews(family, channel)`: `display` the display family (lic_display), `api` the
// api variants (lic_display AND lic_api, history_window inside the views), `meta` the views that hold no observation
// value, and `export` nothing at all, because no export view set exists (bulk_export, a later phase): a route tagged
// `export` fails before it reads (test/api/channels.test.ts). The filters live in the views (gen-views.ts), never only
// here. The canary sweeps iterate this table, so a route added to it is swept the day it is built.

export type Channel = 'display' | 'api' | 'export' | 'meta';
/** The per-client token buckets (limiter.ts): `heavy` is taken in addition to `general`, `beacon` instead of it. */
export type RateClass = 'general' | 'heavy' | 'beacon';

export type RouteDef = {
  /** Hono's path pattern. */
  path: string;
  method: 'GET' | 'POST';
  channel: Channel;
  rate: RateClass;
  /** Takes `v` (day versions; immutable answers). */
  versioned: boolean;
  /** Listed for its rate class and the sweeps, not served yet (/stations/{id} is A§9.2's). */
  planned: boolean;
};

const r = (
  path: string,
  channel: Channel,
  rate: RateClass,
  extra: Partial<Pick<RouteDef, 'method' | 'versioned' | 'planned'>> = {},
): RouteDef => ({ path, method: 'GET', channel, rate, versioned: false, planned: false, ...extra });

export const ROUTES: readonly RouteDef[] = [
  r('/api/v1/meta', 'display', 'general'),
  r('/api/v1/stations', 'display', 'general'),
  r('/api/v1/stations/:id', 'display', 'general', { planned: true }),
  r('/api/v1/snapshot', 'display', 'general', { versioned: true }),
  r('/api/v1/series/:id', 'api', 'heavy', { versioned: true }),
  r('/api/v1/series/:id/forecast', 'api', 'heavy'),
  r('/api/v1/frames', 'api', 'heavy', { versioned: true }),
  r('/api/v1/health', 'meta', 'general'),
  r('/api/v1/health/sources', 'meta', 'general'),
  r('/api/v1/openapi.json', 'meta', 'general'),
  r('/api/v1/beacon', 'meta', 'beacon', { method: 'POST' }),
];

/** The rate class of a request, from its method and raw path alone (the limiter runs before routing). */
export function rateClass(method: string, path: string): RateClass {
  if (method === 'POST' && path === '/api/v1/beacon') return 'beacon';
  if (path.startsWith('/api/v1/series/') || path === '/api/v1/frames' || path.startsWith('/api/v1/frames/'))
    return 'heavy';
  return 'general';
}

const META_VIEWS = ['meta', 'attribution', 'source', 'sourceHealth', 'twinCheck', 'ingestBatch', 'dayVersion'] as const;

export function channelViews(family: ChannelAudience, channel: 'display'): (typeof VIEWS)[ChannelAudience];
export function channelViews(family: ChannelAudience, channel: 'api'): (typeof VIEWS)[ChannelAudience]['api'];
export function channelViews(
  family: ChannelAudience,
  channel: 'meta',
): Pick<(typeof VIEWS)[ChannelAudience], (typeof META_VIEWS)[number]>;
export function channelViews(family: ChannelAudience, channel: 'export'): never;
export function channelViews(family: ChannelAudience, channel: Channel): unknown {
  const v = VIEWS[family];
  if (channel === 'display') return v;
  if (channel === 'api') return v.api;
  if (channel === 'meta') return Object.fromEntries(META_VIEWS.map((k) => [k, v[k]]));
  throw coded('no_export_channel');
}
