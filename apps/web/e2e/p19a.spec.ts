import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { expect, type Page, test } from '@playwright/test';
import {
  chooseMode,
  expectNoSeriousAxe,
  featureState,
  finish,
  mapReady,
  msg,
  open,
  openMode,
  param,
  pickStation,
  playHold,
  start,
} from './helpers.ts';
import { E2E_HOSTILE_LAKE } from './prepare-tiles.ts';

// P19a (issue #67): the lake, coast and sea layers on Chromium, Firefox and WebKit over the e2e seed (apps/server/test/e2e/
// api.ts P19A block; apps/web/e2e/prepare-tiles.ts E2E_BODIES): the fixed clock NOW = 2026-10-26T12:00Z.
//   1  lakes: the fill's state is the reference gauge's, not the worst gauge's; a lake without a reference is "geen klasse";
//   2  coast: the surge in the feature-state, the hatch and the ▲ over it;     3  an offshore MSL platform: hollow, marked;
//   4  the tidal delta is hatched and does not flow; the canals draw and do not flow;
//   5  the layer checkboxes and `?hide=`;     6  the legend;     7  a hostile water-body name stays text;
//   8  the slider: a past hour (-60), NOW + 6 h (150), playback (no surge);     9  0 CSP violations, axe (the end of each test).
// Everything is read through window.__rws.map (the e2e build's hook): feature-state, queryRenderedFeatures, layout
// properties, filters and the paint expressions evaluated with the style spec's own evaluator. No screenshots.

const COAST = 'nl.e2e.coast';
const PLATFORM = 'nl.e2e.platform';
const LAKE_GAUGE = 'nl.e2e.lake-gauge';
const LAKE_REF = 'nl.e2e.lake-ref';
const LAKE_NOREF = 'nl.e2e.lake-noref';
/** The e2e stations of the lake and coast groups (E2E_BODIES). */
const LAKE_STATIONS = [LAKE_GAUGE, LAKE_REF, LAKE_NOREF];
const COAST_STATIONS = [COAST, PLATFORM];
/** The past hour (served from the P9 recent/ file and the API, not a settled day: no seeded day is settled) and NOW + 6 h. */
const PAST = '2026-10-24T12:00Z';
const AHEAD = '2026-10-26T18:00Z';
/** features/legend/palette.ts LADDER: ['no_ref', 'low', 'normal', 'elevated', 'high', 'extreme']; lake-ref is `elevated`. */
const ELEVATED = 3;

const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);

// The few map calls beyond the shared HookMap.
interface Rendered {
  id?: string | number;
  properties: Record<string, unknown>;
}
type Point = [number, number];
interface QMap {
  queryRenderedFeatures(g?: Point | [Point, Point], o?: { layers?: string[] }): Rendered[];
  querySourceFeatures(source: string, o?: object): { properties: Record<string, unknown>; geometry: unknown }[];
  getCanvas(): HTMLCanvasElement;
  getStyle(): { layers: { id: string; 'source-layer'?: string }[] };
  getFeatureState(f: { source: string; sourceLayer?: string; id: string }): Record<string, unknown>;
  getLayoutProperty(layer: string, name: string): unknown;
  getPaintProperty(layer: string, name: string): unknown;
  getFilter(layer: string): unknown;
  getSource(id: string): { getData(): Promise<unknown> } | undefined;
  jumpTo(o: { center: Point; zoom: number }): void;
  project(lngLat: Point): { x: number; y: number };
  unproject(p: Point): { lng: number; lat: number };
  isSourceLoaded(id: string): boolean;
  isMoving(): boolean;
}
/** The map, inside page.evaluate (a function of this file does not exist there): `(window as unknown as Win).__rws.map`. */
type Win = Window & { __rws: { map: QMap } };

/** The hook holds a map (it is null for an instant whenever the station layers are rebuilt, e.g. when the lake list arrives). */
const mapUp = (page: Page) => page.waitForFunction(() => (window as unknown as Win).__rws?.map);
/** Moves the map (the view is not in the URL). */
const jump = async (page: Page, center: Point, zoom: number) => {
  await mapUp(page);
  await page.evaluate(
    ([c, z]) => (window as unknown as Win).__rws.map.jumpTo({ center: c as Point, zoom: z as number }),
    [center, zoom] as const,
  );
};

/** The ids of the features that `layers` renders in the whole canvas now (empty while tiles load). */
const renderedIds = (page: Page, layers: string[]) =>
  page.evaluate(
    (layers) => [
      ...new Set(
        (window as unknown as Win).__rws?.map
          ?.queryRenderedFeatures(undefined, { layers })
          .map((f) => String(f.id ?? f.properties.id)) ?? [],
      ),
    ],
    layers,
  );
/** The ids of the station points the `stations` source holds (the GeoJSON data as set, not what is in view). */
const sourceIds = (page: Page) =>
  page.evaluate(async () => {
    const data = (await (window as unknown as Win).__rws?.map?.getSource('stations')?.getData()) as
      | { features: { properties: { id: string } }[] }
      | undefined;
    return data?.features.map((f) => f.properties.id) ?? [];
  });
/** Those of `ids` that the station source holds (none while the map is rebuilt: a poll then tries again). */
const held = async (page: Page, ids: readonly string[]) => {
  const all = await sourceIds(page);
  return ids.filter((id) => all.includes(id));
};
const visibility = (page: Page, layer: string) =>
  page.evaluate((id) => {
    const map = (window as unknown as Win).__rws?.map;
    return map?.getStyle().layers.some((l) => l.id === id) ? map.getLayoutProperty(id, 'visibility') : null;
  }, layer);
/** The ids of the flow layers (they exist once the river source does and the flow chunk has loaded). */
const flowIds = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as Win).__rws?.map
        ?.getStyle()
        .layers.filter((l) => l.id.startsWith('rivers-flow'))
        .map((l) => l.id) ?? [],
  );
const lakeState = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (window as unknown as Win).__rws?.map?.getFeatureState({ source: 'rivers', sourceLayer: 'waterbodies', id }) ??
      null,
    id,
  );

/** The e2e build starts with the flow off (App.tsx); the specs that need it ask before the page loads (p11a.spec.ts). */
const flowOn = (page: Page) =>
  page.addInitScript(() => {
    (window as unknown as { __rwsFlow?: boolean }).__rwsFlow = true;
  });
/** window.alert is replaced by a recorder, before any page script runs (the dialog listener of `start` is the second net). */
const alertStub = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __alerts: string[] };
    w.__alerts = [];
    window.alert = (message?: unknown) => {
      w.__alerts.push(String(message));
    };
  });
/** The flow clock's steps so far (the e2e build counts them, p11a.spec.ts). */
const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rwsFlowFrames?: number }).__rwsFlowFrames ?? 0);
/** The ids of the toggled river layers in the style now: every `rivers…` layer and the canals (O-3). */
const riverLayers = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as Win).__rws?.map
        ?.getStyle()
        .layers.map((l) => l.id)
        .filter((id) => id.startsWith('rivers') || id === 'water-canals') ?? [],
  );
const alerts = (page: Page) => page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts);

/** The map is mounted and the station states of the page's t have arrived (nl.e2e.coast has a value at every seeded hour). */
async function coastReady(page: Page) {
  await page.locator('main').evaluate((main) => main.scrollIntoView({ block: 'end' }));
  await expect.poll(() => featureState(page, COAST)).toMatchObject({ has: true });
}

/** Evaluates a station layer's paint property for a feature-state with the style spec's own evaluator (as map-layers.test.ts). */
async function paint(page: Page, layer: string, name: string, state: Record<string, unknown>) {
  await mapUp(page);
  const expr = await page.evaluate(
    ([l, n]) => (window as unknown as Win).__rws.map.getPaintProperty(l as string, n as string),
    [layer, name] as const,
  );
  const r = createExpression(
    expr as never,
    {
      type: 'number',
      'property-type': 'data-driven',
      expression: { interpolated: true, parameters: ['zoom', 'feature'] },
    } as never,
  );
  if (r.result !== 'success') throw new Error(`bad expression of ${layer} ${name}`);
  return r.value.evaluate({ zoom: 8 } as never, { properties: {} } as never, state);
}

const checkbox = (page: Page, key: 'layer_rivers' | 'layer_lakes' | 'layer_coast', locale: 'nl' | 'en' = 'nl') =>
  page.getByRole('checkbox', { name: msg(locale, key), exact: true });
const popup = (page: Page) => page.locator('.maplibregl-popup-content');

/**
 * A viewport point inside the lake `id` where a click reaches the lake popup: the lake renders there, no station or river
 * is within the 5 px box (the popup bails then), and the canvas, not a control, is on top. Null while tiles load.
 */
async function lakePoint(page: Page, id: string) {
  return page.evaluate((id) => {
    const map = (window as unknown as Win).__rws.map;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const mid = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = 8; y < canvas.clientHeight - 8; y += 8)
      for (let x = 8; x < canvas.clientWidth - 8; x += 8) {
        const hit = map.queryRenderedFeatures([x, y], { layers: ['water-lakes'] });
        if (!hit.some((f) => String(f.id) === id)) continue;
        const box: [Point, Point] = [
          [x - 7, y - 7],
          [x + 7, y + 7],
        ];
        if (map.queryRenderedFeatures(box, { layers: ['stations', 'rivers'] }).length > 0) continue;
        if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
        const d = (x - mid.x) ** 2 + (y - mid.y) ** 2;
        if (best === null || d < best.d) best = { x: rect.left + x, y: rect.top + y, d };
      }
    return best === null ? null : { x: best.x, y: best.y };
  }, id);
}

/** Moves to a lake, waits for its tiles, and clicks an interior point of it. */
async function clickLake(page: Page, id: string, centre: Point, zoom: number) {
  await jump(page, centre, zoom);
  let at: { x: number; y: number } | null = null;
  await expect
    .poll(async () => (at = await lakePoint(page, id)), { message: `a free point inside ${id}` })
    .not.toBeNull();
  if (at === null) throw new Error('unreachable');
  const { x, y } = at;
  await page.mouse.click(x, y);
}

// ---------------------------------------------------------------- 1: lakes

test('lakes: the fill takes the reference gauge state, a lake without a reference is "geen klasse", the lake gauge is its own point', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await coastReady(page);
  // Both lakes are in the view at zoom 8 over the Markermeer and the Veluwemeer.
  await jump(page, [5.5, 52.55], 8);
  await expect
    .poll(async () => (await renderedIds(page, ['water-lakes'])).sort())
    .toEqual(expect.arrayContaining(['ijsselmeer', 'veluwemeer']));
  // The IJsselmeer's lv is `elevated`, the reference gauge's (D27), although nl.e2e.lake-gauge is `high`; the Veluwemeer
  // has no reference: lv is null, drawn grey.
  await expect.poll(() => lakeState(page, 'ijsselmeer')).toMatchObject({ lv: ELEVATED });
  await expect.poll(() => lakeState(page, 'veluwemeer')).toMatchObject({ lv: null });
  expect(await featureState(page, LAKE_GAUGE)).toMatchObject({ has: true, level: 4 });
  expect(await featureState(page, LAKE_REF)).toMatchObject({ has: true, level: ELEVATED });
  // The lake gauge is a point of its own in the station layer, not folded into the lake.
  await jump(page, [5.5, 52.6], 9);
  await expect.poll(() => renderedIds(page, ['stations'])).toEqual(expect.arrayContaining([LAKE_GAUGE, LAKE_REF]));
  await expect.poll(() => held(page, LAKE_STATIONS)).toEqual(LAKE_STATIONS);

  // A click inside the Veluwemeer (away from its station and any river) opens the lake popup: its name, no reference, no class.
  await clickLake(page, 'veluwemeer', [5.7, 52.4], 11);
  await expect(popup(page)).toContainText(nl('lake_no_reference'));
  await expect(popup(page)).toContainText(nl('lake_no_class'));
  expect(nl('lake_no_class')).toBe('geen klasse');
  await finish(page, s);
});

test('the lakes colour in the state mode only: grey "geen klasse" in the delta and Q modes, the tidal hatch in every mode', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?mode=delta');
  await coastReady(page);
  // Delta (review CR-3): every lake is "geen klasse", the IJsselmeer too.
  await expect.poll(() => lakeState(page, 'ijsselmeer')).toMatchObject({ lv: null });
  await chooseMode(page, 'state');
  await expect.poll(() => lakeState(page, 'ijsselmeer')).toMatchObject({ lv: ELEVATED });
  await chooseMode(page, 'q');
  await expect.poll(() => lakeState(page, 'ijsselmeer')).toMatchObject({ lv: null });
  // The Haringvliet's reference (hellevoetsluis) is tidal: the hatch layer's id filter holds it, in this mode as well,
  // and the hatch renders where the Haringvliet is (review CR-6).
  await expect
    .poll(() =>
      page.evaluate(() => JSON.stringify((window as unknown as Win).__rws?.map?.getFilter('water-lakes-tidal'))),
    )
    .toContain('"haringvliet"');
  await jump(page, [4.25, 51.8], 9);
  await expect.poll(() => renderedIds(page, ['water-lakes-tidal'])).toContain('haringvliet');
  await finish(page, s);
});

// ---------------------------------------------------------------- 2: coast

test('coast: the station has coast true and surge 80, sits in the tidal hatch layer and shows the ▲', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await coastReady(page);
  await expect.poll(() => featureState(page, COAST)).toMatchObject({ has: true, coast: true, surge: 80 });
  await jump(page, [5.25, 53.4], 8);
  await expect.poll(() => renderedIds(page, ['stations-tidal'])).toContain(COAST);
  // ▲ (surge ≥ +50): the layer's own icon-opacity for this feature-state is 1; the ▼ layer is 0.
  const state = await featureState(page, COAST);
  expect(await paint(page, 'stations-surge-up', 'icon-opacity', state ?? {})).toBe(1);
  expect(await paint(page, 'stations-surge-down', 'icon-opacity', state ?? {})).toBe(0);
  // Coloured (not hollow): the circle is drawn.
  expect(await paint(page, 'stations', 'circle-opacity', state ?? {})).toBeGreaterThan(0);
  await finish(page, s);
});

test('a station chosen in the search replaces an open lake popup; its popup says the surge, derived', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await coastReady(page);
  await clickLake(page, 'veluwemeer', [5.7, 52.4], 11);
  await expect(popup(page)).toContainText(nl('lake_no_class'));
  // A lake click never sets `?s=`.
  expect(param(page, 's')).toBeNull();
  // Review CR-5: the search's choice closes the lake popup, so the station's own popup shows.
  await pickStation(page, 'E2E coast');
  await expect.poll(() => param(page, 's')).toBe(COAST);
  await expect(popup(page)).toHaveCount(1);
  await expect(popup(page)).toContainText('E2E coast');
  await expect(popup(page)).not.toContainText(nl('lake_no_class'));
  // Review CR-7: the surge its marker is coloured by, in words, signed and marked derived.
  await expect(popup(page)).toContainText(nl('popup_surge', { cm: '+80' }));
  expect(nl('popup_surge', { cm: '+80' })).toBe('Opzet: +80 cm (afgeleid)');
  await finish(page, s);
});

// ---------------------------------------------------------------- 3: the offshore platform

test('the offshore MSL platform is drawn, marked MSL and hollow, with no surge', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await coastReady(page);
  await jump(page, [4.7, 54.6], 5);
  await expect.poll(() => renderedIds(page, ['stations'])).toContain(PLATFORM);
  await expect.poll(() => renderedIds(page, ['stations-msl'])).toContain(PLATFORM);
  await expect.poll(() => featureState(page, PLATFORM)).toMatchObject({ has: true, coast: true, surge: null });
  // Hollow: its circle has opacity 0 whatever its (MSL) level, so the level is never painted against a NAP scale; and no ▲ or ▼.
  const state = (await featureState(page, PLATFORM)) ?? {};
  expect(await paint(page, 'stations', 'circle-opacity', state)).toBe(0);
  expect(await paint(page, 'stations-surge-up', 'icon-opacity', state)).toBe(0);
  expect(await paint(page, 'stations-surge-down', 'icon-opacity', state)).toBe(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- 4: delta and canals

test('the tidal delta is hatched and does not flow; the canals draw, and do not flow either', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await flowOn(page);
  await open(page, '/');
  await coastReady(page);
  // The flow layers are added once the river source exists; with `__rwsFlow` the clock runs, so never `idle` (p11a.spec.ts).
  await expect.poll(async () => (await flowIds(page)).length).toBeGreaterThan(0);
  const flow = await flowIds(page);
  expect(flow).toEqual(expect.arrayContaining(['rivers-flow', 'rivers-flow-arrows']));
  await expect.poll(() => visibility(page, 'rivers-flow')).toBe('visible');
  /** How many features `layers` renders now, and how many of them carry the tile's `tidal` flag. */
  const tidalOf = (layers: string[]) =>
    page.evaluate((layers) => {
      const found = (window as unknown as Win).__rws?.map?.queryRenderedFeatures(undefined, { layers }) ?? [];
      return { total: found.length, tidal: found.filter((f) => f.properties.tidal === true).length };
    }, layers);

  // Around the Haringvliet and the Nieuwe Waterweg the tidal reaches carry the hatch: the reach layers up to zoom 8, their
  // position-bin copies from zoom 8 (reachLayer.ts BIN_MINZOOM). The flow layers draw on the same view and not one rendered
  // flow feature is tidal.
  for (const [zoom, hatch] of [
    [7, 'rivers-reach-tidal'],
    [9, 'rivers-reach-tidal-bin'],
  ] as const) {
    await jump(page, [4.5, 51.85], zoom);
    await expect
      .poll(async () => (await tidalOf([hatch])).tidal, { message: `${hatch} at zoom ${zoom}` })
      .toBeGreaterThan(0);
    await expect.poll(async () => (await tidalOf(flow)).total, { message: `flow at zoom ${zoom}` }).toBeGreaterThan(0);
    expect((await tidalOf(flow)).tidal, `tidal flow features at zoom ${zoom}`).toBe(0);
  }

  // The canals are drawn (the Amsterdam-Rijnkanaal and the others of the fixture), and no flow layer reads their
  // source-layer: they read `rivers` only, so a canal never flows.
  await jump(page, [5.2, 52.0], 7);
  await expect.poll(async () => (await tidalOf(['water-canals'])).total).toBeGreaterThan(0);
  const sourceLayers = await page.evaluate(() =>
    (window as unknown as Win).__rws.map
      .getStyle()
      .layers.filter((l) => l.id.startsWith('rivers-flow'))
      .map((l) => l['source-layer']),
  );
  expect(sourceLayers.length).toBeGreaterThan(0);
  expect(sourceLayers).not.toContain('canals');
  await finish(page, s);
});

// ---------------------------------------------------------------- 5: the layer checkboxes and ?hide=

test('"Meren" hides the lakes and their gauges, writes hide=lakes, and the language link keeps it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await coastReady(page);
  await openMode(page);
  await expect(checkbox(page, 'layer_lakes')).toBeChecked();
  await expect.poll(() => visibility(page, 'water-lakes')).toBe('visible');
  await expect.poll(() => held(page, LAKE_STATIONS)).toEqual(LAKE_STATIONS);

  await checkbox(page, 'layer_lakes').uncheck();
  // The URL is written after its 400 ms throttle.
  await expect.poll(() => param(page, 'hide')).toBe('lakes');
  for (const id of ['water-lakes', 'water-lakes-tidal', 'water-lakes-line'])
    await expect.poll(() => visibility(page, id), { message: id }).toBe('none');
  await expect.poll(() => held(page, [...LAKE_STATIONS, COAST])).toEqual([COAST]);
  // Rivers and coast stay.
  await expect.poll(() => visibility(page, 'rivers')).toBe('visible');

  // Both languages carry the whole view.
  await expect(page.getByRole('link', { name: 'English' })).toHaveAttribute('href', /^\/en\/\?.*hide=lakes/);
  await page.getByRole('link', { name: 'English' }).click();
  await expect.poll(() => param(page, 'hide')).toBe('lakes');
  expect(new URL(page.url()).pathname).toBe('/en/');
  await expect.poll(() => visibility(page, 'water-lakes')).toBe('none');
  await openMode(page, 'en');
  await expect(checkbox(page, 'layer_lakes', 'en')).not.toBeChecked();
  await finish(page, s);
});

test('an unknown ?hide= token drops the whole key; "Kust en zee" hides the coast points and writes only its own group', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?hide=lakes,bogus');
  await coastReady(page);
  // Nothing is hidden, the key is dropped.
  await openMode(page);
  for (const key of ['layer_rivers', 'layer_lakes', 'layer_coast'] as const)
    await expect(checkbox(page, key)).toBeChecked();
  await expect.poll(() => visibility(page, 'water-lakes')).toBe('visible');
  await expect
    .poll(() => held(page, [...LAKE_STATIONS, ...COAST_STATIONS]))
    .toEqual([...LAKE_STATIONS, ...COAST_STATIONS]);

  // The next URL write carries only the new choice.
  await checkbox(page, 'layer_coast').uncheck();
  await expect.poll(() => param(page, 'hide')).toBe('coast');
  await expect.poll(() => held(page, [...LAKE_STATIONS, ...COAST_STATIONS])).toEqual(LAKE_STATIONS);
  await expect.poll(() => visibility(page, 'water-lakes')).toBe('visible');
  // Back on: the key goes.
  await checkbox(page, 'layer_coast').check();
  await expect.poll(() => param(page, 'hide')).toBeNull();
  await expect.poll(() => held(page, COAST_STATIONS)).toEqual(COAST_STATIONS);
  await finish(page, s);
});

test('"Rivieren" hides the river lines, the canals and the flow; the river stations leave the map', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await flowOn(page);
  await open(page, '/');
  // (mapReady waits for the xss station, a river station: only after it may the rivers be hidden)
  await mapReady(page);
  await expect.poll(async () => (await flowIds(page)).length).toBeGreaterThan(0);
  await expect.poll(() => visibility(page, 'rivers-flow')).toBe('visible');
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
  await openMode(page);
  await checkbox(page, 'layer_rivers').uncheck();
  await expect.poll(() => param(page, 'hide')).toBe('rivers');
  await mapUp(page);
  const layers = await riverLayers(page);
  expect(layers).toEqual(
    expect.arrayContaining(['rivers', 'rivers-reach', 'rivers-flow', 'rivers-flow-arrows', 'water-canals']),
  );
  for (const id of layers) await expect.poll(() => visibility(page, id), { message: id }).toBe('none');
  // The lakes stay.
  await expect.poll(() => visibility(page, 'water-lakes')).toBe('visible');
  await expect
    .poll(() => held(page, ['nl.e2e.xss', ...LAKE_STATIONS, ...COAST_STATIONS]))
    .toEqual([...LAKE_STATIONS, ...COAST_STATIONS]);
  await expect
    .poll(() => held(page, [...LAKE_STATIONS, ...COAST_STATIONS]))
    .toEqual([...LAKE_STATIONS, ...COAST_STATIONS]);
  // The hidden group stops the flow clock, not just its layers (review CR-6, the p11a hidden-tab check).
  await page.waitForTimeout(300); // a frame that was already in flight
  const frozen = await frames(page);
  await page.waitForTimeout(1500);
  expect(await frames(page), 'no flow step while the rivers are hidden').toBe(frozen);
  // Shown again: the clock runs on and the dashes are back.
  await checkbox(page, 'layer_rivers').check();
  await expect.poll(() => param(page, 'hide')).toBeNull();
  await expect.poll(() => frames(page)).toBeGreaterThan(frozen);
  await expect.poll(() => visibility(page, 'rivers-flow')).toBe('visible');
  expect(await visibility(page, 'rivers-flow-arrows')).toBe('none');
  await finish(page, s);
});

test('a ?hide=rivers link hides the river layers that arrive later too: the reach bins and the flow (review CR-1)', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?hide=rivers');
  // Not mapReady: it waits for nl.e2e.xss, a river station, which the hidden group takes off the map. The coast point
  // has a value; the bins come after the archive's metadata read, the flow and the water layers from their own chunks.
  await coastReady(page);
  await expect
    .poll(() => riverLayers(page))
    .toEqual(
      expect.arrayContaining([
        'rivers',
        'rivers-reach',
        'rivers-reach-tidal-bin',
        'rivers-flow-arrows',
        'water-canals',
      ]),
    );
  const layers = await riverLayers(page);
  expect(layers.filter((id) => id.endsWith('-bin'))).toHaveLength(5);
  for (const id of layers) await expect.poll(() => visibility(page, id), { message: id }).toBe('none');
  for (const id of ['water-lakes', 'water-lakes-line'])
    await expect.poll(() => visibility(page, id), { message: id }).toBe('visible');
  await expect.poll(() => held(page, ['nl.e2e.xss', COAST])).toEqual([COAST]);
  await finish(page, s);
});

// ---------------------------------------------------------------- 6: the legend

for (const locale of ['nl', 'en'] as const) {
  test(`the legend says the surge is derived and explains the MSL marker, the lake colour and the canals (${locale.toUpperCase()})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'state');
    await open(page, locale === 'nl' ? '/' : '/en/', locale === 'nl' ? undefined : 'Timeline');
    await coastReady(page);
    const t = (key: string) => msg(locale, key);
    const legend = page.locator('details').filter({ has: page.locator('summary', { hasText: t('legend_heading') }) });
    await legend.locator('summary').click();
    await expect(legend).toHaveAttribute('open', '');
    expect(t('surge_derived')).toBe(
      locale === 'nl' ? 'afgeleid, geen officiële klasse' : 'derived, not an official class',
    );
    for (const key of [
      'surge_derived',
      'legend_surge',
      'legend_surge_up',
      'legend_surge_down',
      'legend_surge_none',
      'legend_msl',
      'legend_lake',
      'legend_canal',
    ])
      await expect(legend, key).toContainText(t(key));
    await finish(page, s);
  });
}

test('axe finds no serious issue with the legend and the layer controls open', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await coastReady(page);
  await page.locator('summary', { hasText: nl('legend_heading') }).click();
  await openMode(page);
  await expect(page.getByRole('group', { name: nl('layer_legend') })).toBeVisible();
  await expectNoSeriousAxe(page);
  await finish(page, s);
});

// ---------------------------------------------------------------- 7: the hostile name

test('a water-body name that looks like HTML is text in the popup: no image, no alert', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await alertStub(page);
  await open(page, '/');
  await coastReady(page);
  await clickLake(page, 'gooimeer', [5.17, 52.3], 11);
  const name = popup(page).locator('span').first();
  await expect(name).toHaveText(E2E_HOSTILE_LAKE);
  await expect(popup(page).locator('img')).toHaveCount(0);
  await expect(page.locator('img[src="x"], [onerror]')).toHaveCount(0);
  expect(await alerts(page)).toEqual([]);
  await finish(page, s);
});

// ---------------------------------------------------------------- 8: the slider

test('a past hour has its own surge (-60), the hour 6 h ahead the forecast surge (150) and the forecast class of the lake', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?mode=state&t=${PAST}`);
  await coastReady(page);
  await expect.poll(() => featureState(page, COAST)).toMatchObject({ has: true, surge: -60 });
  // -60 is ≤ -50: the ▼.
  const past = (await featureState(page, COAST)) ?? {};
  expect(await paint(page, 'stations-surge-down', 'icon-opacity', past)).toBe(1);
  expect(await paint(page, 'stations-surge-up', 'icon-opacity', past)).toBe(0);
  await expect.poll(() => lakeState(page, 'ijsselmeer')).toMatchObject({ lv: ELEVATED });

  // The same page at NOW + 6 h (the forecast): the coast's forecast surge, the lake reference's forecast class.
  await open(page, `/?mode=state&t=${AHEAD}`);
  await coastReady(page);
  await expect.poll(() => featureState(page, COAST)).toMatchObject({ surge: 150 });
  await expect.poll(() => lakeState(page, 'ijsselmeer')).toMatchObject({ lv: ELEVATED });
  await expect.poll(() => lakeState(page, 'veluwemeer')).toMatchObject({ lv: null });
  await finish(page, s);
});

test('during playback the coast shows no surge: a ring, no ▲ or ▼', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await playHold(page);
  await open(page, '/?mode=state&t=2026-10-25T12:00Z');
  await coastReady(page);
  await expect.poll(() => featureState(page, COAST)).toMatchObject({ surge: expect.any(Number) });
  await page.getByRole('button', { name: nl('play'), exact: true }).click();
  await expect(page.getByRole('button', { name: nl('pause'), exact: true })).toBeVisible();
  // The frames carry no tide: once they play, the surge is null and the coast marker is a ring.
  await expect.poll(() => featureState(page, COAST)).toMatchObject({ coast: true, surge: null });
  const state = (await featureState(page, COAST)) ?? {};
  expect(await paint(page, 'stations', 'circle-opacity', state)).toBe(0);
  expect(await paint(page, 'stations-surge-up', 'icon-opacity', state)).toBe(0);
  expect(await paint(page, 'stations-surge-down', 'icon-opacity', state)).toBe(0);
  await finish(page, s);
});
