import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { type NoticePackage, noticesText, thirdPartyNotices, unlicensed } from '../notices.ts';

const tmp = mkdtempSync(join(tmpdir(), 'rws-notices-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const pkg = (
  name: string,
  version: string,
  license: string | undefined,
  ...files: [string, string][]
): NoticePackage => ({
  name,
  version,
  license,
  files: files.map(([name, text]) => ({ name, text })),
});

describe('noticesText', () => {
  const packages = [
    pkg('zeta', '2.0.0', 'ISC', ['LICENSE', 'ISC text\n']),
    pkg('@scope/alpha', '1.0.0', 'MIT', ['NOTICE', 'notice text'], ['LICENSE.md', 'MIT text']),
    pkg('zeta', '10.0.0', 'ISC', ['LICENSE', 'ISC text']),
  ];

  it('sorts packages by name (then version) and files by name, with a header per package', () => {
    const text = noticesText(packages, 'preamble');
    const order = ['@scope/alpha@1.0.0 — MIT', 'zeta@10.0.0 — ISC', 'zeta@2.0.0 — ISC'].map((h) =>
      text.indexOf(`\n${h}\n`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text.indexOf('--- LICENSE.md ---')).toBeLessThan(text.indexOf('--- NOTICE ---'));
    expect(text.startsWith('preamble\n\n')).toBe(true);
  });

  it('lists a package with a "license" field but no file, with a line saying so', () => {
    const text = noticesText([pkg('pmtiles', '4.5.0', 'BSD-3-Clause')], 'p');
    expect(text).toContain('\npmtiles@4.5.0 — BSD-3-Clause\n');
    expect(text).toContain('No licence file was shipped in this package.');
  });

  it('finds the packages with neither a file nor a "license" field', () => {
    const none = pkg('b-none', '1.0.0', undefined);
    const field = pkg('a-field', '1.0.0', 'MIT');
    const file = pkg('c-file', '1.0.0', undefined, ['LICENSE', 'text']);
    expect(unlicensed([none, field, file, pkg('a-none', '2.0.0', undefined)])).toEqual([
      'a-none@2.0.0',
      'b-none@1.0.0',
    ]);
    expect(unlicensed([field, file])).toEqual([]);
  });

  it('is deterministic: LF only, no BOM, one trailing newline, the same bytes for any input order', () => {
    const a = noticesText(packages, 'p');
    expect(noticesText([...packages].reverse(), 'p')).toBe(a);
    const messy = noticesText([pkg('x', '1.0.0', 'MIT', ['LICENSE', '﻿line one\r\nline two\r\n\r\n'])], 'p');
    expect(messy).toContain('--- LICENSE ---\nline one\nline two\n');
    expect(messy).not.toMatch(/\r|﻿|\n\n\n/);
    expect(messy.endsWith('line two\n')).toBe(true);
  });
});

describe('thirdPartyNotices on a synthetic project', () => {
  function project(name: string, packages: Record<string, Record<string, string>>) {
    const dir = join(tmp, name);
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    put('public/assets/map/abc1234/LICENSES.md', 'glyph licences');
    put('local.js', 'export const local = 1;');
    put(
      'main.js',
      `import { local } from './local.js';\n${Object.keys(packages)
        .map((p, i) => `import { v as v${i} } from '${p}';`)
        .join('\n')}\nconsole.log(local, ${Object.keys(packages)
        .map((_, i) => `v${i}`)
        .join(', ')});`,
    );
    for (const [pkgName, files] of Object.entries(packages)) {
      for (const [path, text] of Object.entries(files)) put(`node_modules/${pkgName}/${path}`, text);
    }
    return build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      plugins: [thirdPartyNotices()],
      build: { outDir: join(dir, 'dist'), emptyOutDir: true, rolldownOptions: { input: join(dir, 'main.js') } },
    }).then(() => readFileSync(join(dir, 'dist/third-party-notices.txt'), 'utf8'));
  }
  const manifest = (name: string, extra: object = {}) =>
    JSON.stringify({ name, version: '1.2.3', type: 'module', exports: './dist/index.js', ...extra });
  const body = 'console.log("pkg"); export const v = 1;';

  it('lists each package once, from its root (not the type-only sub-folder package.json), and skips local code', async () => {
    const text = await project('good', {
      'lic-pkg': {
        'package.json': manifest('lic-pkg', { license: 'MIT' }),
        'dist/package.json': '{"type":"module"}',
        'dist/index.js': body,
        LICENSE: 'MIT licence text',
        'licenses/LICENSE-other': 'a directory is not a top-level licence file',
      },
      '@sc/field-only': { 'package.json': manifest('@sc/field-only', { license: 'ISC' }), 'dist/index.js': body },
    });
    expect(text).toContain('\n@sc/field-only@1.2.3 — ISC\n');
    expect(text).toContain('\nlic-pkg@1.2.3 — MIT\n');
    expect(text).toContain('--- LICENSE ---\nMIT licence text\n');
    expect(text).not.toContain('a directory is not');
    expect(text).not.toContain('local.js');
    // Two packages and the two vendored fonts (P10c), each between two rules.
    expect(text.match(/^={72}$/gm)).toHaveLength(8);
    expect(text).toContain('Source Sans 3 (font, @fontsource/source-sans-3)@5.3.0 — OFL-1.1');
    expect(text).toContain('/assets/map/abc1234/LICENSES.md');
  });

  it('fails the build, naming the package, when it ships neither a licence file nor a "license" field', async () => {
    await expect(
      project('bad', {
        'bad-pkg': { 'package.json': manifest('bad-pkg', { version: '0.1.0' }), 'dist/index.js': body },
      }),
    ).rejects.toThrow(/no licence file and no "license" field: bad-pkg@0\.1\.0/);
  });
});
