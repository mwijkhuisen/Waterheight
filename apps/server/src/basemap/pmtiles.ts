import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { BasemapError } from './errors.ts';

// The go-pmtiles binary (/app/bin/pmtiles in the image, pinned by sha256). It is
// started with an argument array, never through a shell, and with an environment
// that holds only what Go needs; its output is read through a bound and never
// forwarded beyond a short ASCII tail on failure.

export const VERIFY_TIMEOUT_MS = 30 * 60_000;
export const SHOW_TIMEOUT_MS = 60_000;
const SHOW_MAX_STDOUT = 64 * 1024;
const TAIL_BYTES = 400;
const DEFAULT_GOMEMLIMIT = '400MiB';

export type ToolRun = { ok: boolean; status: string; stdout: string; tail: string };

/** PATH, HOME and TMPDIR (a scratch directory the job may write), and GOMEMLIMIT when it is well formed. */
export function toolEnv(env: Readonly<Record<string, string | undefined>>, scratch: string): Record<string, string> {
  const limit = env.GOMEMLIMIT ?? '';
  return {
    PATH: env.PATH || '/usr/bin:/bin',
    HOME: scratch,
    TMPDIR: scratch,
    GOMEMLIMIT: /^[0-9]{1,6}(?:B|KiB|MiB|GiB)?$/.test(limit) ? limit : DEFAULT_GOMEMLIMIT,
  };
}

export type ToolOptions = {
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdout?: number;
  cwd?: string;
  signal?: AbortSignal;
};

/** Runs `bin args` to its end. Never rejects: a failure to start, a timeout and an abort are `ok: false`. */
export function runTool(bin: string, args: readonly string[], o: ToolOptions): Promise<ToolRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let tail = '';
    let overflow = false;
    const done = (ok: boolean, status: string) =>
      // ASCII only, one line: the tail is data from a process we do not control.
      resolve({ ok: ok && !overflow, status, stdout, tail: tail.replace(/[^\x20-\x7e]+/g, ' ').trim() });
    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], {
        env: { ...o.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: o.timeoutMs,
        killSignal: 'SIGKILL',
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        ...(o.signal === undefined ? {} : { signal: o.signal }),
      });
    } catch {
      done(false, 'not_started');
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > (o.maxStdout ?? SHOW_MAX_STDOUT)) {
        overflow = true;
        child.kill('SIGKILL');
      } else stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-TAIL_BYTES);
    });
    child.on('error', () => done(false, 'not_started'));
    child.on('close', (code, signal) => done(code === 0, code === null ? `signal ${signal}` : `exit ${code}`));
  });
}

/** A path go-pmtiles reads as a local file: absolute, so it can never be taken for a URL. */
function local(path: string): string {
  if (!isAbsolute(path)) throw new BasemapError('path_not_absolute');
  return path;
}

export type ToolDeps = {
  pmtiles: string;
  env: Readonly<Record<string, string | undefined>>;
  /** HOME and TMPDIR of the tool. */
  scratch: string;
  signal?: AbortSignal;
};

const options = (d: ToolDeps, timeoutMs: number): ToolOptions => ({
  env: toolEnv(d.env, d.scratch),
  timeoutMs,
  ...(d.signal === undefined ? {} : { signal: d.signal }),
});

/** `pmtiles verify`: the archive's structure is consistent (exit status only). */
export async function verifyArchive(d: ToolDeps, path: string): Promise<void> {
  const run = await runTool(d.pmtiles, ['verify', '--quiet', local(path)], options(d, VERIFY_TIMEOUT_MS));
  if (!run.ok) throw new BasemapError('verify_failed');
}

export type Header = {
  tile_type: string;
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
};

/** `pmtiles show --header-json`, parsed strictly: only the four fields we judge are kept. */
export async function readHeader(d: ToolDeps, path: string): Promise<Header> {
  const run = await runTool(d.pmtiles, ['show', '--header-json', local(path)], options(d, SHOW_TIMEOUT_MS));
  if (!run.ok) throw new BasemapError('header_unreadable');
  let doc: unknown;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    throw new BasemapError('header_unreadable');
  }
  const h = (typeof doc === 'object' && doc !== null ? doc : {}) as Record<string, unknown>;
  const { tile_type, minzoom, maxzoom, bounds } = h;
  if (
    typeof tile_type !== 'string' ||
    !Number.isInteger(minzoom) ||
    !Number.isInteger(maxzoom) ||
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    throw new BasemapError('header_unreadable');
  return {
    tile_type,
    minzoom: minzoom as number,
    maxzoom: maxzoom as number,
    bounds: bounds as Header['bounds'],
  };
}

type Extract = { minzoom: number; maxzoom: number };
/** The registry's tolerance for the regional bounds, in degrees. */
export const BOUNDS_SLACK = 0.01;

/**
 * What is wrong with the header of an extract, as a fixed code, or null. Vector
 * tiles of the registry's zoom range; regional bounds inside the registry bbox
 * (± 0.01°); planet bounds that span the world.
 */
export function headerProblem(
  h: Header,
  kind: 'basemap' | 'planet',
  extract: Extract,
  bbox: readonly [number, number, number, number] | undefined,
): string | null {
  if (h.tile_type !== 'mvt') return 'header_type';
  if (h.minzoom !== extract.minzoom || h.maxzoom !== extract.maxzoom) return 'header_zoom';
  const [w, s, e, n] = h.bounds;
  if (!(w < e && s < n)) return 'header_bounds';
  if (kind === 'planet') return w <= -179.9 && e >= 179.9 && s <= -84.9 && n >= 84.9 ? null : 'header_bounds';
  if (bbox === undefined) return 'header_bounds';
  const [bw, bs, be, bn] = bbox;
  return w >= bw - BOUNDS_SLACK && s >= bs - BOUNDS_SLACK && e <= be + BOUNDS_SLACK && n <= bn + BOUNDS_SLACK
    ? null
    : 'header_bounds';
}
