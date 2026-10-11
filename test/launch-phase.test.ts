import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { PAGE_ROUTES } from '../apps/web/src/lib/routes.ts';
import { ownerSourceIds, ownerTerms } from '../scripts/verify-prod.ts';
import { repoRoot } from './catalogue.ts';

// P12b (issue #27, A§9.1, T-LAUNCH-1): the go-public switch. deploy/web/site.caddy imports
// deploy/web/phase-<RWS_SITE_PHASE>.caddy at two places; the launch phase serves robots.txt and sitemap.xml and drops
// noindex from the pages, and the Open Graph tags are made absolute by the templates module. Caddy itself is not started
// here (a local caddy validate, adapt and run proved the behaviour; the CI e2e job runs both phases against the real
// image and the compose stack runs verify-prod in both profiles): this file pins the text.

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
/** A Caddy file without its comment lines. */
const code = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const site = read('deploy/web/site.caddy');
const prelaunch = read('deploy/web/phase-prelaunch.caddy');
const launch = read('deploy/web/phase-launch.caddy');
const IMPORT = 'import phase-{$RWS_SITE_PHASE:prelaunch}.caddy';

describe('site.caddy imports the phase at both sites', () => {
  it('imports the snippet in the site block (main) and in handle_errors (errors), and nowhere else', () => {
    const lines = code(site)
      .split('\n')
      .map((l, i) => [i, l.trim()] as const)
      .filter(([, l]) => l.startsWith('import '));
    expect(lines.map(([, l]) => l)).toEqual([`${IMPORT} main`, `${IMPORT} errors`]);
    const lns = code(site).split('\n');
    const [main, errors] = lines.map(([i]) => i);
    const errorsStart = lns.findIndex((l) => l.trim().startsWith('handle_errors '));
    const errorsEnd = lns.findIndex((l, i) => i > errorsStart && l === '\t}');
    expect(main).toBeLessThan(errorsStart);
    expect(errors).toBeGreaterThan(errorsStart);
    expect(errors).toBeLessThan(errorsEnd);
    // the main import sits right after the site's own header block, before any route
    expect(lns[(main ?? 0) - 1]).toBe('\t}');
  });

  it('keeps X-Robots-Tag out of the header blocks: the phase files own it', () => {
    expect(code(site)).not.toContain('X-Robots-Tag "noindex"\n\t\t-Server');
    // the two 404 shells say noindex in both phases, the only place site.caddy sets it
    const tags = [...code(site).matchAll(/^\s*header X-Robots-Tag "noindex"$/gm)];
    expect(tags).toHaveLength(2);
    expect(code(site).match(/X-Robots-Tag/g)).toHaveLength(2);
  });

  it('defaults to prelaunch: an unset RWS_SITE_PHASE is noindex, a typo stops Caddy (the file is not found)', () => {
    expect(site).toContain('{$RWS_SITE_PHASE:prelaunch}');
    for (const phase of ['prelaunch', 'launch'])
      expect(existsSync(join(repoRoot, `deploy/web/phase-${phase}.caddy`))).toBe(true);
  });

  it('runs the templates module only on the three HTML shells, with the delimiters [[ ]]', () => {
    const c = code(site);
    const blocks = [
      ...c.matchAll(
        /^\t\thandle (@\w+) \{\n(?:\t\t\t.*\n)*?\t\t\ttemplates \{\n\t\t\t\tbetween \[\[ \]\]\n\t\t\t\}\n/gm,
      ),
    ];
    expect(blocks.map((m) => m[1])).toEqual(['@page_nl', '@page_en', '@shells']);
    expect(c.match(/templates \{/g)).toHaveLength(3);
    expect(c.match(/between /g)).toHaveLength(3);
    expect(c).toContain("@shells expression `{path} in ['/index.html', '/en/index.html']`");
  });
});

describe('the phase files', () => {
  it('prelaunch is noindex on every response and nothing else', () => {
    expect(
      code(prelaunch)
        .split('\n')
        .filter((l) => l.trim() !== ''),
    ).toEqual(['header X-Robots-Tag "noindex"']);
  });

  it('read the host from the configuration, never from the request (T-LAUNCH-1)', () => {
    for (const [name, src] of [
      ['prelaunch', prelaunch],
      ['launch', launch],
    ] as const) {
      const c = code(src);
      expect(c, name).not.toMatch(/\{host\}/);
      expect(c, name).not.toMatch(/\{hostport\}/);
      expect(c, name).not.toMatch(/\{http\.request\.host(port)?\}/);
      expect(c, name).not.toMatch(/\{http\.request\.(uri|orig_uri)\}/);
      expect(c, name).not.toMatch(/\{(?:header|http\.request\.header)\.(?:Host|X-Forwarded-Host)/i);
    }
    // every absolute URL of the launch phase starts at the configured domain
    const urls = [...code(launch).matchAll(/https?:\/\/[^\s"<]+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls.filter((u) => !u.startsWith('http://www.sitemaps.org') && !u.startsWith('http://www.w3.org')))
      expect(u, u).toMatch(/^https:\/\/\{\$RWS_DOMAIN\}(\/|$)/);
  });

  it('keep every named matcher unique per import site ({args[0]}), so a double import is valid', () => {
    for (const m of code(launch).matchAll(/@(\w+)/g)) expect(m[1], m[0]).toMatch(/_$/);
    expect(code(launch).match(/@\w+_\{args\[0\]\}/g)?.length).toBeGreaterThanOrEqual(4);
  });

  describe('launch', () => {
    const c = code(launch);
    it('keeps noindex on the data paths and the 404 shells only: no page is in the pattern', () => {
      const pattern = /^@noindex_\{args\[0\]\} path (.+)$/m.exec(c)?.[1]?.split(' ') ?? [];
      expect(pattern).toEqual([
        '/api',
        '/api/*',
        '/data',
        '/data/*',
        '/status/*',
        '/tiles',
        '/tiles/*',
        '/downloads',
        '/downloads/*',
        '/runtime-config.json',
      ]);
      const hit = (path: string) =>
        pattern.some((p) => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p));
      // /status is a page (the status page); /status/x is a file of the data tree
      for (const r of PAGE_ROUTES) for (const p of [r.nl, r.en]) expect(hit(p), p).toBe(false);
      for (const p of ['/api/v1/meta', '/data/v1/meta.json', '/status/capture.json', '/tiles/x'])
        expect(hit(p), p).toBe(true);
      expect(c.match(/X-Robots-Tag/g)).toHaveLength(1);
      expect(c).toContain('header @noindex_{args[0]} X-Robots-Tag "noindex"');
    });

    it('answers robots.txt and sitemap.xml for GET and HEAD only, as XML and plain text, for five minutes', () => {
      for (const [matcher, path] of [
        ['robots', '/robots.txt'],
        ['sitemap', '/sitemap.xml'],
      ] as const)
        expect(c).toContain(`@${matcher}_{args[0]} {\n\tmethod GET HEAD\n\texpression \`{path} == '${path}'\`\n}`);
      expect(c).toContain('header Content-Type "text/plain; charset=utf-8"');
      expect(c).toContain('header Content-Type "application/xml; charset=utf-8"');
      expect(c.match(/header Cache-Control "public, max-age=300"/g)).toHaveLength(2);
    });

    it('robots.txt: all agents, /api/ disallowed, the sitemap of the configured domain', () => {
      const body = /respond <<ROBOTS\n([\s\S]*?)\n\t*ROBOTS 200/.exec(launch)?.[1]?.replaceAll(/^\t+/gm, '');
      expect(body).toBe('User-agent: *\nDisallow: /api/\n\nSitemap: https://{$RWS_DOMAIN}/sitemap.xml\n');
    });

    it('sitemap.xml: exactly the pages of apps/web/src/lib/routes.ts in both languages, each with hreflang nl, en, x-default', () => {
      const body = /respond <<SITEMAP\n([\s\S]*?)\n\t*SITEMAP 200/.exec(launch)?.[1]?.replaceAll(/^\t+/gm, '') ?? '';
      const abs = (p: string) => `https://{$RWS_DOMAIN}${p}`;
      const entries = body.split('\n').filter((l) => l.startsWith('<url>'));
      expect(entries).toHaveLength(PAGE_ROUTES.length * 2);
      const want = PAGE_ROUTES.flatMap((r) => [r.nl, r.en]).sort();
      expect(
        entries.map((e) => /<loc>([^<]+)<\/loc>/.exec(e)?.[1]?.replace('https://{$RWS_DOMAIN}', '')).sort(),
      ).toEqual(want);
      for (const r of PAGE_ROUTES)
        for (const lang of ['nl', 'en'] as const) {
          const entry = entries.find((e) => e.startsWith(`<url><loc>${abs(r[lang])}</loc>`)) ?? '';
          expect(entry, r[lang]).toBe(
            `<url><loc>${abs(r[lang])}</loc>` +
              `<xhtml:link rel="alternate" hreflang="nl" href="${abs(r.nl)}"/>` +
              `<xhtml:link rel="alternate" hreflang="en" href="${abs(r.en)}"/>` +
              `<xhtml:link rel="alternate" hreflang="x-default" href="${abs(r.nl)}"/></url>`,
          );
        }
      expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset ')).toBe(true);
      expect(body.endsWith('</urlset>\n')).toBe(true);
    });

    it('names no owner-audience source, spec or host (invariant 11: no sitemap or robots entry for the owner)', () => {
      const registry = loadRegistry();
      const owners = ownerSourceIds(registry);
      expect(owners.length).toBeGreaterThan(0);
      const text = launch.toLowerCase();
      for (const term of ownerTerms(registry))
        if (term.length > 3) expect(text.includes(term.toLowerCase()), term).toBe(false);
      for (const id of owners) expect(new RegExp(`\\b${id}\\b`, 'i').test(launch), id).toBe(false);
      expect(text).not.toContain('owner.');
      expect(text).not.toContain('canary');
    });
  });
});

describe('the Open Graph tags', () => {
  const SHELLS = ['apps/web/index.html', 'apps/web/en/index.html'];
  /** The one template expression the files may hold: the domain, in two absolute URLs. */
  const ALLOWED = 'https://[[env `RWS_DOMAIN`]]';

  it.each(SHELLS)('%s has no [[ or ]] outside the two allowed expressions', (file) => {
    const html = read(file);
    expect(html.split(ALLOWED).length - 1).toBe(2);
    const rest = html.replaceAll(ALLOWED, '');
    expect(rest).not.toContain('[[');
    expect(rest).not.toContain(']]');
    expect(html).toContain(`<meta property="og:image" content="${ALLOWED}/og.png" />`);
    expect(html).toMatch(
      new RegExp(`<meta property="og:url" content="${ALLOWED.replace(/[[\]`]/g, '\\$&')}/(en/)?" />`),
    );
    for (const tag of ['og:type', 'og:title', 'og:description', 'og:site_name'])
      expect(html, tag).toMatch(new RegExp(`<meta property="${tag}" content="[^"]+" />`));
    // title and description are the page's own messages (no new text), twitter:card is the large image
    expect(html).toContain('<meta property="og:title" content="%m:site_title%" />');
    expect(html).toContain('<meta property="og:description" content="%m:meta_description%" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('the other shells and the messages carry no template syntax at all', () => {
    for (const file of [
      'apps/web/404.html',
      'apps/web/en/404.html',
      'apps/web/messages/nl.json',
      'apps/web/messages/en.json',
    ]) {
      expect(read(file), file).not.toContain('[[');
      expect(read(file), file).not.toContain(']]');
    }
  });

  it('og.png is the one same-origin image: a PNG of 1200 x 630 pixels, under 500 KB, in public/', () => {
    const path = join(repoRoot, 'apps/web/public/og.png');
    const png = readFileSync(path);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(statSync(path).size).toBeLessThan(500_000);
  });
});

describe('every consumer of site.caddy sees both phase files', () => {
  it('the web image copies both next to the Caddyfile and the build context allows them', () => {
    const docker = read('deploy/web/Dockerfile');
    const copy = /^COPY (deploy\/web\/Caddyfile .*) \/etc\/caddy\/$/m.exec(docker)?.[1] ?? '';
    for (const f of ['site.caddy', 'phase-prelaunch.caddy', 'phase-launch.caddy', 'owner.caddy'])
      expect(copy.split(' '), f).toContain(`deploy/web/${f}`);
    const ignore = read('.dockerignore').split('\n');
    for (const f of ['phase-prelaunch.caddy', 'phase-launch.caddy']) expect(ignore).toContain(`!deploy/web/${f}`);
  });

  it('the CI e2e job mounts both beside site.caddy and runs a launch container on 8444 (RWS_DOMAIN has the port)', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const f of ['phase-prelaunch.caddy', 'phase-launch.caddy'])
      expect(ci).toContain(`-v "$PWD/deploy/web/${f}:/etc/caddy/${f}:ro"`);
    expect(ci).toContain('serve e2e-caddy 443 localhost prelaunch');
    expect(ci).toContain('serve e2e-caddy-launch 8444 localhost:8444 launch');
    expect(ci).toContain('-e E2E_BASE_URL_LAUNCH=https://localhost:8444');
    expect(ci).toContain('-e RWS_DOMAIN="$3" -e RWS_SITE_PHASE="$4"');
  });

  it('compose sets the phase on the caddy service only, with a default that is prelaunch until E4', () => {
    const compose = parse(read('deploy/compose.yaml'), { maxAliasCount: 100 }) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const phases = Object.entries(compose.services).flatMap(([name, s]) =>
      s.environment?.RWS_SITE_PHASE === undefined ? [] : [[name, s.environment.RWS_SITE_PHASE]],
    );
    // (the default is the one reviewed line E4 flips; the rebuild drill's env file can still force prelaunch)
    expect(phases).toEqual([['caddy', `\${RWS_SITE_PHASE:-prelaunch}`]]);
    const owner = read('deploy/compose.owner.yaml');
    expect(owner).not.toContain('RWS_SITE_PHASE');
    expect(read('deploy/web/owner.caddy')).not.toContain('phase-');
  });

  it('the CI compose stack takes site.caddy and the phase files from the web image', () => {
    const ci = read('deploy/tests/e2e/compose.ci.yaml');
    expect(ci).toContain('/ci/Caddyfile.ci:/etc/caddy/Caddyfile:ro');
    expect(ci).not.toContain('site.caddy');
    expect(read('deploy/tests/e2e/Caddyfile.ci')).toContain('import /etc/caddy/site.caddy');
  });
});
