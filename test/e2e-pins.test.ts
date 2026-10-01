import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('serves the e2e build with the Caddy image the web image is built from', () => {
    const from = /^FROM (caddy:\S+)$/m.exec(read('deploy/web/Dockerfile'))?.[1];
    expect(from).toBeDefined();
    expect(env('CADDY_IMAGE')).toBe(from);
  });
});
