import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The CI e2e job (P3) must test what production runs: the Playwright image is
// the version of the installed @playwright/test, and Caddy is the very image
// the web image is built FROM.

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const ci = read('.github/workflows/ci.yml');
const env = (name: string) => new RegExp(`^\\s+${name}: (\\S+)$`, 'm').exec(ci)?.[1];

describe('e2e job pins', () => {
  it('runs the Playwright image of the pinned @playwright/test version, by digest', () => {
    const image = env('PLAYWRIGHT_IMAGE') ?? '';
    const pkg = JSON.parse(read('apps/web/package.json'));
    expect(image).toMatch(/^mcr\.microsoft\.com\/playwright:v[0-9.]+-noble@sha256:[0-9a-f]{64}$/);
    expect(/:v([0-9.]+)-/.exec(image)?.[1]).toBe(pkg.devDependencies['@playwright/test']);
  });

  it('hands the deploy job the same Playwright image (P9a: run.sh drives degraded.spec.ts in it)', () => {
    const all = [...ci.matchAll(/^\s+PLAYWRIGHT_IMAGE: (\S+)$/gm)].map((m) => m[1]);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(new Set(all).size).toBe(1);
    expect(ci).toContain('sudo --preserve-env=PLAYWRIGHT_IMAGE deploy/tests/e2e/run.sh');
  });

  it('serves the e2e build with the Caddy image the web image is built from', () => {
    const from = /^FROM (caddy:\S+)$/m.exec(read('deploy/web/Dockerfile'))?.[1];
    expect(from).toBeDefined();
    expect(env('CADDY_IMAGE')).toBe(from);
  });

  // #217: `alone` are the projects a leg runs after the rest of it, one test at a time.
  const legs: { projects: string; alone?: string }[] = parse(ci).jobs.e2e.strategy.matrix.include;
  const words = (s = '') => s.split(' ').filter((w) => w !== '');

  it('runs every Playwright project in exactly one leg of the e2e matrix', () => {
    const inLegs = legs.flatMap((leg) => [...words(leg.projects), ...words(leg.alone)]);
    const config = read('apps/web/e2e/playwright.config.ts');
    const projects = new Set([...config.matchAll(/\bname: '([a-z0-9-]+)'/g)].map((m) => m[1]));
    expect(new Set(inLegs).size).toBe(inLegs.length);
    expect(new Set(inLegs)).toEqual(projects);
  });

  it('runs Lighthouse and fps alone: after the rest of their leg, one test at a time, without their dependencies', () => {
    expect(legs.flatMap((leg) => words(leg.alone)).sort()).toEqual(['fps', 'lighthouse']);
    expect(ci).toContain('--no-deps --workers=1 --output=test-results/alone || rc=$?');
  });

  it('hands each leg its projects and its alone projects (review CR-1)', () => {
    expect(ci).toMatch(/^ {6}E2E_PROJECTS: \$\{\{ matrix\.projects \}\}$/m);
    expect(ci).toMatch(/^ {6}E2E_ALONE: \$\{\{ matrix\.alone \}\}$/m);
    expect(ci).toContain('for p in $E2E_PROJECTS; do args+=(--project="$p"); done');
    expect(ci).toContain('for p in $E2E_ALONE; do alone+=(--project="$p"); done');
  });
});

describe('the ci gate', () => {
  const jobs: Record<string, { needs?: string[]; steps: { uses?: string }[] }> = parse(ci).jobs;

  it('needs every other job of the workflow', () => {
    expect([...(jobs.ci?.needs ?? [])].sort()).toEqual(
      Object.keys(jobs)
        .filter((name) => name !== 'ci')
        .sort(),
    );
  });

  it('starts every job with harden-runner', () => {
    for (const [name, job] of Object.entries(jobs))
      expect(job.steps[0]?.uses, name).toMatch(/^step-security\/harden-runner@/);
  });
});
