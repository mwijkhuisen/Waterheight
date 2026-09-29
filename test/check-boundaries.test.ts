import { describe, expect, it } from 'vitest';
import { checkBoundaries } from '../scripts/check-boundaries.ts';
import { repoRoot } from './catalogue.ts';

const fixture = (name: string) => checkBoundaries(`${repoRoot}scripts/fixtures/boundaries/${name}`);

describe('check-boundaries', () => {
  it('passes on the repository', () => {
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });

  it('passes on the allowed-imports fixture', () => {
    expect(fixture('ok')).toEqual([]);
  });

  it('fails when apps/web imports apps/server', () => {
    expect(fixture('web-to-server')).toEqual([
      expect.stringMatching(/^apps\/web\/src\/bad\.ts: .*apps\/web must not import apps\/server/),
    ]);
  });

  it('fails when a package imports an app, by path and by package name', () => {
    const problems = fixture('packages-to-apps');
    expect(problems).toHaveLength(2);
    for (const p of problems) expect(p).toMatch(/packages must not import apps/);
    expect(problems.join('\n')).toContain('@rws/server');
  });

  it('fails when an adapter imports another adapter, another provider or an http value', () => {
    const problems = fixture('adapter-to-adapter').join('\n');
    expect(problems).toMatch(/imports \.\.\/de-1\/parse\.ts/);
    expect(problems).toMatch(/imports \.\.\/_shared\/wsv\/helper\.ts/);
    expect(problems).toMatch(/imports \.\.\/\.\.\/http\/client\.ts/);
  });

  it('fails when a view name appears outside audience.ts', () => {
    expect(fixture('view-name')).toEqual([expect.stringMatching(/view name pub_obs_latest outside/)]);
  });
});
