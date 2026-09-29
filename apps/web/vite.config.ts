import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { i18nHtml } from './i18n-html.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// NL at /, EN at /en/ (A§10). Two static pages; one bundle.
export default defineConfig({
  plugins: [react(), i18nHtml({ messagesDir: here('./messages'), locales: ['nl', 'en'] })],
  build: {
    // The CSP allows no inline script or style (A§12.2): keep everything in files.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { nl: here('./index.html'), en: here('./en/index.html') },
    },
  },
});
