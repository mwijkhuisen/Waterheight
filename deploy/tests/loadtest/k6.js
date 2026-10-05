// P9b load test (k6 1.8.1, .github/workflows/loadtest.yml): one client of six. Each client is a k6 process on its own
// local address (--local-ips), so the API's per-client limiter sees six distinct clients and is never disabled or fed
// a header. Two scenarios run together for DURATION against the compose stack through Caddy over TLS:
//   static  STATIC_RATE r/s: meta 30 %, latest 40 %, recent 20 %, settled 10 % (/data/v1/...)
//   api     API_RATE r/s:    snapshot 50 %, meta 20 %, stations 10 %, series 10 %, forecast 10 % (/api/v1/...)
// Pass criteria (a breach fails the run): p95 under 200 ms per scenario, and not one failed request, a 429 included
// (no responseCallback accepts it). TLS is verified: the process runs with SSL_CERT_FILE = the e2e root, and
// `insecureSkipTLSVerify` is never set. The summary goes to OUT_DIR/summary-<CLIENT>.{json,txt}.
//
// Environment: BASE (https://<domain>), CADDY_IP (the address the domain resolves to), CLIENT (index, for file
// names), OUT_DIR (default .), STATIC_RATE (50), API_RATE (5), DURATION (2m).
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE;
const CLIENT = __ENV.CLIENT || '0';
const OUT_DIR = __ENV.OUT_DIR || '.';
const STATIC_RATE = Number(__ENV.STATIC_RATE || 50);
const API_RATE = Number(__ENV.API_RATE || 5);
const DURATION = __ENV.DURATION || '2m';
if (!BASE || !/^https:\/\/[a-z0-9.-]+$/.test(BASE)) throw new Error('BASE must be https://<domain>');

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
];
// Always true: a threshold is what makes k6 keep a per-kind sub-metric for the summary.
const thresholds = Object.fromEntries(KINDS.map((k) => [`http_req_duration{kind:${k}}`, ['max>=0']]));
Object.assign(thresholds, {
  'http_req_duration{scenario:static}': ['p(95)<200'],
  'http_req_duration{scenario:api}': ['p(95)<200'],
  http_req_failed: ['rate==0'],
  // A dropped iteration means the generator could not start the request in time: the rate was not offered.
  dropped_iterations: ['count==0'],
});

export const options = {
  scenarios: {
    static: {
      executor: 'constant-arrival-rate',
      exec: 'staticMix',
      rate: STATIC_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(STATIC_RATE),
      maxVUs: Math.ceil(STATIC_RATE) * 4,
    },
    api: {
      executor: 'constant-arrival-rate',
      exec: 'apiMix',
      rate: API_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(API_RATE) * 2,
      maxVUs: Math.ceil(API_RATE) * 20,
    },
  },
  thresholds,
  // The domain resolves to Caddy's address on the e2e interface; the certificate is checked for the domain.
  hosts: __ENV.CADDY_IP ? { [BASE.slice('https://'.length)]: __ENV.CADDY_IP } : {},
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

const settledFallback = new Counter('settled_fallback');
const mixSize = new Counter('mix_files');

const HEADERS = { 'Accept-Encoding': 'zstd, gzip' };
const BUCKET_MS = 600_000;
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

/** Everything a request may name, from what the stack actually serves (files that exist, series with the api flag). */
export function setup() {
  const meta = getJson('/data/v1/meta.json');
  const now = Date.parse(meta.now);
  const stations = getJson('/data/v1/stations.json');
  const series = stations.stations.flatMap((s) => s.series.filter((x) => x.api).map((x) => x.id));
  if (series.length === 0) throw new Error('setup: no series with the api flag');

  // Recent: the 10-minute buckets of the last 24 hours (the newest, which may not be written yet, is left out).
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
  return { now, startedAt: Date.now(), series, recent, settled, fallback };
}

const get = (path, kind) => http.get(`${BASE}${path}`, { headers: HEADERS, tags: { kind } });

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

export function apiMix(data) {
  // The clock of the stack, not of the runner: `data.now` is meta.now at setup, moved on by the elapsed time.
  const now = data.now + (Date.now() - data.startedAt);
  const kind = weighted([
    [50, 'snapshot'],
    [20, 'meta'],
    [10, 'stations'],
    [10, 'series'],
    [10, 'forecast'],
  ]);
  if (kind === 'snapshot') {
    // "now" or one of the last 24 hours of 10-minute buckets: 1 + 143 distinct keys, so most answers are cached.
    const t =
      Math.floor(now / BUCKET_MS) * BUCKET_MS - (Math.random() < 0.3 ? 0 : Math.floor(Math.random() * 143) * BUCKET_MS);
    get(`/api/v1/snapshot?t=${instant(t)}`, 'api_snapshot');
  } else if (kind === 'meta') {
    get('/api/v1/meta', 'api_meta');
  } else if (kind === 'stations') {
    get('/api/v1/stations', 'api_stations');
  } else if (kind === 'series') {
    // A short raw span: two hours that start on a 10-minute bucket within the last day.
    const to = Math.floor(now / BUCKET_MS) * BUCKET_MS - Math.floor(Math.random() * 120) * BUCKET_MS;
    get(`/api/v1/series/${pick(data.series)}?from=${instant(to - 7_200_000)}&to=${instant(to)}&res=raw`, 'api_series');
  } else {
    get(`/api/v1/series/${pick(data.series)}/forecast`, 'api_forecast');
  }
}

const ms = (value) => (value === undefined ? 'n/a' : `${value.toFixed(1)} ms`);

export function handleSummary(summary) {
  const m = (name) => summary.metrics[name];
  const lines = [`k6 client ${CLIENT}: ${STATIC_RATE} r/s static + ${API_RATE} r/s api for ${DURATION}`];
  for (const name of ['http_req_duration{scenario:static}', 'http_req_duration{scenario:api}']) {
    const v = m(name)?.values ?? {};
    lines.push(`${name}: avg ${ms(v.avg)}, p95 ${ms(v['p(95)'])}, max ${ms(v.max)}`);
  }
  for (const kind of KINDS) {
    const v = m(`http_req_duration{kind:${kind}}`)?.values;
    if (v !== undefined) lines.push(`  ${kind}: p95 ${ms(v['p(95)'])}, max ${ms(v.max)}`);
  }
  const failed = m('http_req_failed')?.values ?? {};
  lines.push(
    `requests ${m('http_reqs')?.values.count ?? 0}, failed ${failed.passes ?? 0} (rate ${failed.rate ?? 'n/a'}), dropped ${
      m('dropped_iterations')?.values.count ?? 0
    }`,
  );
  lines.push(
    `settled_fallback: ${m('settled_fallback')?.values.count ? 'yes (no complete settled day; its 10 % went to recent)' : 'no'}`,
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
