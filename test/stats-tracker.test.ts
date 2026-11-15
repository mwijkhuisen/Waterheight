import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBom } from '../scripts/check-bom.ts';
import { repoRoot } from './catalogue.ts';

// The statistics script (#270 part B, ADR-0024): Umami's built tracker, vendored byte for byte from the pinned image
// (scripts/umami-tracker.sh), served from this site's own /assets, and sending to the owner's own stats host only.
// The page shells are shared by the public and the owner site (both serve /srv/www); only the public site runs Caddy's
// templates module over them (site.caddy), so only there does the tag's type become a script type. On the owner site
// the raw value `[[`text/javascript`]]` is no JavaScript MIME type: the tag is a data block, never fetched or run.

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const row = readBom(read('CLAUDE.md')).find((r) => r.name === 'umami tracker');
const pin = row?.pin ?? '';
const file = `apps/web/public/assets/stats-${pin.slice(0, 8)}.js`;
const HOST = 'https://stats.waterradar.io';

/** The one tag, attribute for attribute; the website ID is the owner's (docs/runbooks/stats.md §7). */
const TAG =
  /^ {4}<script type="\[\[`text\/javascript`\]\]" defer src="\/assets\/stats-([0-9a-f]{8})\.js" data-website-id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})" data-host-url="https:\/\/stats\.waterradar\.io" data-domains="waterradar\.io" data-do-not-track="true" data-exclude-search="true" data-exclude-hash="true"><\/script>$/m;

describe('the vendored statistics script', () => {
  it('is the one asset row, of the release the stats stack runs', () => {
    expect(row).toMatchObject({ kind: 'asset', status: 'installed' });
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    const image = /^\s*image: ghcr\.io\/umami-software\/umami:(\S+)@sha256:/m.exec(read('deploy/stats/compose.yaml'));
    expect(row?.version).toBe(image?.[1]);
  });

  it('has the sha256 its BOM row pins, and its name carries it', () => {
    expect(
      createHash('sha256')
        .update(readFileSync(join(repoRoot, file)))
        .digest('hex'),
    ).toBe(pin);
    expect(readdirSync(join(repoRoot, 'apps/web/public/assets')).filter((f) => f.startsWith('stats-'))).toEqual([
      `stats-${pin.slice(0, 8)}.js`,
    ]);
  });

  // What the pinned source (src/tracker/index.ts at v3.4.1) does, checked on the minified bytes we serve.
  it('reads one storage key and writes none, sends without credentials, and only to the configured host', () => {
    const js = read(file);
    expect(js.match(/localStorage|sessionStorage|indexedDB|cookie/g)).toEqual(['localStorage']);
    expect(js).toContain('getItem("umami.disabled")');
    expect(js).not.toMatch(/setItem|removeItem/);
    expect(js).toContain('w("fetch-credentials")||"omit"');
    expect(js.match(/fetch\(/g)).toHaveLength(1);
    expect(js).not.toMatch(/https?:\/\//);
  });
});

describe('the tracker tag', () => {
  const shells = ['apps/web/index.html', 'apps/web/en/index.html'].map((f) => [f, read(f)] as const);

  it.each(shells)('%s holds it once, last in the body, with exactly the attributes of #270 B', (_, html) => {
    expect(html.match(/<script\b/g)).toHaveLength(2);
    const tag = TAG.exec(html);
    expect(tag?.[1]).toBe(pin.slice(0, 8));
    expect(html.indexOf(tag?.[0] ?? '-')).toBeGreaterThan(html.indexOf('<script type="module" src="/src/main.tsx">'));
    expect(html.indexOf(tag?.[0] ?? '-')).toBeLessThan(html.indexOf('</body>'));
  });

  it('is the same in both shells, and the 404 shells have none', () => {
    const [nl, en] = shells.map(([, html]) => TAG.exec(html)?.[0]);
    expect(nl).toBeDefined();
    expect(en).toBe(nl);
    for (const f of ['apps/web/404.html', 'apps/web/en/404.html']) expect(read(f)).not.toContain('stats');
  });
});

describe('the host it sends to', () => {
  const site = read('deploy/web/site.caddy');
  const owner = read('deploy/web/owner.caddy');
  const csp = (src: string) => [...src.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1] ?? '');

  it("is the public CSP's only off-origin source, in connect-src only (script-src stays 'self')", () => {
    for (const policy of csp(site)) {
      expect(policy.match(/https?:\/\/[^\s;]+/g)).toEqual([HOST]);
      expect(policy).toContain(`connect-src 'self' ${HOST};`);
      expect(policy).toContain("script-src 'self';");
    }
  });

  it('is not in the owner site, which runs no templates and keeps the public CSP without it', () => {
    expect(owner).not.toContain('stats.waterradar.io');
    expect(owner.replaceAll(/#.*$/gm, '')).not.toMatch(/\btemplates\b/);
    expect(csp(owner)).toEqual([csp(site)[0]?.replace(` ${HOST};`, ';')]);
  });

  it('is the host the tag names, and the one the stats tunnel routes /api/send for', () => {
    expect(read('apps/web/index.html')).toContain(`data-host-url="${HOST}"`);
    expect(read('deploy/stats/cloudflared.yml')).toMatch(/hostname: stats\.waterradar\.io/);
  });
});
