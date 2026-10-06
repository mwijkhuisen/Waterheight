import { readFileSync } from 'node:fs';
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

  it('rolls one file a day and keeps it for the published number of days', () => {
    expect(log).toContain('\t\t\troll_interval 24h\n');
    expect(log).toContain(`\t\t\troll_keep_for ${LOG.keepDays * 24}h\n`);
  });

  it('caps the beacon body at the published size', () => {
    expect(beaconCapKiB(src) * 1024).toBe(LOG.beaconMaxBytes);
  });
});

describe('beacon cap', () => {
  it('is the same at the api as on the privacy page', () => {
    expect(BEACON_MAX_BYTES).toBe(LOG.beaconMaxBytes);
  });
});
