import { expect, type Page, type Route, test } from '@playwright/test';
import {
  attributionPanel,
  chooseMode,
  chooseView,
  expandTimebar,
  expectInert,
  expectNoSeriousAxe,
  FRAMES_API,
  FRAMES_FILE,
  featureState,
  finish,
  mapReady,
  msg,
  open,
  openAttribution,
  panelOf,
  param,
  playHold,
  reachesPainted,
  reachKinds,
  reachState,
  SNAPSHOT_PATH,
  slider,
  start,
  textHosts,
  timebarOf,
  urlsFrom,
  XSS,
} from './helpers.ts';

// P11b (issue #26): the reach colouring and the hourly frames playback, on the PUBLIC site in Chromium, Firefox and WebKit
// against the e2e build under the production headers, the e2e api (fixed clock 2026-10-26T12:00Z) and the committed
// fixture river release (prepare-tiles.ts; the owner variant: owner-p11b.spec.ts).
//   B1   the fixture's tidal reaches are `tidal` with valued ends, never interpolated (`v`);
//   B2   playing 7 days back: at most one frames file per UTC day, no API frames while the files exist, no snapshot,
//        and a day file that 404s is covered by exactly one API call for its range;
//   R2   a frames file with unknown series ids or misaligned rows maps no value (a canary series least of all);
//   URL  a deep link restores the hour and the speed, paused;
//   D-1  the State mode plays too (#112: the frames carry a state code per series and hour), Play stays on a switch to it;
//   gates  axe 0 serious/critical and the keyboard on the playback controls, the hostile station inert while playing,
//          the credits of the played hours, 0 CSP violations and same-origin requests (finish).
// The reach colouring reads window.__rws.map.getFeatureState (the e2e build's hook); `window.__rwsPlayHold` holds playback
// on its first hour so that a played hour can be inspected.

const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);
const RIVERS = '20261003';
const XSS_ID = 'nl.e2e.xss';
const ranged = (river: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${river}.${from + i}`);
/** The tidal reaches of the fixture release (PHASES §P11b: Scheldt, Ems, Lek delta members, the Meuse delta). */
const TIDAL = [...ranged('scheldt', 9, 13), ...ranged('ems', 23, 33), ...ranged('lek', 4, 6), 'meuse.56'];
/** Chooz to Eijsden: 139.2 km, over GAP_KM (120) and without a station between them. */
const GAP = ranged('meuse', 24, 27);
const MID = '2026-10-25T12:00Z';

const deep = (t = MID, mode = 'delta', extra = '') => `/?mode=${mode}&t=${t}${extra}`;
const play = (page: Page) => page.getByRole('button', { name: nl('play'), exact: true });
const pause = (page: Page) => page.getByRole('button', { name: nl('pause'), exact: true });
/** The speed select of the bar (its label wraps the select, so its name holds the options). */
const speedOf = (page: Page) => timebarOf(page).locator('select');
const paused = (page: Page) => expect(play(page)).toBeVisible();
/** The URL's t (written every 400 ms, so a few hours at a time) is at or after `iso`. */
const reached = async (page: Page, iso: string) => (param(page, 't') ?? '') >= iso;

/** Open a paused deep link in the Δh mode (or `mode`) held on its first hour, and start playing. */
async function held(page: Page, path = deep(), mode?: 'delta' | 'q') {
  await playHold(page);
  await open(page, path);
  await mapReady(page);
  if (mode !== undefined) await chooseMode(page, mode);
  await play(page).click();
  await expect(pause(page)).toBeVisible();
}

/** The response body of a route as JSON, fetched without compression (Firefox cannot take a re-served .zst). */
async function json<T>(route: Route): Promise<T> {
  const res = await route.fetch({ headers: { ...route.request().headers(), 'accept-encoding': 'identity' } });
  return (await res.json()) as T;
}
const fulfilJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

interface Frames {
  from: string;
  to: string;
  series: number[];
  vlast: (number | null)[][];
  state: (number | null)[][];
}

// ---------------------------------------------------------------- B1: tidal reaches

test('B1: the tidal reaches of the fixture are hatched, never interpolated, in every mode and while played', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  // The ends of the tidal reaches that hold a value at the page's t (the API's own answers: stations and snapshot).
  const stationsRes = await page.request.get('/api/v1/stations');
  const { stations } = (await stationsRes.json()) as { stations: { id: string; series: { id: number }[] }[] };
  const snap = (await (await page.request.get(`/api/v1/snapshot?t=${MID}`)).json()) as { values: { series: number }[] };
  const valued = new Set(snap.values.map((v) => v.series));
  const hasValue = (id: string | null) =>
    id !== null && (stations.find((st) => st.id === id)?.series.some((x) => valued.has(x.id)) ?? false);
  const reaches = (await (await page.request.get(`/data/v1/rivers/reaches-${RIVERS}.json`)).json()) as {
    reaches: { id: string; up_station_id: string | null; down_station_id: string | null; flags: { tidal: boolean } }[];
  };
  const byId = new Map(reaches.reaches.map((r) => [r.id, r]));
  for (const id of TIDAL) expect(byId.get(id)?.flags.tidal, `${id} is tidal in the release`).toBe(true);
  const withValue = TIDAL.filter(
    (id) => hasValue(byId.get(id)?.up_station_id ?? null) || hasValue(byId.get(id)?.down_station_id ?? null),
  );
  // Valued ends exist on both estuaries: the colour is withheld although the stations show numbers.
  expect(
    withValue.some((id) => id.startsWith('scheldt.')),
    'a valued end on the Scheldt',
  ).toBe(true);
  expect(
    withValue.some((id) => id.startsWith('ems.')),
    'a valued end on the Ems',
  ).toBe(true);

  await playHold(page);
  await open(page, deep());
  await mapReady(page);
  await reachesPainted(page, TIDAL);
  for (const mode of ['delta', 'q', 'state'] as const) {
    await chooseMode(page, mode);
    // (the mode change repaints the reaches: poll until a non-tidal reach has taken the mode's paint, then read)
    await expect
      .poll(async () => Object.values(await reachKinds(page, TIDAL)).every((k) => k === 'tidal'), { message: mode })
      .toBe(true);
    for (const id of TIDAL) {
      const st = await reachState(page, id);
      expect(st?.k, `${id} in ${mode}`).toBe('tidal');
      expect(st?.c, `${id} has no interpolated colour in ${mode}`).toBe('#0000');
    }
  }
  // Played (held on the first hour): still tidal, never `v`.
  await chooseMode(page, 'delta');
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  await expect.poll(async () => (await reachKinds(page, TIDAL))['scheldt.12']).toBe('tidal');
  expect(Object.values(await reachKinds(page, TIDAL)).filter((k) => k !== 'tidal')).toEqual([]);
  await finish(page, s);
});

// ---------------------------------------------------------------- the gap, the impounded Meuse

test('the Chooz to Eijsden gap is grey in every mode; the impounded Meuse is neutral in the Δh mode', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep());
  await mapReady(page);
  await reachesPainted(page, [...GAP, 'meuse.23', 'meuse.28', 'rhine.4']);
  // The Δh mode: the gap is checked before the impounded rule, so it is `nodata`; the short reaches are `impounded`.
  expect(await reachKinds(page, GAP)).toEqual({
    'meuse.24': 'nodata',
    'meuse.25': 'nodata',
    'meuse.26': 'nodata',
    'meuse.27': 'nodata',
  });
  expect(await reachKinds(page, ['meuse.23', 'meuse.28'])).toEqual({
    'meuse.23': 'impounded',
    'meuse.28': 'impounded',
  });
  // An ordinary free-flowing reach is coloured (rhine.4: the longest Rhine span, 104.6 km, under GAP_KM).
  expect((await reachState(page, 'rhine.4'))?.k).toBe('v');
  await chooseMode(page, 'q');
  await expect.poll(async () => (await reachState(page, 'meuse.28'))?.k).not.toBe('impounded');
  expect(await reachKinds(page, GAP)).toEqual({
    'meuse.24': 'nodata',
    'meuse.25': 'nodata',
    'meuse.26': 'nodata',
    'meuse.27': 'nodata',
  });
  await finish(page, s);
});

test('meuse.23 is coloured once both its ends have a discharge (Chooz given one by a routed stations and frames file)', async ({
  page,
  context,
  baseURL,
}) => {
  // The public stand-in has no Q series at Chooz (the SPW gauge there is an owner source), so the one end the registry
  // lacks is added in the page: a Q series on fr.sandre.B720000002 in stations.json and a constant row in every frames
  // file. Nothing else is touched; the colour is then the span's own interpolation between the two ends.
  const Q_ID = 9_000_001;
  const s = await start(page, context, baseURL, 'dh');
  await page.route('**/data/v1/stations.json', async (route) => {
    const file = await json<{ stations: { id: string; series: { id: number; quantity: string }[] }[] }>(route);
    const donor = file.stations.find((st) => st.id === 'fr.sandre.B720000001')?.series.find((x) => x.quantity === 'Q');
    const chooz = file.stations.find((st) => st.id === 'fr.sandre.B720000002');
    if (donor === undefined || chooz === undefined) throw new Error('the Chooz or Meuse donor station is missing');
    chooz.series.push({ ...donor, id: Q_ID });
    await fulfilJson(route, file);
  });
  await page.route(/\/data\/v1\/frames\/.*\.json$/, async (route) => {
    const f = await json<Frames>(route);
    const hours = (Date.parse(f.to) - Date.parse(f.from)) / 3_600_000;
    f.series.push(Q_ID);
    f.vlast.push(Array.from({ length: hours }, () => 55));
    f.state.push(Array.from({ length: hours }, () => 2));
    await fulfilJson(route, f);
  });
  await held(page, deep(MID, 'q'));
  await reachesPainted(page, ['meuse.23', 'meuse.28']);
  await expect.poll(async () => (await reachState(page, 'meuse.23'))?.k).toBe('v');
  const st = await reachState(page, 'meuse.23');
  expect(st?.c).toMatch(/^#[0-9a-f]{6}$/i);
  // The gap stays grey whatever the ends hold.
  expect(await reachKinds(page, GAP)).toEqual({
    'meuse.24': 'nodata',
    'meuse.25': 'nodata',
    'meuse.26': 'nodata',
    'meuse.27': 'nodata',
  });
  await finish(page, s);
});

// ---------------------------------------------------------------- B2: the request log

test('B2: playing 7 days back reads at most one frames file per UTC day, no snapshot, no API frames', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, '/?mode=delta');
  await mapReady(page);
  // (play from live starts 7 days back, 2026-10-19T12:00Z; the Δh lead makes the window start 25 h earlier)
  const mark = s.log.requests.length;
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  await expect.poll(() => param(page, 'play')).toBe('normal');
  // Past the seed's start (2026-10-24) and into the recent file's days.
  await expect.poll(() => reached(page, '2026-10-25T01:00Z'), { timeout: 60_000 }).toBe(true);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // (Pause starts the paused snapshot: only what was asked until the click counts as asked while playing)
  const stop = s.log.requests.length;
  await pause(page).click();
  await paused(page);
  const during = urlsFrom(s, mark).slice(0, stop - mark);
  const files = during.filter((u) => FRAMES_FILE.test(u.pathname)).map((u) => u.pathname);
  const days = files.filter((p) => !p.endsWith('recent.json')).map((p) => p.split('/')[4]);
  expect(days, 'a day file per settled day of the window, 2026-10-18 to 2026-10-23').toEqual([
    '2026-10-18',
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
  ]);
  expect(new Set(files).size, 'no file is asked twice').toBe(files.length);
  expect(
    files.filter((p) => p.endsWith('/recent.json')),
    'the unsettled days: one recent file',
  ).toHaveLength(1);
  expect(
    during.filter((u) => u.pathname === FRAMES_API),
    'no API frames while the files exist',
  ).toEqual([]);
  // Nothing of the snapshot path while it played (the slice ends before the click on Pause has an effect).
  expect(during.filter((u) => SNAPSHOT_PATH.test(u.pathname)).map((u) => u.pathname)).toEqual([]);
  await finish(page, s);
});

test('B2: a day file that answers 404 is read from the API with exactly one call for its range', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await page.route('**/data/v1/frames/2026-10-20/*', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await open(page, '/?mode=delta');
  await mapReady(page);
  const mark = s.log.requests.length;
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  // Past the failed day (the clock holds on its first hour until the API's answer is in).
  await expect.poll(() => reached(page, '2026-10-21T06:00Z'), { timeout: 60_000 }).toBe(true);
  const stop = s.log.requests.length;
  await pause(page).click();
  await paused(page);
  const during = urlsFrom(s, mark).slice(0, stop - mark);
  const api = during.filter((u) => u.pathname === FRAMES_API);
  expect(api.map((u) => u.search)).toEqual(['?from=2026-10-20T00%3A00%3A00Z&to=2026-10-21T00%3A00%3A00Z&step=1h']);
  // The 404 was asked once (no retry) and the other days still came from their files.
  expect(during.filter((u) => u.pathname.includes('/frames/2026-10-20/'))).toHaveLength(1);
  expect(during.filter((u) => /\/frames\/2026-10-2[123]\//.test(u.pathname))).toHaveLength(3);
  await finish(page, s);
});

// ---------------------------------------------------------------- R2: what a frames file may map

test('R2: a frames file with unknown series ids maps no value; a canary row in it is never shown', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const CANARY = '123456.789';
  // Every series id of the unsettled days' file is shifted out of stations.json (and the withheld canary's value is
  // added as one more unknown series): the file is well formed, but none of its series is a series of this site.
  let routed = 0;
  await page.route('**/data/v1/frames/recent.json', async (route) => {
    const f = await json<Frames>(route);
    routed += 1;
    const hours = (Date.parse(f.to) - Date.parse(f.from)) / 3_600_000;
    f.series = [...f.series.map((id) => id + 50_000_000), 99_999_999];
    f.vlast = [...f.vlast, Array.from({ length: hours }, () => 123456.789)];
    f.state = [...f.state, Array.from({ length: hours }, () => 2)];
    await fulfilJson(route, f);
  });
  await playHold(page);
  await open(page, deep(MID, 'delta', `&s=${XSS_ID}`));
  await mapReady(page);
  // Before playing, the paused snapshot has a value for the station.
  await expect.poll(() => featureState(page, XSS_ID)).toMatchObject({ has: true });
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  // The played hour is on screen (the file answered) and no station has a value: nothing of the file was mapped.
  await expect.poll(() => routed).toBeGreaterThan(0);
  await expect.poll(() => featureState(page, XSS_ID)).toMatchObject({ has: false });
  expect(await featureState(page, 'nl.rws.lobith.bovenrijn.tolkamer')).toMatchObject({ has: false });
  await expect(panelOf(page)).not.toContainText(CANARY);
  await expect(page.locator('body')).not.toContainText(CANARY);
  await finish(page, s);
});

test('R2: a frames file with misaligned rows is not used; the API covers its days and no row of it is shown', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  // Each row one hour short: the contract's alignment check fails, so the file is dropped whole (a recognisable value
  // would show if any of it were mapped).
  await page.route('**/data/v1/frames/recent.json', async (route) => {
    const f = await json<Frames>(route);
    f.vlast = f.vlast.map((row) => row.slice(0, -1).map((v) => (v === null ? null : 424242)));
    await fulfilJson(route, f);
  });
  await playHold(page);
  await open(page, deep(MID, 'delta', `&s=${XSS_ID}`));
  await mapReady(page);
  const mark = s.log.requests.length;
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  // The API answers for the days of the dropped file (recent.json: 2026-10-24 to 2026-10-26).
  await expect.poll(() => urlsFrom(s, mark).filter((u) => u.pathname === FRAMES_API).length).toBe(1);
  const api = urlsFrom(s, mark).filter((u) => u.pathname === FRAMES_API)[0] as URL;
  // (the window starts 25 h before the held hour; the dropped file's days are cut to it)
  expect(api.searchParams.get('from')).toBe('2026-10-24T11:00:00Z');
  await expect(panelOf(page).getByText(nl('played_value_note')).first()).toBeVisible();
  await expect.poll(() => featureState(page, XSS_ID)).toMatchObject({ has: true });
  await expect(page.locator('body')).not.toContainText('424242');
  await finish(page, s);
});

test('R2: a frames file whose state rows alone are misaligned is not used either (C7)', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  // Only the state rows are one hour short, vlast is intact: the contract's alignment check still fails, the file is
  // dropped whole (its recognisable values never show) and the API covers its days.
  await page.route('**/data/v1/frames/recent.json', async (route) => {
    const f = await json<Frames>(route);
    f.vlast = f.vlast.map((row) => row.map((v) => (v === null ? null : 424242)));
    f.state = f.state.map((row) => row.slice(0, -1));
    await fulfilJson(route, f);
  });
  await playHold(page);
  await open(page, deep(MID, 'delta', `&s=${XSS_ID}`));
  await mapReady(page);
  const mark = s.log.requests.length;
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  await expect.poll(() => urlsFrom(s, mark).filter((u) => u.pathname === FRAMES_API).length).toBe(1);
  const api = urlsFrom(s, mark).filter((u) => u.pathname === FRAMES_API)[0] as URL;
  expect(api.searchParams.get('from')).toBe('2026-10-24T11:00:00Z');
  await expect(panelOf(page).getByText(nl('played_value_note')).first()).toBeVisible();
  await expect.poll(() => featureState(page, XSS_ID)).toMatchObject({ has: true });
  await expect(page.locator('body')).not.toContainText('424242');
  await finish(page, s);
});

// ---------------------------------------------------------------- URL

test('URL: a deep link restores the hour and the speed, paused, and Play keeps the speed', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await playHold(page);
  // 13:00 CET is 12:00Z on 2026-10-25 (the DST change was 03:00 CEST that morning); 12:30Z floors to the hour.
  await open(page, '/?mode=delta&t=2026-10-25T12:30Z&play=fast');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /13:00 CET$/);
  await expandTimebar(page);
  await expect(speedOf(page)).toHaveValue('fast');
  await paused(page);
  await expect(pause(page)).toHaveCount(0);
  expect(param(page, 'play')).toBe('fast');
  // Paused: no frames are asked (they are for the played window only), the snapshot path serves the page.
  await mapReady(page);
  expect(urlsFrom(s).filter((u) => FRAMES_FILE.test(u.pathname) || u.pathname === FRAMES_API)).toEqual([]);
  // Play (held on the first hour): the hour is the link's whole hour, the speed the link's.
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /13:00 CET$/);
  expect(param(page, 'play')).toBe('fast');
  await expect(speedOf(page)).toHaveValue('fast');
  // An unknown speed is dropped, not rendered.
  await page.goto('/?mode=delta&t=2026-10-25T12:00Z&play=turbo');
  await expect(slider(page)).toBeVisible();
  await expandTimebar(page);
  await expect(speedOf(page)).toHaveValue('normal');
  await finish(page, s);
});

test('URL: the speed select writes play=; the live view carries no play key', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep());
  await expandTimebar(page);
  const speed = speedOf(page);
  await speed.selectOption('slow');
  await expect.poll(() => param(page, 'play')).toBe('slow');
  await timebarOf(page)
    .getByRole('button', { name: nl('to_now'), exact: true })
    .click();
  await expect.poll(() => param(page, 't')).toBeNull();
  expect(param(page, 'play')).toBeNull();
  await finish(page, s);
});

// ---------------------------------------------------------------- D-1: the State mode

test('D-1: the State mode plays (forward and reverse); a switch to it keeps playing; a paused hour steps', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep(MID, 'state'));
  await expect(play(page)).toBeEnabled();
  await expandTimebar(page);
  await expect(page.getByRole('button', { name: nl('play_reverse'), exact: true })).toBeEnabled();
  // Δh: playing, then the switch to the State mode does not pause, and t keeps moving on.
  await chooseMode(page, 'delta');
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  await chooseMode(page, 'state');
  await expect(pause(page)).toBeVisible();
  const t0 = param(page, 't');
  await expect.poll(() => param(page, 't')).not.toBe(t0);
  // Pause, then the paused hour steps in the State mode.
  await pause(page).click();
  await paused(page);
  const before = param(page, 't');
  await page.getByRole('button', { name: nl('step_forward'), exact: true }).click();
  await expect.poll(() => param(page, 't')).not.toBe(before);
  await finish(page, s);
});

test('D-1: played in the State mode, the marker and the table show the hour state, never its basis', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  // Held on its first hour, so the played hour stays on screen while it is asserted.
  await playHold(page);
  await open(page, deep(MID, 'state'));
  await mapReady(page);
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  // The hostile station's NL-4 class makes any value of 100-1000 cm "elevated": its marker has level 3 while played,
  // its table cell says so beside the played note, and its basis label (the payload's text) appears nowhere.
  await expect.poll(() => featureState(page, XSS_ID)).toMatchObject({ has: true, level: 3 });
  await chooseView(page, 'table');
  const row = page.getByRole('row').filter({ hasText: XSS });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(nl('state_elevated'));
  await expect(row).toContainText(nl('played_note'));
  await expect(page.locator('body')).not.toContainText('onerror=alert(3)');
  await finish(page, s);
});

// ---------------------------------------------------------------- the played hour on screen

test("a played hour: the value with its hour's state, the played notes, the credits of the played hours, no snapshot", async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await playHold(page);
  await open(page, deep(MID, 'delta', `&s=${XSS_ID}`));
  await mapReady(page);
  // Paused: the snapshot's value carries a state and its basis, the credits have no section of the played hours.
  await expect(panelOf(page).getByText(nl('played_value_note'))).toHaveCount(0);
  const credits = await openAttribution(page);
  await expect(credits.getByRole('heading', { name: nl('played_sources'), exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  const mark = s.log.requests.length;
  // The panel says the value is a played-back hour value, shows the state of that hour and no basis row.
  await expect(panelOf(page).getByText(nl('played_value_note'), { exact: false }).first()).toBeVisible();
  await expect(panelOf(page).getByText(nl('panel_state'), { exact: true }).first()).toBeVisible();
  await expect(panelOf(page).getByText(nl('state_elevated'), { exact: true }).first()).toBeVisible();
  await expect(panelOf(page).getByText(nl('panel_basis'), { exact: true })).toHaveCount(0);
  // The credits list the sources of the played hours first.
  await openAttribution(page);
  await expect(attributionPanel(page).getByRole('heading', { name: nl('played_sources'), exact: true })).toBeVisible();
  expect(await attributionPanel(page).locator('li').count()).toBeGreaterThan(0);
  // The table reads the same frames: the hostile station has its played value (Δh: its change over 24 h).
  await chooseView(page, 'table');
  const row = page.getByRole('row').filter({ hasText: XSS });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText('–  –');
  expect(urlsFrom(s, mark).filter((u) => SNAPSHOT_PATH.test(u.pathname))).toEqual([]);
  // Pause: the snapshot path returns.
  await pause(page).click();
  await paused(page);
  await expect(page.getByRole('row').filter({ hasText: XSS })).toHaveCount(1);
  await finish(page, s);
});

// ---------------------------------------------------------------- the hostile station while playing

test('the hostile station stays inert in the legend, the panel and the table while playing', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await held(page, deep(MID, 'delta', `&s=${XSS_ID}`));
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText(XSS);
  await expect(panelOf(page).getByText(nl('played_value_note')).first()).toBeVisible();
  // The legend (open) with the reach entries.
  const legend = page.locator('summary', { hasText: nl('legend_heading') });
  await legend.click();
  await expect(page.getByText(nl('reach_legend_heading'), { exact: true }).first()).toBeVisible();
  await expectInert(page, s);
  await legend.click(); // (it floats over the view disclosures)
  // The table.
  await chooseView(page, 'table');
  const hosts = await textHosts(page, XSS);
  expect(hosts.length).toBeGreaterThan(0);
  expect(hosts.filter((h) => h === 'img' || h === 'svg' || h === 'script')).toEqual([]);
  await expect(page.getByRole('table')).toContainText(XSS);
  await expectInert(page, s);
  await finish(page, s);
});

// ---------------------------------------------------------------- accessibility and the keyboard

test('axe finds no serious issue with playback running, in the map and in the table', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await held(page, deep(MID, 'delta', `&s=${XSS_ID}`));
  await expandTimebar(page);
  await expectNoSeriousAxe(page);
  await chooseView(page, 'table');
  // (a tall window: axe cannot decide the colour contrast of rows that the scroll area clips, as no-webgl2.spec.ts)
  await page.setViewportSize({ width: 1024, height: 12_000 });
  await expectNoSeriousAxe(page);
  await finish(page, s);
});

test('the keyboard: Play, Pause and the speed select are native controls; focus stays put', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await playHold(page);
  await open(page, deep());
  await mapReady(page);
  const bar = timebarOf(page);
  const back = bar.getByRole('button', { name: nl('step_back'), exact: true });
  const speed = speedOf(page);
  // Tab order inside the bar: the slider, 1 hour back, Play, 1 hour forward, "Nu"; the speed in the expanded part.
  await slider(page).focus();
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(play(page)).toBeFocused();
  await page.keyboard.press('Space');
  // The same button now names Pause and keeps the focus (its DOM identity is kept).
  await expect(pause(page)).toBeVisible();
  await expect(pause(page)).toBeFocused();
  await expect(pause(page)).not.toHaveAttribute('aria-pressed');
  await page.keyboard.press('Enter');
  await expect(play(page)).toBeVisible();
  await expect(play(page)).toBeFocused();
  // The speed select (in the expanded part, after the reverse play): reachable by Tab, a native select, and it
  // changes the URL.
  await expandTimebar(page);
  await bar.getByRole('button', { name: nl('play_reverse'), exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(speed).toBeFocused();
  await speed.selectOption('fast');
  await expect.poll(() => param(page, 'play')).toBe('fast');
  await expect(speed).toBeFocused();
  // While playing, a manual step pauses.
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  await back.focus();
  await page.keyboard.press('Enter');
  await paused(page);
  await finish(page, s);
});

test('the polite status says the hours are loading once the clock has waited, and is empty before', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep());
  const status = timebarOf(page).getByRole('status');
  await expect(status).toBeEmpty();
  // (held: the clock never gets its next hour, as if the frames were slow)
  await playHold(page);
  await page.reload();
  await expect(slider(page)).toBeVisible();
  await play(page).click();
  await expect(status).toHaveText(nl('play_waiting'));
  await pause(page).click();
  await expect(status).toBeEmpty();
  await finish(page, s);
});
