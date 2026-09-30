import { constants as fsc } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

// Read side of the raw archive (A§7.1), used by `load`, `replay` and the
// pruner. Keys and file names come from the manifest, which is data: every
// path is checked against the key pattern and resolved inside the archive root
// before it is opened, and nothing is decompressed without a size cap.

const inflate = promisify(zstdDecompress);

/** raw/{source}/{spec}/{yyyy}/{mm}/{dd}/{HHmmss}Z-{sha256:16}.zst */
export const KEY_RE =
  /^raw\/((?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})Z-[0-9a-f]{16}\.zst$/;
export const MANIFEST_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The decoded-body cap of the recorder (A§12.2): no archived object can be larger. */
export const MAX_OBJECT_BYTES = 100 * 1024 * 1024;
/** One manifest line is far below this; a longer "line" is damage, not data. */
export const MAX_LINE_BYTES = 64 * 1024;

export class ArchiveError extends Error {
  readonly code: 'bad_key' | 'outside_root' | 'missing' | 'not_a_file' | 'too_large' | 'corrupt';

  constructor(code: ArchiveError['code']) {
    super(code);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

export type RawLine = {
  /** The line without its newline; not yet parsed. */
  text: string;
  /** Byte offset just after the line's newline: the cursor value once it is processed. */
  end: number;
};

export class ArchiveReader {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * The file of `key`, or an ArchiveError. The key must match the key pattern,
   * and the resolved path (links followed) must be a regular file inside the
   * resolved root: a link that points out of the archive is refused.
   */
  async resolve(key: string): Promise<string> {
    if (!KEY_RE.test(key)) throw new ArchiveError('bad_key');
    const path = join(this.root, key.slice(4));
    let real: string;
    let root: string;
    try {
      root = await realpath(this.root);
      const info = await lstat(path);
      if (!info.isFile()) throw new ArchiveError('not_a_file');
      real = await realpath(path);
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError('missing');
    }
    if (!real.startsWith(root + sep)) throw new ArchiveError('outside_root');
    return real;
  }

  /** The decoded body of an archived object, at most `maxBytes` (both the stored file and the output are capped). */
  async readObject(key: string, maxBytes: number = MAX_OBJECT_BYTES): Promise<Buffer> {
    const path = await this.resolve(key);
    const h = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    try {
      const { size } = await h.stat();
      // zstd never expands by more than a few bytes per block: a stored file over the cap cannot be a valid object.
      if (size > maxBytes + 1024 * 1024) throw new ArchiveError('too_large');
      const stored = await h.readFile();
      try {
        return await inflate(stored, { maxOutputLength: maxBytes });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw new ArchiveError(code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'corrupt');
      }
    } finally {
      await h.close();
    }
  }

  /** Daily manifest files and their sizes, oldest first. */
  async manifests(): Promise<{ file: string; size: number }[]> {
    const dir = join(this.root, '_manifest');
    const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => MANIFEST_FILE_RE.test(f)).sort();
    const out: { file: string; size: number }[] = [];
    for (const file of names) {
      const info = await lstat(join(dir, file)).catch(() => null);
      if (info?.isFile()) out.push({ file, size: info.size });
    }
    return out;
  }

  /**
   * Whole lines of a manifest file from byte `offset`, at most `maxBytes` of
   * them. A last line without its newline is still being written (or is torn)
   * and is not returned. A "line" longer than MAX_LINE_BYTES is returned as an
   * empty text, so the caller counts it as damage and moves past it.
   */
  async lines(file: string, offset: number, maxBytes = 8 * 1024 * 1024): Promise<RawLine[]> {
    if (!MANIFEST_FILE_RE.test(file)) throw new ArchiveError('bad_key');
    const h = await open(join(this.root, '_manifest', file), fsc.O_RDONLY | fsc.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await h.read(buf, 0, maxBytes, offset);
      const out: RawLine[] = [];
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0 || nl >= bytesRead) break;
        const length = nl - start;
        out.push({ text: length > MAX_LINE_BYTES ? '' : buf.toString('utf8', start, nl), end: offset + nl + 1 });
        start = nl + 1;
      }
      // A single line that does not fit the read window at all: step over it once it is complete.
      if (out.length === 0 && bytesRead === maxBytes) {
        const size = (await h.stat()).size;
        let pos = offset + maxBytes;
        const probe = Buffer.alloc(64 * 1024);
        while (pos < size) {
          const { bytesRead: n } = await h.read(probe, 0, probe.length, pos);
          if (n === 0) break;
          const nl = probe.subarray(0, n).indexOf(0x0a);
          if (nl >= 0) return [{ text: '', end: pos + nl + 1 }];
          pos += n;
        }
      }
      return out;
    } finally {
      await h.close();
    }
  }
}
