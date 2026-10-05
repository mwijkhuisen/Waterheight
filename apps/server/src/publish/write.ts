import { createHash, randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gzipSync, constants as zlib, zstdCompressSync } from 'node:zlib';
import { DAY_RE } from '@rws/contracts';

// P9a: the publisher's only way to the file system (A§9.1, T-PUB-1). A file is written as `.zst`, `.gz` and plain,
// each first into `.tmp/` with O_EXCL|O_NOFOLLOW and fsynced, then renamed into `v1/` with the plain file last (Caddy
// serves the plain file's name; its precompressed siblings exist first), then the directory is fsynced. `.tmp/` and
// `.state/` sit beside `v1/` on the same file system, so a rename is atomic and no Caddy (it mounts `v1/` only) sees
// them. Every relative path passes `safeRel`; the publisher never creates a link.

/** The served tree, the temp files and the completion markers under the publisher's root (`/srv/www`). */
export const TREE = 'v1';
const TMP = '.tmp';
const STATE = '.state';

const SEGMENTS = [
  DAY_RE,
  /^v[1-9][0-9]{0,5}$/,
  /^v[1-9][0-9]{0,5}\.json$/,
  /^[0-9]{4}\.json$/,
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$/,
  /^[a-z]+(?:\.json|\.geojson)?$/,
  // A station id (the registry's pattern, api.ts Station.id).
  /^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/,
];

/** A path under `v1/` made only of known segments, each ≤ 80 characters, never `..`, empty or dot-led. */
export function safeRel(rel: string): string {
  const parts = rel.split('/');
  const ok = parts.every(
    (p) => p.length > 0 && p.length <= 80 && !p.startsWith('.') && SEGMENTS.some((re) => re.test(p)),
  );
  if (!ok) throw Object.assign(new Error('unsafe_path'), { code: 'unsafe_path' });
  return rel;
}

/** The absolute path of `rel` under `base`, refused when it would leave `base`. */
function under(base: string, rel: string): string {
  const path = resolve(base, rel);
  if (!path.startsWith(base + sep)) throw Object.assign(new Error('unsafe_path'), { code: 'unsafe_path' });
  return path;
}

const FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

async function fsyncDir(path: string): Promise<void> {
  const fh = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Writes one file into `.tmp/` (new, never a link, fsynced) and returns its path. */
async function temp(root: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, TMP, randomBytes(12).toString('hex'));
  const fh = await open(path, FLAGS, 0o644);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return path;
}

/** Writes `v1/<rel>` with its `.zst` and `.gz` siblings, atomically per file, the plain file last. */
export async function writeAtomic(root: string, rel: string, bytes: Uint8Array): Promise<void> {
  const target = under(resolve(root, TREE), safeRel(rel));
  const variants: [string, Uint8Array][] = [
    [`${target}.zst`, zstdCompressSync(bytes, { params: { [zlib.ZSTD_c_compressionLevel]: 19 } })],
    [`${target}.gz`, gzipSync(bytes, { level: 9 })],
    [target, bytes],
  ];
  const temps: string[] = [];
  try {
    for (const [, b] of variants) temps.push(await temp(root, b));
    const made = await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    for (const [i, [path]] of variants.entries()) await rename(temps[i] as string, path);
    await fsyncDir(dirname(target));
    // Directories mkdir created (review CR-4): each new entry is durable only once its parent is fsynced, so a
    // marker written after this never names a day directory a power loss took back.
    if (made !== undefined)
      for (let dir = dirname(target); dir !== dirname(made); dir = dirname(dir)) await fsyncDir(dirname(dir));
  } catch (err) {
    await Promise.all(temps.map((t) => unlink(t).catch(() => undefined)));
    throw err;
  }
}

/** A settled day's completion marker in `.state/` (never served). */
export type Marker = { day: string; version: number; files: number; seconds: number; at: string };
const MARKER = /^settled-([0-9]{4}-[0-9]{2}-[0-9]{2})-v([1-9][0-9]{0,5})\.done$/;
function markerName(day: string, version: number): string {
  const name = `settled-${day}-v${version}.done`;
  if (!MARKER.test(name)) throw Object.assign(new Error('unsafe_path'), { code: 'unsafe_path' });
  return name;
}

/**
 * The publisher's output: writes a file only when its bytes changed since this process last wrote it (an empty map
 * at start, so the first cycle force-writes every mutable file and repairs a crash between sibling renames).
 */
export class Output {
  readonly root: string;
  readonly #hashes = new Map<string, string>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Creates `v1/`, `.tmp/` and `.state/` when missing and empties `.tmp/`. */
  async start(): Promise<void> {
    await mkdir(join(this.root, TREE), { recursive: true, mode: 0o755 });
    await mkdir(join(this.root, STATE), { recursive: true, mode: 0o700 });
    await rm(join(this.root, TMP), { recursive: true, force: true });
    await mkdir(join(this.root, TMP), { mode: 0o700 });
  }

  /**
   * JSON-encodes `body` and writes it if changed; returns the bytes written (0: unchanged). An immutable file
   * (settled, frames of a day, a dated warnings file) is written once and not remembered (`remember` false).
   */
  async put(rel: string, body: unknown, remember = true): Promise<number> {
    const bytes = Buffer.from(JSON.stringify(body));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (this.#hashes.get(rel) === hash) return 0;
    await writeAtomic(this.root, rel, bytes);
    if (remember) this.#hashes.set(rel, hash);
    return bytes.length;
  }

  /** The bytes of the regular files under a directory of `v1/` (links are not followed). */
  async size(rel: string): Promise<number> {
    let total = 0;
    for (const e of await this.list(rel)) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) total += await this.size(child);
      else if (e.isFile()) total += (await lstat(join(this.root, TREE, child))).size;
    }
    return total;
  }

  /** Removes a file (plain first, then its siblings) or a whole directory under `v1/`. */
  async remove(rel: string): Promise<void> {
    const path = under(resolve(this.root, TREE), safeRel(rel));
    for (const p of [path, `${path}.zst`, `${path}.gz`]) await rm(p, { recursive: true, force: true });
    for (const key of this.#hashes.keys()) if (key === rel || key.startsWith(`${rel}/`)) this.#hashes.delete(key);
  }

  /** The entries of a directory under `v1/` (none when it is missing); a link is never followed. */
  async list(rel = ''): Promise<Dirent[]> {
    const base = resolve(this.root, TREE);
    const path = rel === '' ? base : under(base, safeRel(rel));
    return readdir(path, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
  }

  async markers(): Promise<Marker[]> {
    const names = await readdir(join(this.root, STATE));
    const out: Marker[] = [];
    for (const name of names) {
      const m = MARKER.exec(name);
      if (m === null) continue;
      const body = JSON.parse(await readFile(join(this.root, STATE, name), 'utf8')) as Marker;
      out.push({ ...body, day: m[1] as string, version: Number(m[2]) });
    }
    return out;
  }

  async writeMarker(m: Marker): Promise<void> {
    const tmp = await temp(this.root, Buffer.from(JSON.stringify(m)));
    await rename(tmp, join(this.root, STATE, markerName(m.day, m.version)));
    await fsyncDir(join(this.root, STATE));
  }

  async removeMarker(day: string, version: number): Promise<void> {
    await rm(join(this.root, STATE, markerName(day, version)), { force: true });
  }
}
