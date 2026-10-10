import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './catalogue.ts';

// /.well-known/security.txt (P12a, RFC 9116): a fixed answer of deploy/web/site.caddy, parsed out of it here.
// RFC 9116 wants an Expires of at most a year ahead; this test fails 30 days before it lapses, so the date is renewed
// (by hand, in site.caddy) while the file is still valid, and fails when it is set more than a year ahead.

const site = readFileSync(join(repoRoot, 'deploy/web/site.caddy'), 'utf8');
const body = /respond <<SECURITY\n([\s\S]*?)\n\t*SECURITY 200/.exec(site)?.[1];
const fields = (body ?? '')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const i = l.indexOf(': ');
    return [l.slice(0, i), l.slice(i + 2)] as const;
  });
const all = (name: string) => fields.filter(([n]) => n === name).map(([, v]) => v);
const DAY = 86_400_000;

describe('security.txt in site.caddy', () => {
  it('is a fixed respond route, exact path, before the dotfile 404, with a plain-text type', () => {
    expect(body).toBeDefined();
    const route = site.indexOf("@security_txt expression `{path} == '/.well-known/security.txt'`");
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(site.indexOf('@dotfiles path_regexp'));
    const handle = site.slice(site.indexOf('handle @security_txt {'), site.indexOf('SECURITY 200'));
    expect(handle).toContain('header Content-Type "text/plain; charset=utf-8"');
    expect(handle).not.toMatch(/immutable|max-age/);
  });

  it('has the Contact lines (the mailbox of the domain, the GitHub advisory form), Preferred-Languages and Canonical', () => {
    expect(all('Contact')).toEqual([
      'mailto:security@{$RWS_DOMAIN}',
      'https://github.com/mwijkhuisen/Waterheight/security/advisories/new',
    ]);
    expect(all('Preferred-Languages')).toEqual(['nl, en']);
    expect(all('Canonical')).toEqual(['https://{$RWS_DOMAIN}/.well-known/security.txt']);
    // Never the planned production domain: the placeholder only.
    expect(body).not.toMatch(/https?:\/\/(?!github\.com\/mwijkhuisen\/Waterheight\/|\{\$RWS_DOMAIN\})/);
  });

  it('has exactly one Expires, an ISO 8601 UTC time', () => {
    expect(all('Expires')).toHaveLength(1);
    expect(all('Expires')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('expires more than 30 days from now and at most one year from now (renew it before it lapses)', () => {
    const expires = Date.parse(all('Expires')[0] ?? '');
    expect(Number.isNaN(expires)).toBe(false);
    const now = Date.now();
    expect(expires, 'security.txt Expires is less than 30 days away: renew it in site.caddy').toBeGreaterThan(
      now + 30 * DAY,
    );
    expect(expires, 'security.txt Expires is more than a year ahead (RFC 9116 §2.5.5)').toBeLessThanOrEqual(
      now + 366 * DAY,
    );
  });

  it('uses only the fields RFC 9116 defines', () => {
    const known = new Set(['Contact', 'Expires', 'Preferred-Languages', 'Canonical', 'Encryption', 'Acknowledgments']);
    for (const [name] of fields) expect(known.has(name), name).toBe(true);
  });
});
