import { parseTilesManifest } from '@rws/core/tiles-manifest';
import { describe, expect, it } from 'vitest';
import { acquireProtocol, protocolUsers } from '../src/features/map/protocol.ts';
import { resolveStyle } from '../src/features/map/resolveStyle.ts';

// The map module's pure parts (P3): the protocol refcount behind every
// useMapLibre mount, and the run-time step that puts the style on our origin.

describe('acquireProtocol', () => {
  it('registers once for the first map and removes it with the last', () => {
    const calls: string[] = [];
    const host = {
      addProtocol: (scheme: string) => calls.push(`add ${scheme}`),
      removeProtocol: (scheme: string) => calls.push(`remove ${scheme}`),
    };
    const before = protocolUsers();
    const a = acquireProtocol(host, () => 'handler');
    const b = acquireProtocol(host, () => 'handler');
    expect(calls).toEqual(['add pmtiles']);
    a();
    a(); // idempotent: a second release of the same map changes nothing
    expect(calls).toEqual(['add pmtiles']);
    b();
    expect(calls).toEqual(['add pmtiles', 'remove pmtiles']);
    expect(protocolUsers()).toBe(before);
    const c = acquireProtocol(host, () => 'handler');
    expect(calls).toEqual(['add pmtiles', 'remove pmtiles', 'add pmtiles']);
    c();
  });
});

describe('resolveStyle', () => {
  const entry = (build: string) => ({
    build,
    version: '4.15.2',
    created_at: '2026-10-01T09:12:00.000Z',
    basemap: { file: `basemap-${build}.pmtiles`, sha256: 'a'.repeat(64), bytes: 10 },
    planet: { file: `planet-z6-${build}.pmtiles`, sha256: 'b'.repeat(64), bytes: 10 },
  });
  const manifest = parseTilesManifest(
    JSON.stringify({ schema_version: 1, current: entry('20261001'), previous: null }),
  );
  const style = {
    version: 8,
    glyphs: '/assets/map/028c18f/fonts/{fontstack}/{range}.pbf',
    sprite: '/assets/map/028c18f/sprites/v4/white',
    sources: {
      planet: { type: 'vector', url: 'pmtiles://planet' },
      basemap: { type: 'vector', url: 'pmtiles://basemap' },
    },
    layers: [],
  };

  it('puts glyphs, sprite and both tile sources on the page origin, templates intact', () => {
    const out = resolveStyle(style, manifest, 'https://example.org');
    expect(out.glyphs).toBe('https://example.org/assets/map/028c18f/fonts/{fontstack}/{range}.pbf');
    expect(out.sprite).toBe('https://example.org/assets/map/028c18f/sprites/v4/white');
    expect(out.sources).toEqual({
      planet: { type: 'vector', url: 'pmtiles://https://example.org/tiles/planet-z6-20261001.pmtiles' },
      basemap: { type: 'vector', url: 'pmtiles://https://example.org/tiles/basemap-20261001.pmtiles' },
    });
    expect(style.sources.planet.url).toBe('pmtiles://planet'); // the bundled style is not mutated
  });

  it('refuses a style it does not know and an origin that is not one', () => {
    const bad: unknown[] = [
      { ...style, glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf' },
      { ...style, sprite: '//cdn.example/sprite' },
      { ...style, sources: { ...style.sources, extra: { type: 'vector', url: 'pmtiles://extra' } } },
      { ...style, sources: { ...style.sources, basemap: { type: 'vector', url: 'https://tiles.example/x' } } },
    ];
    for (const s of bad)
      expect(() => resolveStyle(s as typeof style, manifest, 'https://example.org')).toThrow('style_unexpected');
    expect(() => resolveStyle(style, manifest, 'https://example.org/path')).toThrow('style_unexpected');
  });
});
