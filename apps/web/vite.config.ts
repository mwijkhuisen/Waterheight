import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { i18nHtml } from './i18n-html.ts';
import { thirdPartyNotices } from './notices.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// NL at /, EN at /en/ (A§10). Two static pages; one bundle. `--mode e2e` adds
// the P3 map spike pages (/_spike/, /en/_spike/) into dist-e2e for the
// Playwright tests; the production build never contains them.
export default defineConfig(({ mode }) => {
  const e2e = mode === 'e2e';
  return {
    plugins: [react(), i18nHtml({ messagesDir: here('./messages'), locales: ['nl', 'en'] }), thirdPartyNotices()],
    // MapLibre's worker is bundled as an ES module worker served from our
    // origin; setWorkerUrl() points MapLibre at it (ADR-0016: no blob: worker).
    worker: { format: 'es' },
    build: {
      outDir: e2e ? 'dist-e2e' : 'dist',
      // The CSP allows no inline script or style (A§12.2): keep everything in files.
      assetsInlineLimit: 0,
      // MapLibre GL JS 6 alone is about 1.04 MB minified (283 KB gzip). It is a
      // lazy chunk, never part of a page's initial load (test/map-build.test.ts).
      chunkSizeWarningLimit: 1100,
      rolldownOptions: {
        // P10a: the lazy owner chunk shares @rws/contracts with the page, so the schemas move into a shared chunk
        // that main imports; without strict order that chunk ran before lib/zod.ts set `jitless` (a CSP eval probe).
        output: { strictExecutionOrder: true },
        // P10b: the 404 shells, which Caddy serves (with status 404) for a path that is no page; never under their
        // own name.
        input: {
          nl: here('./index.html'),
          en: here('./en/index.html'),
          not_found_nl: here('./404.html'),
          not_found_en: here('./en/404.html'),
          ...(e2e ? { spike_nl: here('./_spike/index.html'), spike_en: here('./en/_spike/index.html') } : {}),
        },
      },
    },
  };
});
