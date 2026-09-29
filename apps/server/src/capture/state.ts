import { constants as fsc } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Per-spec capture state in $RWS_RAW_DIR/_state/ (the contract): written
// tmp → fsync → rename → fsync(dir) under a per-file lock, so a crash leaves
// the previous or the next version, never a torn one. It survives restarts.

export type VariantState = {
  sha?: string;
  key?: string;
  etag?: string;
  last_modified?: string;
  gate_key?: string;
  alert_key?: string;
  shape?: string;
  last_success?: string;
};

export type SpecState = {
  enabled_since: string;
  /** Saved at the start of a run: a tick later than this never ran (catch-up). */
  last_attempt?: string;
  last_success?: string;
  last_failure_status?: number | string | null;
  variants: Record<string, VariantState>;
  /** Resource ids already fetched (LU-5), shared by the spec and its seed. */
  seen: string[];
  /** Alerts that page at the group's next ping (then cleared). */
  pending_page: string[];
};

export const newSpecState = (now: Date): SpecState => ({
  enabled_since: now.toISOString(),
  variants: {},
  seen: [],
  pending_page: [],
});

export async function writeFileAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.${process.pid}.tmp`;
  const h = await open(tmp, 'w', mode);
  try {
    await h.writeFile(text);
    await h.chmod(mode);
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, path);
  const d = await open(dirname(path), fsc.O_RDONLY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}

/**
 * Removes the `<file>.<pid>.tmp` files a crash left behind (writeFileAtomic),
 * at start. Only names matching `pattern` go: $RWS_STATUS_DIR is served by
 * Caddy and shared with P1b's ops.json.
 */
export async function removeStaleTmp(dir: string, pattern = /\.json\.\d+\.tmp$/): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dir, { recursive: true }).catch(() => [] as string[])) {
    if (!pattern.test(basename(name))) continue;
    await rm(join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}

export class StateStore {
  readonly dir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(rawDir: string) {
    this.dir = join(rawDir, '_state');
  }

  private path(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/.test(name)) throw new Error('state: bad name');
    return join(this.dir, `${name}.json`);
  }

  async read<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(name), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** Read-modify-write under this file's lock; the result is written atomically. */
  update<T>(name: string, fn: (current: T | undefined) => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const run = prev.then(async () => {
      const next = await fn(await this.read<T>(name));
      await writeFileAtomic(this.path(name), `${JSON.stringify(next)}\n`, 0o640);
      return next;
    });
    this.locks.set(
      name,
      run.catch(() => {}),
    );
    return run;
  }
}
