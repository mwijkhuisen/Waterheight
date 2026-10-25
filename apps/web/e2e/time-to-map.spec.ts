import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from '@playwright/test';

// O4 (#220): the time to the base map's first idle (the `rws:map-idle` mark of createMap.ts: style + first tiles, no data)
// on a throttled phone-like link: CDP network 150 ms latency, 1.6 Mbps down, 750 kbps up, 4x CPU, a fresh context (no
// cache) per run, 3 runs. REPORT-ONLY: it never fails on time. Every run also logs each same-origin request (path, ms
// after the navigation started) so that the order of the boot requests can be read. The median and the runs go to an
// annotation and to test-results/time-to-map/summary.json (CI uploads the folder). Chromium only (CDP): the `fps` project.

const RUNS = 3;
const DIR = 'test-results/time-to-map';
const MARK = 'rws:map-idle';
/** CDP wants bytes a second. */
const DOWN = (1.6 * 1_000_000) / 8;
const UP = (750 * 1000) / 8;

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? Number.NaN;

test.setTimeout(600_000);

test('time to the first map idle under a 150 ms, 1.6 Mbps link and a 4x CPU throttle', async ({
  browser,
  baseURL,
}, testInfo) => {
  const origin = new URL(baseURL ?? 'https://localhost:4443').origin;
  const runs: { ms: number; requests: { path: string; at: number }[] }[] = [];
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      ignoreHTTPSErrors: true,
    });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: DOWN,
        uploadThroughput: UP,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const requests: { path: string; at: number }[] = [];
      let t0 = 0;
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.origin === origin) requests.push({ path: u.pathname, at: Date.now() - t0 });
      });
      t0 = Date.now();
      await page.goto('/', { waitUntil: 'commit' });
      await page.waitForFunction((m) => performance.getEntriesByName(m).length > 0, MARK, { timeout: 120_000 });
      const ms = await page.evaluate((m) => performance.getEntriesByName(m)[0]?.startTime ?? Number.NaN, MARK);
      runs.push({ ms: Math.round(ms), requests });
    } finally {
      await context.close();
    }
  }
  const summary = { median: median(runs.map((r) => r.ms)), runs };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  testInfo.annotations.push({
    type: 'time-to-map',
    description: `median ${summary.median} ms (${runs.map((r) => r.ms).join(', ')}); 150 ms, 1.6 Mbps, 4x CPU`,
  });
  console.log(`time to map: median ${summary.median} ms, runs ${runs.map((r) => r.ms).join(' ')}`);
});
