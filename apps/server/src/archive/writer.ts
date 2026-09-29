import { createHash, randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants as zc, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { ManifestLine, SOURCE_RE, SPEC_RE } from './manifest.ts';

// The raw archive (A§7.1): content-addressed zstd objects under
// raw/{source}/{spec}/{yyyy}/{mm}/{dd}/{HHmmss}Z-{sha256:16}.zst, written
// tmp → fsync → rename → fsync(dir), then exactly one manifest line per
// capture appended with a single write and fsync. `raw/` in a key is the
// archive root ($RWS_RAW_DIR). A crash leaves either no object and no line,
// or an object without a line, which the start-up recovery records.

export const DIR_MODE = 0o750;
export const FILE_MODE = 0o640;

export type Hooks = {
  /** Test seams (a child process pauses here to be killed); never set from env or config. */
  afterTmpWrite?: () => Promise<void>;
  afterRename?: () => Promise<void>;
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const utcDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** raw/{source}/{spec}/{yyyy}/{mm}/{dd}/{HHmmss}Z-{sha256:16}.zst; IDs are checked, never provider text. */
export function objectKey(source: string, spec: string, at: Date, hash: string): string {
  if (!SOURCE_RE.test(source) || !SPEC_RE.test(spec) || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('archive: invalid key part');
  }
  const [y, m, d] = utcDay(at).split('-');
  const t = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `raw/${source}/${spec}/${y}/${m}/${d}/${t}Z-${hash.slice(0, 16)}.zst`;
}

async function fsyncPath(path: string): Promise<void> {
  const h = await open(path, fsc.O_RDONLY);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

/** mkdir -p that fsyncs the parent of every directory it creates. */
async function mkdirDurable(dir: string): Promise<void> {
  const missing: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    try {
      await stat(d);
      break;
    } catch {
      missing.unshift(d);
      if (dirname(d) === d) break;
    }
  }
  for (const d of missing) {
    await mkdir(d, { mode: DIR_MODE }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    await fsyncPath(dirname(d));
  }
}

export class Archive {
  readonly root: string;
  private readonly hooks: Hooks;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(root: string, hooks: Hooks = {}) {
    this.root = root;
    this.hooks = hooks;
  }

  path(key: string): string {
    if (!key.startsWith('raw/') || key.includes('..')) throw new Error('archive: invalid key');
    return join(this.root, key.slice(4));
  }

  /**
   * Stores zstd(body) under its key. An existing final object (same content,
   * same second) is not rewritten. Returns the key and the stored size.
   */
  async put(
    source: string,
    spec: string,
    at: Date,
    body: Uint8Array,
    hash: string,
  ): Promise<{ key: string; stored: number }> {
    const key = objectKey(source, spec, at, hash);
    const final = this.path(key);
    const existing = await stat(final).catch(() => null);
    if (existing) return { key, stored: existing.size };
    const compressed = zstdCompressSync(body, { params: { [zc.ZSTD_c_compressionLevel]: 9 } });
    await mkdirDurable(join(this.root, '.tmp'));
    const tmp = join(this.root, '.tmp', `${randomBytes(12).toString('hex')}.tmp`);
    const h = await open(tmp, 'wx', FILE_MODE);
    try {
      await h.writeFile(compressed);
      await h.sync();
    } finally {
      await h.close();
    }
    await this.hooks.afterTmpWrite?.();
    await mkdirDurable(dirname(final));
    await rename(tmp, final);
    await fsyncPath(dirname(final));
    await this.hooks.afterRename?.();
    return { key, stored: compressed.length };
  }

  /** Appends one validated line with a single write + fsync; appends are serialised. */
  append(line: ManifestLine): Promise<void> {
    const parsed = ManifestLine.parse(line);
    const run = this.tail.then(async () => {
      const dir = join(this.root, '_manifest');
      await mkdirDurable(dir);
      const file = join(dir, `${parsed.fetched_at.start.slice(0, 10)}.jsonl`);
      const created = !(await stat(file).catch(() => null));
      const h = await open(file, 'a', FILE_MODE);
      try {
        const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`);
        const { bytesWritten } = await h.write(bytes);
        if (bytesWritten !== bytes.length) throw new Error('archive: short manifest write');
        await h.sync();
      } finally {
        await h.close();
      }
      if (created) await fsyncPath(dir);
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Start-up recovery: removes tmp files, truncates a torn last line of the
   * newest two manifests, and appends a `recovered: true` line for every final
   * object of those days (and today) that has no line. Returns that count.
   */
  async recover(
    retentionOf: (source: string, spec: string) => { retention: 'obs' | 'forever'; version: number } | undefined,
    now: Date = new Date(),
  ): Promise<number> {
    await rm(join(this.root, '.tmp'), { recursive: true, force: true });
    const dir = join(this.root, '_manifest');
    const manifests = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-2);
    const keys = new Set<string>();
    for (const f of manifests) {
      const file = join(dir, f);
      let text = await readFile(file, 'utf8');
      if (text.length > 0 && !text.endsWith('\n')) {
        const keep = text.lastIndexOf('\n') + 1;
        const h = await open(file, 'r+');
        try {
          await h.truncate(Buffer.byteLength(text.slice(0, keep)));
          await h.sync();
        } finally {
          await h.close();
        }
        text = text.slice(0, keep);
      }
      for (const l of text.split('\n')) {
        if (l === '') continue;
        try {
          const k = (JSON.parse(l) as { key?: unknown }).key;
          if (typeof k === 'string') keys.add(k);
        } catch {
          // An unreadable line is kept as it is; the loader reports it.
        }
      }
    }
    const days = new Set([...manifests.map((f) => f.slice(0, 10)), utcDay(now)]);
    let recovered = 0;
    for (const source of (await readdir(this.root).catch(() => [] as string[])).filter((s) => SOURCE_RE.test(s))) {
      for (const spec of (await readdir(join(this.root, source)).catch(() => [] as string[])).filter((s) =>
        SPEC_RE.test(s),
      )) {
        for (const day of days) {
          const [y, m, d] = day.split('-') as [string, string, string];
          const folder = join(this.root, source, spec, y, m, d);
          for (const name of (await readdir(folder).catch(() => [] as string[])).sort()) {
            const match = /^(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{16}\.zst$/.exec(name);
            const key = `raw/${source}/${spec}/${y}/${m}/${d}/${name}`;
            if (!match || keys.has(key)) continue;
            const info = retentionOf(source, spec);
            const stored = await readFile(join(folder, name));
            const body = zstdDecompressSync(stored);
            await this.append({
              v: 1,
              source,
              spec,
              spec_version: info?.version ?? 1,
              variant: '',
              recovered: true,
              request: null,
              fetched_at: { start: `${day}T${match[1]}:${match[2]}:${match[3]}.000Z`, end: null },
              status: null,
              headers: {},
              sha256: sha256(body),
              bytes: body.length,
              stored_bytes: stored.length,
              key,
              dup_of: null,
              gate: null,
              shape: null,
              shape_changed: false,
              validity: null,
              retention: info?.retention ?? 'forever',
              error: null,
            });
            recovered += 1;
          }
        }
      }
    }
    return recovered;
  }
}
