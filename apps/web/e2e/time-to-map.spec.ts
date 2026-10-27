import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// O4 (#220): the time to the base map's first idle (the `rws:map-idle` mark of createMap.ts: style + first tiles, no data)
// on a throttled phone-like link: CDP network 150 ms latency, 1.6 Mbps down, 750 kbps up, 4x CPU, a fresh context (no
// cache) per run, 3 runs. REPORT-ONLY: it never fails on time. Every run also logs each same-origin request (path, ms
// after the navigation started) so that the order of the boot requests can be read; each run also asserts that the
// first createMap-*.js request starts before the first snapshot read (the timing itself is never asserted).
// The median and the runs go to an annotation and to test-results/time-to-map/summary.json (CI uploads the folder). Chromium only (CDP): the `fps` project.

const RUNS = 3;
const DIR = 'test-results/time-to-map';
const MARK = 'rws:map-idle';
/** CDP wants bytes a second. */
const DOWN = (1.6 * 1_000_000) / 8;
const UP = (750 * 1000) / 8;

/**
 * The first snapshot read of the home route: the page's now is the earlier of this browser's clock and the e2e data's
 * (`NOW`, 2026-10-26T12:00Z; App.tsx), so `recent/<day>/<hhmm>.json` before that instant and `latest.json` from it on
 * (other recent/ files may exist).
 */
const SNAPSHOT = /^\/data\/v1\/(?:latest|recent\/\d{4}-\d{2}-\d{2}\/\d{4})\.json$/;
const first = (requests: { path: string; at: number }[], re: RegExp) => requests.find((r) => re.test(r.path))?.at;

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? Number.NaN;

test.setTimeout(600_000);

test('time to the first map idle under a 150 ms, 1.6 Mbps link and a 4x CPU throttle', async ({
  browser,
  baseURL,
}, testInfo) => {
  const origin = new URL(baseURL ?? 'https://localhost:4443').origin;
  const runs: {
    ms: number;
    chunkAt: number | undefined;
    snapshotAt: number | undefined;
    requests: { path: string; at: number }[];
  }[] = [];
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
      // Keep logging until the snapshot read has started too (it follows meta + stations and a debounce; on the base it
      // started before the mark). Bounded: a missing read fails the assertion below, not the run's timing.
      await expect.poll(() => first(requests, SNAPSHOT) !== undefined, { timeout: 60_000 }).toBe(true);
      const chunkAt = first(requests, /\/assets\/createMap-[^/]+\.js$/);
      const snapshotAt = first(requests, SNAPSHOT);
      runs.push({ ms: Math.round(ms), chunkAt, snapshotAt, requests });
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

  // O4: the map chunk is asked for before the first snapshot read (the order, never a time).
  for (const r of runs) {
    expect(r.chunkAt, 'createMap chunk requested').toBeDefined();
    expect(r.chunkAt ?? Number.NaN).toBeLessThan(r.snapshotAt ?? Number.NaN);
  }
});
