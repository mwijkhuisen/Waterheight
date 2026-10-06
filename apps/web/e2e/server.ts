// The sandbox stand-in for Caddy (agent sessions have no Docker): HTTPS on
// https://localhost:4443 with a throw-away self-signed certificate, every
// response carrying the security headers read from deploy/web/site.caddy, and
// the routes of site.caddy: any method but GET and HEAD a 405 with Allow, on
// every path; (P4b) everything under /api/v1/ proxied to the e2e api
// (apps/server/test/e2e/api.ts on E2E_API_PORT, default 4480) with a 1 KB body
// limit, any other /api path a 404; the tiles with only one explicit range on a
// tile file, without If-Range, If-Match or If-Unmodified-Since (anything else is
// a 416); /status and /assets misses as 404s; and the pages with no-cache: a
// path with no file and no dot in its last segment answers /en/index.html under
// /en/, else /index.html. CI runs the same specs against the real Caddy image
// instead (.github/workflows/ci.yml job e2e).
// Owner mode (P10a, local runs of owner.spec.ts; CI uses the real deploy/web/owner.caddy): E2E_OWNER=1 with E2E_OWNER_PW
// (basic auth, user `owner`, on every path), E2E_OWNER_PUBLISH_DIR (the owner tree under /data/v1) and E2E_OWNER_API_PORT
// (default 4482): the headers of owner.caddy (Cache-Control "private, no-store" on every response, as its `defer`
// does), /runtime-config.json = owner, /api/v1 to the owner API.
// Usage: node e2e/server.ts   (from apps/web; E2E_PORT overrides 4443)
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { siteHeaders } from './headers.ts';
import { prepareRivers, prepareTiles } from './prepare-tiles.ts';

const port = Number(process.env.E2E_PORT ?? 4443);
const owner = process.env.E2E_OWNER === '1';
const apiPort = Number(owner ? (process.env.E2E_OWNER_API_PORT ?? 4482) : (process.env.E2E_API_PORT ?? 4480));
const ownerAuth = `Basic ${Buffer.from(`owner:${process.env.E2E_OWNER_PW ?? ''}`).toString('base64')}`;
if (owner && !process.env.E2E_OWNER_PW) throw new Error('E2E_OWNER=1 needs E2E_OWNER_PW');
const www = fileURLToPath(new URL('../dist-e2e/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rws-e2e-'));
const tiles = join(tmp, 'tiles');
prepareTiles(tiles);
const riversData = join(tmp, 'rivers');
const downloads = join(tmp, 'downloads');
prepareRivers(riversData, downloads);
execFileSync(
  'openssl',
  [
    ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1'],
    ...['-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
    ...['-keyout', join(tmp, 'key'), '-out', join(tmp, 'cert')],
  ],
  { stdio: 'ignore' },
);

// P9a: the publisher's output (apps/server/test/e2e/api.ts writes it before it listens): `v1/` is /data/v1/. CI's real
// Caddy serves the same directory (ci.yml job e2e); this stand-in serves any file of it with a short cache.
const published = join(
  (owner ? process.env.E2E_OWNER_PUBLISH_DIR : process.env.E2E_PUBLISH_DIR) ?? join(tmpdir(), 'rws-e2e-publish'),
  'v1',
);
const headers = siteHeaders(owner);
const TILE = /^\/tiles\/(basemap|planet-z6)-[0-9]{8}\.pmtiles$/;
/** site.caddy's @tiles_rivers (P6b): the same rule, its own matcher. */
const RIVER_TILE = /^\/tiles\/rivers-[0-9]{8}\.pmtiles$/;
const REACHES = /^\/data\/v1\/rivers\/reaches-[0-9]{8}\.json$/;
const DOWNLOAD = /^\/downloads\/rivers-[0-9]{8}\.geojson\.gz$/;
/** site.caddy's @one_range: a tile file is served only for this Range (SR-1)... */
const ONE_RANGE = /^bytes=[0-9]+-[0-9]+$/;
/** ...and only when none of these is there (SR2-1; an empty header counts as absent, as in Caddy and Go). */
const NO_CONDITION = ['if-range', 'if-match', 'if-unmodified-since'] as const;
/** The extensions Caddy's encode compresses (its default types: text, JSON, JavaScript, SVG; not the gzip files, PNGs or tiles). */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.geojson', '.svg', '.txt', '.md']);
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** site.caddy's catch-all: the pages, the app routes and their 404s and redirects are revalidated on every use. */
const NO_CACHE = 'no-cache';
/** site.caddy's @api: the path as sent, under /api/v1/, with no dot segment. */
const API = (path: string) => path.startsWith('/api/v1/') && !path.includes('/.');
const BODY_MAX = 1024;
/** site.caddy's @beacon (P9b): POST on exactly this path, a body of at most 8 KB. */
const BEACON = '/api/v1/beacon';
const BEACON_MAX = 8192;
/** Hop-by-hop and naming headers that Caddy's reverse_proxy does not pass on (A§12.2: no Server, no Via). */
const DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'server', 'via', 'date']);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, extra: Record<string, string | number> = {}, body = '') {
  res.writeHead(status, { ...extra, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** A file under `root` for a decoded URL path, or undefined (no traversal, no directories but their index.html). */
function file(root: string, urlPath: string): string | undefined {
  const rel = normalize(urlPath).replace(/^[/\\]+/, '');
  const path = join(root, rel.endsWith(sep) || rel === '' ? join(rel, 'index.html') : rel);
  const inside = relative(root, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function serve(res: ServerResponse, path: string, range: string | undefined, cache?: string) {
  const size = statSync(path).size;
  const base: Record<string, string | number> = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' };
  if (cache) base['cache-control'] = cache;
  const single = range === undefined ? null : /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
  if (single?.[1] !== undefined) {
    const start = Number(single[1]);
    const end = Math.min(single[2] ? Number(single[2]) : size - 1, size - 1);
    if (start > end) return send(res, 416, { 'content-range': `bytes */${size}` });
    res.writeHead(206, {
      ...base,
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  // site.caddy's `encode @compressible zstd gzip` (everything but /tiles): the text types, gzip only here, so the sizes a
  // browser (and Lighthouse's throttling model) sees are about those of production.
  if (COMPRESSIBLE.has(extname(path)) && /\bgzip\b/.test(String(res.req.headers['accept-encoding'] ?? ''))) {
    res.writeHead(200, { ...base, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
    createReadStream(path).pipe(createGzip()).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, 'accept-ranges': 'bytes', 'content-length': size });
  createReadStream(path).pipe(res);
}

/**
 * A request to the e2e api, as Caddy's reverse_proxy does: GET and HEAD (body cap 1 KB) and the beacon's POST (8 KB,
 * its body and type passed on); `X-Rws-Client` is the TCP peer, never a client's value (P9b); the site headers stay on
 * top.
 */
function proxy(req: IncomingMessage, res: ServerResponse, max = BODY_MAX) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= max) chunks.push(c);
  });
  req.on('end', () => {
    if (size > max) return send(res, 413);
    const body = Buffer.concat(chunks);
    const type = req.headers['content-type'];
    const up = httpRequest(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: req.method,
        path: req.url,
        headers: {
          accept: req.headers.accept ?? '*/*',
          'x-rws-client': req.socket.remoteAddress ?? '',
          ...(req.method === 'POST' ? { 'content-length': String(body.length) } : {}),
          ...(req.method === 'POST' && type !== undefined ? { 'content-type': type } : {}),
        },
      },
      (answer) => {
        for (const [name, value] of Object.entries(answer.headers))
          if (value !== undefined && !DROP.has(name) && !res.hasHeader(name)) res.setHeader(name, value);
        res.writeHead(answer.statusCode ?? 502);
        answer.pipe(res);
      },
    );
    up.on('error', () => send(res, 502));
    up.end(req.method === 'POST' ? body : undefined);
  });
}

const server = createServer(
  { key: readFileSync(join(tmp, 'key')), cert: readFileSync(join(tmp, 'cert')) },
  (req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    if (owner) {
      // owner.caddy's `defer`: whatever a route sets, the answer is private, no-store.
      const writeHead = res.writeHead.bind(res) as (status: number, extra?: Record<string, unknown>) => ServerResponse;
      res.writeHead = ((status: number, extra?: Record<string, unknown>) => {
        res.setHeader('cache-control', 'private, no-store');
        if (extra !== undefined) delete extra['cache-control'];
        return writeHead(status, extra);
      }) as ServerResponse['writeHead'];
      // basic_auth at site level: every path, the 401 included (WWW-Authenticate asks the browser's credentials).
      if (req.headers.authorization !== ownerAuth) return send(res, 401, { 'www-authenticate': 'Basic realm="owner"' });
    }
    // The path as Caddy matches it: percent-decoded (Go answers a malformed escape with 400 before any route).
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'https://localhost').pathname);
    } catch {
      return send(res, 400);
    }
    // Node joins repeated Range fields with ", ", as Caddy's placeholder joins them with ",": either fails ONE_RANGE.
    const range = req.headers.range;
    // site.caddy's @beacon, then its @write, before every route (the beacon's path as sent, case and all).
    if (req.method === 'POST' && new URL(req.url ?? '/', 'https://localhost').pathname === BEACON)
      return proxy(req, res, BEACON_MAX);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { allow: 'GET, HEAD' });
    if (API(path)) return proxy(req, res);
    if (/^\/api(\/|$)/i.test(path)) return send(res, 404);
    if (path === '/healthz') return send(res, 200);
    if (path === '/status' || path.startsWith('/status/')) return send(res, 404);
    if (path === '/tiles/manifest.json')
      return serve(res, join(tiles, 'manifest.json'), undefined, 'public, max-age=60');
    if (TILE.test(path) || RIVER_TILE.test(path)) {
      // The overlay is served from the rivers directory (root-owned), the basemap from the tiles directory.
      const tile = file(RIVER_TILE.test(path) ? riversData : tiles, path.slice('/tiles'.length));
      if (tile === undefined) return send(res, 404);
      const one = ONE_RANGE.test(range ?? '') && NO_CONDITION.every((h) => !req.headers[h]);
      return one ? serve(res, tile, range, IMMUTABLE) : send(res, 416);
    }
    if (path === '/tiles' || path.startsWith('/tiles/')) return send(res, 404);
    // P6b: the river data (site.caddy's @rivers_*): exact names, a missing file or anything else a bare 404.
    if (path === '/data/v1/rivers/manifest.json')
      return serve(res, join(riversData, 'manifest.json'), undefined, 'public, max-age=60');
    if (REACHES.test(path)) {
      const f = file(riversData, path.slice('/data/v1/rivers'.length));
      return f === undefined ? send(res, 404) : serve(res, f, range, IMMUTABLE);
    }
    if (/^\/data\/v1\/rivers(\/|$)/.test(path)) return send(res, 404);
    if (path === '/runtime-config.json')
      return send(
        res,
        200,
        { 'content-type': 'application/json', 'cache-control': NO_CACHE },
        owner ? '{"audience":"owner"}' : '{"audience":"public"}',
      );
    if (path.startsWith('/data/v1/')) {
      const f = /\/\./.test(path) ? undefined : file(published, path.slice('/data/v1'.length));
      return f === undefined ? send(res, 404) : serve(res, f, range, 'public, max-age=60');
    }
    if (DOWNLOAD.test(path)) {
      const f = file(downloads, path.slice('/downloads'.length));
      return f === undefined ? send(res, 404) : serve(res, f, range, IMMUTABLE);
    }
    if (/^\/downloads(\/|$)/.test(path)) return send(res, 404);
    const asset = file(www, path);
    if (path === '/assets' || path.startsWith('/assets/'))
      return asset === undefined ? send(res, 404) : serve(res, asset, range, IMMUTABLE);
    if (/\/\./.test(path)) return send(res, 404);
    if (asset !== undefined) return serve(res, asset, range, NO_CACHE);
    // A directory without its slash: file_server's redirect (/en → /en/).
    if (!path.endsWith('/') && file(www, `${path}/`) !== undefined)
      return send(res, 308, { location: `${path}/`, 'cache-control': NO_CACHE });
    // An app route: no file, no dot in the last segment (site.caddy's @app_en and @app).
    if (/\.[^/]*$/.test(path)) return send(res, 404, { 'cache-control': NO_CACHE });
    return serve(res, join(www, path.startsWith('/en/') ? 'en/index.html' : 'index.html'), undefined, NO_CACHE);
  },
);

server.listen(port, '127.0.0.1', () => console.log(`e2e server on https://localhost:${port}`));
const stop = () => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
