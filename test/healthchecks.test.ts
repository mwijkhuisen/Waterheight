import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GROUP_SLUGS, loadRegistry } from '../apps/server/src/capture/specs.ts';
import { repoRoot } from './catalogue.ts';

// deploy/healthchecks.yaml (issue #16 "P1a ↔ P1b contract"; P2a adds `load`): the
// 16 slugs, a timeout of each check's cadence and a grace of twice that (alert at
// 3 × cadence).

type Check = { slug: string; timeout: number; grace: number };
const checks = (parse(readFileSync(join(repoRoot, 'deploy/healthchecks.yaml'), 'utf8')) as { checks: Check[] }).checks;
const OPS: Record<string, number> = {
  backup: 3600, // hourly backup
  'restore-drill': 31 * 86_400, // monthly drill
  update: 300, // rws-update every 5 min
  watchdog: 300, // watchdog cycle every 5 min
  cert: 300,
  disk: 300,
  load: 300, // the watchdog pings it every 5 min from /api/v1/health (P2a)
};

describe('deploy/healthchecks.yaml', () => {
  it('has exactly the 16 contract slugs: the 9 capture groups and the 7 operations checks', () => {
    expect(checks.map((c) => c.slug).sort()).toEqual([...GROUP_SLUGS, ...Object.keys(OPS)].sort());
  });

  it('times each capture group at its shortest cadence from registry/capture.yaml', () => {
    for (const g of loadRegistry().groups) {
      expect(checks.find((c) => c.slug === g.slug)?.timeout, g.slug).toBe(g.cadence_s);
    }
  });

  it('times the operations checks at their job cadence, and every grace is twice the timeout', () => {
    for (const [slug, timeout] of Object.entries(OPS)) {
      expect(checks.find((c) => c.slug === slug)?.timeout, slug).toBe(timeout);
    }
    for (const c of checks) expect(c.grace, c.slug).toBe(2 * c.timeout);
  });

  it('rws-hc-sync sends exactly these checks, named by slug, with all integrations', () => {
    const r = spawnSync(join(repoRoot, 'deploy/bin/rws-hc-sync'), ['--dry-run'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const bodies = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(bodies).toEqual(checks.map((c) => ({ ...c, name: c.slug, channels: '*', tags: 'rws', unique: ['slug'] })));
  });
});
