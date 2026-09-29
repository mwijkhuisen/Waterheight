import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { VERSION } from '../apps/server/src/capture/env.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { repoRoot } from './catalogue.ts';

// deploy/reachability.yaml (issue #16 P1b build item 12; catalogue §10 R7): the
// targets cover every first-release host, and every signature passes a real
// recorded payload but none of the block pages a datacentre IP gets instead.

type Target = { id: string; source: string; required: boolean; url: string; sig: string; fixture?: string };
const targets = (parse(readFileSync(join(repoRoot, 'deploy/reachability.yaml'), 'utf8')) as { targets: Target[] })
  .targets;

/** grep -E over the first 64 KB (line anchors), or magic:<hex> on the first bytes, as rws-reachability does. */
function matches(sig: string, body: Buffer): boolean {
  if (sig.startsWith('magic:')) {
    const hex = sig.slice(6);
    return body.subarray(0, hex.length / 2).toString('hex') === hex;
  }
  return new RegExp(sig, 'm').test(body.subarray(0, 65_536).toString('latin1'));
}

/** Hosts in the allowlist that no spec requests (DE-4 and DE-5 are off; listed under DE-1). */
const NO_SPEC = ['pegelonline.wsv.de'];

// What a blocked datacentre address gets instead of data (catalogue §10 R7).
const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const BLOCK_PAGES: Record<string, Buffer> = {
  'a 200 "blocked" PNG tile': PNG_1X1,
  'a Cloudflare challenge': Buffer.from(
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><div id="challenge-error-text">Enable JavaScript and cookies to continue</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
  ),
  'an Azure APIM error': Buffer.from(
    '{ "statusCode": 401, "message": "Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API." }',
  ),
  "Hub'Eau's abuse page": Buffer.from(
    "<html><body><h1>Service indisponible</h1><p>Votre adresse IP a été bloquée suite à un usage abusif de l'API.</p></body></html>",
  ),
  'an empty 200': Buffer.alloc(0),
};

describe('deploy/reachability.yaml', () => {
  it('has a target on every host capture fetches from, owner hosts included', () => {
    const hosts = new Set([...loadRegistry().hosts.values()].flat());
    const covered = new Set(targets.map((t) => new URL(t.url).hostname));
    for (const host of hosts) if (!NO_SPEC.includes(host)) expect(covered, host).toContain(host);
  });

  it('every signature passes the recorded payload it names', () => {
    for (const t of targets.filter((x) => x.fixture !== undefined)) {
      expect(matches(t.sig, readFileSync(join(repoRoot, t.fixture as string))), t.id).toBe(true);
    }
    // Every required provider target is tied to a fixture, except the ones with no committed payload.
    const untested = targets.filter((t) => t.required && t.fixture === undefined).map((t) => t.id);
    expect(untested).toEqual(['ch-1-lindas', 'github-releases', 'ghcr', 'sigstore-tuf', 'docker-apt']);
  });

  it('no signature passes a block page, so a blocked address never counts as reachable', () => {
    for (const t of targets) {
      for (const [page, body] of Object.entries(BLOCK_PAGES))
        expect(matches(t.sig, body), `${t.id} vs ${page}`).toBe(false);
    }
  });

  it("sends no key and uses the version of capture's User-Agent", () => {
    expect(JSON.stringify(targets).toLowerCase()).not.toMatch(/x-api-key|apikey|token=|key=/);
    const script = readFileSync(join(repoRoot, 'deploy/bin/rws-reachability'), 'utf8');
    expect(script).toContain(`ua="rivierstanden/${VERSION} (+https://$RWS_DOMAIN/over; $RWS_CONTACT_EMAIL)"`);
    expect(script).not.toMatch(/\s(-L|--location|-k|--insecure)\s/);
  });
});
