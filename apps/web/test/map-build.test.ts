import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The e2e build (`vite build --mode e2e`, P3): MapLibre and pmtiles reach the
// browser only as lazy chunks, the MapLibre worker is its own same-origin
// file, and the polyfill and the styles load on demand. P4b adds the ECharts
// chunk (also lazy) and the initial-load budget of issue #19.

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
  // The two map shells, the two 404 shells (P10b: Caddy serves them with status 404 for a path that is no page) and the
  // two spike pages. The information pages are the map's shells: Caddy serves index.html for them.
  const shells = ['index.html', 'en/index.html', '404.html', 'en/404.html'];
  const pages = [...shells, '_spike/index.html', 'en/_spike/index.html'];

  beforeAll(async () => {
    // Vitest sets NODE_ENV=test, which makes Vite bundle React's development build (about 60% more gzip than the
    // CLI build that ships): build as the CLI does, or the budget below would measure the wrong bundle.
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await build({
        root: webDir,
        mode: 'e2e',
        logLevel: 'silent',
        build: { outDir: out, emptyOutDir: true, manifest: true },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    manifest = JSON.parse(read('.vite/manifest.json'));
  }, 120_000);

  const byFile = () => new Map(Object.values(manifest).map((c) => [c.file, c]));

  /** `files` and everything they import statically, as built files. */
  function staticClosure(files: Iterable<string>): Set<string> {
    const chunks = byFile();
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const key of chunks.get(file)?.imports ?? []) {
        const dep = manifest[key];
        if (dep !== undefined) visit(dep.file);
      }
    };
    for (const file of files) visit(file);
    return seen;
  }

  /** Every file a page loads before any dynamic import runs: its scripts and their static imports. */
  function initialLoad(page: string): Set<string> {
    const scripts = [...read(page).matchAll(/\s(?:src|href)="\/(assets\/[^"]+\.js)"/g)].flatMap(([, src]) =>
      src ? [src] : [],
    );
    return staticClosure(scripts);
  }

  it('builds the four shells and both spike pages, each loading its own entry script', () => {
    for (const page of pages) expect(initialLoad(page).size, page).toBeGreaterThan(0);
    expect(read('404.html')).toMatch(/<html lang="nl">/);
    expect(read('en/404.html')).toMatch(/<html lang="en">/);
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

  // Issue #19: "Initial JS ≤ 250 KB gzip, excluding the lazy MapLibre and ECharts chunks". P10b: the same budget for the 404
  // shells (they load the same app) as for the map's, which now also carries the layout, the footer and the credits.
  it.each(shells)('%s: the initial JavaScript is at most 250 KB gzip', (page) => {
    const files = [...initialLoad(page)].filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    const gzip = files.reduce((sum, f) => sum + gzipSync(readFileSync(join(out, f))).length, 0);
    console.log(`initial JS of ${page}: ${gzip} bytes gzip (${(gzip / 1024).toFixed(1)} KiB) in ${files.join(', ')}`);
    for (const f of files) console.log(`  ${f}: ${gzipSync(readFileSync(join(out, f))).length} bytes gzip`);
    expect(gzip).toBeLessThanOrEqual(250 * 1024);
  });

  // P11b (issue #26): the reach layers, their colour and their spans are a lazy chunk of their own (the e2e build too,
  // where the specs read their feature-states).
  it('keeps the reach layers out of every page’s initial load, in a lazy chunk of their own', () => {
    const reach = manifest['src/features/flow/reaches/reachLayer.ts'];
    expect(reach?.isDynamicEntry).toBe(true);
    expect(read(reach?.file ?? '')).toContain('rivers-reach');
    for (const page of pages) {
      for (const file of initialLoad(page)) {
        expect(read(file), `${page} → ${file}`).not.toContain('rivers-reach');
        expect(file, `${page} → ${file}`).not.toBe(reach?.file);
      }
    }
  });

  it('keeps ECharts in its own lazy chunk, away from every initial load and from the map chunk', () => {
    const chart = manifest['src/features/station/chart.ts'];
    const map = manifest['src/features/map/createMap.ts'];
    expect(chart?.isDynamicEntry).toBe(true);
    expect(map?.isDynamicEntry).toBe(true);
    const chartCode = read(chart?.file ?? '');
    expect(chartCode).toContain('_echarts_instance_'); // ECharts is in the lazy chart chunk
    expect(chartCode).toContain('ecModel');
    for (const page of pages) {
      for (const file of initialLoad(page)) {
        const code = read(file);
        expect(code, `${page} → ${file}`).not.toMatch(/_echarts_instance_|ecModel/);
        expect(file, `${page} → ${file}`).not.toBe(chart?.file);
      }
    }
    // The chart chunk is not the map chunk, and neither loads the other or holds the other's code.
    expect(chart?.file).not.toBe(map?.file);
    expect(staticClosure([map?.file ?? '']).has(chart?.file ?? '')).toBe(false);
    expect(staticClosure([chart?.file ?? '']).has(map?.file ?? '')).toBe(false);
    expect(read(map?.file ?? '')).not.toMatch(/_echarts_instance_|ecModel/);
    expect(chartCode).not.toMatch(/Wrong magic number for PMTiles|maplibregl-canvas/);
    for (const file of staticClosure([chart?.file ?? ''])) expect(file).not.toMatch(/createMap|maplibre-gl-worker/);
  });
});
