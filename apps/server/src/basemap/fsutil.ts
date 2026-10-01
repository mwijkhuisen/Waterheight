import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BasemapError, EXIT_CONFIG } from './errors.ts';

// File-system helpers of the `basemap` role. The tile files are served to the
// public as immutable: every file the role trusts is opened without following a
// link (O_NOFOLLOW; O_NONBLOCK so a FIFO cannot hang the open), must be a
// regular file with one link, and is hashed through the descriptor it opened.

const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHUNK = 1024 * 1024;

export const isMissing = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'ENOENT';

/** A directory the operator names (a bind-mount target): it must exist and be a directory. */
export async function requireDir(dir: string, code: string): Promise<void> {
  const ok = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!ok) throw new BasemapError(code, EXIT_CONFIG);
}

/** fsync of a directory: the renames in it survive a crash. */
export async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Removes what is inside `dir`, never `dir` itself (a bind-mount target). The
 * names in `last` go after everything else (result.json: the mark that
 * something is staged goes last). A link is removed, never followed.
 */
export async function emptyDir(dir: string, last: readonly string[] = []): Promise<void> {
  const names = await readdir(dir);
  const ordered = [...names.filter((n) => !last.includes(n)), ...last.filter((n) => names.includes(n))];
  for (const name of ordered) await rm(join(dir, name), { recursive: true, force: true });
}

/**
 * A small regular file as text: null when absent; `code` when it is a link, not
 * a regular file, larger than `max` bytes or not UTF-8.
 */
export async function readSmallText(path: string, max: number, code: string): Promise<string | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, OPEN_READ);
  } catch (e) {
    if (isMissing(e)) return null;
    throw new BasemapError(code);
  }
  try {
    if (!(await fh.stat()).isFile()) throw new BasemapError(code);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > max) throw new BasemapError(code);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
  } catch (e) {
    throw e instanceof BasemapError ? e : new BasemapError(code);
  } finally {
    await fh.close();
  }
}

/** A tile file opened for checking: the descriptor, its path and its state when it was opened. */
export type Opened = { fh: FileHandle; path: string; size: number; state: BigIntStats };
const fstatOf = (fh: FileHandle): Promise<BigIntStats> => fh.stat({ bigint: true });

/**
 * Opens `path` as a tile file: null when absent; `not_regular_file` for a link,
 * a FIFO, a directory or a file with another hard link (a second name could
 * change the bytes after the check), or when the path no longer names the file
 * that was opened.
 */
export async function openRegular(path: string): Promise<Opened | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, OPEN_READ);
  } catch (e) {
    if (isMissing(e)) return null;
    throw new BasemapError('not_regular_file');
  }
  try {
    const state = await fstatOf(fh);
    const named = await lstat(path, { bigint: true });
    if (!state.isFile() || state.nlink !== 1n || named.dev !== state.dev || named.ino !== state.ino)
      throw new BasemapError('not_regular_file');
    return { fh, path, size: Number(state.size), state };
  } catch (e) {
    await fh.close();
    throw e instanceof BasemapError ? e : new BasemapError('not_regular_file');
  }
}

/** SHA-256 and length of the first `size` bytes, read in chunks through the open descriptor. */
export async function sha256Of(fh: FileHandle, size: number): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = 0;
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return { sha256: hash.digest('hex'), bytes: pos };
}

/** True while the path still names the very file that was opened, byte for byte (size, mtime, ctime, one link). */
export async function unchanged(o: Opened): Promise<boolean> {
  try {
    const now = await fstatOf(o.fh);
    const named = await lstat(o.path, { bigint: true });
    return (
      now.nlink === 1n &&
      now.size === o.state.size &&
      now.mtimeNs === o.state.mtimeNs &&
      now.ctimeNs === o.state.ctimeNs &&
      now.ino === o.state.ino &&
      now.dev === o.state.dev &&
      named.ino === o.state.ino &&
      named.dev === o.state.dev
    );
  } catch {
    return false;
  }
}

/**
 * Writes `<dir>/<name>` atomically: a fresh temporary file, fsync, rename, fsync
 * of the directory. A reader sees the old file or the new one, never a part.
 */
export async function writeFileAtomic(dir: string, name: string, text: string, mode: number): Promise<void> {
  const tmp = join(dir, `.${name}.tmp`);
  await rm(tmp, { force: true });
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await fh.chmod(mode);
    await fh.writeFile(text);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  await rename(tmp, join(dir, name));
  await syncDir(dir);
}
