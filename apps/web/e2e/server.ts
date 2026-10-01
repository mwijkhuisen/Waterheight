// The sandbox stand-in for Caddy (agent sessions have no Docker): HTTPS on
// https://localhost:4443 with a throw-away self-signed certificate, every
// response carrying the security headers read from deploy/web/site.caddy, the
// routes of site.caddy that the spike uses, and single-range requests on the
// tiles. CI runs the same specs against the real Caddy image instead
// (.github/workflows/ci.yml job e2e).
// Usage: node e2e/server.ts   (from apps/web; E2E_PORT overrides 4443)
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteHeaders } from './headers.ts';
import { prepareTiles } from './prepare-tiles.ts';

const port = Number(process.env.E2E_PORT ?? 4443);
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
const IMMUTABLE = 'public, max-age=31536000, immutable';
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

/** A file under `root`, or undefined (no traversal, no directories but their index.html). */
function file(root: string, urlPath: string): string | undefined {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, '');
  const path = join(root, rel.endsWith(sep) || rel === '' ? join(rel, 'index.html') : rel);
  if (!path.startsWith(root)) return undefined;
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

const server = createServer(
  { key: readFileSync(join(tmp, 'key')), cert: readFileSync(join(tmp, 'cert')) },
  (req, res) => {
    for (const [name, value] of headers) res.setHeader(name, value);
    const path = new URL(req.url ?? '/', 'https://localhost').pathname;
    const range = req.headers.range;
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);
    if (path === '/healthz') return send(res, 200);
    if (path === '/tiles/manifest.json')
      return serve(res, join(tiles, 'manifest.json'), undefined, 'public, max-age=60');
    if (TILE.test(path)) {
      const tile = file(tiles, path.slice('/tiles'.length));
      return tile ? serve(res, tile, range, IMMUTABLE) : send(res, 404);
    }
    if (path.startsWith('/tiles/')) return send(res, 404);
    const asset = file(www, path);
    if (asset === undefined) return send(res, 404);
    return serve(res, asset, range, path.startsWith('/assets/') ? IMMUTABLE : undefined);
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
