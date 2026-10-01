import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The e2e build (`vite build --mode e2e`, P3): MapLibre and pmtiles reach the
// browser only as lazy chunks, the MapLibre worker is its own same-origin
// file, and the polyfill and the styles load on demand.

const webDir = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rws-web-e2e-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Chunk {
  file: string;
  isDynamicEntry?: boolean;
  imports?: string[];
}

describe('e2e build', () => {
  const out = join(tmp, 'dist-e2e');
  let manifest: Record<string, Chunk> = {};
  const read = (file: string) => readFileSync(join(out, file), 'utf8');
  const pages = ['index.html', 'en/index.html', '_spike/index.html', 'en/_spike/index.html'];

  beforeAll(async () => {
    await build({
      root: webDir,
      mode: 'e2e',
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true, manifest: true },
    });
    manifest = JSON.parse(read('.vite/manifest.json'));
  }, 120_000);

  /** Every file a page loads before any dynamic import runs: its scripts and their static imports. */
  function initialLoad(page: string): Set<string> {
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
    for (const [, src] of read(page).matchAll(/\s(?:src|href)="\/(assets\/[^"]+\.js)"/g)) if (src) visit(src);
    return seen;
  }

  it('builds both spike pages, each loading its own entry script', () => {
    for (const page of pages) expect(initialLoad(page).size, page).toBeGreaterThan(0);
    expect(read('_spike/index.html')).toMatch(/<html lang="nl">/);
    expect(read('en/_spike/index.html')).toMatch(/<html lang="en">/);
  });

  it('keeps MapLibre, pmtiles, the polyfill and the styles out of every page’s initial load', () => {
    const map = manifest['src/features/map/createMap.ts'];
    expect(map?.isDynamicEntry).toBe(true);
    const mapCode = read(map?.file ?? '');
    expect(mapCode).toContain('Wrong magic number for PMTiles'); // pmtiles is in the lazy map chunk
    expect(mapCode).toMatch(/\/assets\/maplibre-gl-worker-[^"'`/]+\.js/); // and names the worker file
    for (const page of pages) {
      for (const file of initialLoad(page)) {
        const code = read(file);
        expect(code, `${page} → ${file}`).not.toContain('Wrong magic number for PMTiles');
        expect(code, `${page} → ${file}`).not.toMatch(/maplibregl-canvas|Temporal\.Now/);
        expect(file, `${page} → ${file}`).not.toBe(map?.file);
      }
    }
    for (const key of ['src/features/map/styles/style-nl.json', 'src/features/map/styles/style-en.json'])
      expect(manifest[key]?.isDynamicEntry, key).toBe(true);
    const polyfill = Object.entries(manifest).find(([key]) => key.includes('temporal-polyfill'));
    expect(polyfill?.[1].isDynamicEntry).toBe(true);
  });

  it('emits the MapLibre worker as one same-origin module file, never a blob', () => {
    const workers = readdirSync(join(out, 'assets')).filter((f) => /^maplibre-gl-worker-.+\.js$/.test(f));
    expect(workers).toHaveLength(1);
    expect(read(join('assets', workers[0] ?? ''))).not.toMatch(/^\s*import\s/m); // the shared code is bundled in
    const all = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));
    for (const f of all) expect(read(f), f).not.toMatch(/\?worker&inline|new Blob\(\[[^\]]*maplibre-gl-worker/);
  });
});
