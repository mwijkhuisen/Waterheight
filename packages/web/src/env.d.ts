/// <reference types="vite/client" />

/**
 * Build-time configuration. Vite inlines these at bundle time, so they are
 * fixed in the built client -- see `basemap.ts` and `.env.example`.
 */
interface ImportMetaEnv {
  /** Basemap style document. Defaults to OpenFreeMap's `positron`. */
  readonly VITE_BASEMAP_STYLE_URL?: string;
}
