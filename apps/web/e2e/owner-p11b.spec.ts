import { expect, test } from '@playwright/test';
import {
  chooseMode,
  FRAMES_API,
  finish,
  mapReady,
  msg,
  open,
  playHold,
  reachesPainted,
  reachKinds,
  start,
  urlsFrom,
} from './helpers.ts';

// P11b (issue #26, OV): the OWNER site on Chromium, Firefox and WebKit (the `owner-*` projects). The synthetic SPW
// values of the owner seed (apps/server/test/e2e/owner-seed.ts: H and Q on the Meuse gauges that have a Q series) give
// the sub-spans of the Walloon Meuse both ends. Playback reads the owner API only (the owner host has no static
// frames); each public tile reach takes the colour at its own midpoint, inside the owner sub-span that holds it (D-2).

/** The gauges the seed gives a discharge (owner-seed.ts SPW_Q_STATIONS). */
const Q_SEEDED = new Set(['be.spw.8702', 'be.spw.8078', 'be.spw.8016', 'be.spw.7132', 'be.spw.5451']);
const RIVERS = '20261003';
const T = '2026-10-25T14:00Z';
const nl = (key: string) => msg('nl', key);

interface Reach {
  id: string;
  river_id: string;
  length_km: number;
  up_station_id: string | null;
  down_station_id: string | null;
  downstream: string[];
  part_of?: string;
}
interface Station {
  id: string;
  reach_id: string | null;
  km_graph: number | null;
}

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

/**
 * The public tile reaches of the Meuse whose midpoint sub-span has a seeded discharge at both ends, computed from the
 * owner reaches file: a reach cut into parts takes the part holding its length midpoint (its two station ends); a whole
 * reach walks down the same river to the next station. A gauge counts through the stations co-located with it.
 */
async function qSpans(page: import('@playwright/test').Page) {
  const file = (await (await page.request.get(`/data/v1/rivers/reaches-${RIVERS}.json`)).json()) as {
    reaches: Reach[];
    stations: Station[];
  };
  const byId = new Map(file.reaches.map((r) => [r.id, r]));
  const place = (id: string | null) => {
    const s = file.stations.find((x) => x.id === id);
    return s === undefined ? [] : file.stations.filter((o) => o.reach_id === s.reach_id && o.km_graph === s.km_graph);
  };
  const seeded = (id: string | null) => id !== null && place(id).some((s) => Q_SEEDED.has(s.id));
  const publicIds = new Set(file.reaches.map((r) => r.part_of ?? r.id));
  const valued: string[] = [];
  const open: string[] = [];
  for (const id of [...publicIds].filter((x) => x.startsWith('meuse.'))) {
    const parts = file.reaches
      .filter((r) => r.part_of === id)
      .sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
    let up: string | null;
    let down: string | null;
    if (parts.length > 0) {
      const half = parts.reduce((a, p) => a + p.length_km, 0) / 2;
      const ends = parts.map((_, i) => parts.slice(0, i + 1).reduce((x, p) => x + p.length_km, 0));
      const mid = parts[ends.findIndex((e) => e >= half)] ?? (parts.at(-1) as Reach);
      [up, down] = [mid.up_station_id, mid.down_station_id];
    } else {
      let cur = byId.get(id) as Reach;
      up = cur.up_station_id;
      down = cur.down_station_id;
      for (let i = 0; down === null && i < 40; i += 1) {
        const next = cur.downstream.map((d) => byId.get(d)).find((r) => r?.river_id === cur.river_id);
        if (next === undefined) break;
        cur = next;
        down = cur.down_station_id;
      }
    }
    (seeded(up) && seeded(down) ? valued : open).push(id);
  }
  return { valued, open };
}

test('OV: Q mode, played: the Meuse reaches whose midpoint sub-span has a seeded Q at both ends are coloured; the frames come from the owner API', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const { valued, open: other } = await qSpans(page);
  // Non-vacuous: Chooz (with the SPW gauge co-located) to the first Q gauge downstream is one of them.
  expect(valued).toContain('meuse.24');
  await playHold(page);
  await open(page, `/?mode=q&t=${T}`);
  await mapReady(page);
  const mark = s.log.requests.length;
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === FRAMES_API);
  await page.getByRole('button', { name: nl('play'), exact: true }).click();
  await expect(page.getByRole('button', { name: nl('pause'), exact: true })).toBeVisible();
  // The colours are the played frames', not the paused snapshot's: the owner API answered.
  expect((await answered).status()).toBe(200);
  await reachesPainted(page, valued);
  await expect
    .poll(async () => Object.values(await reachKinds(page, valued)).every((k) => k === 'v'), {
      timeout: 60_000,
    })
    .toBe(true);
  // A reach whose midpoint sub-span has an end without a discharge stays grey (never one-ended): meuse.25 and meuse.26.
  expect(await reachKinds(page, ['meuse.25', 'meuse.26'])).toEqual({ 'meuse.25': 'nodata', 'meuse.26': 'nodata' });
  expect(other).toEqual(expect.arrayContaining(['meuse.25', 'meuse.26']));
  // The owner host reads the frames from the owner API: at least one call, and no static frames file at all.
  const during = urlsFrom(s, mark);
  expect(during.filter((u) => u.pathname === FRAMES_API).length).toBeGreaterThanOrEqual(1);
  expect(during.filter((u) => u.pathname.startsWith('/data/v1/frames'))).toEqual([]);
  await finish(page, s);
});

test('OV: Δh mode, played: the owner sub-spans of the impounded Meuse are impounded, not a stage change', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await playHold(page);
  await open(page, `/?mode=delta&t=${T}`);
  await mapReady(page);
  await page.getByRole('button', { name: nl('play'), exact: true }).click();
  await expect(page.getByRole('button', { name: nl('pause'), exact: true })).toBeVisible();
  const reaches = ['meuse.24', 'meuse.25', 'meuse.26'];
  await reachesPainted(page, reaches);
  // (on the public site these three are a 139 km gap and grey; the owner gauges cut it into sub-spans)
  await expect
    .poll(async () => Object.values(await reachKinds(page, reaches)).every((k) => k === 'impounded'))
    .toBe(true);
  await chooseMode(page, 'q');
  await expect.poll(async () => (await reachKinds(page, ['meuse.24']))['meuse.24']).not.toBe('impounded');
  await finish(page, s);
});
