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
   * Run the daily refresh, weekly correction re-fetch and five-minute latest
   * poll inside the API process. Off by default: with several API instances
   * behind a load balancer, only one should carry the schedules.
   */
  enableSchedules: bool('ENABLE_SCHEDULES', false),

  /**
   * The five-minute poll that keeps the latest reading of every live series
   * current, so live data is served from the store rather than fetched from
   * Rijkswaterstaat while a visitor waits.
   */
  latestPoll: {
    /** Only has an effect where ENABLE_SCHEDULES is on. */
    enabled: bool('ENABLE_LATEST_POLL', true),
    intervalMs: int('LATEST_POLL_INTERVAL_MINUTES', 5) * 60_000,
    /**
     * Locations per upstream call. 100 narrowed locations answered in about a
     * second when measured; the cap exists because the service builds the
     * cross product of the location and metadata lists it is given.
     */
    batchSize: int('LATEST_POLL_BATCH_SIZE', 100),
    /**
     * Ceiling on the location x filter cross product one call may ask for,
     * and so the lever between calls and bytes. Raise it for fewer, larger
     * calls; lower it for more, leaner ones. Measured over 1,744 live series:
     * one filter per call cost 140 calls and 4.5 MiB, sixteen per call 9 calls
     * and 6.7 MiB, both returning the same readings.
     */
    maxCombinations: int('LATEST_POLL_MAX_COMBINATIONS', 2000),
    /**
     * How far back a reading still counts as live. Both which series are
     * polled and which returned readings are stored: OphalenLaatsteWaarnemingen
     * answers with every series a location ever ran, some last heard from in
     * 1900, and those must not become part of the store.
     */
    maxAgeMs: int('LATEST_POLL_MAX_AGE_HOURS', 48) * 3_600_000,
    /**
     * Pairs probed per cycle for a series the poll does not know yet. Each is
     * one small call, and the rotation is oldest-first, so a cold store warms
     * up over a few hours rather than in one burst upstream.
     */
    discoveryLimit: int('LATEST_POLL_DISCOVERY_LIMIT', 50),
    /**
     * Window a discovery probe asks for. Long enough that a station reporting
     * only once or twice a day still answers one.
     */
    discoveryWindowMs: int('LATEST_POLL_DISCOVERY_HOURS', 26) * 3_600_000,
  },

  /**
   * Whether a request for a window the store does not cover may fetch it from
   * Rijkswaterstaat while the caller waits.
   *
   * On by default, which is what makes a fresh install useful before any
   * backfill has run. Turn it off once the poll and the backfill are keeping
   * the store current and every upstream call should come from the scheduler
   * -- an uncovered window then answers from what is stored rather than
   * putting visitor traffic on Rijkswaterstaat's rate limit.
   */
  liveFetchOnRequest: bool('LIVE_FETCH_ON_REQUEST', true),

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
