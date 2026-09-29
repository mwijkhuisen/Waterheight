import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBom } from '../scripts/check-bom.ts';
import { repoRoot } from './catalogue.ts';

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch copy of everything check-bom reads. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rws-bom-'));
  copies.push(dir);
  const files = ['CLAUDE.md', 'package.json', 'pnpm-lock.yaml', '.node-version'];
  const dirs = [
    '.github/workflows',
    '.claude/hooks',
    'scripts',
    'apps/server',
    'apps/web',
    'packages/core',
    'packages/contracts',
  ];
  for (const f of files) cpSync(join(repoRoot, f), join(dir, f));
  for (const d of dirs) {
    cpSync(join(repoRoot, d), join(dir, d), {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|dist|fixtures)([/\\]|$)/.test(src),
    });
  }
  return dir;
}

function edit(dir: string, file: string, from: string | RegExp, to: string) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(from, to);
  if (next === text) throw new Error(`no change in ${file}`);
  writeFileSync(path, next);
}

describe('check-bom', () => {
  it('passes on the repository', () => {
    expect(checkBom(repoRoot)).toEqual([]);
  });

  it('passes on an unchanged scratch copy', () => {
    expect(checkBom(scratch())).toEqual([]);
  });

  it('fails on a wrong pin in a package.json', () => {
    const dir = scratch();
    edit(dir, 'apps/server/package.json', '"hono": "4.13.8"', '"hono": "4.13.9"');
    expect(checkBom(dir).join('\n')).toMatch(/hono@4\.13\.9: the bill of materials says 4\.13\.8/);
  });

  it('fails on a version range', () => {
    const dir = scratch();
    edit(dir, 'packages/contracts/package.json', '"zod": "4.6.5"', '"zod": "^4.6.5"');
    expect(checkBom(dir).join('\n')).toMatch(/zod@\^4\.6\.5: not an exact version/);
  });

  it('fails when the bill of materials drifts from the pins', () => {
    const dir = scratch();
    edit(dir, 'CLAUDE.md', '| vitest | npm | 5.0.1 |', '| vitest | npm | 5.0.2 |');
    expect(checkBom(dir).join('\n')).toMatch(/vitest@5\.0\.1: the bill of materials says 5\.0\.2/);
  });

  it('fails when a dependency has no row', () => {
    const dir = scratch();
    edit(dir, 'CLAUDE.md', /^\| yaml \| npm .*\n/m, '');
    expect(checkBom(dir).join('\n')).toMatch(/yaml@2\.9\.1: no installed npm row/);
  });

  it('fails when the lockfile does not match', () => {
    const dir = scratch();
    edit(dir, 'pnpm-lock.yaml', /(\n {6}hono:\n {8}specifier: )4\.13\.8/, '$14.13.7');
    expect(checkBom(dir).join('\n')).toMatch(/hono@4\.13\.8: pnpm-lock\.yaml has 4\.13\.7/);
  });

  it('fails on TypeScript 7', () => {
    const dir = scratch();
    edit(dir, 'CLAUDE.md', '| typescript | npm | 6.0.3 |', '| typescript | npm | 7.0.2 |');
    expect(checkBom(dir).join('\n')).toMatch(/TS 7 is forbidden/);
  });

  it('fails on a workflow action pinned to a SHA the BOM does not list', () => {
    const dir = scratch();
    edit(dir, '.github/workflows/ci.yml', '3d3c42e5aac5ba805825da76410c181273ba90b1', 'a'.repeat(40));
    expect(checkBom(dir).join('\n')).toMatch(/workflow uses actions\/checkout@a{40}/);
  });

  it('fails when .node-version drifts', () => {
    const dir = scratch();
    writeFileSync(join(dir, '.node-version'), '26.9.0\n');
    expect(checkBom(dir).join('\n')).toMatch(/node: \.node-version is 26\.9\.0/);
  });
});
