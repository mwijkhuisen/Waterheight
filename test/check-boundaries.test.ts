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
    expect(problems).toMatch(/parse\.ts: imports \.\.\/\.\.\/http\/client\.ts/);
    // `import { type X }` is still a runtime import (verbatimModuleSyntax).
    expect(problems).toMatch(/normalise\.ts: imports \.\.\/\.\.\/http\/client\.ts/);
  });

  it('fails when a view name appears outside audience.ts: TypeScript, tests, scripts and SQL', () => {
    // The names are assembled here: this file is scanned by the same rule.
    const view = (family: string, name: string) => `view name ${family}_${name} outside`;
    expect(fixture('view-name').sort()).toEqual([
      expect.stringContaining(`apps/server/src/load/q.sql: ${view('pub', 'forecast_run')}`),
      expect.stringContaining(`packages/core/src/sql.ts: ${view('pub', 'obs_latest')}`),
      expect.stringContaining(`scripts/report.ts: ${view('own', 'obs')}`),
      expect.stringContaining(`test/x.test.ts: ${view('pub', 'series')}`),
    ]);
  });
});
