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

/** The four static shells: the map in both languages, and the 404 page in both (the information pages are the map's). */
const SHELLS = ['index.html', 'en/index.html', '404.html', 'en/404.html'];

type Chunk = { file: string; imports?: string[]; isDynamicEntry?: boolean };

describe('web build', () => {
  const out = join(tmp, 'dist');
  const page = (p: string) => readFileSync(join(out, p), 'utf8');
  const manifestOf = () => JSON.parse(page('.vite/manifest.json')) as Record<string, Chunk>;
  /** `files` and everything they import statically, as built files. */
  function closureOf(manifest: Record<string, Chunk>, files: Iterable<string>): Set<string> {
    const byFile = new Map(Object.values(manifest).map((c) => [c.file, c]));
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const key of byFile.get(file)?.imports ?? []) {
        const dep = manifest[key];
        if (dep !== undefined) visit(dep.file);
      }
    };
    for (const file of files) visit(file);
    return seen;
  }
  /** What a shell loads before any dynamic import runs: its scripts and their static imports. */
  const initialLoad = (manifest: Record<string, Chunk>, html: string) =>
    closureOf(
      manifest,
      [...page(html).matchAll(/\ssrc="\/(assets\/[^"]+\.js)"/g)].flatMap(([, s]) => (s ? [s] : [])),
    );

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

  // P10b: Caddy serves these two with status 404 for any path that is no page. They hold the 404 page's own heading and
  // a link to the map, so the page says what it is before any script runs.
  it.each([
    ['404.html', 'nl', 'Pagina niet gevonden', 'Rivierstanden', '/'],
    ['en/404.html', 'en', 'Page not found', 'River levels', '/en/'],
  ])(
    '%s is the static %s 404 shell: its title, its heading and a link to the map',
    (file, lang, heading, site, home) => {
      const html = page(file);
      expect(html).toMatch(new RegExp(`<html lang="${lang}">`));
      expect(html).toContain(`<title>${heading} · ${site}</title>`);
      expect(html).toMatch(new RegExp(`<div id="app">\\s*<main>\\s*<h1>${heading}</h1>\\s*<p><a href="${home}">`));
      expect(html).not.toMatch(/%m:/);
    },
  );

  it.each(SHELLS)('%s makes no third-party request (invariant 7)', (file) => {
    // Every src/href is a same-origin path; no scheme, no protocol-relative URL.
    const refs = [...page(file).matchAll(/\s(?:src|href)="([^"]*)"/g)].map(([, v]) => v);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^\/(?!\/)/);
  });

  it.each(SHELLS)('%s has no inline script, style or handler', (file) => {
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
    const manifest = manifestOf();
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
    for (const html of SHELLS) {
      const initial = initialLoad(manifest, html);
      expect(initial.size).toBeGreaterThan(0);
      for (const file of initial) {
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

  // P10b (plan C1, C9): the text of the information pages is one lazy chunk per page and language, and the shells load none
  // of it; the footer's credits (MapCredits) are static, so the licence of the river network is in the entry's load.
  it('keeps the text of every information page in its own lazy chunk, out of every shell’s initial load', () => {
    const manifest = manifestOf();
    const names = ['nl', 'en'].flatMap((locale) => {
      const files = readdirSync(join(webDir, 'src/features/pages/content', locale));
      return files.map((f) => `src/features/pages/content/${locale}/${f}`);
    });
    // Eight pages in two languages, the same file names in each (scripts/check-i18n.ts holds the content rule).
    expect(names).toHaveLength(16);
    const initial = new Set(SHELLS.flatMap((html) => [...initialLoad(manifest, html)]));
    const files = new Set<string>();
    for (const key of names) {
      const chunk = manifest[key];
      expect(chunk?.isDynamicEntry, `${key} is a dynamic entry`).toBe(true);
      expect(initial.has(chunk?.file ?? ''), `${key} is in no shell's initial load`).toBe(false);
      files.add(chunk?.file ?? '');
    }
    expect(files.size, 'one chunk per page and language').toBe(16);
    // The router-less App reaches them only through the Page component's lazy imports.
    const dynamic = Object.keys(manifest).filter((k) => k.startsWith('src/features/pages/content/'));
    expect(dynamic.sort()).toEqual([...names].sort());
  });

  it('puts the ODbL in the entry script or a chunk it imports statically, as scripts/verify-prod.ts reads it', () => {
    // verify-prod's `rivers attribution`: the first script the page references, or its static imports (two levels, at
    // most ten files). The footer of every page names the licence of the river network, so it is in the entry's load.
    const staticImports = (js: string) => [
      ...new Set(
        [...js.matchAll(/(?:\bimport|\bfrom)\s*["']\.\/([A-Za-z0-9_.-]+\.js)["']/g)].map(([, f]) => `assets/${f}`),
      ),
    ];
    for (const html of SHELLS) {
      const entry = /<script[^>]*\ssrc="\/(assets\/[^"]+\.js)"/.exec(page(html))?.[1];
      expect(entry, html).toBeDefined();
      const first = staticImports(page(entry ?? ''));
      const second = first.flatMap((f) => staticImports(page(f)));
      const read = [...new Set([entry ?? '', ...first, ...second])].slice(0, 11);
      expect(
        read.some((f) => page(f).includes('ODbL')),
        `${html}: the ODbL is in the entry or its static imports`,
      ).toBe(true);
    }
  });

  it('has no personal-use source id and no canary in any chunk built from features/pages (invariant 11)', () => {
    const manifest = manifestOf();
    const owner = new Set(
      Object.entries(manifest)
        .filter(([src, c]) => src.startsWith('src/features/owner/') && c.isDynamicEntry === true)
        .map(([, c]) => c.file),
    );
    expect(owner.size).toBe(3);
    const entries = Object.entries(manifest).filter(([src]) => src.startsWith('src/features/pages/'));
    expect(entries.length).toBeGreaterThanOrEqual(16);
    // The chunks built from features/pages: each text and every chunk it imports statically that no shell loads at the
    // start (the parts: the lists, the tables, the links). The owner chunks are loaded dynamically, never by import,
    // so they are not among them; the shared initial chunks are not features/pages code.
    const initial = new Set(SHELLS.flatMap((html) => [...initialLoad(manifest, html)]));
    const chunks = [
      ...closureOf(
        manifest,
        entries.map(([, c]) => c.file),
      ),
    ].filter((f) => !initial.has(f));
    for (const file of chunks) expect(owner.has(file), `${file} is not an owner chunk`).toBe(false);
    // 16 texts, and at least the parts the data pages are made of.
    expect(chunks.length).toBeGreaterThan(20);
    for (const part of ['SourcesList', 'StatusTables', 'OfficialLinks'])
      expect(
        chunks.some((f) => f.startsWith(`assets/${part}-`)),
        part,
      ).toBe(true);
    const id = /\b(?:BE-3|LU-2|LU-3|LU-4|DE-2|DE-3)\b/;
    for (const file of chunks.filter((f) => f.endsWith('.js'))) {
      const code = page(file);
      expect(id.exec(code)?.[0], `${file}: a personal-use source id`).toBeUndefined();
      expect(code, `${file}: a canary`).not.toContain('CANARY-');
      // Nor the words of the private channel (message keys are identifiers: the sweep below reads them too).
      for (const needle of ['private_basis', 'owner_sources', 'licence_gate'])
        expect(code.includes(needle), `${file}: ${needle}`).toBe(false);
    }
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
