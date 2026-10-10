// P9b/P12a load test (k6 1.8.1, .github/workflows/loadtest.yml). One k6 process = one client. In CI there are six per
// scenario, each on its own local address (--local-ips, deploy/tests/loadtest/run-k6.sh), so the API's per-client
// limiter sees six distinct clients and is never disabled or fed a header. TLS is verified (SSL_CERT_FILE = the e2e
// root; `insecureSkipTLSVerify` is never set). SCENARIO selects what the process does:
//
//   normal      CI. STATIC_RPS (300) static + API_RPS (50) API requests per second over all CLIENTS processes (each
//               does 1/CLIENTS of it) for DURATION (15m): static meta 30 %, latest 40 %, recent 20 %, settled 10 %;
//               API snapshot 50 %, meta 20 %, stations 10 %, series 10 %, forecast 10 %. Plus the loader-lag sampler.
//               Thresholds: p95 < 300 ms per scenario, http_req_failed < 0.1 %, no dropped iteration, lag (below).
//   abusive     CI. One client hammers /series and /frames (ABUSE_RPS, 300 r/s, ten times the 30 r/s limit and sixty
//               times the 5 r/s heavy one): at least half of the answers must be 429. ABUSE_ROTATE=1 sends a new
//               X-Forwarded-For, X-Real-IP and True-Client-IP on every request: it must be throttled all the same.
//   flood       CI (flood drill). Visitor sessions, SESSIONS_PER_S (1) per process: meta, latest, tiles manifest,
//               style assets (sprite, glyphs), ~30 PMTiles Range requests, 5 slider steps (API snapshot), 2 /series
//               calls, with think time. p95 < 300 ms, errors < 0.1 %, lag (below).
//   saturation  CI. Every client at the edge of its limiter (SAT_RPS, 28 r/s) with cache-missing wide /series, /frames
//               and snapshot calls to saturate the API; only the loader lag is judged (p95 < 120 s). With
//               SATURATION_REQUIRE=1 the run also fails unless the API showed pressure (a 503, a 504 or an answer over
//               one second), so that "lag while saturated" is never claimed for an idle API.
//   production  Owner-triggered, one process against a live site (BASE): static files only, PROD_RPS (1000) r/s incl.
//               PMTiles Range requests, DURATION (15m), a polite User-Agent (UA). p95 < 300 ms, errors < 0.1 %;
//               aborts at once when errors exceed 1 % or /api/v1/health goes red (non-200 or `down`, or no longer `ok`
//               when it was at the start). No API call but that health sample.
//
// Loader lag (normal, flood, saturation): a sampler reads /api/v1/health every HEALTH_EVERY_S (10 s) and REQUIRES a
// non-null loader.lag_p95_s and a generated_at younger than 5 minutes: either missing is a failed check (health_ok),
// never a skipped sample (a 503 `busy` under saturation is the one answer that is not a sample). The lag goes into the
// Trend loader_lag_s (seconds) with p95 < 120, and health_samples (a Counter) must reach half of the expected samples,
// because a Trend without samples would pass its threshold. LENIENT=1 (the A/B windows of the abusive comparison, which
// are judged by compare-p95.mjs) turns the pass thresholds of the other scenarios into always-true ones that keep the
// sub-metrics in the summary.
//
// The summary goes to OUT_DIR/summary-<CLIENT>.{json,txt}. Environment: BASE (https://<domain>), CADDY_IP (the address
// the domain resolves to), CLIENT, CLIENTS (6), OUT_DIR, SCENARIO, DURATION, STATIC_RPS, API_RPS, ABUSE_RPS, SAT_RPS,
// SESSIONS_PER_S, PROD_RPS, HEALTH_EVERY_S, MAP_ASSETS (/assets/map/<commit7>, for flood and production), UA.

import { sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const SCENARIOS = ['normal', 'abusive', 'flood', 'saturation', 'production'];
const SCENARIO = __ENV.SCENARIO || 'normal';
if (!SCENARIOS.includes(SCENARIO)) throw new Error(`SCENARIO must be one of ${SCENARIOS.join(', ')}`);
const BASE = __ENV.BASE;
if (!BASE || !/^https:\/\/[a-z0-9.-]+$/.test(BASE)) throw new Error('BASE must be https://<domain>');
const CLIENT = __ENV.CLIENT || '0';
const CLIENTS = Number(__ENV.CLIENTS || 6);
const OUT_DIR = __ENV.OUT_DIR || '.';
const DEFAULT_DURATION = { normal: '15m', abusive: '2m', flood: '12m', saturation: '3m', production: '15m' };
const DURATION = __ENV.DURATION || DEFAULT_DURATION[SCENARIO];
const LENIENT = __ENV.LENIENT === '1';
const STATIC_RPS = Number(__ENV.STATIC_RPS || 300);
const API_RPS = Number(__ENV.API_RPS || 50);
const ABUSE_RPS = Number(__ENV.ABUSE_RPS || 300);
const ABUSE_ROTATE = __ENV.ABUSE_ROTATE === '1';
const SAT_RPS = Number(__ENV.SAT_RPS || 28);
const SESSIONS_PER_S = Number(__ENV.SESSIONS_PER_S || 1);
const PROD_RPS = Number(__ENV.PROD_RPS || 1000);
const HEALTH_EVERY_S = Number(__ENV.HEALTH_EVERY_S || 10);
const MAP_ASSETS = __ENV.MAP_ASSETS || '';
if (MAP_ASSETS !== '' && !/^\/assets\/map\/[0-9a-f]{7}$/.test(MAP_ASSETS))
  throw new Error('MAP_ASSETS: /assets/map/<7 hex>');
const clean = (n, what) => {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a positive number`);
  return n;
};
for (const n of [STATIC_RPS, API_RPS, ABUSE_RPS, SAT_RPS, SESSIONS_PER_S, PROD_RPS, HEALTH_EVERY_S, CLIENTS])
  clean(n, 'a rate');

const seconds = (text) => {
  const m = /^([0-9]+)(s|m|h)$/.exec(text);
  if (!m) throw new Error(`DURATION: ${text}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
};
const DURATION_S = seconds(DURATION);

const KINDS = [
  'static_meta',
  'static_latest',
  'static_recent',
  'static_settled',
  'api_snapshot',
  'api_meta',
  'api_stations',
  'api_series',
  'api_forecast',
  'api_frames',
  'tiles_manifest',
  'tile_range',
  'map_asset',
  'abuse',
];

// ---------------------------------------------------------------------------------------------- metrics
const settledFallback = new Counter('settled_fallback');
const mixSize = new Counter('mix_files');
const status429 = new Counter('status_429');
const apiPressure = new Counter('api_pressure');
const abuse429 = new Rate('abuse_429');
const lagS = new Trend('loader_lag_s');
const healthOk = new Rate('health_ok');
const healthSamples = new Counter('health_samples');
const healthBusy = new Counter('health_busy');
const healthRed = new Rate('health_red');

// ---------------------------------------------------------------------------------------------- options
/** constant-arrival-rate for `perSec` requests a second (tenths of a request resolve rates such as 50/6). */
const arrival = (exec, perSec, pre, max) => ({
  executor: 'constant-arrival-rate',
  exec,
  rate: Math.max(1, Math.round(perSec * 10)),
  timeUnit: '10s',
  duration: DURATION,
  preAllocatedVUs: pre,
  maxVUs: max,
});
const healthScenario = (exec) => ({
  executor: 'constant-arrival-rate',
  exec,
  rate: 1,
  timeUnit: `${HEALTH_EVERY_S}s`,
  duration: DURATION,
  preAllocatedVUs: 1,
  maxVUs: 4,
});

const scenarios = {};
const thresholds = {};
/** A threshold: `strict` normally, an always-true one of the same metric type when LENIENT (only the sub-metric stays). */
const th = (name, type, strict) => {
  thresholds[name] = LENIENT ? [{ trend: 'max>=0', rate: 'rate>=0', counter: 'count>=0' }[type]] : strict;
};
// Always true: a threshold is what makes k6 keep a per-kind sub-metric for the summary.
const keepKinds = (kinds) => {
  for (const k of kinds) thresholds[`http_req_duration{kind:${k}}`] = ['max>=0'];
};
const healthThresholds = () => {
  // One sample every HEALTH_EVERY_S; at least half of them must have answered with a lag.
  const minSamples = Math.max(3, Math.floor(DURATION_S / HEALTH_EVERY_S / 2));
  th('health_ok', 'rate', ['rate==1']);
  th('loader_lag_s', 'trend', ['p(95)<120']);
  th('health_samples', 'counter', [`count>=${minSamples}`]);
};

if (SCENARIO === 'normal') {
  scenarios.static = arrival(
    'staticMix',
    STATIC_RPS / CLIENTS,
    Math.ceil(STATIC_RPS / CLIENTS),
    Math.ceil(STATIC_RPS / CLIENTS) * 4,
  );
  scenarios.api = arrival(
    'apiMix',
    API_RPS / CLIENTS,
    Math.ceil(API_RPS / CLIENTS) * 2,
    Math.ceil(API_RPS / CLIENTS) * 20,
  );
  scenarios.health = healthScenario('healthSample');
  keepKinds(KINDS.slice(0, 9));
  th('http_req_duration{scenario:static}', 'trend', ['p(95)<300']);
  th('http_req_duration{scenario:api}', 'trend', ['p(95)<300']);
  th('http_req_failed', 'rate', ['rate<0.001']);
  // A dropped iteration means the generator could not start the request in time: the rate was not offered.
  th('dropped_iterations', 'counter', ['count==0']);
  healthThresholds();
} else if (SCENARIO === 'abusive') {
  scenarios.abuse = arrival('abuse', ABUSE_RPS, 20, 200);
  keepKinds(['abuse']);
  // Never lenient: the abuser must be throttled in every window.
  thresholds.abuse_429 = ['rate>0.5'];
  thresholds.status_429 = ['count>0'];
} else if (SCENARIO === 'flood') {
  scenarios.flood = arrival('floodSession', SESSIONS_PER_S, 30, 200);
  scenarios.health = healthScenario('healthSample');
  keepKinds(KINDS);
  th('http_req_duration{scenario:flood}', 'trend', ['p(95)<300']);
  th('http_req_failed', 'rate', ['rate<0.001']);
  th('dropped_iterations', 'counter', ['count==0']);
  healthThresholds();
} else if (SCENARIO === 'saturation') {
  scenarios.saturate = arrival('saturate', SAT_RPS, SAT_RPS, SAT_RPS * 10);
  scenarios.health = healthScenario('healthSample');
  keepKinds(['api_snapshot', 'api_series', 'api_frames']);
  healthThresholds();
  if (__ENV.SATURATION_REQUIRE === '1') thresholds.api_pressure = ['count>=1'];
} else {
  scenarios.static = arrival('prodMix', PROD_RPS, 200, 1500);
  scenarios.health = healthScenario('prodHealth');
  keepKinds(['static_meta', 'static_latest', 'static_recent', 'static_settled', 'tile_range', 'map_asset']);
  thresholds['http_req_duration{scenario:static}'] = ['p(95)<300'];
  thresholds.http_req_failed = ['rate<0.001', { threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '20s' }];
  thresholds.health_red = [{ threshold: 'rate==0', abortOnFail: true, delayAbortEval: '5s' }];
  thresholds.dropped_iterations = ['count==0'];
}

export const options = {
  scenarios,
  thresholds,
  // The domain resolves to Caddy's address on the e2e interface; the certificate is checked for the domain.
  hosts: __ENV.CADDY_IP ? { [BASE.slice('https://'.length)]: __ENV.CADDY_IP } : {},
  ...(__ENV.UA ? { userAgent: __ENV.UA } : {}),
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

// ---------------------------------------------------------------------------------------------- helpers
const HEADERS = { 'Accept-Encoding': 'zstd, gzip' };
const BUCKET_MS = 600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};
/** The time of the API's `t` parameter: YYYY-MM-DDTHH:MMZ. */
const instant = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const sample = (list, n) => [...list].sort(() => Math.random() - 0.5).slice(0, n);
/** A weighted choice: [[weight, value], ...]. */
const weighted = (table) => {
  let r = Math.random() * table.reduce((sum, [w]) => sum + w, 0);
  for (const [w, v] of table) {
    r -= w;
    if (r < 0) return v;
  }
  return table[table.length - 1][1];
};

const getJson = (path) => {
  const res = http.get(`${BASE}${path}`, { headers: HEADERS, responseType: 'text' });
  if (res.status !== 200) throw new Error(`setup: GET ${path} answered ${res.status}`);
  return res.json();
};

/** The sampled paths that answer 200 to a HEAD (a 404 is the answer being asked, not a failure of the run). */
const existing = (paths) => {
  const requests = paths.map((p) => [
    'HEAD',
    `${BASE}${p}`,
    null,
    { headers: HEADERS, responseCallback: http.expectedStatuses(200, 404), tags: { kind: 'probe' } },
  ]);
  const found = [];
  for (let i = 0; i < requests.length; i += 12) {
    const batch = http.batch(requests.slice(i, i + 12));
    batch.forEach((res, j) => {
      if (res.status === 200) found.push(paths[i + j]);
    });
  }
  return found;
};

const get = (path, kind, params = {}) => {
  const res = http.get(`${BASE}${path}`, { headers: HEADERS, tags: { kind }, ...params });
  if (res.status === 429) status429.add(1);
  return res;
};

/** The static files of the normal mix: the 10-minute buckets of the last day, and the newest settled days. */
function staticFiles(meta) {
  const now = Date.parse(meta.now);
  const newest = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const buckets = Array.from({ length: 143 }, (_, k) => newest - (k + 1) * BUCKET_MS);
  const recent = existing(sample(buckets, 48).map((t) => `/data/v1/recent/${dayOf(t)}/${hhmm(t)}.json`));
  if (recent.length === 0) throw new Error('setup: no recent file answers 200');
  // Settled: the newest settled days (D + 1 day <= now - 48 h) at the version meta.dayVersions names; 0 is "none".
  const days = [];
  const newestSettled = Math.floor((now - 3 * DAY_MS) / DAY_MS) * DAY_MS;
  for (let d = newestSettled; days.length < 10 && d >= Date.parse(meta.displayStart); d -= DAY_MS) days.push(d);
  const candidates = [];
  for (const d of days) {
    const version = meta.dayVersions[dayOf(d)] ?? 1;
    if (version === 0) continue;
    for (let k = 0; k < 144; k++)
      candidates.push(`/data/v1/settled/${dayOf(d)}/v${version}/${hhmm(d + k * BUCKET_MS)}.json`);
  }
  let settled = existing(sample(candidates, 48));
  const fallback = settled.length === 0;
  if (fallback) {
    settledFallback.add(1);
    settled = recent; // C17: no settled day is complete in this stack; the 10 % goes to recent files
  }
  mixSize.add(recent.length + settled.length);
  return { recent, settled, fallback };
}

/** The basemap file and the style assets a visitor loads: from /tiles/manifest.json and MAP_ASSETS. */
function mapFiles() {
  const manifest = getJson('/tiles/manifest.json');
  const file = manifest?.current?.basemap?.file;
  const bytes = manifest?.current?.basemap?.bytes;
  if (
    typeof file !== 'string' ||
    !/^basemap-[0-9]{8}\.pmtiles$/.test(file) ||
    !Number.isInteger(bytes) ||
    bytes < 16_384
  )
    throw new Error('setup: /tiles/manifest.json names no usable basemap file');
  if (MAP_ASSETS === '') throw new Error('setup: MAP_ASSETS is not set (flood and production need the style assets)');
  const candidates = [
    'sprites/v4/white.json',
    'sprites/v4/white.png',
    'sprites/v4/white@2x.json',
    'sprites/v4/white@2x.png',
    'fonts/Noto%20Sans%20Regular/0-255.pbf',
    'fonts/Noto%20Sans%20Regular/256-511.pbf',
    'fonts/Noto%20Sans%20Medium/0-255.pbf',
  ].map((p) => `${MAP_ASSETS}/${p}`);
  const assets = existing(candidates);
  if (assets.length === 0) throw new Error(`setup: no style asset under ${MAP_ASSETS} answers 200`);
  return { tile: `/tiles/${file}`, tileBytes: bytes, assets };
}

/** Everything a request may name, from what the stack actually serves (files that exist, series with the api flag). */
export function setup() {
  const meta = getJson('/data/v1/meta.json');
  const data = { now: Date.parse(meta.now), startedAt: Date.now(), displayStart: Date.parse(meta.displayStart) };
  if (SCENARIO !== 'production') {
    const stations = getJson('/data/v1/stations.json');
    data.series = stations.stations.flatMap((s) => s.series.filter((x) => x.api).map((x) => x.id));
    if (data.series.length === 0) throw new Error('setup: no series with the api flag');
  }
  if (SCENARIO === 'normal' || SCENARIO === 'production') Object.assign(data, staticFiles(meta));
  if (SCENARIO === 'flood' || SCENARIO === 'production') Object.assign(data, mapFiles());
  if (SCENARIO === 'production') {
    const health = http.get(`${BASE}/api/v1/health`, { headers: HEADERS, responseType: 'text' });
    data.healthAtStart = health.status === 200 ? health.json().status : 'unreadable';
    if (data.healthAtStart === 'down' || data.healthAtStart === 'unreadable')
      throw new Error(`setup: /api/v1/health is ${data.healthAtStart}; not starting a burst against a red site`);
  }
  return data;
}

/** The clock of the stack, not of the runner: `data.now` is meta.now at setup, moved on by the elapsed time. */
const stackNow = (data) => data.now + (Date.now() - data.startedAt);

// ---------------------------------------------------------------------------------------------- normal
export function staticMix(data) {
  const kind = weighted([
    [30, 'meta'],
    [40, 'latest'],
    [20, 'recent'],
    [10, 'settled'],
  ]);
  const path =
    kind === 'meta'
      ? '/data/v1/meta.json'
      : kind === 'latest'
        ? '/data/v1/latest.json'
        : pick(kind === 'recent' ? data.recent : data.settled);
  get(path, `static_${kind}`);
}

/** A short raw span: two hours that start on a 10-minute bucket within the last day. */
const seriesPath = (data, now) => {
  const to = Math.floor(now / BUCKET_MS) * BUCKET_MS - Math.floor(Math.random() * 120) * BUCKET_MS;
  return `/api/v1/series/${pick(data.series)}?from=${instant(to - 7_200_000)}&to=${instant(to)}&res=raw`;
};
/** "now" or one of the last 24 hours of 10-minute buckets: 1 + 143 distinct keys, so most answers are cached. */
const snapshotPath = (now) => {
  const t =
    Math.floor(now / BUCKET_MS) * BUCKET_MS - (Math.random() < 0.3 ? 0 : Math.floor(Math.random() * 143) * BUCKET_MS);
  return `/api/v1/snapshot?t=${instant(t)}`;
};

export function apiMix(data) {
  const now = stackNow(data);
  const kind = weighted([
    [50, 'snapshot'],
    [20, 'meta'],
    [10, 'stations'],
    [10, 'series'],
    [10, 'forecast'],
  ]);
  if (kind === 'snapshot') get(snapshotPath(now), 'api_snapshot');
  else if (kind === 'meta') get('/api/v1/meta', 'api_meta');
  else if (kind === 'stations') get('/api/v1/stations', 'api_stations');
  else if (kind === 'series') get(seriesPath(data, now), 'api_series');
  else get(`/api/v1/series/${pick(data.series)}/forecast`, 'api_forecast');
}

// ---------------------------------------------------------------------------------------------- loader lag
/**
 * One /api/v1/health sample. The lag is REQUIRED (null is a failed check, not a skipped sample) and so is a loader pass
 * younger than 5 minutes. A 503 `busy` (the API saturated, no stale body to serve) is counted apart and is no sample.
 */
export function healthSample() {
  const res = http.get(`${BASE}/api/v1/health`, {
    headers: HEADERS,
    responseType: 'text',
    responseCallback: http.expectedStatuses(200, 503),
    tags: { kind: 'health' },
  });
  if (res.status === 503) {
    healthBusy.add(1);
    return;
  }
  let body = null;
  try {
    body = res.json();
  } catch (_) {
    body = null;
  }
  const lag = body?.loader?.lag_p95_s;
  const generated = body?.generated_at ? Date.parse(body.generated_at) : Number.NaN;
  const ok =
    res.status === 200 && typeof lag === 'number' && Number.isFinite(generated) && Date.now() - generated < 300_000;
  if (!ok) console.error(`health sample failed: status ${res.status}, lag ${lag}, generated_at ${body?.generated_at}`);
  healthOk.add(ok);
  healthSamples.add(1);
  if (typeof lag === 'number') lagS.add(lag);
}

// ---------------------------------------------------------------------------------------------- abusive
const octet = () => between(1, 254);
const randomIp = () => `${between(11, 99)}.${octet()}.${octet()}.${octet()}`;

/** One request of the abuser: wide /series and /frames calls (heavy class, 5 r/s), optionally with rotating client headers. */
export function abuse(data) {
  const now = stackNow(data);
  const params = {
    headers: { ...HEADERS },
    responseCallback: http.expectedStatuses(200, 400, 429, 503),
    tags: { kind: 'abuse' },
  };
  if (ABUSE_ROTATE) {
    const ip = randomIp();
    params.headers['X-Forwarded-For'] = `${ip}, ${randomIp()}`;
    params.headers['X-Real-IP'] = randomIp();
    params.headers['True-Client-IP'] = randomIp();
  }
  const path = Math.random() < 0.5 ? wideSeries(data, now) : wideFrames(data, now);
  const res = get(path, 'abuse', params);
  abuse429.add(res.status === 429);
}

// ---------------------------------------------------------------------------------------------- saturation
/** A cache-missing /series call: a random end on the 10-minute grid, a random span, random series and resolution. */
function wideSeries(data, now) {
  const to = Math.floor(now / BUCKET_MS) * BUCKET_MS - between(0, 400) * BUCKET_MS;
  const from = Math.max(data.displayStart, to - between(6, 72) * HOUR_MS);
  const res = pick(['raw', '1h', '1h']);
  return `/api/v1/series/${pick(data.series)}?from=${instant(from)}&to=${instant(to)}&res=${res}`;
}
/** A /frames call over whole hours between the display start and the last full hour; up to 14 days. */
function wideFrames(data, now) {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS;
  const first = Math.ceil(data.displayStart / HOUR_MS) * HOUR_MS;
  const hours = Math.max(1, Math.floor((last - first) / HOUR_MS));
  const span = between(Math.min(24, hours), Math.min(hours, 14 * 24));
  const to = last - between(0, hours - span) * HOUR_MS;
  return `/api/v1/frames?from=${instant(to - span * HOUR_MS)}&to=${instant(to)}`;
}

export function saturate(data) {
  const now = stackNow(data);
  const params = {
    headers: HEADERS,
    responseCallback: http.expectedStatuses(200, 400, 429, 503),
    tags: { kind: 'api_snapshot' },
  };
  const kind = weighted([
    [45, 'series'],
    [25, 'frames'],
    [30, 'snapshot'],
  ]);
  const path =
    kind === 'series' ? wideSeries(data, now) : kind === 'frames' ? wideFrames(data, now) : snapshotPath(now);
  params.tags = { kind: kind === 'series' ? 'api_series' : kind === 'frames' ? 'api_frames' : 'api_snapshot' };
  const res = get(path, params.tags.kind, params);
  if (res.status === 503 || res.status === 504 || res.timings.duration >= 1000) apiPressure.add(1);
}

// ---------------------------------------------------------------------------------------------- flood
const range = (data) => {
  // pmtiles.js asks for an explicit `bytes=first-last` (Caddy serves nothing else): the header first, then directory and tile reads.
  const len = pick([4096, 16_384, 65_536]);
  const first = between(0, data.tileBytes - len);
  return { Range: `bytes=${first}-${first + len - 1}` };
};

/** One visitor: first paint (static files, style assets, ~30 tile ranges), then 5 slider steps and 2 series with think time. */
export function floodSession(data) {
  get('/data/v1/meta.json', 'static_meta');
  get('/data/v1/latest.json', 'static_latest');
  get('/tiles/manifest.json', 'tiles_manifest');
  http.batch(data.assets.map((p) => ['GET', `${BASE}${p}`, null, { headers: HEADERS, tags: { kind: 'map_asset' } }]));
  const tile = (first) => [
    'GET',
    `${BASE}${data.tile}`,
    null,
    {
      headers: first ? { Range: 'bytes=0-16383' } : range(data),
      responseCallback: http.expectedStatuses(206),
      tags: { kind: 'tile_range' },
    },
  ];
  // 30 reads, six at a time as a browser's connections allow.
  const reads = Array.from({ length: 30 }, (_, i) => tile(i === 0));
  for (let i = 0; i < reads.length; i += 6) {
    http.batch(reads.slice(i, i + 6));
    sleep(0.1);
  }
  const now = stackNow(data);
  for (let step = 0; step < 5; step++) {
    sleep(0.5 + Math.random());
    get(snapshotPath(now), 'api_snapshot');
  }
  sleep(0.5 + Math.random());
  get(seriesPath(data, now), 'api_series');
  sleep(0.5 + Math.random());
  get(seriesPath(data, now), 'api_series');
  sleep(1 + Math.random() * 2);
}

// ---------------------------------------------------------------------------------------------- production
export function prodMix(data) {
  const kind = weighted([
    [15, 'meta'],
    [20, 'latest'],
    [15, 'recent'],
    [10, 'settled'],
    [30, 'tile'],
    [10, 'asset'],
  ]);
  if (kind === 'tile')
    http.get(`${BASE}${data.tile}`, {
      headers: { ...HEADERS, ...range(data) },
      responseCallback: http.expectedStatuses(206),
      tags: { kind: 'tile_range' },
    });
  else if (kind === 'asset') get(pick(data.assets), 'map_asset');
  else if (kind === 'meta') get('/data/v1/meta.json', 'static_meta');
  else if (kind === 'latest') get('/data/v1/latest.json', 'static_latest');
  else get(pick(kind === 'recent' ? data.recent : data.settled), `static_${kind}`);
}

/** The production health sample: red = not 200 twice in a row, `down`, or no longer `ok` when it was `ok` at the start. */
export function prodHealth(data) {
  const read = () => {
    const res = http.get(`${BASE}/api/v1/health`, { headers: HEADERS, responseType: 'text', tags: { kind: 'health' } });
    if (res.status !== 200) return { red: true, why: `HTTP ${res.status}` };
    const status = res.json().status;
    if (status === 'down') return { red: true, why: 'status down' };
    if (data.healthAtStart === 'ok' && status !== 'ok') return { red: true, why: `status ${status} (was ok)` };
    return { red: false };
  };
  let r = read();
  if (r.red) {
    sleep(2);
    r = read();
  }
  if (r.red) console.error(`production health is red: ${r.why}`);
  healthRed.add(r.red);
}

// ---------------------------------------------------------------------------------------------- summary
const ms = (value) => (value === undefined ? 'n/a' : `${value.toFixed(1)} ms`);

export function handleSummary(summary) {
  const m = (name) => summary.metrics[name];
  const count = (name) => m(name)?.values.count ?? 0;
  const lines = [`k6 ${SCENARIO} client ${CLIENT}${LENIENT ? ' (lenient)' : ''}: ${DURATION}`];
  for (const name of Object.keys(summary.metrics).filter((n) => /^http_req_duration\{scenario:[a-z]+\}$/.test(n))) {
    const v = m(name).values;
    lines.push(`${name}: avg ${ms(v.avg)}, p95 ${ms(v['p(95)'])}, max ${ms(v.max)}`);
  }
  for (const kind of KINDS) {
    const v = m(`http_req_duration{kind:${kind}}`)?.values;
    if (v !== undefined) lines.push(`  ${kind}: p95 ${ms(v['p(95)'])}, max ${ms(v.max)}`);
  }
  const failed = m('http_req_failed')?.values ?? {};
  lines.push(
    `requests ${count('http_reqs')}, failed ${failed.passes ?? 0} (rate ${failed.rate ?? 'n/a'}), dropped ${count('dropped_iterations')}, 429 ${count('status_429')}`,
  );
  if (m('health_samples') !== undefined) {
    const lag = m('loader_lag_s')?.values ?? {};
    lines.push(
      `loader lag (s): p95 ${lag['p(95)'] ?? 'n/a'}, max ${lag.max ?? 'n/a'}; health samples ${count('health_samples')}, ok rate ${m('health_ok')?.values.rate ?? 'n/a'}, busy ${count('health_busy')}`,
    );
  }
  if (SCENARIO === 'saturation') lines.push(`api pressure (503, 504 or over 1 s): ${count('api_pressure')} answers`);
  if (SCENARIO === 'abusive')
    lines.push(
      `abuse 429 share: ${m('abuse_429')?.values.rate ?? 'n/a'}${ABUSE_ROTATE ? ' (rotating client headers)' : ''}`,
    );
  if (SCENARIO === 'production') lines.push(`health red rate: ${m('health_red')?.values.rate ?? 'n/a'}`);
  lines.push(
    `settled_fallback: ${count('settled_fallback') ? 'yes (no complete settled day; its 10 % went to recent)' : 'no'}`,
  );
  const breached = Object.entries(summary.metrics).flatMap(([name, metric]) =>
    Object.entries(metric.thresholds ?? {})
      .filter(([, t]) => t.ok === false)
      .map(([expr]) => `${name} ${expr}`),
  );
  lines.push(breached.length === 0 ? 'thresholds: all passed' : `thresholds BREACHED: ${breached.join('; ')}`);
  const text = `${lines.join('\n')}\n`;
  return {
    [`${OUT_DIR}/summary-${CLIENT}.json`]: JSON.stringify(summary, null, 2),
    [`${OUT_DIR}/summary-${CLIENT}.txt`]: text,
    stdout: text,
  };
}
