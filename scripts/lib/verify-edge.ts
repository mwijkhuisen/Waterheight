// verify-prod group "edge" (issue #109; only with --edge cloudflare). The site sits behind a Cloudflare Tunnel:
// Cloudflare terminates TLS and could add headers, scripts, cookies or cache entries that the origin never sends. These
// checks read the public responses and fail on the drift (a dashboard setting turned on): a header the browser would
// act on (NEL, Report-To, Set-Cookie, Speculation-Rules: invariant 7), an injected script, a tile range that does not
// come back as the origin sends it, or a cache HIT on a route that must never be cached. Pure classifiers plus one runner
// whose I/O is injected (verify-prod.ts wires the network). Failures name a header or a needle, never a value.

import type { Page, Result } from '../verify-prod.ts';

const pass = (check: string, detail: string): Result => ({ check, ok: true, detail });
const fail = (check: string, detail: string): Result => ({ check, ok: false, detail });
const na = (check: string, detail: string): Result => ({ check, ok: 'n/a', detail });

/** Headers the edge must not add to a page (Node lower-cases the names). */
export const EDGE_FORBIDDEN_HEADERS = ['nel', 'report-to', 'set-cookie', 'speculation-rules'] as const;
/** Strings an edge feature injects into HTML (Rocket Loader, analytics, e-mail obfuscation, bot challenge). */
export const EDGE_HTML_NEEDLES = [
  '/cdn-cgi/',
  'cloudflareinsights',
  'rocket-loader',
  'email-decode',
  'challenge-platform',
  '__cf_bm',
  'beacon.min.js',
] as const;
/** Routes that must never be a cache HIT at the edge (dynamic JSON and status files). */
export const EDGE_UNCACHED_PATHS = ['/api/v1/health', '/api/v1/meta', '/status/capture.json'] as const;
/** A path under /data/ that does not exist: its 404 has no Cache-Control and must never be cached. */
export const EDGE_MISSING_PATH = '/data/v1/rws-verify-no-file.json';
export const EDGE_PAGES = ['/', '/en/'] as const;
export const EDGE_TILE_RANGE = 'bytes=0-1023';

const isHit = (p: Page) => (p.headers['cf-cache-status'] ?? '').trim().toLowerCase() === 'hit';

/** `edge headers <path>`: none of EDGE_FORBIDDEN_HEADERS. */
export function classifyEdgeHeaders(path: string, page: Page | string): Result {
  const check = `edge headers ${path}`;
  if (typeof page === 'string') return fail(check, page);
  const found = EDGE_FORBIDDEN_HEADERS.filter((h) => page.headers[h] !== undefined);
  return found.length === 0
    ? pass(check, `none of ${EDGE_FORBIDDEN_HEADERS.join(', ')}`)
    : fail(check, `the edge added ${found.join(', ')}`);
}

/** `edge html <path>`: none of EDGE_HTML_NEEDLES in the body. */
export function classifyEdgeHtml(path: string, page: Page | string): Result {
  const check = `edge html ${path}`;
  if (typeof page === 'string') return fail(check, page);
  const body = page.body.toLowerCase();
  const found = EDGE_HTML_NEEDLES.filter((n) => body.includes(n));
  return found.length === 0
    ? pass(check, 'no injected edge script or marker')
    : fail(check, `the body holds ${found.join(', ')}`);
}

/** `edge tile range`: two Range reads of the current tile file come back 206, `bytes 0-1023/<size>`, 1024 bytes. */
export function classifyTileRange(file: { file: string; bytes: number } | undefined, pages: (Page | string)[]): Result {
  const check = 'edge tile range';
  if (file === undefined) return na(check, 'no usable tiles manifest yet');
  if (file.bytes <= 1023) return fail(check, 'the manifest lists a file of 1023 bytes or less');
  const problems: string[] = [];
  for (const [i, p] of pages.entries()) {
    if (typeof p === 'string') {
      problems.push(`read ${i + 1}: ${p}`);
      continue;
    }
    if (p.status !== 206) problems.push(`read ${i + 1}: status ${p.status}, want 206`);
    if (p.headers['content-range'] !== `bytes 0-1023/${file.bytes}`)
      problems.push(`read ${i + 1}: content-range ${JSON.stringify(p.headers['content-range'] ?? null)}`);
    const n = p.bytes?.length ?? Buffer.byteLength(p.body);
    if (n !== 1024) problems.push(`read ${i + 1}: ${n} bytes, want 1024`);
  }
  return problems.length === 0
    ? pass(check, `${file.file}: twice 206, bytes 0-1023/${file.bytes}, 1024 bytes`)
    : fail(check, problems.join('; '));
}

/** `edge not cached <label>`: no answer is a cache HIT; with `want404` every answer is a 404 too. */
export function classifyNotCached(label: string, pages: (Page | string)[], want404 = false): Result {
  const check = `edge not cached ${label}`;
  const problems: string[] = [];
  for (const [i, p] of pages.entries()) {
    if (typeof p === 'string') {
      problems.push(`read ${i + 1}: ${p}`);
      continue;
    }
    if (isHit(p)) problems.push(`read ${i + 1}: cf-cache-status HIT`);
    if (want404 && p.status !== 404) problems.push(`read ${i + 1}: status ${p.status}, want 404`);
  }
  return problems.length === 0
    ? pass(check, `${pages.length} reads, never a cache HIT${want404 ? ', 404 each time' : ''}`)
    : fail(check, problems.join('; '));
}

/** `edge runtime config cdn`: /runtime-config.json parses and names the CDN (the operator's name is never read here). */
export function classifyEdgeCdn(page: Page | string): Result {
  const check = 'edge runtime config cdn';
  if (typeof page === 'string') return fail(check, page);
  if (page.status !== 200) return fail(check, `status ${page.status}`);
  let cdn: unknown;
  try {
    cdn = (JSON.parse(page.body) as { cdn?: unknown } | null)?.cdn;
  } catch {
    return fail(check, 'not JSON');
  }
  return typeof cdn === 'string' && cdn.trim().length > 0
    ? pass(check, `cdn ${JSON.stringify(cdn)}`)
    : fail(check, 'cdn is empty or not a text: the privacy page would say "no CDN"');
}

export type EdgeIo = {
  get: (path: string, headers?: Readonly<Record<string, string>>) => Promise<Page | string>;
};

/** The whole group. `tile` is the current basemap file of the tiles manifest, undefined when there is none yet. */
export async function checkEdge(io: EdgeIo, tile: { file: string; bytes: number } | undefined): Promise<Result[]> {
  const out: Result[] = [];
  const pages = [];
  for (const path of EDGE_PAGES) pages.push([path, await io.get(path)] as const);
  for (const [path, page] of pages) out.push(classifyEdgeHeaders(path, page));
  for (const [path, page] of pages) out.push(classifyEdgeHtml(path, page));
  const reads: (Page | string)[] = [];
  if (tile !== undefined)
    for (let i = 0; i < 2; i += 1)
      reads.push(await io.get(`/tiles/${tile.file}`, { range: EDGE_TILE_RANGE, 'accept-encoding': 'gzip, zstd' }));
  out.push(classifyTileRange(tile, reads));
  for (const path of EDGE_UNCACHED_PATHS) out.push(classifyNotCached(path, [await io.get(path), await io.get(path)]));
  out.push(classifyNotCached('404', [await io.get(EDGE_MISSING_PATH), await io.get(EDGE_MISSING_PATH)], true));
  out.push(classifyEdgeCdn(await io.get('/runtime-config.json')));
  return out;
}
