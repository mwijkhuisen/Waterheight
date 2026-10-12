import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkEdge,
  classifyEdgeCdn,
  classifyEdgeHeaders,
  classifyEdgeHtml,
  classifyNotCached,
  classifyTileRange,
  EDGE_MISSING_ASSET,
  EDGE_MISSING_PATH,
} from '../scripts/lib/verify-edge.ts';
import {
  checkOwnerListener,
  classifyEdge,
  type Io,
  type Probe,
  parseProbeHead,
} from '../scripts/lib/verify-owner-listener.ts';
import { CHECKS, checkHeaders, checkNotFound, checkPages, PAGE_PATHS, type Page } from '../scripts/verify-prod.ts';

// Issue #109: the site behind a Cloudflare Tunnel (`--edge cloudflare`).

const repoRoot = join(import.meta.dirname, '..');
const page = (over: Partial<Page> = {}): Page => ({ status: 200, headers: {}, body: '', ...over });
const tile = { file: 'basemap-20261001.pmtiles', bytes: 5_000_000 };
const range = (over: Partial<Page> = {}): Page =>
  page({
    status: 206,
    headers: { 'content-range': `bytes 0-1023/${tile.bytes}` },
    bytes: Buffer.alloc(1024),
    ...over,
  });

describe('edge headers', () => {
  it('passes a page without the edge headers', () => {
    expect(classifyEdgeHeaders('/', page({ headers: { server: 'cloudflare', 'cf-ray': 'x' } })).ok).toBe(true);
  });
  it('fails NEL, Report-To, Set-Cookie and Speculation-Rules and names the header, never its value', () => {
    for (const h of ['nel', 'report-to', 'set-cookie', 'speculation-rules']) {
      const r = classifyEdgeHeaders('/en/', page({ headers: { [h]: 'secret-value' } }));
      expect(r.ok, h).toBe(false);
      expect(r.check).toBe('edge headers /en/');
      expect(r.detail).toContain(h);
      expect(r.detail).not.toContain('secret-value');
    }
  });
  it('fails a network error', () => {
    expect(classifyEdgeHeaders('/', 'timeout').ok).toBe(false);
  });
});

describe('edge html', () => {
  it('passes clean HTML', () => {
    expect(classifyEdgeHtml('/', page({ body: '<html><script src="/assets/index-abc.js"></script></html>' })).ok).toBe(
      true,
    );
  });
  it('fails each injected marker and names it', () => {
    for (const n of [
      '/cdn-cgi/',
      'cloudflareinsights',
      'rocket-loader',
      'email-decode',
      'challenge-platform',
      '__cf_bm',
      'beacon.min.js',
    ]) {
      const r = classifyEdgeHtml('/', page({ body: `<script src="https://x/${n.toUpperCase()}x.js"></script>` }));
      expect(r.ok, n).toBe(false);
      expect(r.detail, n).toContain(n);
    }
  });
});

describe('edge tile range', () => {
  it('passes two correct 206 reads', () => {
    expect(classifyTileRange(tile, [range(), range()]).ok).toBe(true);
  });
  it('is n/a without a manifest file', () => {
    expect(classifyTileRange(undefined, []).ok).toBe('n/a');
  });
  it('fails a 200 instead of a 206 (the edge dropped the Range)', () => {
    expect(classifyTileRange(tile, [range(), range({ status: 200 })]).ok).toBe(false);
  });
  it('fails a wrong Content-Range, a missing one and a wrong body size', () => {
    expect(classifyTileRange(tile, [range({ headers: { 'content-range': 'bytes 0-1023/9' } }), range()]).ok).toBe(
      false,
    );
    expect(classifyTileRange(tile, [range({ headers: {} }), range()]).ok).toBe(false);
    expect(classifyTileRange(tile, [range(), range({ bytes: Buffer.alloc(16) })]).ok).toBe(false);
  });
  it('fails a file of 1023 bytes or less and a network error', () => {
    expect(classifyTileRange({ file: tile.file, bytes: 1023 }, [range(), range()]).ok).toBe(false);
    expect(classifyTileRange(tile, [range(), 'timeout']).ok).toBe(false);
  });
});

describe('edge not cached', () => {
  const dynamic = page({ headers: { 'cf-cache-status': 'DYNAMIC' } });
  it('passes DYNAMIC, BYPASS and an absent header', () => {
    for (const v of ['DYNAMIC', 'BYPASS', 'bypass', undefined])
      expect(
        classifyNotCached('/api/v1/health', [page({ headers: { 'cf-cache-status': v } }), dynamic]).ok,
        `${v}`,
      ).toBe(true);
  });
  // #109 review S3: MISS, EXPIRED, STALE, UPDATING and REVALIDATED mean Cloudflare held the answer as cacheable.
  it('fails any cacheable status on either read, in any case', () => {
    for (const v of ['HIT', 'hit', ' Hit ', 'MISS', 'EXPIRED', 'STALE', 'UPDATING', 'REVALIDATED', 'NONE'])
      for (const pages of [
        [page({ headers: { 'cf-cache-status': v } }), dynamic],
        [dynamic, page({ headers: { 'cf-cache-status': v } })],
      ]) {
        const r = classifyNotCached('/api/v1/health', pages);
        expect(r.ok, v).toBe(false);
        expect(r.check).toBe('edge not cached /api/v1/health');
      }
  });
  it('the 404 case wants a 404 every time and never a HIT', () => {
    const nf = page({ status: 404 });
    expect(classifyNotCached('404', [nf, nf], true).ok).toBe(true);
    expect(classifyNotCached('404', [nf, page({ status: 200 })], true).ok).toBe(false);
    expect(classifyNotCached('404', [nf, page({ status: 404, headers: { 'cf-cache-status': 'HIT' } })], true).ok).toBe(
      false,
    );
    expect(classifyNotCached('404', [nf, 'timeout'], true).ok).toBe(false);
  });
});

describe('edge runtime config cdn', () => {
  const cfg = (cdn: unknown, over: Partial<Page> = {}) =>
    page({ body: JSON.stringify({ audience: 'public', cdn }), ...over });
  it('passes a named CDN and prints it', () => {
    const r = classifyEdgeCdn(cfg('Cloudflare'));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Cloudflare');
  });
  it('fails an empty, missing or non-text cdn, bad JSON and a bad status', () => {
    expect(classifyEdgeCdn(cfg('')).ok).toBe(false);
    // Review round 2: only the exact name selects the Cloudflare privacy text (Cdn.tsx).
    for (const name of ['cloudflare', 'Cloudflare, Inc.', 'Cloudflare ', 'Example CDN'])
      expect(classifyEdgeCdn(cfg(name)).ok, name).toBe(false);
    expect(classifyEdgeCdn(cfg('  ')).ok).toBe(false);
    expect(classifyEdgeCdn(cfg(undefined)).ok).toBe(false);
    expect(classifyEdgeCdn(cfg(7)).ok).toBe(false);
    expect(classifyEdgeCdn(page({ body: 'nope' })).ok).toBe(false);
    expect(classifyEdgeCdn(cfg('Cloudflare', { status: 404 })).ok).toBe(false);
  });
  it('never prints the operator', () => {
    const r = classifyEdgeCdn(page({ body: JSON.stringify({ cdn: '', operator: 'Jan Jansen' }) }));
    expect(r.detail).not.toContain('Jan');
  });
});

describe('checkEdge', () => {
  const clean = (path: string, headers?: Readonly<Record<string, string>>): Page => {
    if (headers?.range !== undefined) return range();
    if (path === '/runtime-config.json') return page({ body: JSON.stringify({ cdn: 'Cloudflare' }) });
    if (path === EDGE_MISSING_PATH || path === EDGE_MISSING_ASSET) return page({ status: 404 });
    return page({ headers: { 'cf-cache-status': 'DYNAMIC' }, body: '<html></html>' });
  };
  const run = (get: (path: string, headers?: Readonly<Record<string, string>>) => Page | string) =>
    checkEdge({ get: async (p, h) => get(p, h) }, tile);

  it('runs the whole group, every check name starting with "edge "', async () => {
    const r = await run(clean);
    expect(r.every((x) => x.check.startsWith('edge '))).toBe(true);
    expect(r.map((x) => x.check)).toEqual([
      'edge headers /',
      'edge headers /en/',
      'edge html /',
      'edge html /en/',
      'edge tile range',
      'edge not cached /api/v1/health',
      'edge not cached /api/v1/meta',
      'edge not cached /status/capture.json',
      'edge not cached 404',
      'edge not cached 404 /assets',
      'edge runtime config cdn',
    ]);
    expect(r.filter((x) => x.ok !== true)).toEqual([]);
  });
  it('asks the tile with Range bytes=0-1023, twice, and each other route twice', async () => {
    const seen: string[] = [];
    await run((p, h) => {
      seen.push(`${p}|${h?.range ?? ''}`);
      return clean(p, h);
    });
    expect(seen.filter((s) => s === `/tiles/${tile.file}|bytes=0-1023`)).toHaveLength(2);
    expect(seen.filter((s) => s.startsWith('/api/v1/health|'))).toHaveLength(2);
    expect(seen.filter((s) => s.startsWith(`${EDGE_MISSING_PATH}|`))).toHaveLength(2);
    expect(seen.filter((s) => s.startsWith(`${EDGE_MISSING_ASSET}|`))).toHaveLength(2);
  });
  it('fails the check that sees the drift and only that one', async () => {
    const bad = async (over: (p: string, h?: Readonly<Record<string, string>>) => Page | undefined) =>
      (await run((p, h) => over(p, h) ?? clean(p, h))).filter((x) => x.ok === false).map((x) => x.check);
    expect(await bad((p) => (p === '/' ? page({ headers: { nel: '{}' } }) : undefined))).toEqual(['edge headers /']);
    expect(await bad((p) => (p === '/en/' ? page({ headers: { 'set-cookie': '__cf_bm=1' } }) : undefined))).toEqual([
      'edge headers /en/',
    ]);
    expect(await bad((p) => (p === '/en/' ? page({ body: '<script src="/cdn-cgi/x.js">' }) : undefined))).toEqual([
      'edge html /en/',
    ]);
    expect(await bad((_p, h) => (h?.range ? range({ status: 200 }) : undefined))).toEqual(['edge tile range']);
    expect(
      await bad((p) => (p === '/api/v1/health' ? page({ headers: { 'cf-cache-status': 'HIT' } }) : undefined)),
    ).toEqual(['edge not cached /api/v1/health']);
    expect(
      await bad((p) =>
        p === EDGE_MISSING_ASSET ? page({ status: 404, headers: { 'cf-cache-status': 'MISS' } }) : undefined,
      ),
    ).toEqual(['edge not cached 404 /assets']);
    expect(await bad((p) => (p === '/runtime-config.json' ? page({ body: '{"cdn":""}' }) : undefined))).toEqual([
      'edge runtime config cdn',
    ]);
  });
  it('is n/a for the tile when there is no manifest file yet, and asks no tile', async () => {
    const seen: string[] = [];
    const r = await checkEdge(
      {
        get: async (p, h) => {
          seen.push(p);
          return clean(p, h);
        },
      },
      undefined,
    );
    expect(r.find((x) => x.check === 'edge tile range')?.ok).toBe('n/a');
    expect(seen.some((p) => p.startsWith('/tiles/'))).toBe(false);
  });
});

describe('headers: Server', () => {
  const expected = { 'x-content-type-options': 'nosniff' };
  const h = (server?: string) => ({ 'x-content-type-options': 'nosniff', ...(server === undefined ? {} : { server }) });
  it('direct mode still fails `Server: cloudflare`, with the same text as before', () => {
    const r = checkHeaders('/', 200, h('cloudflare'), expected);
    expect(r).toMatchObject({ check: 'headers /', ok: false, detail: 'server: "cloudflare"' });
    expect(checkHeaders('/', 200, h('cloudflare'), expected, 200, 'direct')).toEqual(r);
  });
  it('cloudflare mode accepts exactly `cloudflare`, or none, and nothing else', () => {
    expect(checkHeaders('/', 200, h('cloudflare'), expected, 200, 'cloudflare').ok).toBe(true);
    expect(checkHeaders('/', 200, h(), expected, 200, 'cloudflare').ok).toBe(true);
    for (const s of ['nginx', 'Cloudflare', 'cloudflare-nginx', 'Caddy', ''])
      expect(checkHeaders('/', 200, h(s), expected, 200, 'cloudflare').ok, s).toBe(false);
  });
  it('other rules are unchanged in cloudflare mode', () => {
    expect(checkHeaders('/', 200, { server: 'cloudflare' }, expected, 200, 'cloudflare').ok).toBe(false);
    expect(
      checkHeaders('/', 200, { ...h('cloudflare'), 'access-control-allow-origin': '*' }, expected, 200, 'cloudflare')
        .ok,
    ).toBe(false);
    expect(checkHeaders('/', 500, h(), expected, 200, 'cloudflare').ok).toBe(false);
  });
  it('the pages and not found checks pass the edge on', () => {
    const got: Record<string, Page> = {};
    for (const { path, lang } of PAGE_PATHS)
      got[path] = page({
        headers: { ...expected, server: 'cloudflare', 'cache-control': 'no-cache' },
        body: `<html lang="${lang}">`,
      });
    expect(checkPages(got, expected).every((x) => x.ok === false)).toBe(true);
    expect(checkPages(got, expected, 'cloudflare').every((x) => x.ok === true)).toBe(true);
    const nf = (lang: string) =>
      page({
        status: 404,
        headers: { ...expected, 'x-robots-tag': 'noindex', server: 'cloudflare', 'cache-control': 'no-cache' },
        body: `<html lang="${lang}">`,
      });
    const found = { '/rws-verify-geen-pagina': nf('nl'), '/en/rws-verify-no-page': nf('en') };
    const shell = { ...expected, 'x-robots-tag': 'noindex' };
    expect(checkNotFound(found, shell).ok).toBe(false);
    expect(checkNotFound(found, shell, 'cloudflare').ok).toBe(true);
  });
});

describe('owner listener through the edge', () => {
  const addr = '104.21.0.1';
  const answered = (status: number, over: Partial<Extract<Probe, { kind: 'answered' }>> = {}): Probe => ({
    kind: 'answered',
    status,
    wwwAuthenticate: false,
    ...over,
  });
  it('passes handshake failures, refusals, timeouts, certificate errors and CDN error pages', () => {
    for (const p of [
      { kind: 'handshake-failed' },
      { kind: 'refused' },
      { kind: 'timeout' },
      { kind: 'certificate' },
      answered(403),
      answered(404),
      answered(409),
      answered(421),
      answered(530),
    ] satisfies Probe[])
      for (const port of [443, 8443] as const) {
        const r = classifyEdge(port, addr, p);
        expect(r.ok, `${port} ${JSON.stringify(p)}`).toBe(true);
        expect(r.check).toBe(`owner listener ${port} ${addr}`);
      }
  });
  it('fails our owner site answering through the edge: 200, 401, a challenge, owner headers', () => {
    for (const p of [
      answered(200),
      answered(401),
      answered(403, { wwwAuthenticate: true }),
      answered(403, { ownerHeaders: true }),
      answered(404, { ownerHeaders: true }),
    ])
      for (const port of [443, 8443] as const)
        expect(classifyEdge(port, addr, p).ok, `${port} ${JSON.stringify(p)}`).toBe(false);
  });
  // #109 review C2/S1: Cloudflare's own error pages carry Cache-Control: private, …; only the owner site's exact
  // values count as owner headers, read from the answer as it comes off the wire.
  it('parses a Cloudflare error page as no owner sign, and the owner site by its exact headers', () => {
    const cloudflare = parseProbeHead(
      [
        'HTTP/1.1 530 <none>',
        'Date: Mon, 12 Oct 2026 12:00:00 GMT',
        'Content-Type: text/html; charset=UTF-8',
        'Cache-Control: private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0',
        'X-Frame-Options: SAMEORIGIN',
        'Referrer-Policy: same-origin',
        'Server: cloudflare',
        'CF-RAY: 0123456789abcdef-AMS',
      ].join('\r\n'),
    );
    expect(cloudflare).toEqual({ kind: 'answered', status: 530, wwwAuthenticate: false, ownerHeaders: false });
    for (const port of [443, 8443] as const) expect(classifyEdge(port, addr, cloudflare).ok).toBe(true);
    const owner401 = parseProbeHead(
      [
        'HTTP/1.1 401 Unauthorized',
        'Cache-Control: private, no-store',
        'Www-Authenticate: Basic realm="restricted"',
        'X-Robots-Tag: noindex, nofollow',
      ].join('\r\n'),
    );
    expect(owner401).toMatchObject({ status: 401, wwwAuthenticate: true, ownerHeaders: true });
    for (const head of [
      'HTTP/2 404\r\ncache-control: private, no-store',
      'HTTP/2 403\r\nx-robots-tag: noindex, nofollow',
    ]) {
      const p = parseProbeHead(head);
      expect(p, head).toMatchObject({ ownerHeaders: true });
      expect(classifyEdge(443, addr, p).ok, head).toBe(false);
    }
    expect(parseProbeHead('\u0016\u0003\u0001 not http')).toEqual({ kind: 'handshake-failed' });
  });
  it('is n/a where the address is unreachable', () => {
    expect(classifyEdge(443, '2606:4700::1', { kind: 'unreachable' }).ok).toBe('n/a');
  });

  const io = (probe: Probe): Io => ({
    addresses: async () => [addr],
    probe: async () => probe,
    dns: async () => ({ addresses: [], code: 'ENOTFOUND' }),
    get: async () => ({ status: 404, body: '' }),
  });
  it('checkOwnerListener judges by the edge only in cloudflare mode; the DNS rule and documents are unchanged', async () => {
    const edge403 = answered(403);
    const direct = await checkOwnerListener('d.example', [], io(edge403));
    const cf = await checkOwnerListener('d.example', [], io(edge403), 'cloudflare');
    expect(direct.filter((x) => x.ok === false).map((x) => x.check)).toEqual([
      `owner listener 443 ${addr}`,
      `owner listener 8443 ${addr}`,
    ]);
    expect(cf.filter((x) => x.ok === false)).toEqual([]);
    expect(cf.map((x) => x.check)).toEqual(direct.map((x) => x.check));
    const leak = await checkOwnerListener('d.example', [], io(answered(401, { wwwAuthenticate: true })), 'cloudflare');
    expect(leak.filter((x) => x.ok === false)).toHaveLength(2);
    const dns = await checkOwnerListener(
      'd.example',
      [],
      { ...io({ kind: 'refused' }), dns: async () => ({ addresses: ['192.0.2.9'] }) },
      'cloudflare',
    );
    expect(dns.filter((x) => x.ok === false).map((x) => x.check)).toEqual(['owner listener DNS']);
  });
  it('the default is the direct judgement, byte for byte', async () => {
    for (const p of [answered(421), answered(200), { kind: 'refused' } satisfies Probe]) {
      expect(await checkOwnerListener('d.example', [], io(p))).toEqual(
        await checkOwnerListener('d.example', [], io(p), 'direct'),
      );
    }
  });
});

// Each case starts verify-prod.ts (a few hundred ms of Node start-up each, more under the full suite's load).
describe('the command line', { timeout: 60_000 }, () => {
  const run = (...args: string[]) =>
    spawnSync(join(repoRoot, 'scripts/verify-prod.sh'), args, { encoding: 'utf8', timeout: 20_000 });
  it('--edge takes direct or cloudflare, else a usage error (64)', () => {
    for (const args of [
      ['--edge', 'bogus', 'x.example'],
      ['x.example', '--edge'],
      ['x.example', '--edge', 'Cloudflare'],
    ]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(64);
      expect(r.stderr).toContain('usage:');
    }
    for (const e of ['direct', 'cloudflare']) expect(run('--dry-run', '--edge', e, 'x').status).toBe(0);
  });
  it('--dry-run lists the edge group once, with its note, and the same list for both edges', () => {
    const direct = run('--dry-run', 'x').stdout;
    expect(run('--dry-run', '--edge', 'cloudflare', 'x').stdout).toBe(direct);
    expect(CHECKS.filter((c) => c.startsWith('edge (issue #109;'))).toHaveLength(1);
    expect(direct).toContain('only with --edge cloudflare');
    expect(direct).toMatch(/^headers \/ and \/en\/: 200 and every A§12\.2 header byte for byte .*no Server, and/m);
  });
  it('the edge group is reached only for --edge cloudflare', () => {
    const src = readFileSync(join(repoRoot, 'scripts/verify-prod.ts'), 'utf8');
    expect(src).toMatch(/if \(edge === 'cloudflare'\)\s+results\.push\(\s+\.\.\.\(await checkEdge\(/);
    expect(src.match(/checkEdge\(/g)).toHaveLength(1);
  });
});
