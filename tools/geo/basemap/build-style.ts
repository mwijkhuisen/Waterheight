// Generates the MapLibre styles of the self-hosted basemap (P3, ADR-0016) from the pinned
// @protomaps/basemaps layer set, one per language of registry/basemap.yaml:
// apps/web/src/features/map/styles/style-<lang>.json. Deterministic and offline: the same
// registry and package give the same bytes, and nothing in a style names a host.
//
//   node tools/geo/basemap/build-style.ts           # rewrites the style files
//   node tools/geo/basemap/build-style.ts --check   # exit 1 if a committed file differs
//
// Two vector sources, both PMTiles placeholders that the web client resolves from
// /tiles/manifest.json: `planet` (the world at z0-6, overzoomed past it, so the map is
// never blank) and `basemap` (the regional extract). The planet layers carry the
// `planet:` id prefix and the regional layers `basemap:`. Regional layers start at
// style.regional_minzoom and planet symbol layers end there (minzoom is inclusive and
// maxzoom exclusive), so labels never double up; the planet fills and lines stay
// underneath at every zoom. Glyph and sprite URLs are root-relative (the client makes
// them absolute at run time) and point at the pinned assets, never at protomaps.github.io.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { parse } from 'yaml';
import { type BasemapFile, basemapAssetsPath, validateBasemap } from '../../../packages/contracts/src/basemap.ts';

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const STYLES_DIR = join(ROOT, 'apps/web/src/features/map/styles');
export const styleFile = (lang: string) => join(STYLES_DIR, `style-${lang}.json`);

/** Placeholder of both sources; the web tests compare the rendered credit with this text. */
export const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · Protomaps';

export function readBasemap(): BasemapFile {
  const { problems, basemap } = validateBasemap(parse(readFileSync(join(ROOT, 'registry/basemap.yaml'), 'utf8')));
  if (basemap === undefined) throw new Error(`registry/basemap.yaml: ${problems.join('; ')}`);
  return basemap;
}

/**
 * The style of one language, and the ids of the layers left out because the zoom split
 * left them no zoom range (minzoom at or above maxzoom).
 */
export function buildStyle(b: BasemapFile, lang: string): { style: StyleSpecification; dropped: string[] } {
  const flavor = namedFlavor(b.style.flavour);
  const regional = b.style.regional_minzoom;
  const dropped: string[] = [];
  const keep = (l: LayerSpecification): LayerSpecification[] => {
    if ((l.minzoom ?? 0) < (l.maxzoom ?? 24)) return [l];
    dropped.push(l.id);
    return [];
  };
  const prefixed = (source: string) => layers(source, flavor, { lang }).map((l) => ({ ...l, id: `${source}:${l.id}` }));
  // The planet list keeps the one background; a second one in the regional list would paint over
  // the planet underlay outside the bbox.
  const planet = prefixed('planet').flatMap((l) =>
    keep(l.type === 'symbol' ? { ...l, maxzoom: Math.min(l.maxzoom ?? 24, regional) } : l),
  );
  const basemap = prefixed('basemap')
    .filter((l) => l.type !== 'background')
    .flatMap((l) => keep({ ...l, minzoom: Math.max(l.minzoom ?? 0, regional) }));
  const assets = basemapAssetsPath(b);
  const source = (name: string) => ({ type: 'vector' as const, url: `pmtiles://${name}`, attribution: ATTRIBUTION });
  return {
    style: {
      version: 8,
      name: `rivierstanden basemap (${b.style.flavour}, ${lang})`,
      sources: { planet: source('planet'), basemap: source('basemap') },
      glyphs: `${assets}fonts/{fontstack}/{range}.pbf`,
      sprite: `${assets}sprites/v4/${b.style.flavour}`,
      layers: [...planet, ...basemap],
    },
    dropped,
  };
}

export const styleText = (style: StyleSpecification) => `${JSON.stringify(style, null, 2)}\n`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--check')) {
    console.error('usage: node tools/geo/basemap/build-style.ts [--check]');
    process.exit(64);
  }
  const check = args.length > 0;
  const b = readBasemap();
  for (const lang of b.style.langs) {
    const { style, dropped } = buildStyle(b, lang);
    const text = styleText(style);
    const file = styleFile(lang);
    console.log(`style-${lang}.json: ${style.layers.length} layers, ${dropped.length} dropped (${dropped.join(' ')})`);
    if (!check) {
      mkdirSync(STYLES_DIR, { recursive: true });
      writeFileSync(file, text);
    } else if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      console.error(`build-style: ${file} is stale; run node tools/geo/basemap/build-style.ts`);
      process.exitCode = 1;
    }
  }
}
