import { type Browser, devices, expect, type Page, test } from '@playwright/test';
import { type HovW, mapReady, msg, NOW, open, settled, slider, type W } from './helpers.ts';

// P11a (issue #26, C4; owner decision D-B): the frame rate of the map with the flow animation on, while the timebar is
// scrubbed with the keyboard for 10 s over the fixture rivers (the committed river release, prepare-tiles.ts), measured
// from a Chromium trace. Chromium only (tracing is a Chromium feature), and after every other project (`dependencies` in
// the config), so that nothing else shares the CPU and Lighthouse's scores stay clean.
//
//   desktop         at least 30 frames a second
//   mobile, 4x CPU  at least 20 frames a second (Pixel 5 profile, device scale factor 2.75, the CDP CPU throttle)
//
// THE THRESHOLDS ARE FIXED. A shortfall is never "fixed" by lowering them (D-B). They fail the test only with
// FPS_GATE=1 (owner decision 2026-10-09, the Lighthouse pattern of KG-237): with software WebGL the map alone renders
// about 23 frames a second before the flow is added (KG-269), so CI reports the numbers (console, an annotation and an
// attachment; the traces via testInfo.outputPath, uploaded by CI's `if: always()` step), and the owner runs this spec
// once with FPS_GATE=1 on a machine with a real GPU before the launch.
//
// What is counted. Chromium's compositor reports every display frame as a `PipelineReporter` async event whose
// `chrome_frame_reporter.state` says what became of it: `STATE_PRESENTED_ALL` or `STATE_PRESENTED_PARTIAL` is a frame the
// user saw, `STATE_NO_UPDATE_DESIRED` and `STATE_DROPPED` are not. That count (events of one id counted once) is the
// presented-frame count. Chromium versions differ in where that state sits (the begin or the end event, under
// `args.chrome_frame_reporter` or `args.data`), so the parser looks in all of them; if a trace has no such event, it
// falls back to the compositor's `DrawFrame` instants, then to the viz display's `Display::DrawAndSwap` slices, and the
// annotation names the one used. fps = frames / 10 s (the trace spans exactly the scrubbing).
//
// O3 (#219): each run also reports `busy`, the share of the traced time the page's main thread spent in tasks (`RunTask`
// on the busiest `CrRendererMain` thread of the trace, nested tasks once). On a software renderer the frame count is bound by the GL emulation,
// so the per-step work of the page (charts, feature-state, warnings, frames) shows in `busy` first.

const DESKTOP_MIN_FPS = 30;
const MOBILE_MIN_FPS = 20;
const SCRUB_MS = 10_000;
const KEY_EVERY_MS = 30; // a held key repeats about 30 times a second
/** O3 (#219): the station of the panel case, with an H and a Q chart in the e2e seed. */
const STATION = 'nl.rws.lobith.bovenrijn.tolkamer';
const FLOW = 'rivers-flow';
const CATEGORIES = [
  'toplevel',
  'benchmark',
  'viz',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
];

interface TraceEvent {
  name?: string;
  ph?: string;
  pid?: number;
  tid?: number;
  /** Microseconds. */
  ts?: number;
  /** Microseconds, on a complete (`X`) event. */
  dur?: number;
  id?: string | number;
  id2?: { local?: string; global?: string };
  args?: {
    chrome_frame_reporter?: { state?: string };
    data?: { state?: string };
    state?: string;
    /** A `thread_name` metadata event's name. */
    name?: string;
  };
}

const eventsOf = (trace: unknown): TraceEvent[] =>
  Array.isArray(trace) ? trace : ((trace as { traceEvents?: TraceEvent[] } | null)?.traceEvents ?? []);

/**
 * The share of the traced time that the busiest `CrRendererMain` thread spent in tasks: the union of its `RunTask`
 * intervals (a nested task is counted once) over the span of the whole trace; 0 when none is found.
 */
function mainBusy(trace: unknown): number {
  const events = eventsOf(trace);
  const main = new Set<string>();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') main.add(`${e.pid}:${e.tid}`);
  const tasks = new Map<string, [number, number][]>();
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (typeof e.ts !== 'number' || e.ph === 'M') continue;
    lo = Math.min(lo, e.ts);
    hi = Math.max(hi, e.ts + (e.dur ?? 0));
    const key = `${e.pid}:${e.tid}`;
    if (e.name === 'RunTask' && e.ph === 'X' && main.has(key))
      tasks.set(key, [...(tasks.get(key) ?? []), [e.ts, e.ts + (e.dur ?? 0)]]);
  }
  let busiest = 0;
  for (const list of tasks.values()) {
    list.sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const [from, to] of list) {
      if (to > end) busy += to - Math.max(from, end);
      end = Math.max(end, to);
    }
    busiest = Math.max(busiest, busy);
  }
  return hi > lo ? busiest / (hi - lo) : 0;
}

type FrameCount = { method: 'presented' | 'DrawFrame' | 'DrawAndSwap' | 'none'; frames: number };

/** Presented frames of a Chromium trace (`{traceEvents: [...]}` or a bare array), by the first method that finds any. */
function countFrames(trace: unknown): FrameCount & { all: Record<string, number> } {
  const events = eventsOf(trace);
  const presented = new Map<string, boolean>();
  let drawFrame = 0;
  let drawAndSwap = 0;
  for (const e of events) {
    if (e.name === 'PipelineReporter') {
      const key = `${e.pid}:${e.id ?? e.id2?.local ?? e.id2?.global}`;
      const state = e.args?.chrome_frame_reporter?.state ?? e.args?.data?.state ?? e.args?.state;
      presented.set(key, (presented.get(key) ?? false) || (state?.startsWith('STATE_PRESENTED') ?? false));
    } else if (e.name === 'DrawFrame') drawFrame++;
    else if (e.name === 'Display::DrawAndSwap' && (e.ph === 'X' || e.ph === 'B')) drawAndSwap++;
  }
  const all = {
    presented: [...presented.values()].filter(Boolean).length,
    DrawFrame: drawFrame,
    DrawAndSwap: drawAndSwap,
  };
  const method =
    all.presented > 0 ? 'presented' : all.DrawFrame > 0 ? 'DrawFrame' : all.DrawAndSwap > 0 ? 'DrawAndSwap' : 'none';
  return { method, frames: method === 'none' ? 0 : all[method], all };
}

interface Run {
  fps: number;
  method: string;
  all: Record<string, number>;
  flowTicks: number;
  pixelRatio: number;
  /** O3: the main thread's busy share of the traced time (mainBusy). */
  busy: number;
  /** O3: the station charts' `setOption` calls while measured: full (`notMerge`) redraws and merges (the marker). */
  chartSets: { full: number; merge: number };
  /** O3: the hours the URL's t moved while measured (playback progress; 0 when scrubbing ends where it began). */
  hours: number;
}

/** Opens the map over the fixture rivers in a page, scrubs the timebar for 10 s under a trace, and counts the frames. */
async function measure(
  browser: Browser,
  page: Page,
  tracePath: string,
  throttle: number | null,
  playing = false,
  panel = false,
  station?: string,
): Promise<Run> {
  await page.clock.setFixedTime(NOW);
  await open(
    page,
    station !== undefined
      ? `/?mode=delta&s=${station}`
      : panel
        ? '/?mode=delta&hov=rhine-waal'
        : playing
          ? '/?mode=delta'
          : '/',
  );
  await mapReady(page);
  // O3: with a station panel open its charts have drawn their points before measuring.
  if (station !== undefined) await settled(page);
  // P11c: with the "Langs de rivier" panel open its chart has drawn (the hook holds the ECharts instance) before measuring.
  if (panel)
    await expect.poll(() => page.evaluate(() => (window as unknown as HovW).__rwsHov?.chart != null)).toBe(true);
  // The e2e build starts with the flow off (App.tsx), so the camera jump below can wait for `idle` (a running animation
  // holds it off on a software renderer); the real pause control turns the flow on before the measurement.
  // The Rhine and the Meuse of the fixture release both in view (about 4 degrees across at this zoom).
  const lines = await page.evaluate(async () => {
    const map = (window as unknown as W).__rws?.map;
    if (!map) throw new Error('no map');
    const idle = new Promise<void>((r) => map.once('idle', () => r()));
    map.jumpTo({ center: [6.4, 51.2], zoom: 8.5 });
    await idle;
    return {
      lines: map.querySourceFeatures('rivers', { sourceLayer: 'rivers' }).length,
      flow: map.getLayer('rivers-flow') !== undefined,
    };
  });
  expect(lines.lines, 'the fixture river lines are in view').toBeGreaterThan(0);
  expect(lines.flow, `the ${FLOW} layer exists`).toBe(true);
  const toggle = page.getByRole('button', { name: msg('nl', 'flow_toggle') });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const pixelRatio = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas');
    return canvas === null ? Number.NaN : canvas.width / canvas.clientWidth;
  });
  // The map caps its pixel ratio at 2 (createMap.ts), whatever the device scale factor is.
  expect(pixelRatio, 'map pixel ratio').toBeLessThanOrEqual(2.01);

  if (throttle !== null) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  const framesBefore = await flowFrames(page);
  await countChartSets(page);
  const tOf = () => Date.parse(new URL(page.url()).searchParams.get('t') ?? '');
  await slider(page).focus();
  // The map draws every frame while measured (MapLibre's `repaint`): Chromium presents a frame only when something
  // changed, so without it the count follows the key presses (about 26 a second here), not what the page can render.
  await setRepaint(page, true);
  await browser.startTracing(page, { path: tracePath, categories: CATEGORIES });
  const t0 = performance.now();
  let tStart = Number.NaN;
  if (playing) {
    // P11b: hourly playback from 7 days back at the normal speed, the reach layers painting a new hour about 12 times a second.
    await page.getByRole('button', { name: msg('nl', 'play'), exact: true }).click();
    await page.waitForTimeout(500);
    tStart = tOf();
    await page.waitForTimeout(SCRUB_MS - 500);
  } else {
    // Back through the time range, and forth again: every key press changes t, so values and map states change.
    for (let key = 0; performance.now() - t0 < SCRUB_MS; key++) {
      await page.keyboard.press(Math.floor(key / 100) % 2 === 0 ? 'ArrowLeft' : 'ArrowRight');
      await page.waitForTimeout(KEY_EVERY_MS);
    }
  }
  const elapsed = (performance.now() - t0) / 1000;
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as unknown;
  await setRepaint(page, false);
  const { method, frames, all } = countFrames(trace);
  const flowTicks = (await flowFrames(page)) - framesBefore;
  // Flow stayed on the whole time, at no more than its cap.
  expect(flowTicks, 'flow ticks while scrubbing or playing').toBeGreaterThan(0);
  expect(flowTicks / elapsed, 'flow ticks a second').toBeLessThanOrEqual(25.5);
  return {
    fps: frames / (SCRUB_MS / 1000),
    method,
    all,
    flowTicks,
    pixelRatio,
    busy: mainBusy(trace),
    chartSets: await page.evaluate(() => (window as unknown as SetsW).__o3Sets ?? { full: 0, merge: 0 }),
    hours: Number.isFinite(tStart) ? (tOf() - tStart) / 3_600_000 : 0,
  };
}

/** The threshold fails the test only with FPS_GATE=1; otherwise a shortfall is reported. */
function gate(fps: number, min: number, what: string): void {
  if (process.env.FPS_GATE === '1') expect(fps, what).toBeGreaterThanOrEqual(min);
  else if (fps < min) console.log(`fps REPORT-ONLY (set FPS_GATE=1 to gate): ${what} ${fps.toFixed(1)} < ${min}`);
}

const setRepaint = (page: Page, on: boolean) =>
  page.evaluate((v) => {
    const map = (window as unknown as W).__rws?.map;
    if (!map) throw new Error('no map');
    map.repaint = v;
  }, on);

type SetsW = W & { __o3Sets?: { full: number; merge: number } };

/**
 * O3: counts the `setOption` calls of the open station charts from now on, full redraws apart (wrapping each ECharts
 * instance of the e2e hook, so it counts the same on a build before O3).
 */
const countChartSets = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as SetsW;
    const sets = { full: 0, merge: 0 };
    w.__o3Sets = sets;
    for (const chart of w.__rws?.charts ?? []) {
      const c = chart as unknown as { setOption: (o: unknown, opts?: unknown, lazy?: unknown) => void };
      const set = c.setOption.bind(c);
      c.setOption = (o, opts, lazy) => {
        if (opts === true || (opts as { notMerge?: boolean } | undefined)?.notMerge === true) sets.full++;
        else sets.merge++;
        set(o, opts, lazy);
      };
    }
  });

const flowFrames = (page: Page) =>
  page.evaluate(() => (window as unknown as W & { __rwsFlowFrames?: number }).__rwsFlowFrames ?? 0);

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

test('desktop: at least 30 frames a second while scrubbing the timebar with the flow on', async ({
  browser,
  page,
}, testInfo) => {
  const run = await measure(browser, page, testInfo.outputPath('trace-desktop.json'), null);
  testInfo.annotations.push({ type: 'fps-desktop', description: `${run.fps.toFixed(1)} (${run.method})` });
  await testInfo.attach('fps-desktop.json', { body: JSON.stringify(run, null, 2), contentType: 'application/json' });
  console.log(
    `fps desktop: ${run.fps.toFixed(1)} (${run.method}; ${JSON.stringify(run.all)}; flow ticks ${run.flowTicks}; main busy ${(run.busy * 100).toFixed(1)} %)`,
  );
  gate(run.fps, DESKTOP_MIN_FPS, `desktop fps (${run.method}) ${JSON.stringify(run.all)}`);
});

test('mobile, 4x CPU throttle: at least 20 frames a second while scrubbing the timebar with the flow on', async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    ...devices['Pixel 5'],
    ...(baseURL === undefined ? {} : { baseURL }),
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await context.newPage();
    const run = await measure(browser, page, testInfo.outputPath('trace-mobile.json'), 4);
    testInfo.annotations.push({ type: 'fps-mobile-4x', description: `${run.fps.toFixed(1)} (${run.method})` });
    await testInfo.attach('fps-mobile.json', { body: JSON.stringify(run, null, 2), contentType: 'application/json' });
    console.log(
      `fps mobile 4x: ${run.fps.toFixed(1)} (${run.method}; ${JSON.stringify(run.all)}; flow ticks ${run.flowTicks}; main busy ${(run.busy * 100).toFixed(1)} %)`,
    );
    gate(run.fps, MOBILE_MIN_FPS, `mobile fps (${run.method}) ${JSON.stringify(run.all)}`);
  } finally {
    await context.close();
  }
});

// P11b (issue #26): the same measure with hourly playback running and the reach layers painting every hour. Report-only
// like the others (KG-269) unless FPS_GATE=1; the numbers are printed, annotated and attached.
test('desktop: at least 30 frames a second while playing back with the reach layers on', async ({
  browser,
  page,
}, testInfo) => {
  const run = await measure(browser, page, testInfo.outputPath('trace-desktop-play.json'), null, true);
  testInfo.annotations.push({ type: 'fps-desktop-play', description: `${run.fps.toFixed(1)} (${run.method})` });
  await testInfo.attach('fps-desktop-play.json', {
    body: JSON.stringify(run, null, 2),
    contentType: 'application/json',
  });
  console.log(
    `fps desktop playing: ${run.fps.toFixed(1)} (${run.method}; ${JSON.stringify(run.all)}; flow ticks ${run.flowTicks}; main busy ${(run.busy * 100).toFixed(1)} %; hours played ${run.hours})`,
  );
  gate(run.fps, DESKTOP_MIN_FPS, `desktop playing fps (${run.method}) ${JSON.stringify(run.all)}`);
});

// P11c (issue #26): the same two measures with the "Langs de rivier" panel open (the ECharts canvas of 168 rows) and
// hourly playback running, so the chart's marker and the reach layers both update. Report-only like the others (KG-269)
// unless FPS_GATE=1; the numbers are printed, annotated and attached.
test('desktop: at least 30 frames a second while playing back with the Hovmöller panel open', async ({
  browser,
  page,
}, testInfo) => {
  const run = await measure(browser, page, testInfo.outputPath('trace-desktop-hov.json'), null, true, true);
  testInfo.annotations.push({ type: 'fps-desktop-hov', description: `${run.fps.toFixed(1)} (${run.method})` });
  await testInfo.attach('fps-desktop-hov.json', {
    body: JSON.stringify(run, null, 2),
    contentType: 'application/json',
  });
  console.log(
    `fps desktop panel: ${run.fps.toFixed(1)} (${run.method}; ${JSON.stringify(run.all)}; flow ticks ${run.flowTicks}; main busy ${(run.busy * 100).toFixed(1)} %)`,
  );
  gate(run.fps, DESKTOP_MIN_FPS, `desktop panel fps (${run.method}) ${JSON.stringify(run.all)}`);
});

test('mobile, 4x CPU throttle: at least 20 frames a second while playing back with the Hovmöller panel open', async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    ...devices['Pixel 5'],
    ...(baseURL === undefined ? {} : { baseURL }),
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await context.newPage();
    const run = await measure(browser, page, testInfo.outputPath('trace-mobile-hov.json'), 4, true, true);
    testInfo.annotations.push({ type: 'fps-mobile-4x-hov', description: `${run.fps.toFixed(1)} (${run.method})` });
    await testInfo.attach('fps-mobile-hov.json', {
      body: JSON.stringify(run, null, 2),
      contentType: 'application/json',
    });
    console.log(
      `fps mobile 4x panel: ${run.fps.toFixed(1)} (${run.method}; ${JSON.stringify(run.all)}; flow ticks ${run.flowTicks}; main busy ${(run.busy * 100).toFixed(1)} %)`,
    );
    gate(run.fps, MOBILE_MIN_FPS, `mobile panel fps (${run.method}) ${JSON.stringify(run.all)}`);
  } finally {
    await context.close();
  }
});

// O3 (issue #219): the same measure with a station panel open (Lobith's H and Q charts) and hourly playback running, so
// every played hour moves the charts' selected-time line, the station feature-states and the reach layers. Report-only
// like the others (KG-269) unless FPS_GATE=1; the numbers (and the main thread's busy share) are printed, annotated and
// attached.
test('desktop: at least 30 frames a second while playing back with a station panel open', async ({
  browser,
  page,
}, testInfo) => {
  const run = await measure(
    browser,
    page,
    testInfo.outputPath('trace-desktop-station.json'),
    null,
    true,
    false,
    STATION,
  );
  testInfo.annotations.push({
    type: 'fps-desktop-station',
    description: `${run.fps.toFixed(1)} (${run.method}; main busy ${(run.busy * 100).toFixed(1)} %)`,
  });
  await testInfo.attach('fps-desktop-station.json', {
    body: JSON.stringify(run, null, 2),
    contentType: 'application/json',
  });
  console.log(
    `fps desktop station: ${run.fps.toFixed(1)} (${run.method}; ${JSON.stringify(run.all)}; flow ticks ${run.flowTicks}; main busy ${(run.busy * 100).toFixed(1)} %; chart setOption ${JSON.stringify(run.chartSets)}; hours played ${run.hours})`,
  );
  gate(run.fps, DESKTOP_MIN_FPS, `desktop station fps (${run.method}) ${JSON.stringify(run.all)}`);
});
