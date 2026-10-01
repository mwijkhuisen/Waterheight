import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// P3 e2e (issue #18): the spike page on Chromium, Firefox and WebKit under the
// exact production headers. CI sets E2E_BASE_URL to the real Caddy serving
// dist-e2e (.github/workflows/ci.yml job e2e); without it the sandbox test
// server (server.ts) sends the same site.caddy headers. Both are HTTPS.
const external = process.env.E2E_BASE_URL;
const viewport = { width: 1024, height: 768 };

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  forbidOnly: true,
  use: { baseURL: external ?? 'https://localhost:4443', ignoreHTTPSErrors: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport } },
    {
      name: 'firefox',
      // Firefox refuses WebGL on a GL driver it does not trust; on a GPU-less runner that is Mesa's
      // software renderer under Xvfb (ci.yml). The page still has to create its own WebGL2 context.
      use: {
        ...devices['Desktop Firefox'],
        viewport,
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true } },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
  ],
  ...(external === undefined
    ? {
        webServer: {
          command: 'node e2e/server.ts',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          url: 'https://localhost:4443/healthz',
          ignoreHTTPSErrors: true,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      }
    : {}),
});
