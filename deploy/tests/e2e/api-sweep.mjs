// CI only (deploy/tests/e2e/run.sh, P9b): the owner canary sweep of issue #24, run inside the server image on the
// rws_edge network, which reaches both the public caddy and caddy-owner. No dependency: node:https and node:zlib; the
// route table comes from the image's own build (ROUTES in apps/server/dist/api/channels.js) and the canary's text
// from the image's registry (/app/registry/sources.yaml), so nothing is hard-coded but the two renderings of the
// canary value (CANARIES in packages/contracts).
//
// Public side (through `caddy`, TLS verified against Pebble's root): every non-planned GET route of ROUTES, /snapshot
// at 50 random instants, /series and /series/{id}/forecast for public ids and for the owner canary's id (which must be
// byte-identical to an unknown id's 404), health, openapi, the static files that meta.json lists or implies, status
// files, robots.txt and sitemap.xml when they answer 200, a beacon of each content type; every body in identity, gzip
// and zstd, decompressed. NO term may occur in any public byte.
// Owner side (through `caddy-owner`, basic_auth with the run's throw-away password): the canary appears in the
// owner /snapshot, /series/{id} and /series/{id}/forecast, its source id in the attribution of the answers, every
// answer says audience "owner" and sends `private, no-store`.
// Prints one summary line per side and FAIL lines naming the path and the term's index, never the term; exit 1.

import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
// ---- terms, from the registry at run time
const registryRoot = '/app/registry';
const requireFromServer = createRequire('/app/apps/server/dist/main.js');
const { parse } = requireFromServer('yaml');
const registry = parse(readFileSync(`${registryRoot}/sources.yaml`, 'utf8'));
const canarySource = registry.sources.find((s) => s.canary === true && s.audience === 'owner');
if (!canarySource) throw new Error('no owner canary source in registry/sources.yaml');
const OWNER_IDS = registry.sources.filter((s) => s.audience === 'owner').map((s) => s.id);
const CANARY_STATION = 'nl.canary.owner';
const terms = [
  '777777.777',
  '777777.75',
  CANARY_STATION,
  canarySource.id,
  'owner-canary',
  canarySource.attribution_text,
  canarySource.private_basis.clause,
  canarySource.name,
].filter((t) => typeof t === 'string' && t.length > 0);
const termBuffers = terms.map((t) => [Buffer.from(t), Buffer.from(JSON.stringify(t).slice(1, -1))]);

// ---- `--logs <file>...`: only the terms in the files of a run (compose logs, the public access log); no network.
// Prints the path and the term's index, never the term.
if (process.argv[2] === '--logs') {
  const files = process.argv.slice(3);
  if (files.length === 0) throw new Error('--logs needs files');
  let found = 0;
  for (const f of files)
    for (const i of termsIn(readFileSync(f))) {
      found += 1;
      console.log(`FAIL ${f}: term #${i}`);
    }
  console.log(`logs: ${files.length} files, ${terms.length} terms, ${found} findings`);
  process.exit(found === 0 ? 0 : 1);
}
const domain = env('RWS_DOMAIN');
const password = env('OWNER_PW');
const publicCa = readFileSync(env('PUBLIC_CA'));
const ownerCa = readFileSync(env('OWNER_CA'));

// ---- the route table of the image's own build
const { ROUTES } = await import('file:///app/apps/server/dist/api/channels.js');
const getRoutes = ROUTES.filter((r) => r.method === 'GET' && !r.planned).map((r) => r.path);
const beaconRoute = ROUTES.find((r) => r.method === 'POST' && r.path === '/api/v1/beacon');
if (!beaconRoute) throw new Error('ROUTES has no POST /api/v1/beacon');

// ---- HTTP
const sides = {
  public: { host: 'caddy', port: 443, servername: domain, ca: publicCa, authority: domain },
  owner: { host: 'caddy-owner', port: 8443, servername: `owner.${domain}`, ca: ownerCa, authority: `owner.${domain}` },
};
const counts = { public: { requests: 0, bodies: 0, retried: 0 }, owner: { requests: 0, bodies: 0, retried: 0 } };
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastHeavy = 0;

function once(side, { method = 'GET', path, headers = {}, body }) {
  const s = sides[side];
  const h = { host: s.authority, ...headers };
  if (side === 'owner') h.authorization = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
  if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = request(
      { host: s.host, port: s.port, servername: s.servername, ca: s.ca, path, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function decode(res) {
  const enc = res.headers['content-encoding'];
  if (enc === undefined || enc === 'identity') return res.raw;
  if (enc === 'gzip') return gunzipSync(res.raw);
  if (enc === 'zstd') return zstdDecompressSync(res.raw);
  if (enc === 'br') return brotliDecompressSync(res.raw);
  throw new Error(`unknown content-encoding ${enc}`);
}

/** One request, paced for the heavy routes, a 429 honoured once (all our requests come from one address: C16). */
async function call(side, opts) {
  if (opts.path.startsWith('/api/v1/series')) {
    const wait = lastHeavy + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    lastHeavy = Date.now();
  }
  counts[side].requests += 1;
  let res = await once(side, opts);
  if (res.status === 429) {
    const after = Number(res.headers['retry-after']);
    if (!Number.isInteger(after) || after < 1 || after > 30) {
      fail(`${side} ${opts.path}: 429 without a usable Retry-After`);
      return { ...res, body: decode(res) };
    }
    counts[side].retried += 1;
    await sleep(after * 1000 + 100);
    counts[side].requests += 1;
    res = await once(side, opts);
  }
  return { ...res, body: decode(res) };
}

/** The terms found in a public body, as indices into `terms`. */
function termsIn(buf) {
  const found = [];
  termBuffers.forEach((variants, i) => {
    if (variants.some((v) => buf.includes(v))) found.push(i);
  });
  return found;
}

const ENCODINGS = ['identity', 'gzip', 'zstd'];
/**
 * A public GET in every encoding: statuses within `ok`, the decoded body and the headers free of every term.
 * Returns the identity answer.
 */
async function publicGet(path, ok = [200]) {
  let first;
  for (const enc of ENCODINGS) {
    const res = await call('public', { path, headers: { 'accept-encoding': enc } });
    counts.public.bodies += 1;
    if (!ok.includes(res.status)) fail(`public ${path} [${enc}]: HTTP ${res.status}`);
    for (const i of termsIn(res.body)) fail(`public ${path} [${enc}]: term #${i}`);
    for (const i of termsIn(Buffer.from(JSON.stringify(res.headers))))
      fail(`public ${path} [${enc}] headers: term #${i}`);
    if (first === undefined) first = res;
  }
  return first;
}
const json = (res) => JSON.parse(res.body.toString('utf8'));

// ---- seeded PRNG (mulberry32)
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BUCKET = 600_000;
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const floor = (ms) => Math.floor(ms / BUCKET) * BUCKET;

// ---- owner side, first: its stations name the canary's series id
async function ownerGet(path, what) {
  const res = await call('owner', { path, headers: { 'accept-encoding': 'identity' } });
  counts.owner.bodies += 1;
  if (res.status !== 200) fail(`owner ${path}: HTTP ${res.status}`);
  if (res.headers['cache-control'] !== 'private, no-store')
    fail(`owner ${path}: Cache-Control is not private, no-store`);
  let body;
  try {
    body = json(res);
  } catch {
    fail(`owner ${path}: not JSON`);
    return { res, body: undefined };
  }
  if (what !== 'openapi' && body.audience !== 'owner') fail(`owner ${path}: no audience "owner"`);
  return { res, body };
}
const hasCanaryAttribution = (body) =>
  Array.isArray(body?.attribution) && body.attribution.some((e) => e?.source === canarySource.id);
const hasValue = (buf) => buf.includes('777777.75') || buf.includes('777777.777');

const ownerMeta = await ownerGet('/api/v1/meta');
if (ownerMeta.body === undefined) throw new Error('the owner /api/v1/meta did not answer');
const now = Date.parse(ownerMeta.body.now);
const displayStart = Date.parse(ownerMeta.body.displayStart);
if (!hasCanaryAttribution(ownerMeta.body)) fail('owner /api/v1/meta: no attribution entry of the canary source');
if (!ownerMeta.body.sources?.some((s) => s.id === canarySource.id))
  fail('owner /api/v1/meta: the canary source is not listed');

const ownerStations = await ownerGet('/api/v1/stations');
const canaryStation = ownerStations.body?.stations?.find((s) => s.id === CANARY_STATION);
const canaryId = canaryStation?.series?.[0]?.id;
if (!Number.isInteger(canaryId)) throw new Error('the owner /api/v1/stations lists no canary series');
if (!hasCanaryAttribution(ownerStations.body))
  fail('owner /api/v1/stations: no attribution entry of the canary source');

const tNow = iso(floor(now));
const span = `from=${iso(displayStart)}&to=${tNow}`; // the whole window: holds the canary's one instant
const ownerPaths = {
  '/api/v1/meta': ['/api/v1/meta'],
  '/api/v1/stations': ['/api/v1/stations'],
  '/api/v1/snapshot': [`/api/v1/snapshot?t=${tNow}`],
  '/api/v1/series/:id': [`/api/v1/series/${canaryId}?${span}&res=1d`],
  '/api/v1/series/:id/forecast': [`/api/v1/series/${canaryId}/forecast`],
  '/api/v1/health': ['/api/v1/health'],
  '/api/v1/health/sources': ['/api/v1/health/sources'],
  '/api/v1/openapi.json': ['/api/v1/openapi.json'],
};
const ownerSeen = new Set();
for (const route of getRoutes) {
  if (!(route in ownerPaths)) {
    fail(`ROUTES holds ${route}, which this sweep does not know (owner)`);
    continue;
  }
  for (const path of ownerPaths[route]) {
    const { res, body } = await ownerGet(path, route.endsWith('openapi.json') ? 'openapi' : undefined);
    ownerSeen.add(route);
    const needsValue =
      route === '/api/v1/snapshot' || route === '/api/v1/series/:id' || route === '/api/v1/series/:id/forecast';
    if (needsValue) {
      if (!hasValue(res.body)) fail(`owner ${path}: the canary value is absent`);
      if (!hasCanaryAttribution(body)) fail(`owner ${path}: no attribution entry of the canary source`);
    }
  }
}
// The snapshot's entry of the canary series holds the value (a real: 777777.75).
{
  const snap = await ownerGet(`/api/v1/snapshot?t=${tNow}`);
  const v = snap.body?.values?.find((x) => x.series === canaryId);
  if (!v || Math.abs(v.value - 777777.777) > 0.05)
    fail('owner /api/v1/snapshot: the canary series has no canary value');
}

// ---- public side
const stations = json(await publicGet('/api/v1/stations'));
const meta = json(await publicGet('/api/v1/meta'));
const ids = stations.stations.flatMap((s) => s.series.map((x) => x.id)).slice(0, 3);
if (ids.length === 0) throw new Error('the public /api/v1/stations lists no series');
const UNKNOWN_ID = 2_147_483_000;
const rand = prng(24);
const lo = Date.parse(meta.displayStart);
const hi = Date.parse(meta.now) + 48 * 3_600_000 - BUCKET;
const randomT = Array.from({ length: 50 }, () => iso(floor(lo + rand() * (hi - lo))));
const pnow = Date.parse(meta.now);
const pspan = `from=${iso(floor(pnow) - 2 * 86_400_000)}&to=${iso(floor(pnow))}`;
let series200 = 0;
const publicPaths = {
  '/api/v1/meta': ['/api/v1/meta'],
  '/api/v1/stations': ['/api/v1/stations'],
  '/api/v1/snapshot': [`/api/v1/snapshot?t=${iso(floor(pnow))}`, ...randomT.map((t) => `/api/v1/snapshot?t=${t}`)],
  '/api/v1/series/:id': ids.map((id) => `/api/v1/series/${id}?${pspan}`),
  '/api/v1/series/:id/forecast': ids.map((id) => `/api/v1/series/${id}/forecast`),
  '/api/v1/health': ['/api/v1/health'],
  '/api/v1/health/sources': ['/api/v1/health/sources'],
  '/api/v1/openapi.json': ['/api/v1/openapi.json'],
};
for (const route of getRoutes) {
  if (!(route in publicPaths)) {
    fail(`ROUTES holds ${route}, which this sweep does not know (public)`);
    continue;
  }
  const lenient = route.startsWith('/api/v1/series/');
  for (const path of publicPaths[route]) {
    const res = await publicGet(path, lenient ? [200, 404] : [200]);
    if (lenient && res.status === 200 && route === '/api/v1/series/:id') series200 += 1;
  }
}
if (series200 === 0) fail('public /api/v1/series/{id}: no public series answered 200');

// The owner canary's id and an unknown id: the same 404, byte for byte, on both routes.
for (const [label, mk] of [
  ['series', (id) => `/api/v1/series/${id}?${pspan}`],
  ['forecast', (id) => `/api/v1/series/${id}/forecast`],
]) {
  const canary = await publicGet(mk(canaryId), [404]);
  const unknown = await publicGet(mk(UNKNOWN_ID), [404]);
  if (!canary.body.equals(unknown.body))
    fail(`public ${label} of the canary id: the 404 body differs from an unknown id's`);
  for (const h of ['content-type', 'cache-control', 'vary', 'content-encoding', 'content-length', 'x-stale'])
    if (canary.headers[h] !== unknown.headers[h]) fail(`public ${label} of the canary id: the 404's ${h} differs`);
}

// Health: the owner sources only as a count; no owner source id anywhere in the two documents.
const health = await publicGet('/api/v1/health/sources');
const wholeWord = (id) => new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^A-Za-z0-9-])`);
const strings = [];
(function walk(x) {
  if (typeof x === 'string') strings.push(x);
  else if (Array.isArray(x)) x.forEach(walk);
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) {
      strings.push(k);
      walk(v);
    }
})(json(health));
const os = json(health).owner_sources;
if (
  !os ||
  Object.keys(os).sort().join() !== 'healthy,total' ||
  typeof os.healthy !== 'number' ||
  typeof os.total !== 'number'
)
  fail('public /api/v1/health/sources: owner_sources is not exactly two numbers (healthy, total)');
OWNER_IDS.forEach((id, i) => {
  if (strings.some((s) => wholeWord(id).test(s))) fail(`public /api/v1/health/sources: owner source #${i} named`);
});

// A beacon of each content type: 204 (the body is logged by the api, never stored).
const beacons = {
  'application/json': JSON.stringify({ kind: 'client_error', message: 'e2e', url: '/' }),
  'application/csp-report': JSON.stringify({
    'csp-report': { 'document-uri': `https://${domain}/`, 'violated-directive': 'script-src' },
  }),
  'application/reports+json': JSON.stringify([
    { type: 'csp-violation', age: 1, url: `https://${domain}/`, user_agent: 'e2e', body: { blockedURL: 'inline' } },
  ]),
};
for (const [type, body] of Object.entries(beacons)) {
  const res = await call('public', { method: 'POST', path: '/api/v1/beacon', headers: { 'content-type': type }, body });
  counts.public.bodies += 1;
  if (res.status !== 204) fail(`public POST /api/v1/beacon (${type}): HTTP ${res.status}`);
  if (res.body.length !== 0) fail(`public POST /api/v1/beacon (${type}): a body`);
}

// The static files: what meta.json lists or implies, and the status and crawler files.
const required = [
  'meta.json',
  'latest.json',
  'stations.json',
  'forecast/latest.json',
  'warnings/latest.geojson',
  'sources.json',
  'status.json',
];
const staticPaths = new Set(required);
staticPaths.add('frames/recent.json');
const bucket = floor(pnow);
for (let i = 0; i < 6; i++) {
  const t = new Date(bucket - i * BUCKET).toISOString();
  staticPaths.add(`recent/${t.slice(0, 10)}/${t.slice(11, 13)}${t.slice(14, 16)}.json`);
}
const staticMeta = json(await publicGet('/data/v1/meta.json'));
const staticStations = json(await publicGet('/data/v1/stations.json'));
for (const s of staticStations.stations.slice(0, 3)) staticPaths.add(`series/${s.id}/recent.json`);
staticPaths.add(`warnings/${iso(lo).slice(0, 10)}.json`);
for (const [day, v] of Object.entries(staticMeta.dayVersions ?? {})) {
  if (v < 1) continue;
  for (const hhmm of ['0000', '1200', '2350']) staticPaths.add(`settled/${day}/v${v}/${hhmm}.json`);
  staticPaths.add(`frames/${day}/v${v}.json`);
}
for (const p of staticPaths) await publicGet(`/data/v1/${p}`, required.includes(p) ? [200] : [200, 404]);
await publicGet('/status/capture.json', [200]);
await publicGet('/runtime-config.json', [200]);
for (const p of ['/robots.txt', '/sitemap.xml']) {
  const probe = await call('public', { path: p, headers: { 'accept-encoding': 'identity' } });
  if (probe.status === 200) await publicGet(p, [200]);
}

console.log(
  `public: ${counts.public.requests} requests (${counts.public.retried} retried after a 429), ${counts.public.bodies} bodies decoded, ` +
    `${terms.length} terms (value x2, station, source id, key, attribution text, clause, name), ` +
    `${failures.filter((f) => f.startsWith('public')).length} findings`,
);
console.log(
  `owner: ${counts.owner.requests} requests (${counts.owner.retried} retried), ${counts.owner.bodies} bodies, routes ${[...ownerSeen].length} of ${getRoutes.length}, ` +
    `${failures.filter((f) => f.startsWith('owner')).length} findings`,
);
if (failures.length > 0) {
  console.error(`api-sweep: ${failures.length} findings`);
  process.exit(1);
}
console.log('PASS api-sweep');
