/**
 * The basemap: what the data layer is drawn over, and how it gets there.
 *
 * This used to be PDOK's BRT achtergrondkaart, the Dutch national basemap. It
 * stops at the Dutch border -- tiles outside the Netherlands come back empty --
 * which is invisible while every plotted location is Dutch and becomes most of
 * the screen the moment a station upstream of the border is. So the basemap is
 * OpenStreetMap-derived now: OpenFreeMap's `positron`, whose pale grey keeps
 * the decision the map was built on, that the basemap is decoration and the
 * data layer carries the colour.
 *
 * The style is fetched at runtime rather than declared inline, and that is the
 * awkward part. Passing the URL straight to `new maplibregl.Map({ style })`
 * would be one line, but it makes the markers -- which are the product --
 * depend on a third-party tile server: if the style never arrives, no style
 * loads, `style.load` never fires, and there is nothing on the screen at all.
 * So the map opens on BOOTSTRAP_STYLE, which is inline and therefore always
 * parses, gets its data layers immediately, and swaps the fetched style in
 * underneath them if and when it arrives. An unreachable provider then costs
 * the map its decoration and nothing else, which is the same trade the
 * `style.load` handling in MapView already makes for tiles.
 */

import type { StyleSpecification, TransformStyleFunction } from 'maplibre-gl';

/**
 * OpenStreetMap vector tiles, no key, no registration, no documented request
 * cap, MIT-licensed and self-hostable. `tile.openstreetmap.org` is deliberately
 * not used: the OSM Foundation's tile policy exists to stop applications like
 * this one from pointing at it.
 */
const OPENFREEMAP = 'https://tiles.openfreemap.org';

const DEFAULT_BASEMAP_STYLE_URL = `${OPENFREEMAP}/styles/positron`;

/**
 * Baked in at build time, not read at runtime -- the client is a static bundle,
 * so changing this needs `npm run build:web` again, not a restart. It exists so
 * that a self-hosted style (a Protomaps `.pmtiles` served from this origin, a
 * tileserver on the same network) is a configuration change rather than a code
 * change. Such a style must serve LABEL_FONT from its own glyph endpoint.
 */
export const BASEMAP_STYLE_URL: string =
  import.meta.env.VITE_BASEMAP_STYLE_URL || DEFAULT_BASEMAP_STYLE_URL;

/**
 * The font stack the cluster counts ask for.
 *
 * MapLibre requests a stack as one comma-joined path segment, so listing a
 * fallback only helps if the glyph server serves that exact combination.
 * Neither OpenFreeMap's endpoint nor MapLibre's demo one does: the stack this
 * replaces, `Open Sans Bold,Arial Unicode MS Bold`, 404s on both and has for as
 * long as it has been here. MapLibre papers over that -- the counts still draw,
 * in something other than what was asked for -- so the only symptom was two
 * failed requests per glyph range and a font nobody chose. `Noto Sans Bold` is
 * served by both, and is what positron labels the rest of the map in.
 */
export const LABEL_FONT = ['Noto Sans Bold'];

/**
 * The style the map opens on, before -- or instead of -- the fetched one.
 *
 * Flat, and the same grey positron paints its background with, so the swap is
 * not a visible flash. It carries a glyph endpoint because the cluster-count
 * layer is added against this style and would otherwise have nowhere to fetch a
 * font from at all. That endpoint is OpenFreeMap's, which is right for the
 * default and a wart under a self-hosted BASEMAP_STYLE_URL: one request to a
 * host that deployment is trying not to need, until the configured style
 * arrives with a glyph endpoint of its own. Deriving it from the configured URL
 * would only be a guess at a path that style alone knows, and the request fails
 * harmlessly -- MapLibre draws the counts either way.
 */
export const BOOTSTRAP_STYLE: StyleSpecification = {
  version: 8,
  glyphs: `${OPENFREEMAP}/fonts/{fontstack}/{range}.pbf`,
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': 'rgb(242,243,240)' } },
  ],
};

/**
 * Credit for the measurement data, which no basemap can supply.
 *
 * The basemap's own attribution rides along with the vector source's TileJSON
 * and the AttributionControl picks it up unprompted, so restating it here would
 * only risk saying something the tiles do not. This one has to be passed
 * explicitly, and passing it as `customAttribution` also means it survives the
 * basemap failing to load.
 */
export const DATA_ATTRIBUTION =
  '<a href="https://rijkswaterstaatdata.nl/waterdata/">Rijkswaterstaat</a>';

/** Bounds the wait, not the map: the flat background is already usable. */
const STYLE_TIMEOUT_MS = 10_000;

function isStyleSpecification(value: unknown): value is StyleSpecification {
  const style = value as Partial<StyleSpecification> | null;
  return (
    typeof style === 'object' &&
    style !== null &&
    style.version === 8 &&
    Array.isArray(style.layers) &&
    typeof style.sources === 'object'
  );
}

/**
 * Fetch the basemap style. Rejects rather than returning a half-usable style:
 * every caller's fallback is to keep the one the map already has.
 */
export async function fetchBasemapStyle(
  url: string,
  signal: AbortSignal,
): Promise<StyleSpecification> {
  // A second controller, so the timeout and the caller's signal can both stop
  // the request. `AbortSignal.any` would say this in one line and is newer than
  // the browsers this otherwise supports.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STYLE_TIMEOUT_MS);
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    const body: unknown = await response.json();
    if (!isStyleSpecification(body)) throw new Error(`${url} is not a v8 style document`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Put a fetched basemap underneath layers the map already has.
 *
 * MapLibre's `setStyle` replaces everything, so without this the data layers
 * would be dropped on the swap. `transformStyle` is the documented seam for it:
 * `previous` is the live style serialised, which means the source arrives with
 * whatever data has been pushed into it and the layers with whatever filters
 * have been set on them. Appending rather than inserting keeps the markers
 * above every basemap layer, which is where they have to be.
 */
export function keepLayersOf(sourceId: string): TransformStyleFunction {
  return (previous, next) => {
    const source = previous?.sources[sourceId];
    if (!previous || !source) return next;

    return {
      ...next,
      sources: { ...next.sources, [sourceId]: source },
      layers: [
        ...next.layers,
        ...previous.layers.filter((layer) => 'source' in layer && layer.source === sourceId),
      ],
    };
  };
}
