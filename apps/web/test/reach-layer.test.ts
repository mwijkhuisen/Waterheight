import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it, vi } from 'vitest';
import type { ReachPaint } from '../src/features/flow/reaches/colour.ts';
import { addReaches, binLayers, REACH_HATCH, reachLayers } from '../src/features/flow/reaches/reachLayer.ts';
import { reachItems } from '../src/features/legend/items.ts';
import { reachHatchIcon } from '../src/features/map/icons.ts';
import { showRivers } from '../src/features/map/rivers.ts';

// The writer is tested against the real module boundary: spans and paints are mocked (W2 owns them), so only the
// layer's own diffing, caching and safety are under test.
const paints = vi.hoisted(() => ({
  current: new Map<string, unknown>(),
  bins: new Map<string, unknown>(),
  spanCalls: 0,
}));
vi.mock('../src/features/flow/reaches/spans.ts', () => ({
  spansOf: () => {
    paints.spanCalls++;
    return new Map([['a', {}]]);
  },
}));
vi.mock('../src/features/flow/reaches/colour.ts', () => ({
  reachPaints: () => paints.current,
  binPaints: () => paints.bins,
}));

const st = (id: string) => ({ id }) as never;
const input = (stations: string[], graph: object = {}) =>
  ({ graph, mode: 'state', stations: stations.map(st), values: new Map(), changes: undefined }) as never;

function fakeMap(opts: { source?: boolean; zoom?: number } = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const layers = new Set<string>();
  const images = new Set<string>();
  const handlers = new Map<string, () => void>();
  let source = opts.source ?? true;
  let zoom = opts.zoom ?? 10;
  const rec =
    (fn: string, f?: (...a: never[]) => unknown) =>
    (...args: never[]) => {
      calls.push({ fn, args });
      return f?.(...args);
    };
  const map = {
    getLayer: (id: string) => (layers.has(id) ? {} : undefined),
    getSource: () => (source ? {} : undefined),
    hasImage: (n: string) => images.has(n),
    addImage: rec('addImage', (n: string) => images.add(n)),
    removeImage: rec('removeImage', (n: string) => images.delete(n)),
    addLayer: rec('addLayer', (l: { id: string }) => layers.add(l.id)),
    removeLayer: rec('removeLayer', (id: string) => layers.delete(id)),
    setLayerZoomRange: rec('setLayerZoomRange'),
    setFeatureState: rec('setFeatureState'),
    removeFeatureState: rec('removeFeatureState'),
    getZoom: () => zoom,
    on: rec('on', (ev: string, fn: () => void) => handlers.set(ev, fn)),
    off: rec('off', (ev: string) => handlers.delete(ev)),
  };
  layers.add('rivers-highlight');
  /** Moves the zoom and fires `zoomend` as MapLibre would. */
  const zoomTo = (z: number) => {
    zoom = z;
    handlers.get('zoomend')?.();
  };
  return { map: map as never, calls, dropSource: () => (source = false), zoomTo };
}
const only = (calls: { fn: string; args: unknown[] }[], fn: string) => calls.filter((c) => c.fn === fn);
const byId = (id: string) => reachLayers().find((l) => l.id === id);

describe('reach layer specs', () => {
  it('are valid for the style spec, in the planned order', () => {
    const layers = reachLayers();
    const style = {
      version: 8,
      sprite: undefined,
      sources: { rivers: { type: 'vector', url: 'pmtiles://x/tiles/rivers-20260101.pmtiles' } },
      layers,
    };
    expect(validateStyleMin(style as never)).toEqual([]);
    expect(layers.map((l) => l.id)).toEqual([
      'rivers-reach-casing',
      'rivers-reach',
      'rivers-reach-nodata',
      'rivers-reach-impounded',
      'rivers-reach-tidal',
    ]);
  });
  it('keeps zoom at the top of the width, with feature-state inside the stops', () => {
    const w = (byId('rivers-reach') as { paint: Record<string, unknown> }).paint['line-width'] as unknown[];
    expect(w.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    expect(JSON.stringify(w.slice(4, 5))).toContain('feature-state');
  });
  it('evaluates: colour from state c, transparent without; opacity by kind', () => {
    const paint = byId('rivers-reach')?.paint as Record<string, never>;
    const ev = (expr: never, state: Record<string, unknown>, type: 'color' | 'number') => {
      const r = createExpression(expr, {
        type,
        'property-type': 'data-driven',
        expression: { interpolated: true, parameters: ['zoom', 'feature'] },
      } as never);
      if (r.result !== 'success') throw new Error('bad expression');
      return r.value.evaluate({ zoom: 8 } as never, { properties: {} } as never, state);
    };
    expect(String(ev(paint['line-color'] as never, { c: '#ff0000' }, 'color'))).toBe('rgba(255,0,0,1)');
    expect(String(ev(paint['line-color'] as never, {}, 'color'))).toBe('rgba(0,0,0,0)');
    expect(ev(paint['line-opacity'] as never, { k: 'v' }, 'number')).toBe(1);
    expect(ev(paint['line-opacity'] as never, { k: 'nodata' }, 'number')).toBe(0);
    expect(ev(paint['line-width'] as never, { w: 2 }, 'number')).toBeCloseTo(4.8);
    expect(ev(paint['line-width'] as never, {}, 'number')).toBeCloseTo(2.4);
    // the casing under it: only for a coloured reach, 1.6 px wider, so near-white (steady, normal) reads on a light map
    const casing = byId('rivers-reach-casing')?.paint as Record<string, never>;
    expect(ev(casing['line-opacity'] as never, { k: 'v' }, 'number')).toBe(1);
    expect(ev(casing['line-opacity'] as never, { k: 'tidal' }, 'number')).toBe(0);
    expect(ev(casing['line-width'] as never, { w: 2 }, 'number')).toBeCloseTo(4.8 + 1.6);
  });
  it('hatches by the tile flag, 3 px or more at every zoom, and carries no name or label', () => {
    const tidal = byId('rivers-reach-tidal');
    expect((tidal as { filter?: unknown }).filter).toEqual(['==', ['get', 'tidal'], true]);
    const w = (tidal as { paint: Record<string, unknown> }).paint['line-width'] as number[];
    expect([w[4], w[6], w[8]].every((x) => (x ?? 0) >= 3)).toBe(true);
    expect(JSON.stringify(reachLayers())).not.toMatch(/name|label/);
  });
});

describe('bin layer specs', () => {
  it('are the five layers with -bin ids from reach_bins, zoom 8, butt caps, valid for the style spec', () => {
    const layers = binLayers();
    expect(layers.map((l) => l.id)).toEqual(reachLayers().map((l) => `${l.id}-bin`));
    for (const l of layers) {
      expect(l).toMatchObject({ 'source-layer': 'reach_bins', minzoom: 8, layout: { 'line-cap': 'butt' } });
    }
    const style = {
      version: 8,
      sprite: undefined,
      sources: { rivers: { type: 'vector', url: 'pmtiles://x/tiles/rivers-20260101.pmtiles' } },
      layers: [...reachLayers(), ...layers],
    };
    expect(validateStyleMin(style as never)).toEqual([]);
  });
});

describe('reach hatch icon', () => {
  it('is an opaque 8 x 8 tile that repeats seamlessly with both colours', () => {
    const { width, height, data } = reachHatchIcon();
    expect([width, height]).toEqual([8, 8]);
    const px = (x: number, y: number) => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)].join();
    const seen = new Set<string>();
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        expect(data[(y * 8 + x) * 4 + 3]).toBe(255);
        expect(px(x, y)).toBe(px((x + 4) % 8, y));
        expect(px(x, y)).toBe(px(x, (y + 4) % 8));
        seen.add(px(x, y));
      }
    expect(seen.size).toBe(2);
  });
});

describe('addReaches', () => {
  it('adds the hatch image and five layers before the highlight, and removes them on dispose', () => {
    const f = fakeMap();
    const h = addReaches(f.map, 'rivers-highlight');
    expect(only(f.calls, 'addImage')[0]?.args[2]).toEqual({ pixelRatio: 1 });
    const adds = only(f.calls, 'addLayer');
    expect(adds).toHaveLength(5);
    for (const a of adds) expect(a.args[1]).toBe('rivers-highlight');
    h.dispose();
    expect(only(f.calls, 'removeLayer')).toHaveLength(5);
    expect(only(f.calls, 'removeImage')[0]?.args[0]).toBe(REACH_HATCH);
    h.dispose();
    expect(only(f.calls, 'removeLayer')).toHaveLength(5);
  });
  it('writes only the reaches whose paint changed, with sourceLayer, and resets vanished ones', () => {
    const f = fakeMap();
    const h = addReaches(f.map, 'rivers-highlight');
    const v = (colour: string): ReachPaint => ({ k: 'v', colour, width: 1.5 });
    paints.current = new Map<string, unknown>([
      ['a', v('#111111')],
      ['b', { k: 'nodata' }],
    ]);
    h.update(input(['s1']));
    const sets = () => only(f.calls, 'setFeatureState');
    expect(sets()).toHaveLength(2);
    expect(sets()[0]?.args).toEqual([
      { source: 'rivers', sourceLayer: 'rivers', id: 'a' },
      { k: 'v', c: '#111111', w: 1.5 },
    ]);
    expect(sets()[1]?.args[1]).toEqual({ k: 'nodata', c: '#0000', w: 1 });
    h.update(input(['s1']));
    expect(sets()).toHaveLength(2);
    paints.current = new Map<string, unknown>([['a', v('#222222')]]);
    h.update(input(['s1']));
    expect(sets()).toHaveLength(3);
    expect(only(f.calls, 'removeFeatureState').map((c) => c.args[0])).toEqual([
      { source: 'rivers', sourceLayer: 'rivers', id: 'b' },
    ]);
  });
  it('caches the spans per graph and set of station ids', () => {
    const f = fakeMap();
    const h = addReaches(f.map, 'rivers-highlight');
    paints.current = new Map();
    paints.spanCalls = 0;
    const g = {};
    h.update(input(['s1', 's2'], g));
    h.update(input(['s2', 's1'], g));
    expect(paints.spanCalls).toBe(1);
    h.update(input(['s1', 's2', 's3'], g));
    expect(paints.spanCalls).toBe(2);
    h.update(input(['s1', 's2', 's3'], {}));
    expect(paints.spanCalls).toBe(3);
  });
  it('does not throw or write after dispose or when the source is gone', () => {
    const f = fakeMap();
    const h = addReaches(f.map, 'rivers-highlight');
    paints.current = new Map<string, unknown>([['a', { k: 'tidal' }]]);
    f.dropSource();
    expect(() => h.update(input(['s1']))).not.toThrow();
    expect(only(f.calls, 'setFeatureState')).toHaveLength(0);
    h.dispose();
    expect(() => h.update(input(['s1']))).not.toThrow();
  });
  it('disposes without throwing after map.remove() (StationsMap unmounts the map first)', () => {
    const f = fakeMap();
    const h = addReaches(f.map, 'rivers-highlight');
    // A removed map has no style: MapLibre throws on every style query.
    const gone = () => {
      throw new TypeError('style is undefined');
    };
    Object.assign(f.map, { getLayer: gone, hasImage: gone, removeLayer: gone, removeImage: gone });
    expect(() => h.dispose()).not.toThrow();
  });
});

describe('addReaches with bins', () => {
  const v = (colour: string): ReachPaint => ({ k: 'v', colour, width: 1.5 });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const sets = (calls: { fn: string; args: unknown[] }[]) => only(calls, 'setFeatureState');
  const binTarget = (id: string) => ({ source: 'rivers', sourceLayer: 'reach_bins', id });

  it('false: no bin layer, no zoom range, per-reach states only', async () => {
    const f = fakeMap();
    const h = addReaches(f.map, 'rivers-highlight', Promise.resolve(false));
    paints.current = new Map<string, unknown>([['a', v('#111111')]]);
    paints.bins = new Map<string, unknown>([['a/0', v('#222222')]]);
    await tick();
    h.update(input(['s1']));
    expect(only(f.calls, 'addLayer')).toHaveLength(5);
    expect(only(f.calls, 'setLayerZoomRange')).toHaveLength(0);
    expect(sets(f.calls).map((c) => (c.args[0] as { sourceLayer: string }).sourceLayer)).toEqual(['rivers']);
  });
  it('true: adds the bin layers, limits the reach layers to [0, 8), writes bin states on the next update', async () => {
    const f = fakeMap({ zoom: 8 }); // both sets are written near BIN_MINZOOM
    const h = addReaches(f.map, 'rivers-highlight', Promise.resolve(true));
    paints.current = new Map<string, unknown>([['a', v('#111111')]]);
    paints.bins = new Map<string, unknown>([
      ['a/0', v('#222222')],
      ['a/1', v('#333333')],
    ]);
    await tick();
    const adds = only(f.calls, 'addLayer');
    expect(adds).toHaveLength(10);
    expect(adds.slice(5).map((c) => (c.args[0] as { id: string }).id)).toEqual(binLayers().map((l) => l.id));
    for (const a of adds.slice(5)) expect(a.args[1]).toBe('rivers-highlight');
    expect(only(f.calls, 'setLayerZoomRange').map((c) => c.args)).toEqual(reachLayers().map((l) => [l.id, 0, 8]));
    h.update(input(['s1']));
    expect(sets(f.calls).map((c) => c.args[0])).toEqual([
      { source: 'rivers', sourceLayer: 'rivers', id: 'a' },
      binTarget('a/0'),
      binTarget('a/1'),
    ]);
    // only changed keys; the gone bin is removed
    paints.bins = new Map<string, unknown>([['a/0', v('#444444')]]);
    h.update(input(['s1']));
    expect(sets(f.calls)).toHaveLength(4);
    expect(sets(f.calls)[3]?.args).toEqual([binTarget('a/0'), { k: 'v', c: '#444444', w: 1.5 }]);
    expect(only(f.calls, 'removeFeatureState').map((c) => c.args[0])).toEqual([binTarget('a/1')]);
    h.dispose();
    expect(only(f.calls, 'removeLayer')).toHaveLength(10);
  });
  it('true: below zoom 7.5 no bin is written; a zoom in writes them, a dispose stops listening', async () => {
    const f = fakeMap({ zoom: 7 });
    const h = addReaches(f.map, 'rivers-highlight', Promise.resolve(true));
    paints.current = new Map<string, unknown>([['a', v('#111111')]]);
    paints.bins = new Map<string, unknown>([['a/0', v('#222222')]]);
    await tick();
    h.update(input(['s1']));
    expect(sets(f.calls).map((c) => c.args[0])).toEqual([{ source: 'rivers', sourceLayer: 'rivers', id: 'a' }]);
    f.zoomTo(9);
    expect(sets(f.calls).map((c) => c.args[0])).toContainEqual(binTarget('a/0'));
    // at a bin zoom the per-reach states wait for a zoom back out
    const before = sets(f.calls).length;
    paints.current = new Map<string, unknown>([['a', v('#999999')]]);
    paints.bins = new Map<string, unknown>([['a/0', v('#aaaaaa')]]);
    h.update(input(['s1']));
    expect(
      sets(f.calls)
        .slice(before)
        .map((c) => c.args[0]),
    ).toEqual([binTarget('a/0')]);
    f.zoomTo(6);
    expect(sets(f.calls).at(-1)?.args[0]).toEqual({ source: 'rivers', sourceLayer: 'rivers', id: 'a' });
    h.dispose();
    expect(only(f.calls, 'off').map((c) => c.args[0])).toEqual(['zoomend']);
  });
  it('true after an update: the pending last input is written per bin when it resolves', async () => {
    const f = fakeMap();
    let resolve: (b: boolean) => void = () => undefined;
    const h = addReaches(f.map, 'rivers-highlight', new Promise<boolean>((r) => (resolve = r)));
    paints.current = new Map<string, unknown>([['a', v('#111111')]]);
    paints.bins = new Map<string, unknown>([['a/0', v('#222222')]]);
    h.update(input(['s1']));
    expect(sets(f.calls)).toHaveLength(1);
    resolve(true);
    await tick();
    expect(sets(f.calls).map((c) => c.args[0])).toEqual([
      { source: 'rivers', sourceLayer: 'rivers', id: 'a' },
      binTarget('a/0'),
    ]);
  });
  it('a dispose before the promise resolves adds nothing', async () => {
    const f = fakeMap();
    let resolve: (b: boolean) => void = () => undefined;
    const h = addReaches(f.map, 'rivers-highlight', new Promise<boolean>((r) => (resolve = r)));
    h.dispose();
    resolve(true);
    await tick();
    expect(only(f.calls, 'addLayer')).toHaveLength(5);
    expect(only(f.calls, 'setLayerZoomRange')).toHaveLength(0);
  });
});

describe('rivers source and legend', () => {
  it('promotes reach_id and dims the base line only where a reach has a paint', () => {
    const f = fakeMap({ source: false });
    const added: { id: string; paint?: Record<string, unknown> }[] = [];
    const map = {
      getSource: () => undefined,
      getLayer: () => undefined,
      addSource: (_id: string, spec: unknown) => added.push({ id: 'src', paint: spec as never }),
      addLayer: (l: never) => added.push(l),
    };
    showRivers(map as never, 'https://x', 'rivers-20260101.pmtiles', 'stations');
    expect(added[0]?.paint).toMatchObject({ promoteId: { rivers: 'reach_id', reach_bins: 'seg' } });
    expect(JSON.stringify(added[1]?.paint?.['line-opacity'])).toBe(
      JSON.stringify(['case', ['==', ['feature-state', 'k'], null], 0.7, 0]),
    );
    expect(f.calls).toHaveLength(0);
  });
  it('lists the three reach keys', () => {
    expect(reachItems()).toEqual(['nodata', 'tidal', 'impounded']);
  });
});
