/**
 * The basemap manifest, `/tiles/manifest.json` (P3, ADR-0016). The `basemap
 * promote` job writes it; the web app, verify-prod and the job read it back.
 * Pure and dependency-free: the web app imports this file through the subpath
 * `@rws/core/tiles-manifest`, so nothing else of this package reaches the
 * browser. Every tile URL the client builds comes from a manifest that passed
 * `parseTilesManifest`, and its file names match `TILE_FILE_RE`.
 */

/** A manifest is a few hundred bytes; anything near this cap is not ours. */
export const TILES_MANIFEST_MAX_BYTES = 16_384;

/** The only tile file names the job writes, Caddy serves and the client requests. */
export const TILE_FILE_RE = /^(basemap|planet-z6)-([0-9]{8})\.pmtiles$/;

const BUILD_RE = /^[0-9]{8}$/;
const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;

export interface TileFile {
  file: string;
  sha256: string;
  bytes: number;
}

/** One extract: the Protomaps build it came from and its two files. */
export interface TilesEntry {
  /** The build date, `YYYYMMDD` (the Protomaps file `<build>.pmtiles`). */
  build: string;
  /** The tiles' schema version from the build list, e.g. `4.15.2`. */
  version: string;
  /** When the job made the extract, UTC. */
  created_at: string;
  basemap: TileFile;
  planet: TileFile;
}

export interface TilesManifest {
  schema_version: 1;
  current: TilesEntry;
  previous: TilesEntry | null;
}

/** A manifest that is not exactly ours. `code` and `path` never carry file content. */
export class TilesManifestError extends Error {
  readonly code: 'manifest_too_large' | 'manifest_not_json' | 'manifest_invalid';
  readonly path: string;

  constructor(code: TilesManifestError['code'], path = '') {
    super(path === '' ? code : `${code} at ${path}`);
    this.name = 'TilesManifestError';
    this.code = code;
    this.path = path;
  }
}

/** The file names an extract of `build` has. */
export const tileFileNames = (build: string) => ({
  basemap: `basemap-${build}.pmtiles`,
  planet: `planet-z6-${build}.pmtiles`,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function keysExactly(v: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new TilesManifestError('manifest_invalid', path);
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i]))
    throw new TilesManifestError('manifest_invalid', path);
  return v;
}

function matching(v: unknown, re: RegExp, path: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw new TilesManifestError('manifest_invalid', path);
  return v;
}

function tileFile(v: unknown, name: string, path: string): TileFile {
  const o = keysExactly(v, ['file', 'sha256', 'bytes'], path);
  if (o.file !== name) throw new TilesManifestError('manifest_invalid', `${path}.file`);
  const bytes = o.bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0)
    throw new TilesManifestError('manifest_invalid', `${path}.bytes`);
  return { file: name, sha256: matching(o.sha256, SHA256_RE, `${path}.sha256`), bytes };
}

function entry(v: unknown, path: string): TilesEntry {
  const o = keysExactly(v, ['build', 'version', 'created_at', 'basemap', 'planet'], path);
  const build = matching(o.build, BUILD_RE, `${path}.build`);
  const names = tileFileNames(build);
  return {
    build,
    version: matching(o.version, VERSION_RE, `${path}.version`),
    created_at: matching(o.created_at, UTC_RE, `${path}.created_at`),
    basemap: tileFile(o.basemap, names.basemap, `${path}.basemap`),
    planet: tileFile(o.planet, names.planet, `${path}.planet`),
  };
}

/** Checks an already parsed value; throws `TilesManifestError` on any deviation. */
export function checkTilesManifest(value: unknown): TilesManifest {
  const o = keysExactly(value, ['schema_version', 'current', 'previous'], 'manifest');
  if (o.schema_version !== 1) throw new TilesManifestError('manifest_invalid', 'manifest.schema_version');
  const current = entry(o.current, 'manifest.current');
  const previous = o.previous === null ? null : entry(o.previous, 'manifest.previous');
  if (previous !== null && previous.build === current.build)
    throw new TilesManifestError('manifest_invalid', 'manifest.previous.build');
  return { schema_version: 1, current, previous };
}

/** Parses the text of `/tiles/manifest.json`, size-capped before JSON.parse runs. */
export function parseTilesManifest(text: string): TilesManifest {
  if (text.length > TILES_MANIFEST_MAX_BYTES) throw new TilesManifestError('manifest_too_large');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TilesManifestError('manifest_not_json');
  }
  return checkTilesManifest(value);
}

/** The same-origin paths of the current extract's two files. */
export const tilePaths = (m: TilesManifest) => ({
  basemap: `/tiles/${m.current.basemap.file}`,
  planet: `/tiles/${m.current.planet.file}`,
});

/** Every file name the manifest names (current and previous): what retention keeps. */
export const referencedFiles = (m: TilesManifest): string[] =>
  [m.current, ...(m.previous === null ? [] : [m.previous])].flatMap((e) => [e.basemap.file, e.planet.file]);
