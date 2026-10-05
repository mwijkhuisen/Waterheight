import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './catalogue.ts';

// The owner site (P9a): its A§12.2 headers are the public site's, and only the
// two owner headers differ; the owner stack is isolated from the public one by
// construction (deploy/compose.yaml, deploy/compose.owner.yaml).

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const publicSite = read('deploy/web/site.caddy');
const ownerSite = read('deploy/web/owner.caddy');

/** The lines of the first `header {` block: the A§12.2 set. */
function headerBlock(src: string): string[] {
  const m = /^\theader \{\n([\s\S]*?)^\t\}/m.exec(src);
  if (!m?.[1]) throw new Error('no header block');
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('owner site headers', () => {
  const pub = headerBlock(publicSite);
  const own = headerBlock(ownerSite);

  it('equal the public set except X-Robots-Tag and the two owner additions', () => {
    const robots = (l: string) => l.startsWith('X-Robots-Tag ');
    expect(pub.filter(robots)).toEqual(['X-Robots-Tag "noindex"']);
    expect(own.filter(robots)).toEqual(['X-Robots-Tag "noindex, nofollow"']);
    // Cache-Control and `defer` (so a proxied answer cannot override it) are the additions.
    expect(own.filter((l) => !robots(l) && l !== 'Cache-Control "private, no-store"' && l !== 'defer')).toEqual(
      pub.filter((l) => !robots(l)),
    );
    expect(own).toContain('Cache-Control "private, no-store"');
  });

  it('are repeated in the error route, so a 401 and a 404 carry the same two headers', () => {
    const errors = /handle_errors \{\n\t\theader \{\n([\s\S]*?)\t\t\}\n\t\trespond \{err\.status_code\}/.exec(
      ownerSite,
    );
    expect(errors?.[1]).toContain('X-Robots-Tag "noindex, nofollow"');
    expect(errors?.[1]).toContain('Cache-Control "private, no-store"');
  });
});

describe('owner site isolation', () => {
  it('gates the whole site with basic_auth at site level, never inside a route', () => {
    // A basic_auth in a route does not gate `handle` blocks (Caddy 2.11.4, measured).
    expect(ownerSite).toMatch(/^\tbasic_auth \{\n\t\timport \/run\/secrets\/owner_basic_auth\n\t\}/m);
    expect(ownerSite).not.toMatch(/^\s*route\b/m);
  });

  it('never reads the public tree, and the public site never reads the owner tree or the secret', () => {
    expect(ownerSite.replaceAll(/#.*$/gm, '')).not.toContain('/srv/rws/public');
    const code = (f: string) => f.replaceAll(/#.*$/gm, '');
    expect(code(publicSite)).not.toMatch(/owner_basic_auth|caddy-owner|\/srv\/rws\/owner/);
    expect(code(read('deploy/compose.yaml'))).not.toMatch(/owner_basic_auth|caddy-owner/);
  });

  it('mounts each publisher on its own audience only, and caddy-owner only the owner v1, read-only', () => {
    type Svc = { volumes?: string[]; secrets?: string[]; networks?: string[]; ports?: string[] };
    const base = parse(read('deploy/compose.yaml')) as { services: Record<string, Svc> };
    const overlay = parse(read('deploy/compose.owner.yaml')) as { services: Record<string, Svc> };
    const vols = (s?: Svc) => s?.volumes ?? [];
    expect(vols(base.services.publish).join(' ')).not.toContain('/srv/rws/owner');
    expect(vols(base.services['publish-owner']).join(' ')).not.toContain('/srv/rws/public');
    expect(base.services.publish?.secrets).toEqual(['db_rws_publish']);
    expect(base.services['publish-owner']?.secrets).toEqual(['db_rws_owner_api']);
    expect(base.services.publish?.networks).toEqual(['db']);
    expect(base.services['publish-owner']?.networks).toEqual(['db']);
    expect(vols(base.services.caddy).filter((v) => v.includes('/www'))).toEqual([
      '/srv/rws/public/www/v1:/srv/rws/public/www/v1:ro',
    ]);
    const owner = overlay.services['caddy-owner'];
    expect(owner?.volumes?.filter((v) => v.startsWith('/'))).toEqual([
      '/srv/rws/owner/www/v1:/srv/rws/owner/www/v1:ro',
    ]);
    expect(owner?.ports).toBeUndefined();
    expect(owner?.networks).toEqual(['edge']);
    expect(owner?.secrets).toEqual(['owner_basic_auth']);
  });
});
