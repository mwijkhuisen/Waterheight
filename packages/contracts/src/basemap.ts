import { z } from 'zod';

// The self-hosted basemap (registry/basemap.yaml; P3, ADR-0016): the job's fetch
// targets, the extracts and the pinned style assets.

const Host = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/)
  .max(253);
const HttpsUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^\s/?#]+\/[^\s?#]*$/);
const Zoom = z.number().int().min(0).max(15);
const Lon = z.number().min(-180).max(180);
const Lat = z.number().min(-85.0511).max(85.0511);

export const Flavours = ['light', 'dark', 'white', 'grayscale', 'black'] as const;

export const BasemapFile = z.strictObject({
  version: z.literal(1),
  protomaps: z.strictObject({
    hosts: z.array(Host).min(1).max(4),
    builds_url: HttpsUrl,
    builds_max_bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    tiles_base_url: HttpsUrl.refine((u) => u.endsWith('/'), 'must end with /'),
    tiles_major: z.number().int().positive(),
  }),
  extracts: z.strictObject({
    basemap: z.strictObject({
      bbox: z.tuple([Lon, Lat, Lon, Lat]),
      minzoom: Zoom,
      maxzoom: Zoom,
      max_bytes: z.number().int().positive(),
    }),
    planet: z.strictObject({ minzoom: Zoom, maxzoom: Zoom, max_bytes: z.number().int().positive() }),
  }),
  disk_max_pct: z.number().int().min(1).max(95),
  style: z.strictObject({
    package: z.literal('@protomaps/basemaps'),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    flavour: z.enum(Flavours),
    langs: z.array(z.enum(['nl', 'en'])).min(1),
    regional_minzoom: Zoom,
  }),
  assets: z.strictObject({
    repo: z.literal('https://github.com/protomaps/basemaps-assets'),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    archive_url: HttpsUrl,
    fonts: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9 ]+$/)
          .max(60),
      )
      .min(1),
    licences: z.strictObject({
      fonts: z.strictObject({ spdx: z.string().min(1), file: z.string().min(1) }),
      sprites: z.strictObject({ spdx: z.string().min(1), note: z.string().min(1), url: HttpsUrl }),
    }),
    sums_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export type BasemapFile = z.infer<typeof BasemapFile>;

/** The served directory of the pinned assets: `/assets/map/<first 7 of commit>/`. */
export const basemapAssetsPath = (b: BasemapFile) => `/assets/map/${b.assets.commit.slice(0, 7)}/`;

/**
 * The schema, plus what it cannot say alone: every URL names a listed host,
 * the archive is the pinned commit, the bbox and the zoom ranges are well formed.
 */
export function validateBasemap(input: unknown): { problems: string[]; basemap?: BasemapFile } {
  const parsed = BasemapFile.safeParse(input);
  if (!parsed.success) return { problems: [z.prettifyError(parsed.error)] };
  const b = parsed.data;
  const problems: string[] = [];
  // HttpsUrl already holds: `https://<host>/…` with no userinfo, port or query.
  const host = (u: string) => u.slice('https://'.length).split('/')[0] ?? '';
  for (const [name, url] of [
    ['builds_url', b.protomaps.builds_url],
    ['tiles_base_url', b.protomaps.tiles_base_url],
  ] as const) {
    if (!b.protomaps.hosts.includes(host(url))) problems.push(`protomaps.${name}: host is not in protomaps.hosts`);
  }
  if (!b.assets.archive_url.endsWith(`/${b.assets.commit}`)) problems.push('assets.archive_url: not the pinned commit');
  const [w, s, e, n] = b.extracts.basemap.bbox;
  if (!(w < e && s < n)) problems.push('extracts.basemap.bbox: not west < east and south < north');
  for (const name of ['basemap', 'planet'] as const) {
    const x = b.extracts[name];
    if (x.minzoom > x.maxzoom) problems.push(`extracts.${name}: minzoom > maxzoom`);
  }
  const r = b.style.regional_minzoom;
  if (r < b.extracts.basemap.minzoom || r > b.extracts.basemap.maxzoom)
    problems.push('style.regional_minzoom: outside the regional extract');
  if (new Set(b.style.langs).size !== b.style.langs.length) problems.push('style.langs: duplicate');
  return problems.length > 0 ? { problems } : { problems, basemap: b };
}
