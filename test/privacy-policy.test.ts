import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEACON_MAX_BYTES } from '../apps/server/src/api/beacon.ts';
import { LOG } from '../apps/web/src/features/pages/policy.ts';
import { repoRoot } from './catalogue.ts';

// The privacy page (P10b) says how the logs are kept, with the numbers of apps/web/src/features/pages/policy.ts
// (parts/LogPolicy.tsx prints them). This test holds those numbers to what the two Caddy sites and the beacon really do,
// so the page cannot drift from the configuration (E5: the privacy notice must match the logging configuration).

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** The body of a site's own `log { … }` block (one tab deep; its nested blocks are deeper). */
function logBlock(src: string): string {
  const block = /^\tlog \{\n([\s\S]*?)^\t\}/m.exec(src);
  if (!block?.[1]) throw new Error('no log block');
  return block[1];
}

/** The size of the body cap on the beacon's `handle`: its number of KiB. */
function beaconCapKiB(src: string): number {
  const cap = /handle @beacon \{\s*request_body \{\s*max_size (\d+)KiB\s*\}/.exec(src);
  if (!cap?.[1]) throw new Error('no beacon body cap in KiB');
  return Number(cap[1]);
}

describe.each(['deploy/web/site.caddy', 'deploy/web/owner.caddy'])('%s access log', (file) => {
  const src = read(file);
  const log = logBlock(src);

  it('masks every address field to the published prefix lengths', () => {
    for (const field of ['request>remote_ip', 'request>client_ip', 'request>headers>X-Forwarded-For'])
      expect(log).toContain(`\t\t\t${field} ip_mask ${LOG.ipv4} ${LOG.ipv6}\n`);
  });

  it('never logs the Authorization or Cookie header', () => {
    expect(log).toContain('\t\t\trequest>headers>Authorization delete\n');
    expect(log).toContain('\t\t\trequest>headers>Cookie delete\n');
  });

  // Review round 1: only X-Forwarded-For is masked, so every other header that can carry a client address is
  // dropped, or a proxy or a CDN (D20) would put full addresses in the log the privacy page calls shortened.
  it.each(['Forwarded', 'X-Real-Ip', 'Cf-Connecting-Ip', 'True-Client-Ip', 'X-Client-Ip', 'Fastly-Client-Ip'])(
    'never logs the %s header',
    (header) => {
      expect(log).toContain(`\t\t\trequest>headers>${header} delete\n`);
    },
  );

  it('masks no request header but X-Forwarded-For: every other one that names a client is deleted', () => {
    const named = [...log.matchAll(/request>headers>([A-Za-z-]+) (ip_mask|delete)/g)].map(
      ([, h, how]) => `${h} ${how}`,
    );
    expect(named.filter((n) => n.endsWith('ip_mask'))).toEqual(['X-Forwarded-For ip_mask']);
  });

  it('rolls one file a day and keeps it for the published number of days', () => {
    expect(log).toContain('\t\t\troll_interval 24h\n');
    expect(log).toContain(`\t\t\troll_keep_for ${LOG.keepDays * 24}h\n`);
  });

  it('caps the beacon body at the published size', () => {
    expect(beaconCapKiB(src) * 1024).toBe(LOG.beaconMaxBytes);
  });
});

// #133 (KG-314): Caddy's own log (stderr, kept by Docker's local driver) carries a request with reverse_proxy's warnings,
// so it gets the access logs' masks, plus X-Rws-Client (the address Caddy sends the api) and the error text's addresses.
describe("Caddy's own log (deploy/web/default-log.caddy)", () => {
  const filter = read('deploy/web/default-log.caddy');

  it('masks or deletes every field both access logs do, and X-Rws-Client', () => {
    for (const file of ['deploy/web/site.caddy', 'deploy/web/owner.caddy']) {
      const lines = logBlock(read(file))
        .split('\n')
        .filter((l) => l.startsWith('\t\t\trequest>'));
      expect(lines.length).toBeGreaterThan(10);
      for (const l of lines) expect([file, filter]).toEqual([file, expect.stringContaining(`\n\t\t${l.trim()}\n`)]);
    }
    expect(filter).toContain(`\n\t\trequest>headers>X-Rws-Client ip_mask ${LOG.ipv4} ${LOG.ipv6}\n`);
  });

  it("replaces every address in an error text (Go's net errors, IPv4 and IPv6)", () => {
    const [, pattern, value] = /^\t\terror regexp `(.+)` (\S+)$/m.exec(filter) ?? [];
    expect(value).toBe('[address]');
    const mask = (s: string) => s.replaceAll(new RegExp(pattern ?? '$^', 'g'), value ?? '');
    expect(mask('writing: write tcp 172.18.0.5:443->203.0.113.7:51234: write: broken pipe')).toBe(
      'writing: write tcp [address]:443->[address]:51234: write: broken pipe',
    );
    expect(mask('write tcp [2a0a:e5c0:ffff::10]:443->[2001:db8:1:2::5]:51234: write: connection reset by peer')).toBe(
      'write tcp [address]:443->[address]:51234: write: connection reset by peer',
    );
    expect(mask('reading: unexpected EOF')).toBe('reading: unexpected EOF');
  });

  it.each(['deploy/web/Caddyfile', 'deploy/web/Caddyfile.owner', 'deploy/tests/e2e/Caddyfile.ci'])(
    'is imported in the global options of %s',
    (file) => {
      const globals = /^\{\n([\s\S]*?)^\}$/m.exec(read(file))?.[1] ?? '';
      expect(globals).toContain('\n\timport /etc/caddy/default-log.caddy\n');
    },
  );

  it('ships in the web image', () => {
    expect(read('deploy/web/Dockerfile')).toMatch(
      /^COPY deploy\/web\/Caddyfile deploy\/web\/default-log\.caddy .* \/etc\/caddy\/$/m,
    );
    expect(read('.dockerignore').split('\n')).toContain('!deploy/web/default-log.caddy');
  });
});

describe('beacon cap', () => {
  it('is the same at the api as on the privacy page', () => {
    expect(BEACON_MAX_BYTES).toBe(LOG.beaconMaxBytes);
  });
});

// P12b (E5, launch checklist): the privacy page's claims, read from the real configuration, never from a copy of the
// page text. The numbers come from policy.ts and the page prints them through parts/LogPolicy.tsx.

const SITE = read('deploy/web/site.caddy');
const OWNER_SITE = read('deploy/web/owner.caddy');
const COMPOSE = read('deploy/compose.yaml');
const COMPOSE_OWNER = read('deploy/compose.owner.yaml');
/** The compose line of an optional variable: empty unless the owner sets it in /etc/rws/rws.env. */
const dflt = (name: string) => `${name}: \${${name}:-}`;
const message = (lang: 'en' | 'nl', key: string): string => {
  const value = (JSON.parse(read(`apps/web/messages/${lang}.json`)) as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error(`no message ${key}`);
  return value;
};

describe('the published log numbers', () => {
  it('are 24 and 48 bits and 14 days (336 h), in both Caddy sites, and no page or message holds a number of its own', () => {
    expect([LOG.ipv4, LOG.ipv6, LOG.keepDays]).toEqual([24, 48, 14]);
    for (const src of [SITE, OWNER_SITE]) {
      expect(src).toContain('ip_mask 24 48');
      expect(src).toContain('roll_keep_for 336h');
    }
    for (const lang of ['en', 'nl'] as const) {
      const page = read(`apps/web/src/features/pages/content/${lang}/Privacy.tsx`);
      expect(page).toContain(`<LogPolicy locale="${lang}" topic="access" />`);
      expect(page).toContain(`<LogPolicy locale="${lang}" topic="beacon" />`);
      // The sentences take every number as a placeholder; a digit in them is a number that policy.ts does not hold.
      for (const key of ['privacy_log_mask', 'privacy_beacon_size'])
        expect(message(lang, key).replace(/\{[a-z0-9]+\}|IPv[46]/g, '')).not.toMatch(/\d/);
    }
  });
});

describe('no cookie anywhere', () => {
  it('is set by a Caddy site, a compose file or the api, and the page and the app store nothing', () => {
    for (const [name, src] of [
      ['site.caddy', SITE],
      ['owner.caddy', OWNER_SITE],
      ['Caddyfile', read('deploy/web/Caddyfile')],
      ['compose.yaml', COMPOSE],
      ['compose.owner.yaml', COMPOSE_OWNER],
    ] as const)
      expect([name, /set-cookie/i.test(src)]).toEqual([name, false]);
    const sources = (dir: string): string[] =>
      readdirSync(join(repoRoot, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => join(dir, f));
    const files = [...sources('apps/server/src/api'), ...sources('apps/server/src/publish'), ...sources('apps/web/src')]
      // The generated Paraglide runtime reads its locale cookie option, which the app switches off (strategy url).
      .filter((f) => !f.includes('/paraglide/'));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const text = read(f);
      // Provider responses may carry Set-Cookie; the archive manifest drops it (not scanned). Prose in the pages is fine.
      expect([
        f,
        /set-cookie|setCookie\(|document\.cookie|localStorage\.|sessionStorage\.|indexedDB\./i.test(text),
      ]).toEqual([f, false]);
    }
  });
});

describe('the browser asks no third party (invariant 7)', () => {
  const csp = /\n\t\tContent-Security-Policy "([^"]+)"/.exec(SITE)?.[1] ?? '';
  const directives = csp.split(';').map((d) => d.trim().split(/\s+/));

  it('has no source in the CSP but self, none and data:', () => {
    expect(directives.length).toBeGreaterThan(8);
    expect(csp).not.toMatch(/https?:|wss?:|\*/);
    for (const [name, ...values] of directives) {
      if (name === 'upgrade-insecure-requests' || name === 'report-to') continue;
      for (const v of values) expect([name, ["'self'", "'none'", 'data:'].includes(v)]).toEqual([name, true]);
    }
    expect(directives.find(([n]) => n === 'connect-src')).toEqual(['connect-src', "'self'"]);
  });
});

describe('no CDN unless the break-glass is armed (D20)', () => {
  it('the runtime config says cdn from RWS_CDN_NAME, which every committed default leaves empty', () => {
    for (const src of [SITE, OWNER_SITE]) expect(src).toContain('"cdn":"{$RWS_CDN_NAME}"');
    // Armed means a name here and trusted proxies in /etc/rws/rws.env: neither has a committed value.
    expect(COMPOSE).toContain(dflt('RWS_CDN_NAME'));
    expect(COMPOSE).toContain(dflt('RWS_TRUSTED_PROXIES'));
    expect(COMPOSE_OWNER).toContain(dflt('RWS_CDN_NAME'));
    for (const file of ['deploy/host/bootstrap.sh', 'deploy/tests/e2e/run.sh'])
      for (const m of read(file).matchAll(/^\s*RWS_(?:CDN_NAME|TRUSTED_PROXIES)=(.*)$/gm))
        expect([file, m[1]]).toEqual([file, '']);
    expect(read('.github/workflows/ci.yml')).not.toMatch(/RWS_(?:CDN_NAME|TRUSTED_PROXIES)=\S/);
  });

  it('and the runbook that arms it says it is not enabled', () => {
    const runbook = read('docs/runbooks/cdn-break-glass.md');
    expect(runbook).toContain('Pre-written, **not enabled**');
    expect(runbook).toContain('RWS_CDN_NAME');
  });
});
