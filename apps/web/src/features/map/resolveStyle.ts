import { type TilesManifest, tilePaths } from '@rws/core/tiles-manifest';
import { SCHEME } from './protocol.ts';

/**
 * The generated styles (tools/geo/basemap/build-style.ts) carry root-relative
 * glyph and sprite paths and two placeholder sources. At run time they become
 * absolute URLs on the page's own origin, so the build and the style hold no
 * hostname and the same build serves any site (A§10 owner mode).
 */

export interface BaseStyle {
  glyphs?: string;
  sprite?: unknown;
  sources: Record<string, unknown>;
}

const PLACEHOLDERS = { planet: `${SCHEME}://planet`, basemap: `${SCHEME}://basemap` } as const;

export class StyleError extends Error {
  readonly code = 'style_unexpected';

  constructor() {
    super('style_unexpected');
    this.name = 'StyleError';
  }
}

/** A root-relative path on `origin`. `new URL` would percent-encode the `{fontstack}` template. */
function onOrigin(origin: string, path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new StyleError();
  return `${origin}${path}`;
}

/** `origin` is `location.origin`; the manifest has already passed `parseTilesManifest`. */
export function resolveStyle<S extends BaseStyle>(style: S, manifest: TilesManifest, origin: string): S {
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new StyleError();
  if (Object.keys(style.sources).sort().join() !== 'basemap,planet') throw new StyleError();
  const out = structuredClone(style);
  out.glyphs = onOrigin(origin, style.glyphs);
  out.sprite = onOrigin(origin, style.sprite);
  const paths = tilePaths(manifest);
  for (const name of ['planet', 'basemap'] as const) {
    const source = out.sources[name] as { url?: unknown } | null;
    if (typeof source !== 'object' || source === null || source.url !== PLACEHOLDERS[name]) throw new StyleError();
    source.url = `${SCHEME}://${onOrigin(origin, paths[name])}`;
  }
  return out;
}
