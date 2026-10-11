import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './catalogue.ts';

// The production compose files carry nothing of the CI overlays (P12a, ADR-0019): no fake upstream, no extra CA, no
// /ci/ path; every service is bounded and hardened; the public api and caddy share at most half of the 4 vCPU so
// ingestion (capture, load, db) keeps the rest.

type Service = Record<string, unknown> & { image?: string };
const FILES = ['deploy/compose.yaml', 'deploy/compose.owner.yaml'];
const load = (rel: string) => {
  const text = readFileSync(join(repoRoot, rel), 'utf8');
  return { text, doc: parse(text, { merge: true }) as { services: Record<string, Service>; networks?: object } };
};

describe.each(FILES)('%s', (rel) => {
  const { text, doc } = load(rel);
  const live = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('has no fake upstream, extra hosts, extra CA or CI path', () => {
    expect(live).not.toMatch(/extra_hosts|NODE_EXTRA_CA_CERTS|\/ci\//);
    for (const name of [...Object.keys(doc.services), ...Object.keys(doc.networks ?? {})])
      expect(name, name).not.toMatch(/^fake/);
  });

  it('bounds and hardens every service', () => {
    for (const [name, s] of Object.entries(doc.services)) {
      if (!s.image) continue; // an overlay of the db service adds networks only
      for (const key of ['mem_limit', 'cpus', 'pids_limit', 'restart'] as const)
        expect(s[key], `${name}.${key}`).toBeDefined();
      expect(s.read_only, `${name}.read_only`).toBe(true);
      expect(s.cap_drop, `${name}.cap_drop`).toEqual(['ALL']);
      expect(s.security_opt, `${name}.security_opt`).toContain('no-new-privileges:true');
    }
  });
});

describe('the ingestion priority budget', () => {
  it('gives the api and caddy at most 2.0 of the 4 vCPU', () => {
    const { doc } = load('deploy/compose.yaml');
    const api = doc.services.api?.cpus as number;
    const caddy = doc.services.caddy?.cpus as number;
    expect(api + caddy).toBeLessThanOrEqual(2);
  });
});
