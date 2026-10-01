import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// P3 e2e (issue #18) and P4b (issue #19): the spike page and the real pages on
// Chromium, Firefox and WebKit under the exact production headers. CI sets
// E2E_BASE_URL to the real Caddy serving dist-e2e, with the e2e api behind it
// (.github/workflows/ci.yml job e2e); without it the sandbox test server
// (server.ts) sends the same site.caddy headers. Both are HTTPS.
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
        // No HTTP/3: the CI job's Caddy advertises h3 (Alt-Svc) on a UDP port its container does not publish, and one
        // CI run showed Firefox's own network-error page after a navigation (P4b review round 2, R2-CR-2). The site
        // itself keeps h3 (production publishes 443/udp); this changes the runner, not an assertion.
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'network.http.http3.enable': false } },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
  ],
  ...(external === undefined
    ? {
        // P4b: the e2e api (a throw-away database on the PostgreSQL that DATABASE_URL names, a fixed clock) and
        // the stand-in for Caddy that proxies /api/v1/ to it.
        webServer: [
          {
            command: 'node ../server/test/e2e/api.ts',
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: { HOST: '127.0.0.1', PORT: '4480' },
            url: 'http://127.0.0.1:4480/healthz',
            reuseExistingServer: false,
            timeout: 120_000,
          },
          {
            command: 'node e2e/server.ts',
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: { E2E_API_PORT: '4480' },
            url: 'https://localhost:4443/healthz',
            ignoreHTTPSErrors: true,
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ],
      }
    : {}),
});
