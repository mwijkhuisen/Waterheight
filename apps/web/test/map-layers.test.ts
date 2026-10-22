import { readFileSync } from 'node:fs';
import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { LAPSED_COLOUR, LAPSED_RADIUS, STATE_COLOUR } from '../src/features/legend/palette.ts';
import { hatchAreaIcon, hatchIcon, triangleIcon } from '../src/features/map/icons.ts';
import { badgeLine, changeLine, surgeLine } from '../src/features/map/popup.ts';
import { riverFilter, riverUrl, showRivers } from '../src/features/map/rivers.ts';
import { hollow, layerPaints, stationPoints } from '../src/features/map/stationLayer.ts';
import { warningLayers, warningsGeoJson } from '../src/features/map/warnings.ts';
import { addWater } from '../src/features/map/waterLayer.ts';
import type { WarningsAt } from '../src/lib/data/warnings.ts';
import { MODES } from '../src/lib/url/url.ts';
import { WATER_CANALS, WATER_LAKES, WATER_LAKES_LINE, WATER_LAKES_TIDAL } from '../src/lib/water.ts';

const src = (name: string) => readFileSync(new URL(`../src/features/map/${name}`, import.meta.url), 'utf8');
const alpha = (i: { data: Uint8ClampedArray }) => [...i.data].filter((_, k) => k % 4 === 3);

describe('rivers', () => {
  it('builds exactly the highlight filter on the tile property river_id', () => {
    expect(riverFilter('rijn')).toEqual(['==', ['get', 'river_id'], 'rijn']);
  });
  it('builds a pmtiles URL only for a rivers-YYYYMMDD.pmtiles name', () => {
    expect(riverUrl('https://x.example', 'rivers-20261002.pmtiles')).toBe(
      'pmtiles://https://x.example/tiles/rivers-20261002.pmtiles',
    );
    for (const bad of [
      '../rivers-20261002.pmtiles',
      'rivers-2026.pmtiles',
      'planet.pmtiles',
      'rivers-20261002.pmtiles/x',
      '',
    ])
      expect(riverUrl('https://x.example', bad), bad).toBeUndefined();
  });
});

describe('icons (drawn at run time)', () => {
  it('draw RGBA of the stated size, with some opaque and some empty pixels', () => {
    for (const i of [hatchIcon(), hatchAreaIcon(), triangleIcon(true), triangleIcon(false)]) {
      expect(i.data.length).toBe(i.width * i.height * 4);
      expect(alpha(i).some((a) => a > 0)).toBe(true);
      expect(alpha(i).some((a) => a === 0)).toBe(true);
    }
  });
  it('point up and down: the apex row is narrower than the base row', () => {
    const row = (i: ReturnType<typeof triangleIcon>, y: number) =>
      alpha(i)
        .slice(y * i.width, (y + 1) * i.width)
        .filter((a) => a > 0).length;
    const up = triangleIcon(true);
    const down = triangleIcon(false);
    expect(row(up, 2)).toBeLessThan(row(up, 9));
    expect(row(down, 9)).toBeLessThan(row(down, 2));
  });
});

describe('stationPoints', () => {
  it('carries the two flags as booleans, null as false', () => {
    const st = (flags: { tidal: boolean | null; impounded: boolean | null }) =>
      ({ id: 'a', lon: 1, lat: 2, flags, series: [] }) as never;
    const f = stationPoints([st({ tidal: true, impounded: null })]).features[0];
    expect(f?.properties).toEqual({ id: 'a', tidal: true, impounded: false, msl: false });
  });
});

describe('layer paint', () => {
  it('is valid for the style spec in every mode, and differs between modes', () => {
    const colours = new Set<string>();
    for (const mode of MODES) {
      const paints = layerPaints(mode);
      colours.add(JSON.stringify(paints.stations?.['circle-color']));
      const layers = Object.entries(paints).map(([id, paint]) =>
        id.startsWith('stations-trend') || id.startsWith('stations-surge')
          ? { id, type: 'symbol', source: 's', layout: { 'icon-image': 'tri-up' }, paint }
          : { id, type: 'circle', source: 's', paint },
      );
      const style = {
        version: 8,
        sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
        layers,
      };
      expect(validateStyleMin(style as never), mode).toEqual([]);
    }
    expect(colours.size).toBe(3);
  });
  it('draws a lapsed station (stale without a value) as a small grey dot in every mode (KG-233)', () => {
    for (const mode of MODES) {
      const paint = JSON.stringify(layerPaints(mode).stations);
      expect(paint, mode).toContain(LAPSED_COLOUR);
      expect(paint, mode).toContain(String(LAPSED_RADIUS));
    }
  });
  it('shows the triangles only in the delta mode', () => {
    expect(JSON.stringify(layerPaints('state')['stations-trend-up'])).toContain('false');
    expect(JSON.stringify(layerPaints('delta')['stations-trend-up'])).toContain('dhBin');
  });
  it('warning layers are valid and carry no name or label', () => {
    const style = {
      version: 8,
      sources: { warnings: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: warningLayers,
    };
    expect(validateStyleMin(style as never)).toEqual([]);
    expect(JSON.stringify(warningLayers)).not.toMatch(/name|label/);
  });
});

describe('warningsGeoJson', () => {
  const feature = (name: string, geometry: unknown) => ({
    type: 'Feature' as const,
    geometry,
    properties: {
      source: 'DE-6',
      area: 'HE:1',
      name,
      level: 3,
      levelRaw: '2',
      label: '<img src=x onerror=alert(1)>',
      from: '2026-10-01T00:00:00Z',
      to: null,
      issuedAt: null,
    },
  });
  it('keeps source, area, level and levelRaw only and drops an area without geometry', () => {
    const w = {
      incomplete: false,
      features: [feature('<b>Name</b>', { type: 'Polygon', coordinates: [] }), feature('x', null)],
    } as unknown as WarningsAt;
    const out = warningsGeoJson(w);
    expect(out.features.map((f) => f.properties)).toEqual([{ source: 'DE-6', area: 'HE:1', level: 3, levelRaw: '2' }]);
    expect(JSON.stringify(out)).not.toMatch(/Name|onerror/);
    expect(warningsGeoJson(undefined).features).toEqual([]);
  });
});

describe('popup text', () => {
  it('words the change with its trend, or "not applicable" without one', () => {
    expect(changeLine('Q', { quantity: 'H' }, { dh: 12, trend: 'rising' }, 'en')).toBe(
      'Q: +12 cm over 24 hours, rising',
    );
    expect(changeLine('Q', { quantity: 'H' }, null, 'en')).toBe('Q: Δh not applicable');
  });
  it('joins the badges in words', () => {
    const state = { section: true, owner: false, suspect: true, stale: false } as never;
    expect(badgeLine({ state, tidal: true, impounded: false }, 'en')).toMatch(/^section · ! suspect.* · tidal$/);
    expect(badgeLine({ state: undefined, tidal: false, impounded: false }, 'en')).toBe('');
    // KG-233: stale with a value is a carried value; stale without one is a lapsed station.
    const stale = (has: boolean) => ({ section: false, owner: false, suspect: false, stale: true, has }) as never;
    expect(badgeLine({ state: stale(true), tidal: false, impounded: false }, 'en')).toBe(
      'older than two measuring steps',
    );
    expect(badgeLine({ state: stale(false), tidal: false, impounded: false }, 'en')).toBe(
      'no value within the staleness limit',
    );
  });
  it('words a coast surge, signed and derived, in the state mode only (P19a, review CR-7)', () => {
    const surge = (cm: number | null) => ({ surge: cm }) as never;
    expect(surgeLine(surge(80), 'state', 'nl')).toBe('Opzet: +80 cm (afgeleid)');
    expect(surgeLine(surge(-60), 'state', 'en')).toBe('Surge: -60 cm (derived)');
    expect(surgeLine(surge(12.5), 'state', 'nl')).toBe('Opzet: +12,5 cm (afgeleid)');
    expect(surgeLine(surge(0), 'state', 'en')).toBe('Surge: 0 cm (derived)');
    // none without a surge (playback, no tide), for no state, and in the other modes
    expect(surgeLine(surge(null), 'state', 'en')).toBe('');
    expect(surgeLine(undefined, 'state', 'en')).toBe('');
    expect(surgeLine(surge(80), 'delta', 'en')).toBe('');
    expect(surgeLine(surge(80), 'q', 'en')).toBe('');
  });
});

describe('attribution (C9)', () => {
  it('createMap passes no customAttribution and the new sources set no attribution', () => {
    expect(src('createMap.ts')).not.toMatch(/customAttribution/);
    for (const f of ['rivers.ts', 'warnings.ts', 'stationLayer.ts'])
      expect(src(f), f).not.toMatch(/\battribution['"]?\s*:/i);
  });
});

// The expression evaluator of the style spec, for a paint or filter that reads feature-state.
function evaluate(expr: unknown, type: 'boolean' | 'color' | 'number', state: Record<string, unknown>, zoom = 8) {
  const r = createExpression(
    expr as never,
    {
      type,
      'property-type': 'data-driven',
      expression: { interpolated: type !== 'boolean', parameters: ['zoom', 'feature'] },
    } as never,
  );
  if (r.result !== 'success') throw new Error('bad expression');
  return r.value.evaluate({ zoom } as never, { properties: {} } as never, state);
}

describe('coast stations in state mode (P19a T2)', () => {
  const base = { has: true, coast: true, forecast: false, stale: false, level: 3 };
  it('are hollow without a surge, and coloured with one; a river station follows its level', () => {
    const hollowIn = (st: Record<string, unknown>) => evaluate(hollow('state'), 'boolean', st);
    expect(hollowIn({ ...base, surge: null })).toBe(true);
    expect(hollowIn({ ...base })).toBe(true);
    expect(hollowIn({ ...base, surge: 80 })).toBe(false);
    expect(hollowIn({ ...base, surge: 0 })).toBe(false);
    expect(hollowIn({ ...base, coast: false, surge: null })).toBe(false);
    expect(hollowIn({ ...base, coast: false, level: 0 })).toBe(true);
    expect(hollowIn({ ...base, surge: 80, has: false })).toBe(true);
  });
  it('draw no fill for a hollow coast point, and a fill for one with a surge', () => {
    const opacity = layerPaints('state').stations?.['circle-opacity'];
    expect(evaluate(opacity, 'number', { ...base, surge: null })).toBe(0);
    expect(evaluate(opacity, 'number', { ...base, surge: 80 })).toBe(1);
  });
});

interface Spec {
  id: string;
  type: string;
  'source-layer': string;
  filter?: unknown;
  paint: Record<string, unknown>;
}

describe('water layers (P19a T3)', () => {
  function fakeWater(opts: { rivers?: boolean } = {}) {
    let broken = false;
    const layers = new Map<string, unknown>(opts.rivers === false ? [] : [['rivers', {}]]);
    const specs: { spec: Spec; before: string | undefined }[] = [];
    const calls: { fn: string; args: unknown[] }[] = [];
    const rec =
      (fn: string, f?: (...a: never[]) => unknown) =>
      (...args: never[]) => {
        calls.push({ fn, args });
        return f?.(...args);
      };
    const map = {
      getLayer: (id: string) => {
        if (broken) throw new Error('the map is removed');
        return layers.get(id);
      },
      addLayer: rec('addLayer', (spec: Spec, before: string | undefined) => {
        specs.push({ spec, before });
        layers.set(spec.id, spec);
      }),
      removeLayer: rec('removeLayer', (id: string) => layers.delete(id)),
      setFilter: rec('setFilter'),
      setFeatureState: rec('setFeatureState'),
    };
    return { map: map as never, specs, calls, layers, remove: () => (broken = true) };
  }
  const only = (calls: { fn: string; args: unknown[] }[], fn: string) => calls.filter((c) => c.fn === fn);
  const added = () => {
    const f = fakeWater();
    const handle = addWater(f.map, 'rivers');
    return { ...f, handle, byId: (id: string) => f.specs.find((s) => s.spec.id === id)?.spec as Spec };
  };

  it('adds the four layers under rivers, valid for the style spec', () => {
    const { specs } = added();
    expect(specs.map((s) => s.spec.id)).toEqual([WATER_LAKES, WATER_LAKES_TIDAL, WATER_LAKES_LINE, WATER_CANALS]);
    for (const s of specs) expect(s.before, s.spec.id).toBe('rivers');
    const style = {
      version: 8,
      sprite: undefined,
      sources: { rivers: { type: 'vector', url: 'pmtiles://x/tiles/rivers-20260101.pmtiles' } },
      layers: specs.map((s) => s.spec),
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });
  it('anchors on nothing when the river layer is missing', () => {
    const f = fakeWater({ rivers: false });
    addWater(f.map, 'rivers');
    expect(f.specs.map((s) => s.before)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it('keeps feature-state out of every pattern property (a pattern cannot read it)', () => {
    const { specs } = added();
    const patterns = specs.flatMap((s) => Object.entries(s.spec.paint).filter(([k]) => k.endsWith('-pattern')));
    expect(patterns.map(([k, v]) => [k, v])).toEqual([['fill-pattern', 'hatch-area']]);
    for (const [k, v] of patterns) expect(JSON.stringify(v), k).not.toContain('feature-state');
  });
  it('draws the canals from the canals tile layer only, and no flow layer reads it', () => {
    const { byId } = added();
    expect(byId(WATER_CANALS)).toMatchObject({ type: 'line', 'source-layer': 'canals' });
    expect(JSON.stringify(byId(WATER_CANALS).paint)).not.toContain('feature-state');
    for (const id of [WATER_LAKES, WATER_LAKES_TIDAL, WATER_LAKES_LINE])
      expect(byId(id)['source-layer'], id).toBe('waterbodies');
    const flow = readFileSync(new URL('../src/features/flow/flowLayer.ts', import.meta.url), 'utf8');
    expect(flow).not.toMatch(/canals|waterbodies/);
    expect(flow.match(/'source-layer': '[a-z_]+'/g)?.every((x) => x === "'source-layer': 'rivers'")).toBe(true);
  });
  it('draws the canals thinner than the river line at every zoom', () => {
    const rivers: { spec: Spec }[] = [];
    const sources = new Set<string>();
    showRivers(
      {
        getLayer: () => undefined,
        getSource: (id: string) => (sources.has(id) ? {} : undefined),
        addSource: (id: string) => sources.add(id),
        addLayer: (spec: Spec) => rivers.push({ spec }),
      } as never,
      'https://x.example',
      'rivers-20261002.pmtiles',
      'warnings-fill',
    );
    const river = rivers.find((r) => r.spec.id === 'rivers')?.spec.paint['line-width'];
    const canal = added().byId(WATER_CANALS).paint['line-width'];
    for (let z = 0; z <= 16; z++)
      expect(evaluate(canal, 'number', {}, z), `zoom ${z}`).toBeLessThan(evaluate(river, 'number', {}, z) as number);
  });
  it('fills a lake by the state of its reference gauge (lv), grey without a class, and only polygons of lake kinds', () => {
    const { byId } = added();
    const colour = byId(WATER_LAKES).paint['fill-color'];
    const rgba = (state: Record<string, unknown>) => String(evaluate(colour, 'color', state));
    expect(rgba({ lv: 3 })).toBe(STATE_COLOUR.elevated);
    expect(rgba({ lv: 5 })).toBe(STATE_COLOUR.extreme);
    expect(rgba({})).toBe('#c8ccd0');
    expect(rgba({ lv: null })).toBe('#c8ccd0');
    for (const id of [WATER_LAKES, WATER_LAKES_TIDAL, WATER_LAKES_LINE])
      expect(JSON.stringify(byId(id).filter), id).toContain('geometry-type');
    for (const id of [WATER_LAKES, WATER_LAKES_LINE])
      expect(JSON.stringify(byId(id).filter), id).toContain('closed_estuary');
  });
  it('writes the tidal lakes as an id filter, and the levels as lv on the waterbodies layer', () => {
    const { handle, calls } = added();
    handle.setTidal(['haringvliet']);
    const filter = only(calls, 'setFilter')[0]?.args;
    expect(filter?.[0]).toBe(WATER_LAKES_TIDAL);
    expect(JSON.stringify(filter?.[1])).toContain('["literal",["haringvliet"]]');
    // by the tile property, with the polygon guard: a filter never sees the promoted id (review CR-6)
    expect(JSON.stringify(filter?.[1])).toContain('["get","waterbody_id"]');
    expect(JSON.stringify(filter?.[1])).not.toContain('["id"]');
    expect(JSON.stringify(filter?.[1])).toContain('geometry-type');
    handle.update(
      new Map([
        ['ijsselmeer', { level: 3 }],
        ['veluwemeer', { level: null }],
      ]),
    );
    expect(only(calls, 'setFeatureState').map((c) => c.args)).toEqual([
      [{ source: 'rivers', sourceLayer: 'waterbodies', id: 'ijsselmeer' }, { lv: 3 }],
      [{ source: 'rivers', sourceLayer: 'waterbodies', id: 'veluwemeer' }, { lv: null }],
    ]);
  });
  it('removes its layers on dispose, and survives a map that is already gone', () => {
    const { handle, calls } = added();
    handle.dispose();
    expect(only(calls, 'removeLayer').map((c) => c.args[0])).toEqual([
      WATER_LAKES,
      WATER_LAKES_TIDAL,
      WATER_LAKES_LINE,
      WATER_CANALS,
    ]);
    const gone = fakeWater();
    const h = addWater(gone.map, 'rivers');
    gone.remove();
    expect(() => h.dispose()).not.toThrow();
  });
});
