import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { i18nHtml, keyDrift } from '../i18n-html.ts';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rws-web-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('web build', () => {
  const out = join(tmp, 'dist');
  const page = (p: string) => readFileSync(join(out, p), 'utf8');

  beforeAll(async () => {
    await build({ root: webDir, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  }, 60_000);

  it.each([
    ['index.html', 'nl', 'Rivierstanden', 'Hallo'],
    ['en/index.html', 'en', 'River levels', 'Hello'],
  ])('%s is static %s with its title and <main>', (file, lang, title, hello) => {
    const html = page(file);
    expect(html).toMatch(new RegExp(`<html lang="${lang}">`));
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toMatch(new RegExp(`<main id="app">\\s*<h1>${hello}</h1>`));
    expect(html).not.toMatch(/%m:/);
  });

  it.each(['index.html', 'en/index.html'])('%s has no inline script, style or handler', (file) => {
    const html = page(file);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\ssrc="\/assets\/[^"]+\.js"/);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
  });
});

describe('i18n guard', () => {
  function project(name: string, html: string, nl: object, en: object) {
    const dir = join(tmp, name);
    const messages = join(dir, 'messages');
    mkdirSync(messages, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
    writeFileSync(join(messages, 'nl.json'), JSON.stringify(nl));
    writeFileSync(join(messages, 'en.json'), JSON.stringify(en));
    return build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      plugins: [i18nHtml({ messagesDir: messages, locales: ['nl', 'en'] })],
      build: { outDir: join(dir, 'dist'), emptyOutDir: true },
    });
  }

  it('fails the build when a page uses a key that does not exist', async () => {
    await expect(
      project('missing', '<html lang="nl"><title>%m:nope%</title></html>', { a: 'x' }, { a: 'y' }),
    ).rejects.toThrow(/message "nope" is missing in nl\.json/);
  });

  it('fails the build when NL and EN define different keys', async () => {
    await expect(
      project('drift', '<html lang="nl"><title>%m:a%</title></html>', { a: 'x', b: 'z' }, { a: 'y' }),
    ).rejects.toThrow(/message "b" is missing in en\.json/);
  });

  it('fails the build for a page in an unknown language', async () => {
    await expect(
      project('lang', '<html lang="de"><title>%m:a%</title></html>', { a: 'x' }, { a: 'y' }),
    ).rejects.toThrow(/<html lang> must be one of nl, en/);
  });

  it('the committed message files have no drift', () => {
    const load = (l: string) => JSON.parse(readFileSync(join(webDir, 'messages', `${l}.json`), 'utf8'));
    expect(
      keyDrift(
        new Map([
          ['nl', load('nl')],
          ['en', load('en')],
        ]),
      ),
    ).toEqual([]);
  });
});
