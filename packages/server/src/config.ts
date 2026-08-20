/**
 * All configuration in one place, read from the environment once at startup.
 * See .env.example for the documented set.
 */

// Must come first: this populates process.env from the `.env` file, and every
// value below is read at module evaluation. Importing it here rather than in
// each entry point means no entry point can get the ordering wrong.
import './env.js';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

export const config = {
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  logLevel: str('LOG_LEVEL', 'info'),

  databaseUrl: str('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/rws'),
  dbPoolSize: int('DB_POOL_SIZE', 10),

  rws: {
    apiBase: str('RWS_API_BASE', 'https://ddapi20-waterwebservices.rijkswaterstaat.nl'),
    wfsUrl: str('RWS_WFS_URL', 'https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows'),
    /**
     * Not required today, but Rijkswaterstaat asks clients to send one so that
     * future key-based rate limiting does not break them.
     */
    apiKey: str('RWS_API_KEY', 'dummy'),
    timeoutMs: int('RWS_TIMEOUT_MS', 120_000),
    /** Politeness cap on concurrent outbound calls to RWS. */
    maxConcurrency: int('RWS_MAX_CONCURRENCY', 4),
    maxRetries: int('RWS_MAX_RETRIES', 5),
  },

  /** A location counts as active if its latest observation is newer than this. */
  activeWindowDays: int('ACTIVE_WINDOW_DAYS', 7),

  cache: {
    /** RWS publishes on a ~10-minute cadence, so caching latest for 5 is safe. */
    latestTtlSeconds: int('CACHE_LATEST_TTL_SECONDS', 300),
    observationsTtlSeconds: int('CACHE_OBSERVATIONS_TTL_SECONDS', 180),
  },

  /** Never send 50,000 points to a browser drawing a 400px-wide chart. */
  maxPointsPerResponse: int('MAX_POINTS_PER_RESPONSE', 2000),

  /**
   * Run the daily refresh and weekly correction re-fetch inside the API
   * process. Off by default: with several API instances behind a load
   * balancer, only one should carry the schedules.
   */
  enableSchedules: bool('ENABLE_SCHEDULES', false),

  /**
   * Directory of the built map client. When present the API serves it at the
   * root, so the whole app is one origin and one container -- which also means
   * the browser never needs CORS. Empty disables static serving (API only).
   */
  webRoot: str('WEB_ROOT', ''),

  /**
   * Allowed CORS origin for third-party API consumers. The data is public and
   * the API is read-only, so '*' is the sensible default; set a specific origin
   * to lock it down. The bundled client does not rely on this -- it is served
   * from the same origin.
   */
  corsOrigin: str('CORS_ORIGIN', '*'),

  /** Inbound rate limit per IP. The upstream politeness cap is separate. */
  rateLimit: {
    max: int('RATE_LIMIT_MAX', 300),
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  },
} as const;

export type Config = typeof config;
