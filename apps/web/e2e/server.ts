// The sandbox stand-in for Caddy (agent sessions have no Docker): HTTPS on
// https://localhost:4443 with a throw-away self-signed certificate, every
// response carrying the security headers read from deploy/web/site.caddy, and
// the routes of site.caddy: (P4b) GET and HEAD under /api/v1/ proxied to the
// e2e api (apps/server/test/e2e/api.ts on E2E_API_PORT, default 4480) with a
// 1 KB body limit, another method a 405, any other /api path a 404; the tiles
// with only one explicit range on a tile file, without If-Range, If-Match or
// If-Unmodified-Since (anything else is a 416); /status and /assets misses as
// 404s; and the app routes: a path with no file and no dot in its last segment
// answers /en/index.html under /en/, else /index.html. CI runs the same specs
// against the real Caddy image instead (.github/workflows/ci.yml job e2e).
// Usage: node e2e/server.ts   (from apps/web; E2E_PORT overrides 4443)
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteHeaders } from './headers.ts';
import { prepareTiles } from './prepare-tiles.ts';

const port = Number(process.env.E2E_PORT ?? 4443);
const apiPort = Number(process.env.E2E_API_PORT ?? 4480);
const www = fileURLToPath(new URL('../dist-e2e/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rws-e2e-'));
const tiles = join(tmp, 'tiles');
prepareTiles(tiles);
execFileSync(
  'openssl',
  [
    ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1'],
    ...['-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
    ...['-keyout', join(tmp, 'key'), '-out', join(tmp, 'cert')],
  ],
  { stdio: 'ignore' },
);

const headers = siteHeaders();
const TILE = /^\/tiles\/(basemap|planet-z6)-[0-9]{8}\.pmtiles$/;
/** site.caddy's @one_range: a tile file is served only for this Range (SR-1)... */
const ONE_RANGE = /^bytes=[0-9]+-[0-9]+$/;
/** ...and only when none of these is there (SR2-1; an empty header counts as absent, as in Caddy and Go). */
const NO_CONDITION = ['if-range', 'if-match', 'if-unmodified-since'] as const;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** site.caddy's @api: the path as sent, under /api/v1/, with no dot segment. */
const API = (path: string) => path.startsWith('/api/v1/') && !path.includes('/.');
const BODY_MAX = 1024;
/** Hop-by-hop and naming headers that Caddy's reverse_proxy does not pass on (A§12.2: no Server, no Via). */
const DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'server', 'via', 'date']);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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
  res.writeHead(200, { ...base, 'accept-ranges': 'bytes', 'content-length': size });
  createReadStream(path).pipe(res);
}

/** GET or HEAD to the e2e api, as Caddy's reverse_proxy does; the site headers stay on top. */
function proxy(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= BODY_MAX) chunks.push(c);
  });
  req.on('end', () => {
    if (size > BODY_MAX) return send(res, 413);
    const up = httpRequest(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: req.method,
        path: req.url,
        headers: { accept: req.headers.accept ?? '*/*' },
      },
      (answer) => {
        for (const [name, value] of Object.entries(answer.headers))
          if (value !== undefined && !DROP.has(name) && !res.hasHeader(name)) res.setHeader(name, value);
        res.writeHead(answer.statusCode ?? 502);
        answer.pipe(res);
      },
    );
    up.on('error', () => send(res, 502));
    up.end();
  });
}

const server = createServer(
  { key: readFileSync(join(tmp, 'key')), cert: readFileSync(join(tmp, 'cert')) },
  (req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    // The path as Caddy matches it: percent-decoded (Go answers a malformed escape with 400 before any route).
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'https://localhost').pathname);
    } catch {
      return send(res, 400);
    }
    // Node joins repeated Range fields with ", ", as Caddy's placeholder joins them with ",": either fails ONE_RANGE.
    const range = req.headers.range;
    if ((req.method === 'GET' || req.method === 'HEAD') && API(path)) return proxy(req, res);
    if (/^\/api\/v1\//i.test(path) && req.method !== 'GET' && req.method !== 'HEAD')
      return send(res, 405, { allow: 'GET, HEAD' });
    if (/^\/api(\/|$)/i.test(path)) return send(res, 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);
    if (path === '/healthz') return send(res, 200);
    if (path === '/status' || path.startsWith('/status/')) return send(res, 404);
    if (path === '/tiles/manifest.json')
      return serve(res, join(tiles, 'manifest.json'), undefined, 'public, max-age=60');
    if (TILE.test(path)) {
      const tile = file(tiles, path.slice('/tiles'.length));
      if (tile === undefined) return send(res, 404);
      const one = ONE_RANGE.test(range ?? '') && NO_CONDITION.every((h) => !req.headers[h]);
      return one ? serve(res, tile, range, IMMUTABLE) : send(res, 416);
    }
    if (path === '/tiles' || path.startsWith('/tiles/')) return send(res, 404);
    const asset = file(www, path);
    if (path === '/assets' || path.startsWith('/assets/'))
      return asset === undefined ? send(res, 404) : serve(res, asset, range, IMMUTABLE);
    if (/\/\./.test(path)) return send(res, 404);
    if (asset !== undefined) return serve(res, asset, range);
    // A directory without its slash: file_server's redirect (/en → /en/).
    if (!path.endsWith('/') && file(www, `${path}/`) !== undefined) return send(res, 308, { location: `${path}/` });
    // An app route: no file, no dot in the last segment (site.caddy's @app_en and @app).
    if (/\.[^/]*$/.test(path)) return send(res, 404);
    return serve(res, join(www, path.startsWith('/en/') ? 'en/index.html' : 'index.html'), undefined);
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
