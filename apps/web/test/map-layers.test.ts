import { readFileSync } from 'node:fs';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { hatchAreaIcon, hatchIcon, triangleIcon } from '../src/features/map/icons.ts';
import { badgeLine, changeLine } from '../src/features/map/popup.ts';
import { riverFilter, riverUrl } from '../src/features/map/rivers.ts';
import { layerPaints, stationPoints } from '../src/features/map/stationLayer.ts';
import { warningLayers, warningsGeoJson } from '../src/features/map/warnings.ts';
import type { WarningsAt } from '../src/lib/data/warnings.ts';
import { MODES } from '../src/lib/url/url.ts';

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
    expect(f?.properties).toEqual({ id: 'a', tidal: true, impounded: false });
  });
});

describe('layer paint', () => {
  it('is valid for the style spec in every mode, and differs between modes', () => {
    const colours = new Set<string>();
    for (const mode of MODES) {
      const paints = layerPaints(mode);
      colours.add(JSON.stringify(paints.stations?.['circle-color']));
      const layers = Object.entries(paints).map(([id, paint]) =>
        id.startsWith('stations-trend')
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
  });
});

describe('attribution (C9)', () => {
  it('createMap passes no customAttribution and the new sources set no attribution', () => {
    expect(src('createMap.ts')).not.toMatch(/customAttribution/);
    for (const f of ['rivers.ts', 'warnings.ts', 'stationLayer.ts'])
      expect(src(f), f).not.toMatch(/\battribution['"]?\s*:/i);
  });
});
