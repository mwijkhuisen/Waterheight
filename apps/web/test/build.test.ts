import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANARY_RENDERINGS } from '@rws/contracts';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { i18nHtml, keyDrift } from '../i18n-html.ts';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rws-web-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('web build', () => {
  const out = join(tmp, 'dist');
  const page = (p: string) => readFileSync(join(out, p), 'utf8');

  beforeAll(async () => {
    // Vitest sets NODE_ENV=test, which makes Vite bundle React's development build: build as the CLI does.
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await build({ root: webDir, logLevel: 'silent', build: { outDir: out, emptyOutDir: true, manifest: true } });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it.each([
    ['index.html', 'nl', 'Rivierstanden', 'geen officiële waarschuwingsdienst'],
    ['en/index.html', 'en', 'River levels', 'not an official warning service'],
  ])('%s is the static %s page shell with its title and <main>', (file, lang, title, notice) => {
    const html = page(file);
    expect(html).toMatch(new RegExp(`<html lang="${lang}">`));
    expect(html).toContain(`<title>${title}</title>`);
    // The app mounts into #app and replaces the shell; until then (and without JavaScript) the page is this <main>.
    expect(html).toMatch(new RegExp(`<div id="app">\\s*<main>\\s*<h1>${title}</h1>\\s*<p>`));
    expect(html).toContain(notice);
    expect(html).not.toMatch(/%m:/);
  });

  it.each(['index.html', 'en/index.html'])('%s makes no third-party request (invariant 7)', (file) => {
    // Every src/href is a same-origin path; no scheme, no protocol-relative URL.
    const refs = [...page(file).matchAll(/\s(?:src|href)="([^"]*)"/g)].map(([, v]) => v);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^\/(?!\/)/);
  });

  it.each(['index.html', 'en/index.html'])('%s has no inline script, style or handler', (file) => {
    const html = page(file);
    // Every <script> (any case) is an external file with an empty body.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    expect(html.match(/<script\b/gi)).toHaveLength(scripts.length);
    for (const [, attrs = '', body = ''] of scripts) {
      expect(attrs).toMatch(/\ssrc="\/assets\/[^"]+\.js"/);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
  });

  it('never ships the P3 map spike (it exists only in `--mode e2e`)', () => {
    const files = readdirSync(out, { recursive: true, encoding: 'utf8' });
    expect(files.filter((f) => f.includes('_spike'))).toEqual([]);
    for (const f of files.filter((f) => /\.(html|js|css)$/.test(f))) {
      expect(readFileSync(join(out, f), 'utf8'), f).not.toMatch(/__spike|Kaartproef|Map spike/);
    }
  });

  it('serves the third-party notices of every npm package in the bundle (KG-108), none of ours', () => {
    const text = page('third-party-notices.txt');
    // The lazy map, polyfill and chart chunks are in the bundle too, so their packages are named.
    for (const header of [
      'react@19.3.0 — MIT',
      'react-dom@19.3.0 — MIT',
      'maplibre-gl@6.11.1 — BSD-3-Clause',
      'pmtiles@4.5.0 — BSD-3-Clause',
      'temporal-polyfill@1.0.5 — MIT',
      'echarts@6.1.0 — Apache-2.0',
      'zrender@6.1.0 — BSD-3-Clause',
      'tslib@2.3.0 — 0BSD',
      '@tanstack/react-query@5.103.2 — MIT',
      '@tanstack/query-core@5.103.2 — MIT',
      'zod@4.6.5 — MIT',
    ])
      expect(text, header).toContain(`\n${header}\n`);
    expect(text).toContain('Permission is hereby granted'); // MIT
    expect(text).toContain('Redistribution and use in source and binary forms'); // BSD-3-Clause
    expect(text).toMatch(/Apache License\s+Version 2\.0, January 2004/); // ECharts
    expect(text).not.toContain('@rws/');
    const commit = readdirSync(join(webDir, 'public/assets/map'))[0];
    expect(text).toContain(`/assets/map/${commit}/LICENSES.md`);
    expect(text).toContain('© OpenStreetMap contributors · Protomaps');
  });

  it('never ships the e2e test hook (`window.__rws`) or the e2e seed ids; both exist only in `--mode e2e`', () => {
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const e of files) {
      const path = join(e.parentPath, e.name);
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toContain('__rws');
      expect(text, path).not.toContain('nl.e2e.');
    }
  });

  it('ships no canary rendering and no registry or health internal of @rws/contracts (invariant 11, SR-1)', () => {
    // The public static files are a public output: the owner canary appears in none, the withheld one nowhere.
    // The web uses only the API contract and the units; `sideEffects: false` lets the bundler drop the rest.
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(CANARY_RENDERINGS.length).toBe(4);
    for (const e of files) {
      const path = join(e.parentPath, e.name);
      const text = readFileSync(path, 'utf8');
      for (const needle of [...CANARY_RENDERINGS, 'private_basis', 'owner_sources', 'licence_gate'])
        expect(text.includes(needle), `${path}: ${needle}`).toBe(false);
    }
  });

  // P10a (plan C1, C13): the owner site runs this same build, so the build may hold the owner's schemas and labels
  // only in the lazy owner chunks, and never anything that names the owner site, its secret or a private basis.
  it('keeps the owner chunks out of every page’s initial load, and the canary spelling inside them', () => {
    type Chunk = { file: string; imports?: string[]; isDynamicEntry?: boolean };
    const manifest = JSON.parse(page('.vite/manifest.json')) as Record<string, Chunk>;
    const owner = Object.entries(manifest)
      .filter(([src, c]) => src.startsWith('src/features/owner/') && c.isDynamicEntry === true)
      .map(([, c]) => c.file);
    // contracts.ts (the owner schemas), labels.gen.ts (BE-3, LU-4 labels) and index.ts (the banner).
    expect(owner).toHaveLength(3);
    const ownerLabelPrefixes = (
      parse(readFileSync(join(webDir, '../../registry/sources.yaml'), 'utf8')) as {
        sources: { id: string; audience: string }[];
      }
    ).sources
      .filter((x) => x.audience === 'owner')
      .map((x) => `lbl_${x.id.toLowerCase().replaceAll('-', '_')}_`);
    expect(ownerLabelPrefixes).toContain('lbl_be_3_');
    const byFile = new Map(Object.values(manifest).map((c) => [c.file, c]));
    const closure = (entry: string) => {
      const seen = new Set<string>();
      const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        for (const key of byFile.get(file)?.imports ?? []) {
          const dep = manifest[key];
          if (dep !== undefined) visit(dep.file);
        }
      };
      visit(entry);
      return seen;
    };
    for (const html of ['index.html', 'en/index.html']) {
      const entries = [...page(html).matchAll(/\ssrc="\/(assets\/[^"]+\.js)"/g)].flatMap(([, s]) => (s ? [s] : []));
      expect(entries.length).toBeGreaterThan(0);
      for (const file of entries.flatMap((e) => [...closure(e)])) {
        expect(owner, `${html} → ${file}`).not.toContain(file);
        // static-owner's own refinement text: the owner sources schema is in no file a public page loads.
        expect(page(file), `${html} → ${file}`).not.toContain('an owner source has a private basis');
        // The owner label index and texts (lbl_be_3_…, lbl_lu_4_…) live in the owner chunk only (security review round 1).
        for (const prefix of ownerLabelPrefixes) expect(page(file), `${html} → ${file}`).not.toContain(prefix);
      }
    }
    const files = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));
    const withCanary = files.filter((f) => page(f).includes('CANARY-'));
    expect(withCanary.length).toBeGreaterThan(0);
    for (const f of withCanary) expect(owner, f).toContain(f);
  });

  it('names no owner host, port, secret, path or private-basis clause in any file (invariant 11, T-OWN-1)', () => {
    const sources = (
      parse(readFileSync(join(webDir, '../../registry/sources.yaml'), 'utf8')) as {
        sources: { id: string; audience: string; private_basis?: { clause: string } }[];
      }
    ).sources.filter((s) => s.audience === 'owner');
    expect(sources.length).toBeGreaterThanOrEqual(4);
    const clauses = sources.map((s) => (s.private_basis?.clause ?? '').replace(/\s+/g, ' ').trim().slice(0, 60));
    for (const c of clauses) expect(c.length, 'every owner source states its clause').toBeGreaterThan(20);
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    for (const e of files) {
      const path = join(e.parentPath, e.name);
      const text = readFileSync(path, 'utf8');
      const flat = text.replace(/\s+/g, ' ');
      for (const needle of ['api-owner', 'owner_basic_auth', '/srv/rws/owner', ':8443', ...clauses])
        expect(flat.includes(needle), `${path}: ${needle}`).toBe(false);
      expect(text, path).not.toMatch(/\bowner\.(?:localhost|[a-z0-9-]+\.(?:info|example|test|local))\b/);
    }
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
