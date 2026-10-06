import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

// P10a (C8): Lighthouse 13 against the page's own origin, in Playwright's own Chromium started with
// --remote-debugging-port=9222 and --ignore-certificate-errors (the certificate of the stand-in or of CI's Caddy is a
// throw-away). Playwright itself drives its browsers over a pipe and gives a launched one no debugging port, so the spec
// starts that Chromium as a process of its own (`chromium.executablePath()`), which is the same binary the other projects
// use. Lighthouse drives it with its defaults (mobile form factor, simulated 4G and CPU throttling), three runs, and each
// number below is the median of the three. It measures the e2e build, which differs from production only by the test
// hook. The reports (json and html of every run) go to test-results/lighthouse/ (CI uploads the folder). The thresholds
// are the plan's: performance at least 80, accessibility at least 95, LCP under 2500 ms. They fail the test only with
// LIGHTHOUSE_GATE=1 (owner decision 2026-10-06): on the shared CI runner the same build measured performance 73, 95
// and 74, so CI reports the numbers (the summary, an annotation and the artifact) and the P12 performance pass makes
// them a gate (KG-237).

const PORT = 9222;
const RUNS = 3;
const DIR = 'test-results/lighthouse';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

/** Waits until the browser answers on its debugging port. */
async function listening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the browser did not open its debugging port');
}

test('Lighthouse: performance, accessibility and LCP of the start page', async ({ baseURL }) => {
  test.setTimeout(900_000);
  const { default: lighthouse } = await import('lighthouse');
  mkdirSync(DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'rws-lighthouse-'));
  const browser = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--ignore-certificate-errors',
      // (as Playwright's own launch: no sandbox inside a container, software GL for the map's WebGL2)
      '--no-sandbox',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    await listening();
    const url = new URL('/', baseURL).href;
    const performance: number[] = [];
    const accessibility: number[] = [];
    const lcp: number[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const result = await lighthouse(url, {
        port: PORT,
        output: ['json', 'html'],
        onlyCategories: ['performance', 'accessibility'],
        logLevel: 'error',
      });
      if (result === undefined) throw new Error('lighthouse returned nothing');
      const reports = [result.report].flat();
      writeFileSync(`${DIR}/run-${run}.json`, reports[0] ?? '');
      writeFileSync(`${DIR}/run-${run}.html`, reports[1] ?? '');
      const { categories, audits } = result.lhr;
      performance.push(Math.round((categories.performance?.score ?? 0) * 100));
      accessibility.push(Math.round((categories.accessibility?.score ?? 0) * 100));
      lcp.push(audits['largest-contentful-paint']?.numericValue ?? Number.POSITIVE_INFINITY);
    }
    const summary = {
      url,
      runs: RUNS,
      performance,
      accessibility,
      lcp_ms: lcp.map(Math.round),
      median: {
        performance: median(performance),
        accessibility: median(accessibility),
        lcp_ms: Math.round(median(lcp)),
      },
    };
    writeFileSync(`${DIR}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`lighthouse ${JSON.stringify(summary)}`);

    const misses = [
      summary.median.performance < 80 && `performance ${summary.median.performance} < 80`,
      summary.median.accessibility < 95 && `accessibility ${summary.median.accessibility} < 95`,
      summary.median.lcp_ms >= 2500 && `LCP ${summary.median.lcp_ms} ms >= 2500 ms`,
    ].filter((x): x is string => typeof x === 'string');
    test.info().annotations.push({
      type: 'lighthouse',
      description: misses.length === 0 ? 'all thresholds met' : `below threshold: ${misses.join('; ')}`,
    });
    if (process.env.LIGHTHOUSE_GATE === '1') {
      expect(summary.median.performance, `performance ${performance}`).toBeGreaterThanOrEqual(80);
      expect(summary.median.accessibility, `accessibility ${accessibility}`).toBeGreaterThanOrEqual(95);
      expect(summary.median.lcp_ms, `LCP ${lcp}`).toBeLessThan(2500);
    } else if (misses.length > 0) {
      console.log(`lighthouse REPORT-ONLY (set LIGHTHOUSE_GATE=1 to gate): ${misses.join('; ')}`);
    }
  } finally {
    browser.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
});
