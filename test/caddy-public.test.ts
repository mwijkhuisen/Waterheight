import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './catalogue.ts';

// The public site (deploy/web/site.caddy), P12a: the brownout TTLs, the host-less 421 catch-all and the CSP. Caddy
// itself is not started here (the offline run has none): `caddy adapt` and a local run proved the behaviour, and the CI
// deploy job proves it end to end.

const site = readFileSync(join(repoRoot, 'deploy/web/site.caddy'), 'utf8');
const code = site
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

describe('brownout (A§9.2)', () => {
  // [matcher, normal Cache-Control, brownout Cache-Control]
  const CLASSES = [
    [
      'brownout_live',
      'public, max-age=60, stale-while-revalidate=300',
      'public, max-age=300, stale-while-revalidate=600',
    ],
    [
      'brownout_recent',
      'public, max-age=300, stale-while-revalidate=600',
      'public, max-age=900, stale-while-revalidate=1800',
    ],
    ['brownout_slow', 'public, max-age=300', 'public, max-age=900'],
    ['brownout_warnings', 'public, max-age=60', 'public, max-age=300'],
    ['brownout_status', 'public, max-age=30', 'public, max-age=120'],
  ] as const;
  const maxAge = (cc: string) => Number(/max-age=(\d+)/.exec(cc)?.[1]);

  it.each(CLASSES)('%s tests the flag file the host mounts read-only', (name) => {
    const matcher = new RegExp(
      `\\t\\t@${name} \\{\\n\\t\\t\\tfile \\{\\n\\t\\t\\t\\troot /run/rws-brownout\\n\\t\\t\\t\\ttry_files /active\\n\\t\\t\\t\\}`,
    );
    expect(site).toMatch(matcher);
  });

  it.each(CLASSES)(
    '%s raises the TTL, deferred so it wins over the class header, never immutable',
    (name, normal, raised) => {
      expect(code).toContain(`\t\t\theader @${name} >Cache-Control "${raised}"\n`);
      // The class header it replaces is the line right above it.
      expect(code).toContain(`\t\t\theader Cache-Control "${normal}"\n\t\t\theader @${name} >Cache-Control`);
      expect(maxAge(raised)).toBeGreaterThan(maxAge(normal));
      expect(raised).not.toMatch(/immutable/);
      // The browser still revalidates within a bounded time: an hour at most.
      expect(maxAge(raised)).toBeLessThanOrEqual(3600);
    },
  );

  it('leaves meta.json (it carries the flag) and every immutable class alone', () => {
    expect(site).toContain(
      '\t\t@brownout_live {\n\t\t\tfile {\n\t\t\t\troot /run/rws-brownout\n\t\t\t\ttry_files /active\n\t\t\t}\n\t\t\tnot path /v1/meta.json\n\t\t}',
    );
    const brownoutHeaders = [...code.matchAll(/^\s+header @brownout_\w+ >Cache-Control "(.*)"$/gm)].map((m) => m[1]);
    expect(brownoutHeaders).toHaveLength(CLASSES.length);
    // Only the five mutable data classes: no tiles, assets, rivers or pages, no immutable value.
    expect(brownoutHeaders.join('\n')).not.toMatch(/immutable|31536000/);
    expect((code.match(/\/run\/rws-brownout/g) ?? []).length).toBe(CLASSES.length);
  });

  it('keeps the response headers in the access log, where the host evaluator reads X-Brownout', () => {
    const log = /\tlog \{\n([\s\S]*?)\n\t\}\n/.exec(site)?.[1] ?? '';
    expect(log).toContain('format filter');
    expect(log).not.toMatch(/resp_headers/);
    expect(log).not.toMatch(/X-Brownout/i);
    // header_down never strips it from the api's answer either.
    expect(code).not.toMatch(/header_down -X-Brownout/i);
  });
});

describe('the host-less catch-all (A§12.2, criterion 10)', () => {
  // #109: the block is one of two files, chosen by RWS_SITE_SCHEME: both ports in direct mode, :80 alone in tunnel mode.
  const HTTPS = readFileSync(join(repoRoot, 'deploy/web/catchall-https.caddy'), 'utf8');
  const HTTP = readFileSync(join(repoRoot, 'deploy/web/catchall-http.caddy'), 'utf8');
  const strip = (text: string) =>
    text
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
  const body = (text: string, address: string) =>
    new RegExp(`^${address} \\{\\n([\\s\\S]*?)\\n\\}\\n$`).exec(strip(text))?.[1] ?? '';
  const catchAll = body(HTTPS, ':80, :443');

  it('answers 421 for any Host or SNI that is not the domain, on both ports, with no site content', () => {
    expect(catchAll).toContain('respond 421');
    expect(catchAll).toContain('header -Server');
    expect(catchAll).toContain('header Cache-Control "no-store"');
    expect(catchAll).not.toMatch(/file_server|reverse_proxy|root /);
  });

  it('is the same block on :80 alone in tunnel mode (no TLS listener), and nothing else', () => {
    expect(body(HTTP, ':80')).not.toBe('');
    expect(body(HTTP, ':80')).toBe(catchAll);
    expect(strip(HTTP)).not.toMatch(/443/);
  });

  it('is the last site, after the domain and the healthcheck listener', () => {
    const at = (s: string) => site.indexOf(s);
    const domain = '\n{$RWS_SITE_SCHEME:https}://{$RWS_DOMAIN} {\n';
    expect(at(domain)).toBeGreaterThanOrEqual(0);
    expect(at(domain)).toBeLessThan(at('http://127.0.0.1:8081 {'));
    expect(at('http://127.0.0.1:8081 {')).toBeLessThan(at('\nimport catchall-{$RWS_SITE_SCHEME:https}.caddy'));
    expect(
      code
        .split('\n')
        .filter((l) => l.trim() !== '')
        .at(-1),
    ).toBe('import catchall-{$RWS_SITE_SCHEME:https}.caddy');
    // The catch-all is no longer written in site.caddy itself.
    expect(code).not.toMatch(/^:80/m);
  });

  it('reads the scheme of its site address from RWS_SITE_SCHEME, https when unset', () => {
    expect(code.split('\n').filter((l) => /^\S.* \{$/.test(l))).toEqual([
      '{$RWS_SITE_SCHEME:https}://{$RWS_DOMAIN} {',
      'http://127.0.0.1:8081 {',
    ]);
  });

  it('uses no on-demand TLS and no default_sni: an unknown SNI fails the handshake', () => {
    expect(code).not.toMatch(/on_demand|default_sni|fallback_sni|\btls\b/);
    for (const text of [HTTPS, HTTP, readFileSync(join(repoRoot, 'deploy/web/Caddyfile'), 'utf8')])
      expect(text).not.toMatch(/on_demand|default_sni/);
  });
});

describe('the Content-Security-Policy (ADR-0016)', () => {
  const csp = /\n\t\tContent-Security-Policy "([^"]+)"/.exec(site)?.[1] ?? '';

  it('allows no inline script or style and no eval', () => {
    expect(csp).not.toBe('');
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self';");
  });

  it('is the same policy in the error routes, so a 502 or 503 is as strict', () => {
    const all = [...site.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(1);
  });
});
