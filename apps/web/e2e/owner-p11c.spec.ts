import { expect, test } from '@playwright/test';
import {
  FRAMES_API,
  FRAMES_FILE,
  finish,
  type HovW,
  hovAxisLabels,
  hovDrawnText,
  hovReady,
  hovRegion,
  hovSeries,
  hovState,
  hovTableToggle,
  msg,
  open,
  reachKm,
  start,
  stationNames,
  urlsFrom,
} from './helpers.ts';

// P11c (issue #26, OV): the "Langs de rivier" panel on the OWNER site on Chromium, Firefox and WebKit (the `owner-*`
// projects). The owner reaches variant (apps/server/test/e2e/api.ts) puts the SPW gauges of the Walloon Meuse in the
// graph, so on the Meuse path they fill the stretch the public site shows as a gap:
//   - the SPW columns sit between Chooz and Lixhe, in the registry's chainage order, each with the "owner only" badge in
//     the table's column header and on the axis label;
//   - no Walloon gap band and no gap column;
//   - a Q-only SPW gauge is coloured by its discharge trend (D-2), not grey;
//   - the owner canary station is never a column, and no canary value is on the panel.
// Nothing here reads or writes an owner value: only the columns, their order, their badge and the class of a cell.

const nl = (key: string) => msg('nl', key);
const T = '2026-10-25T12:00Z';
const T_ISO = '2026-10-25T12:00:00.000Z';
const CHOOZ = 'fr.sandre.B720000001';
const EIJSDEN = 'nl.rws.eijsden.grens';
const LIXHE = 'nl.rws.lixhebiefaval';
/** The SPW gauge of Eijsden's reach with a discharge series only, which the owner seed gives synthetic values. */
const Q_ONLY = 'be.spw.5451';
const CANARY = ['nl.canary.owner', 'nl.e2e.gap'];

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

test('OV: the SPW gauges are columns of the Meuse path between Chooz and Lixhe, badged, with no Walloon gap', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const [km, names] = [await reachKm(page), await stationNames(page)];
  await open(page, `/?mode=delta&t=${T}&hov=meuse`);
  await hovReady(page, 'meuse');
  const columns = (await hovState(page))?.columns ?? [];
  const ids = columns.map((c) => c.id);
  const spw = ids.filter((id) => id.startsWith('be.spw.'));
  expect(spw.length, 'SPW columns on the owner Meuse path').toBeGreaterThanOrEqual(2);
  // Between Chooz and Lixhe (the owner gauges stand in the stretch the public site has no station in).
  expect(ids[0]).toBe(CHOOZ);
  const [chooz, lixhe, eijsden] = [ids.indexOf(CHOOZ), ids.indexOf(LIXHE), ids.indexOf(EIJSDEN)];
  expect(eijsden).toBeGreaterThan(chooz);
  for (const id of spw) {
    const at = ids.indexOf(id);
    expect(at, `${id} after Chooz`).toBeGreaterThan(chooz);
    expect(at, `${id} before Lixhe`).toBeLessThan(lixhe);
  }
  // The registry's order: x = −km_to_nl_entry of the owner reaches file, strictly increasing, the same ids by km.
  for (const c of columns) expect(c.x, `${c.id}'s x`).toBeCloseTo(-(km.get(c.id) ?? Number.NaN), 6);
  for (const [i, c] of columns.entries()) if (i > 0) expect(c.x).toBeGreaterThan(columns[i - 1]?.x ?? 0);
  expect(ids).toEqual([...ids].sort((a, b) => (km.get(b) ?? 0) - (km.get(a) ?? 0)));
  // The axis labels: the owner badge text after the name of an SPW column, none after a public one.
  const badge = nl('owner_badge');
  const labels = await hovAxisLabels(
    page,
    columns.map((c) => c.x),
  );
  for (const [i, id] of ids.entries()) {
    if (spw.includes(id)) expect(labels[i], `axis label of ${id}`).toBe(`${names.get(id)} · ${badge}`);
    else expect(labels[i], `axis label of ${id}`).toBe(names.get(id));
  }
  // No gap: no band, no gap text drawn.
  expect(await hovSeries(page, 'gaps')).toHaveLength(0);
  expect(await hovDrawnText(page)).not.toContain(nl('hov_gap_wallonia'));
  // The canary is no column and no value of it is on the panel.
  expect(ids.filter((id) => CANARY.includes(id) || /canary/i.test(id))).toEqual([]);
  expect((await hovDrawnText(page)).join('\n')).not.toContain('777777.777');

  // The table: the badge is in the column header of each SPW column and of no other; no gap column.
  await hovTableToggle(page).click();
  const table = hovRegion(page).getByRole('table');
  await expect(table).toBeVisible();
  for (const id of ids) {
    const head = table
      .locator('thead th')
      .filter({ has: page.getByRole('button', { name: names.get(id) ?? '?', exact: true }) });
    await expect(head, id).toHaveCount(1);
    if (spw.includes(id)) await expect(head, id).toContainText(badge);
    else await expect(head, id).not.toContainText(badge);
  }
  await expect(table.locator('thead th').filter({ hasText: nl('hov_gap_wallonia') })).toHaveCount(0);
  expect(await table.locator('thead th').count(), 'the time header and one per column').toBe(ids.length + 1);
  await expect(hovRegion(page)).not.toContainText('777777.777');
  await finish(page, s);
});

test('OV: a discharge-only SPW gauge is coloured by its trend (the map’s Δ rule), not grey', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, `/?mode=delta&t=${T}&hov=meuse`);
  await hovReady(page, 'meuse');
  const columns = (await hovState(page))?.columns ?? [];
  expect(
    columns.map((c) => c.id),
    'the Q-only gauge is a column',
  ).toContain(Q_ONLY);
  // The seed holds values from 2026-10-24, so the 24 h change exists from the 25th on: a class (a bin), by the Q trend.
  const cell = await page.evaluate(
    ([id, iso]) => (window as unknown as HovW).__rwsHov?.cellAt(id as string, iso as string),
    [Q_ONLY, T_ISO],
  );
  expect(cell?.quantity).toBe('Q');
  expect(cell?.bin, 'a trend class, not no data').not.toBeNull();
  // The table says it in words, with the discharge unit.
  await hovTableToggle(page).click();
  const table = hovRegion(page).getByRole('table');
  const col = columns.findIndex((c) => c.id === Q_ONLY) + 1;
  const row = table.locator('tbody tr').filter({ has: page.locator('th[scope="row"] button[aria-current="time"]') });
  await expect(row.locator('td').nth(col - 1)).toHaveText(/^[+−]?\d+ m³\/s$/);
  await finish(page, s);
});

// Review round 1 (T-WEB-8): the owner host reads the panel's page from the owner API, one bounded call, no file.
test('OV: the owner panel asks its page of frames with one owner API call of at most 14 days, no static file', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, `/?mode=delta&t=${T}&hov=meuse`);
  await hovReady(page, 'meuse');
  const urls = urlsFrom(s);
  const calls = urls.filter((u) => u.pathname === FRAMES_API);
  expect(calls, 'one owner API call for the page').toHaveLength(1);
  const [from, to] = [
    Date.parse(calls[0]?.searchParams.get('from') ?? ''),
    Date.parse(calls[0]?.searchParams.get('to') ?? ''),
  ];
  expect(to - from, 'at most 14 days').toBeLessThanOrEqual(14 * 86_400_000);
  expect(to, 'the window ends at the page, never after it').toBeLessThanOrEqual(Date.parse('2026-10-26T12:00:00Z'));
  expect(
    urls.filter((u) => FRAMES_FILE.test(u.pathname)),
    'no static frames file on the owner host',
  ).toEqual([]);
  await finish(page, s);
});
