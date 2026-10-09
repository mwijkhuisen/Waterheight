import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// P3 e2e (issue #18), P4b (issue #19) and P10a (issue #25): the spike page and the real pages on Chromium, Firefox and
// WebKit under the exact production headers. CI sets E2E_BASE_URL to the real Caddy serving dist-e2e, with the e2e api
// behind it (.github/workflows/ci.yml job e2e), and E2E_OWNER_URL to the real owner Caddy (owner.caddy, basic_auth);
// without them the sandbox test server (server.ts) sends the same site.caddy headers, and a second instance of it in
// owner mode stands in for owner.caddy. All of them are HTTPS.
const external = process.env.E2E_BASE_URL;
// E2E_COMPOSE=1 (P9a): the compose stack of the deploy job is already running at E2E_COMPOSE_URL; only degraded.spec.ts
// runs, and no web server is started. With E2E_OWNER_SMOKE=1 (P10a, the same job's owner step) it is only
// owner-smoke.spec.ts, against the production build behind caddy-owner at E2E_OWNER_URL.
const compose = process.env.E2E_COMPOSE === '1';
const smoke = process.env.E2E_OWNER_SMOKE === '1';
const local = external === undefined && !compose;
const viewport = { width: 1024, height: 768 };

// The owner site: CI's real owner Caddy, or the stand-in on its own port. The password reaches the specs by the
// environment (CI generates it and masks it); the local one is a fixed throw-away.
const OWNER_PORT = 4444;
const OWNER_API_PORT = 4482;
const ownerUrl = process.env.E2E_OWNER_URL ?? (local ? `https://localhost:${OWNER_PORT}` : undefined);
const ownerPw = process.env.E2E_OWNER_PW ?? (local ? 'e2e-owner-local' : undefined);
const ownerPublish = join(tmpdir(), 'rws-e2e-owner-publish');

/** Files each kind of project runs. The public ones never run an owner spec (no credentials) or the tool specs. */
const OWNER = /owner[^/]*\.spec\.ts$/;
const PUBLIC_IGNORE = /(owner[^/]*|cvd|screens|lighthouse|fps|no-webgl2|visual)\.spec\.ts$/;

// P11b (issue #26 B3): the visual-regression project runs in CI's e2e job (its baselines come from the pinned Playwright
// image there) and locally only with VISUAL=1: a baseline made on another machine would never match.
const visual = !compose && (process.env.CI !== undefined || process.env.VISUAL === '1');

// Firefox refuses WebGL on a GL driver it does not trust; on a GPU-less runner that is Mesa's software renderer under
// Xvfb (ci.yml). The page still has to create its own WebGL2 context. No HTTP/3: the CI job's Caddy advertises h3
// (Alt-Svc) on a UDP port its container does not publish, and one CI run showed Firefox's own network-error page after
// a navigation (P4b review round 2, R2-CR-2). The site itself keeps h3 (production publishes 443/udp); this changes the
// runner, not an assertion.
const firefox = {
  ...devices['Desktop Firefox'],
  viewport,
  launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'network.http.http3.enable': false } },
};
const chromium = { ...devices['Desktop Chrome'], viewport };
const webkit = { ...devices['Desktop Safari'], viewport };

// The projects Lighthouse waits for, so that it measures with no other browser on the CPU (see `workers`).
const LIGHTHOUSE_AFTER = [
  'chromium',
  'firefox',
  'webkit',
  'no-webgl2',
  'cvd',
  ...(visual ? ['visual'] : []),
  ...(ownerUrl === undefined ? [] : ['owner-chromium', 'owner-firefox', 'owner-webkit']),
];

const ownerUse = {
  baseURL: ownerUrl ?? 'https://localhost:4444',
  httpCredentials: { username: 'owner', password: ownerPw ?? '' },
};

export default defineConfig({
  testDir: '.',
  testMatch: compose ? (smoke ? /owner-smoke\.spec\.ts$/ : /degraded\.spec\.ts$/) : /\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  // Files run in parallel, the tests of one file in order. The specs share nothing on the server side (the e2e api
  // answers reads on a fixed clock; every peer is loopback, so no rate limit), and each test has its own browser
  // context. CI's runner has 4 vCPUs and renders WebGL in software: 2 workers there. `--workers=N` overrides.
  workers: process.env.CI ? 2 : '50%',
  reporter: [['list']],
  forbidOnly: true,
  use: { baseURL: external ?? 'https://localhost:4443', ignoreHTTPSErrors: true },
  projects: [
    // (compose mode: the one project the deploy job names, `--project=chromium`)
    { name: 'chromium', testIgnore: compose ? [] : PUBLIC_IGNORE, use: chromium },
    ...(compose
      ? []
      : [
          { name: 'firefox', testIgnore: PUBLIC_IGNORE, use: firefox },
          { name: 'webkit', testIgnore: PUBLIC_IGNORE, use: webkit },
          // WebGL2 is not there at all (the GPU path off): the page shows the table (no-webgl2.spec.ts).
          {
            name: 'no-webgl2',
            testMatch: /no-webgl2\.spec\.ts$/,
            use: { ...chromium, launchOptions: { args: ['--disable-3d-apis'] } },
          },
          // The colour-vision-deficiency screenshots of the map and the legend (Chromium's CDP emulation), and P10d's
          // screenshots of the viewer for the owner's visual check (screens.spec.ts).
          { name: 'cvd', testMatch: /(cvd|screens)\.spec\.ts$/, use: chromium },
          // P11b (issue #26 B3, visual.spec.ts): three held playback scenes as screenshots, one fixed viewport, Chromium
          // only, baselines under visual/__screenshots__ (written by CI's pinned image, never by a developer machine).
          // maxDiffPixelRatio 0.002 (about 1,600 of 786,432 pixels) absorbs the software GL's anti-aliasing of the river
          // lines and the glyph rasterisation between two runs; a reach with the wrong colour or the hatch missing moves
          // far more than that.
          ...(visual
            ? [
                {
                  name: 'visual',
                  testMatch: /visual\.spec\.ts$/,
                  snapshotPathTemplate: '{testDir}/visual/__screenshots__/{arg}{ext}',
                  expect: { toHaveScreenshot: { animations: 'disabled' as const, maxDiffPixelRatio: 0.002 } },
                  use: chromium,
                },
              ]
            : []),
          // Lighthouse (C8): the spec starts Playwright's Chromium itself with --remote-debugging-port=9222 and
          // --ignore-certificate-errors, because a browser Playwright launches has no debugging port (lighthouse.spec.ts).
          // It runs after every other project (`dependencies`), alone, so parallel workers never skew its scores; to
          // run it on its own, add --no-deps.
          {
            name: 'lighthouse',
            testMatch: /lighthouse\.spec\.ts$/,
            use: chromium,
            dependencies: LIGHTHOUSE_AFTER,
          },
          // The frame rate of the map with the flow animation on (P11a, issue #26 C4, fps.spec.ts): Chromium's trace of
          // 10 s of timebar scrubbing, on desktop and on a throttled phone. After Lighthouse (which itself waits for every
          // other project), so that the two never run at once and each has the CPU to itself; to run it on its own, add
          // --no-deps. Its thresholds are fixed (owner decision D-B): a shortfall is reported, never tuned away.
          {
            name: 'fps',
            testMatch: /fps\.spec\.ts$/,
            use: chromium,
            dependencies: ['lighthouse'],
          },
          // The owner site (owner.spec.ts): its own origin and the basic-auth credentials, on three browsers.
          ...(ownerUrl === undefined
            ? []
            : [
                {
                  name: 'owner-chromium',
                  testMatch: OWNER,
                  testIgnore: /owner-smoke/,
                  use: { ...chromium, ...ownerUse },
                },
                {
                  name: 'owner-firefox',
                  testMatch: OWNER,
                  testIgnore: /owner-smoke/,
                  use: { ...firefox, ...ownerUse },
                },
                { name: 'owner-webkit', testMatch: OWNER, testIgnore: /owner-smoke/, use: { ...webkit, ...ownerUse } },
              ]),
        ]),
  ],
  ...(local
    ? {
        // P4b: the e2e api (a throw-away database on the PostgreSQL that DATABASE_URL names, a fixed clock) and
        // the stand-in for Caddy that proxies /api/v1/ to it. P10a: the same process also writes the owner tree and
        // serves the owner api (E2E_OWNER_PUBLISH_DIR), which a second stand-in in owner mode puts behind basic auth.
        webServer: [
          {
            command: 'node ../server/test/e2e/api.ts',
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: {
              HOST: '127.0.0.1',
              PORT: '4480',
              E2E_OWNER_PUBLISH_DIR: ownerPublish,
              E2E_OWNER_API_PORT: String(OWNER_API_PORT),
            },
            url: 'http://127.0.0.1:4480/healthz',
            reuseExistingServer: false,
            // P11b: the seed and the publish of nine settled days take about 3 minutes (174 s on a dev box).
            timeout: 300_000,
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
          {
            command: 'node e2e/server.ts',
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: {
              E2E_OWNER: '1',
              E2E_PORT: String(OWNER_PORT),
              E2E_OWNER_PW: ownerPw ?? '',
              E2E_OWNER_PUBLISH_DIR: ownerPublish,
              E2E_OWNER_API_PORT: String(OWNER_API_PORT),
            },
            // basic_auth answers every path with a 401: Playwright takes it as "up".
            url: `https://localhost:${OWNER_PORT}/healthz`,
            ignoreHTTPSErrors: true,
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ],
      }
    : {}),
});
