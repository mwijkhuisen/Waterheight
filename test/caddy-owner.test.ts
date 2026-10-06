import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './catalogue.ts';

// The owner site (P9a): its A§12.2 headers are the public site's, and only the
// two owner headers differ, plus `Referrer-Policy: no-referrer` (P10a: a link to a provider never names the owner
// site); the owner stack is isolated from the public one by
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

  it('equal the public set except X-Robots-Tag, the Referrer-Policy and the two owner additions', () => {
    const robots = (l: string) => l.startsWith('X-Robots-Tag ') || l.startsWith('Referrer-Policy ');
    expect(pub.filter(robots)).toEqual(['Referrer-Policy "strict-origin-when-cross-origin"', 'X-Robots-Tag "noindex"']);
    expect(own.filter(robots)).toEqual(['Referrer-Policy "no-referrer"', 'X-Robots-Tag "noindex, nofollow"']);
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

describe('the owner api routes (P9b)', () => {
  const code = ownerSite.replaceAll(/#.*$/gm, '');
  const proxies = [...code.matchAll(/reverse_proxy (\S+) \{/g)];

  it('has the beacon handle: exact POST, 8 KB, before the 405 guard, to api-owner', () => {
    expect(code).toMatch(/@beacon \{\n\t\tmethod POST\n\t\texpression `\{path\} == '\/api\/v1\/beacon'`\n\t\}/);
    const beacon = /handle @beacon \{\n\t\trequest_body \{\n\t\t\tmax_size 8KiB\n\t\t\}\n([\s\S]*?)\n\t\}\n/.exec(code);
    expect(beacon?.[1]).toContain('reverse_proxy api-owner:8080 {');
    expect(code.indexOf('handle @beacon {')).toBeLessThan(code.indexOf('handle @write {'));
    // The 405 guard itself is unchanged.
    expect(code).toContain('\t@write not method GET HEAD\n');
  });

  it('sets X-Rws-Client on every reverse_proxy: the TCP peer on the owner site, {client_ip} on the public one (KG-228)', () => {
    expect(proxies.map((m) => m[1])).toEqual(['api-owner:8080', 'api-owner:8080']);
    for (const site of [ownerSite, publicSite]) {
      // Up to the first line that is only a closing brace (a nested block of the snapshot proxy comes after the headers).
      const all = [...site.replaceAll(/#.*$/gm, '').matchAll(/reverse_proxy (\S+) \{\n([\s\S]*?)\n\t*\}\n/g)];
      expect(all.length).toBe(site === ownerSite ? 2 : 3);
      const want = site === ownerSite ? '{remote_host}' : '{client_ip}';
      for (const m of all) expect(m[2], m[1]).toContain(`header_up X-Rws-Client ${want}`);
    }
  });

  it('trusts X-Forwarded-For only from RWS_TRUSTED_PROXIES, strictly, on the public site alone (KG-228)', () => {
    const globals = read('deploy/web/Caddyfile').replaceAll(/#.*$/gm, '');
    expect(globals).toContain('trusted_proxies static {$RWS_TRUSTED_PROXIES}\n');
    expect(globals).toContain('trusted_proxies_strict\n');
    expect(globals).toContain('client_ip_headers X-Forwarded-For\n');
    expect(read('deploy/web/Caddyfile.owner')).not.toContain('trusted_proxies');
    expect(read('deploy/compose.yaml')).toContain('RWS_TRUSTED_PROXIES: ${RWS_TRUSTED_PROXIES:-}\n');
  });

  it('puts Reporting-Endpoints in the header block of both sites', () => {
    const line = 'Reporting-Endpoints "csp=\\"/api/v1/beacon\\""';
    expect(headerBlock(publicSite)).toContain(line);
    expect(headerBlock(ownerSite)).toContain(line);
  });
});

describe('owner site isolation', () => {
  it('gates the whole site with basic_auth at site level, never inside a route', () => {
    // A basic_auth in a route does not gate `handle` blocks (Caddy 2.11.4, measured).
    expect(ownerSite).toMatch(/^\tbasic_auth \{\n\t\timport \/run\/secrets\/owner_basic_auth\n\t\}/m);
    expect(ownerSite).not.toMatch(/^\s*route\b/m);
  });

  it('reads nothing of the public tree but the river files, and the public site never reads the owner tree or the secret', () => {
    // P10a (KG-213): the one public path the owner site reads is the rivers directory (and /srv/rws/tiles, which is not public/).
    const ownerCode = ownerSite.replaceAll(/#.*$/gm, '').replaceAll('/srv/rws/public/data/v1/rivers', '');
    expect(ownerCode).not.toContain('/srv/rws/public');
    expect(ownerCode).not.toContain('/srv/rws/owner/status');
    const code = (f: string) => f.replaceAll(/#.*$/gm, '');
    expect(code(publicSite)).not.toMatch(/owner_basic_auth|caddy-owner|\/srv\/rws\/owner/);
    expect(code(read('deploy/compose.yaml'))).not.toMatch(/owner_basic_auth|caddy-owner/);
  });

  it('mounts each publisher on its own audience only, and caddy-owner only the owner v1, the tiles and the rivers directory, read-only', () => {
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
    // An exact list (P10a, KG-213): the owner tree, the basemap tiles and the river files, never anything else of /srv/rws/public.
    expect(owner?.volumes?.filter((v) => v.startsWith('/'))).toEqual([
      '/srv/rws/owner/www/v1:/srv/rws/owner/www/v1:ro',
      '/srv/rws/tiles:/srv/rws/tiles:ro',
      '/srv/rws/public/data/v1/rivers:/srv/rws/public/data/v1/rivers:ro',
    ]);
    expect(owner?.ports).toBeUndefined();
    expect(owner?.networks).toEqual(['edge', 'owner_edge']);
    expect(owner?.secrets).toEqual(['owner_basic_auth']);
  });

  it('adds api-owner in the overlay only: the hardening of compose.yaml, one secret, owner_edge and owner_db, no port (P9b C15, review F1)', () => {
    type Svc = Record<string, unknown> & { networks?: string[]; secrets?: string[] };
    type File = { services: Record<string, Svc>; networks?: Record<string, { internal?: boolean }> };
    const base = parse(read('deploy/compose.yaml'), { merge: true }) as File;
    const overlay = parse(read('deploy/compose.owner.yaml'), { merge: true }) as File;
    expect(base.services['api-owner']).toBeUndefined();
    expect(read('deploy/compose.yaml').replaceAll(/#.*$/gm, '')).not.toMatch(/api-owner|owner_edge/);
    const svc = overlay.services['api-owner'] as Svc;
    // The overlay repeats x-hardening literally (anchors do not cross files): every key of the public api's copy.
    for (const k of ['read_only', 'tmpfs', 'cap_drop', 'security_opt', 'restart', 'user']) {
      expect(svc[k], k).toEqual((base.services.api as Svc)[k]);
    }
    expect(svc.read_only).toBe(true);
    expect(svc.cap_drop).toEqual(['ALL']);
    expect(svc.security_opt).toEqual(['no-new-privileges:true']);
    expect(svc.user).toBe('65532:65532');
    expect(svc.image).toBe((base.services.api as Svc).image);
    expect(svc.command).toEqual(['api', '--audience', 'owner']);
    // The owner API secret group, as publish-owner's.
    expect(svc.group_add).toEqual(['61009']);
    expect(svc.group_add).toEqual(base.services['publish-owner']?.group_add);
    expect(svc.secrets).toEqual(['db_rws_owner_api']);
    expect(svc.mem_limit).toBe('256m');
    expect(svc.cpus).toBe(0.5);
    expect(svc.pids_limit).toBe(64);
    expect(svc.ports).toBeUndefined();
    expect(svc.networks).toEqual(['owner_edge', 'owner_db']);
    expect(svc.healthcheck).toEqual((base.services.api as Svc).healthcheck);
    expect(svc.depends_on).toEqual((base.services.api as Svc).depends_on);
    expect(svc.environment).toEqual((base.services.api as Svc).environment);
    // owner_edge: internal, joined by caddy-owner and api-owner only; neither the public caddy nor the public api.
    expect(overlay.networks?.owner_edge?.internal).toBe(true);
    const joined = [...Object.entries(base.services), ...Object.entries(overlay.services)]
      .filter(([, s]) => s.networks?.includes('owner_edge'))
      .map(([name]) => name)
      .sort();
    expect(joined).toEqual(['api-owner', 'caddy-owner']);
    expect(base.networks?.owner_edge).toBeUndefined();
    // owner_db (review F1): internal, joined by api-owner and db only, so the public api (on the shared db network)
    // cannot reach api-owner; the overlay's db entry keeps its own network.
    expect(overlay.networks?.owner_db?.internal).toBe(true);
    const onOwnerDb = Object.entries(overlay.services)
      .filter(([, s]) => s.networks?.includes('owner_db'))
      .map(([name]) => name)
      .sort();
    expect(onOwnerDb).toEqual(['api-owner', 'db']);
    expect((overlay.services.db as Svc).networks).toEqual(['db', 'owner_db']);
    expect(Object.values(base.services).some((s) => s.networks?.includes('owner_db'))).toBe(false);
    expect(base.networks?.owner_db).toBeUndefined();
  });
});
