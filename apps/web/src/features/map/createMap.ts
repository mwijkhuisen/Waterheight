// The lazy map chunk (A§10: MapLibre is never in the initial bundle). Everything
// MapLibre needs comes from our own origin: the worker is a same-origin module
// URL (no blob:, ADR-0016), the style is bundled here, glyphs and sprites are
// under /assets/map/, the tiles are named by /tiles/manifest.json.
import { parseTilesManifest } from '@rws/core/tiles-manifest';
import { addProtocol, Map as MapLibreMap, type MapOptions, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { acquireProtocol } from './protocol.ts';
import { resolveStyle } from './resolveStyle.ts';

// For the station popup (StationsMap): taken from this chunk, which is loaded by then.
export { Popup } from 'maplibre-gl';

type Style = Exclude<MapOptions['style'], string | undefined>;

const styles = {
  nl: () => import('./styles/style-nl.json'),
  en: () => import('./styles/style-en.json'),
};

export class MapError extends Error {
  readonly code = 'manifest_unavailable';

  constructor() {
    super('manifest_unavailable');
    this.name = 'MapError';
  }
}

/** The manifest names the current extract; it is validated before any URL is built from it. */
async function loadManifest(signal: AbortSignal) {
  const res = await fetch('/tiles/manifest.json', { signal, redirect: 'error' });
  if (!res.ok) throw new MapError();
  return parseTilesManifest(await res.text());
}

/** MapLibre's own UI strings in the page language. */
const mapLocale = (locale: Locale): Record<string, string> => ({
  'Map.Title': m.map_label({}, { locale }),
  'NavigationControl.ZoomIn': m.map_zoom_in({}, { locale }),
  'NavigationControl.ZoomOut': m.map_zoom_out({}, { locale }),
  'NavigationControl.ResetBearing': m.map_reset_bearing({}, { locale }),
  'AttributionControl.ToggleAttribution': m.map_toggle_attribution({}, { locale }),
  'AttributionControl.MapFeedback': m.map_feedback({}, { locale }),
  'Popup.Close': m.map_popup_close({}, { locale }),
});

export interface CreatedMap {
  map: MapLibreMap;
  /** Removes the map and releases its hold on the pmtiles protocol (which stays registered); safe to call twice. */
  dispose(): void;
}

export async function createMap(
  container: HTMLElement,
  { lang, signal, options }: { lang: Locale; signal: AbortSignal; options?: Partial<MapOptions> | undefined },
): Promise<CreatedMap> {
  setWorkerUrl(workerUrl);
  const [manifest, style] = await Promise.all([loadManifest(signal), styles[lang]().then((s) => s.default)]);
  signal.throwIfAborted();
  // metadata off, explicitly (it is also pmtiles' default): the archive's own
  // attribution HTML never reaches MapLibre's attribution control; the style's
  // constant does (invariant 3, T-MAP-4, R-066).
  const release = acquireProtocol({ addProtocol }, () => new Protocol({ metadata: false }).tile);
  try {
    const map = new MapLibreMap({
      container,
      // Validated offline against the style spec maplibre-gl resolves (test/basemap-style.test.ts).
      style: resolveStyle(style, manifest, location.origin) as unknown as Style,
      center: [6.1, 51.85],
      zoom: 7,
      maxPitch: 0,
      pixelRatio: Math.min(devicePixelRatio, 2),
      attributionControl: { compact: true },
      locale: mapLocale(lang),
      ...options,
    });
    let disposed = false;
    return {
      map,
      dispose() {
        if (disposed) return;
        disposed = true;
        map.remove();
        release();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}
