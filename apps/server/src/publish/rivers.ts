import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { checkReaches, ReachesFile, RIVERS_VERSION_RE, type RivernetFile, RiversManifest } from '@rws/contracts';
import { checkOwnerReaches, type OwnerReachesFile } from '@rws/contracts/reaches-owner';
import type { Logger } from 'pino';
import { RegistryError, readRiverRegistry } from '../load/registry-sync.ts';
import { type OwnerSkipCode, splitReaches } from './render/reaches-owner.ts';

// P11a (D-C): the owner publisher's read of the installed river release. publish-owner mounts the public rivers
// directory read-only at RWS_RIVERS_DIR (/srv/rivers), reads its manifest.json, verifies the reaches file of the
// current and the previous release against the manifest's bytes and sha256, splits each at the owner stations
// (render/reaches-owner.ts) and hands the cycle the owner variants to write. It never writes under the mount, reads
// nothing but those two names, and never throws for a missing or bad release: a fixed code is logged once per process
// and the owner site keeps serving the public file (owner.caddy falls back to it). The public publisher has no such step.

export const RIVERS_DIR_DEFAULT = '/srv/rivers';
/** The manifest has two entries of three names each. */
const MANIFEST_MAX = 64 * 1024;
/** The cap rws-rivers-refresh puts on the reaches file (geo-refresh runbook). */
const REACHES_MAX = 32 * 1024 * 1024;

export type OwnerVariant = { name: string; body: OwnerReachesFile; skipped: { id: string; code: OwnerSkipCode }[] };
export type Rivernet = Pick<RivernetFile, 'stations'>;

/** Reads at most `max` bytes of a regular file, never through a link; `expect` is the size the manifest promised. */
async function readExact(path: string, max: number, expect?: number): Promise<Buffer> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max || (expect !== undefined && st.size !== expect))
      throw Object.assign(new Error('size'), { code: 'SIZE' });
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

const fixed = (err: unknown): string => ((err as { code?: unknown })?.code === 'ENOENT' ? 'missing' : 'unreadable');

export class OwnerRivers {
  readonly #dir: string;
  readonly #log: Pick<Logger, 'error'>;
  readonly #registry: () => Rivernet | null;
  readonly #logged = new Set<string>();
  #rivernet: { ok: Rivernet } | { code: string } | undefined;
  #key = '';

  /**
   * `registry` reads rivernet.yaml (default: the image's registry through readRiverRegistry, parsed once and cached
   * for the process, a RegistryError included).
   */
  constructor(
    dir: string,
    log: Pick<Logger, 'error'>,
    registry: () => Rivernet | null = () => readRiverRegistry().rivernet,
  ) {
    this.#dir = dir;
    this.#log = log;
    this.#registry = registry;
  }

  #fail(code: string): null {
    if (!this.#logged.has(code)) {
      this.#logged.add(code);
      this.#log.error({ code, step: 'reaches', family: 'owner' }, 'owner reaches variant not written');
    }
    return null;
  }

  #net(): Rivernet | string {
    if (this.#rivernet === undefined) {
      try {
        const net = this.#registry();
        this.#rivernet = net === null ? { code: 'rivernet_missing' } : { ok: net };
      } catch (err) {
        if (!(err instanceof RegistryError)) throw err;
        this.#rivernet = { code: 'rivernet_invalid' };
      }
    }
    return 'ok' in this.#rivernet ? this.#rivernet.ok : this.#rivernet.code;
  }

  /**
   * The owner variants to write now: one per verified release in the manifest (current, then previous), or null when
   * there is nothing to do (nothing changed since the last call, or the release is missing or does not verify; the
   * code is logged once). `owner` is the ids of the owner stations.json.
   */
  async next(owner: ReadonlySet<string>): Promise<OwnerVariant[] | null> {
    const net = this.#net();
    if (typeof net === 'string') return this.#fail(net);

    let manifest: RiversManifest;
    try {
      const text = (await readExact(join(this.#dir, 'manifest.json'), MANIFEST_MAX)).toString('utf8');
      const parsed = RiversManifest.safeParse(JSON.parse(text));
      if (!parsed.success) return this.#fail('rivers_manifest_invalid');
      manifest = parsed.data;
    } catch (err) {
      return this.#fail(err instanceof SyntaxError ? 'rivers_manifest_invalid' : `rivers_manifest_${fixed(err)}`);
    }

    const entries = [manifest.current, ...(manifest.previous === null ? [] : [manifest.previous])].filter(
      (e, i, all) => RIVERS_VERSION_RE.test(e.version) && all.findIndex((o) => o.version === e.version) === i,
    );
    const key = `${entries.map((e) => `${e.version}:${e.reaches.sha256}`).join(',')}|${createHash('sha256')
      .update([...owner].sort().join('\n'))
      .digest('hex')}`;
    if (key === this.#key) return null;

    const built: OwnerVariant[] = [];
    for (const e of entries) {
      let release: ReachesFile;
      try {
        const bytes = await readExact(join(this.#dir, e.reaches.file), REACHES_MAX, e.reaches.bytes);
        if (createHash('sha256').update(bytes).digest('hex') !== e.reaches.sha256) {
          this.#fail('rivers_reaches_mismatch');
          continue;
        }
        const parsed = ReachesFile.safeParse(JSON.parse(bytes.toString('utf8')));
        if (!parsed.success || parsed.data.version !== e.version || checkReaches(parsed.data).length > 0) {
          this.#fail('rivers_reaches_invalid');
          continue;
        }
        release = parsed.data;
      } catch (err) {
        this.#fail(err instanceof SyntaxError ? 'rivers_reaches_invalid' : `rivers_reaches_${fixed(err)}`);
        continue;
      }
      const { file, skipped } = splitReaches(release, owner, net);
      if (checkOwnerReaches(file).length > 0) {
        this.#fail('owner_reaches_invalid');
        continue;
      }
      built.push({ name: e.reaches.file, body: file, skipped });
    }
    if (built.length === 0) return null;
    // A release that failed is retried every cycle; the key is kept only when every entry verified.
    if (built.length === entries.length) this.#key = key;
    return built;
  }
}
