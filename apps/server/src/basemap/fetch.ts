import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { BasemapFile } from '@rws/contracts';
import { checkTilesManifest, type TileFile, type TilesEntry, tileFileNames } from '@rws/core';
import type { Resolver } from '../http/addresses.ts';
import { Client } from '../http/client.ts';
import type { Res, Transport } from '../http/types.ts';
import { type Build, parseBuilds } from './builds.ts';
import { BasemapError, type Log } from './errors.ts';
import { emptyDir, openRegular, requireDir, sha256Of, syncDir, writeFileAtomic } from './fsutil.ts';
import { readManifest } from './manifest.ts';
import { runTool, toolEnv } from './pmtiles.ts';

// `basemap fetch`: the only networked command of the role. It reads the build
// list, picks a build, extracts the regional and the planet tiles with go-pmtiles
// into the staging directory and writes result.json. It never writes the
// directory Caddy serves (threat model T-WEB-1): `basemap promote`, which has no
// network, validates the staged files and moves them there.

/** The label of the host allowlist in the HTTP client (there is no catalogue source). */
const ALLOWLIST = 'basemap';
const HTTP_TIMEOUT_MS = 60_000;
/** A 1-byte ranged read answers in a few bytes; anything larger is a server that ignored the range. */
const PROBE_MAX_BYTES = 64 * 1024;
const EXTRACT_TIMEOUT_MS = 4 * 60 * 60_000;
const KINDS = ['basemap', 'planet'] as const;
type Kind = (typeof KINDS)[number];

export type DiskStat = { blocks: number; bfree: number; bavail: number; bsize: number };

export type FetchDeps = {
  basemap: BasemapFile;
  /** Read only here: the current manifest. */
  tilesDir: string;
  stagingDir: string;
  pmtiles: string;
  /** Where PATH and GOMEMLIMIT of go-pmtiles come from; nothing else is passed on. */
  env: Readonly<Record<string, string | undefined>>;
  userAgent: string;
  transport: Transport;
  resolver?: Resolver;
  log: Log;
  /** The plan of a dry run. */
  out: (line: string) => void;
  now: () => Date;
  signal?: AbortSignal;
  statfs?: (dir: string) => Promise<DiskStat>;
  httpTimeoutMs?: number;
  extractTimeoutMs?: number;
};

export type FetchOptions = { build?: string; dryRun: boolean };

/**
 * The client follows redirects on its own host; this role does not accept any
 * (a 3xx is a failure). The wrapper records the redirect and refuses the hop.
 */
function refuseRedirects(inner: Transport, seen: { redirected: boolean }): Transport {
  return async (req) => {
    const res = await inner(req);
    if (res.status >= 300 && res.status < 400) {
      seen.redirected = true;
      res.body.on('error', () => {});
      res.body.destroy();
      throw new BasemapError('redirect');
    }
    return res;
  };
}

const tilesUrl = (b: BasemapFile, build: string) => `${b.protomaps.tiles_base_url}${build}.pmtiles`;

export async function runFetch(d: FetchDeps, o: FetchOptions): Promise<void> {
  const { basemap: b, log } = d;
  await requireDir(d.tilesDir, 'tiles_dir');
  await requireDir(d.stagingDir, 'staging_dir');
  // What is served now. The previous build is still on disk and named immutable: a re-extract of it can differ
  // byte for byte and would stop promote (exists_different) after hours of download. A rollback brings it back.
  const current = await readManifest(d.tilesDir);
  if (o.build !== undefined && o.build === current?.previous?.build) {
    d.out(`${o.build} is the previous build: make it current again with rws-basemap-refresh --rollback`);
    throw new BasemapError('build_is_previous');
  }
  // Extract cannot resume: every run starts clean. A dry run changes nothing.
  if (!o.dryRun) {
    try {
      await emptyDir(d.stagingDir);
    } catch {
      throw new BasemapError('staging_clean');
    }
    log('info', 'staging_cleared');
  }

  const seen = { redirected: false };
  const client = new Client({
    hosts: new Map([[ALLOWLIST, b.protomaps.hosts]]),
    userAgent: d.userAgent,
    transport: refuseRedirects(d.transport, seen),
    ...(d.resolver === undefined ? {} : { resolver: d.resolver }),
  });
  const get = async (what: 'builds' | 'tiles', url: string, maxBytes: number, range = false): Promise<Res> => {
    const r = await client.fetch(
      ALLOWLIST,
      { url, method: 'GET', variant: what, ...(range ? { headers: { range: 'bytes=0-0' } } : {}) },
      {
        maxBytes,
        timeoutMs: d.httpTimeoutMs ?? HTTP_TIMEOUT_MS,
        ...(d.signal === undefined ? {} : { signal: d.signal }),
      },
    );
    if (!r.ok) throw new BasemapError(seen.redirected ? `${what}_redirect` : `${what}_${r.error}`);
    return r.res;
  };

  // 1. The build list: https, allowlisted host, no redirect, capped while streaming.
  const list = await get('builds', b.protomaps.builds_url, b.protomaps.builds_max_bytes);
  if (list.status !== 200) throw new BasemapError('builds_status');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(list.body);
  } catch {
    throw new BasemapError('builds_invalid');
  }
  const builds = parseBuilds(text, b.protomaps.tiles_major, d.now());
  const newest = builds.at(-1);
  log('info', 'builds_listed', { eligible: builds.length, newest: newest?.build ?? null });
  const chosen: Build | undefined = o.build === undefined ? newest : builds.find((x) => x.build === o.build);
  if (chosen === undefined) throw new BasemapError(o.build === undefined ? 'no_eligible_build' : 'build_not_eligible');

  // 2. Against what is served now.
  if (current?.current.build === chosen.build) {
    log('info', 'already_current', { build: chosen.build });
    d.out(`already current: ${chosen.build}`);
    return;
  }
  if (o.build === undefined && current !== null) {
    // Without --build the job only moves forward, and a rollback sticks: the build that was rolled away from is
    // not fetched again by the daily run (a second rollback makes it current again).
    if (chosen.build < current.current.build) {
      log('info', 'not_newer', { build: chosen.build, current: current.current.build });
      d.out(`not newer than the current build ${current.current.build}: nothing to do`);
      return;
    }
    if (chosen.build === current.previous?.build) {
      log('info', 'rolled_back_build', { build: chosen.build });
      d.out(`${chosen.build} is the build that was rolled back: nothing to do (--rollback makes it current again)`);
      return;
    }
  }

  // 3. The tiles must be reachable without a redirect (go-pmtiles itself follows them) and answer a range.
  const url = tilesUrl(b, chosen.build);
  const probe = await get('tiles', url, PROBE_MAX_BYTES, true);
  const total = /^bytes 0-0\/([0-9]{1,15})$/.exec(probe.headers['content-range'] ?? '')?.[1];
  if (probe.status !== 206 || total === undefined || Number(total) <= 0) throw new BasemapError('tiles_status');
  log('info', 'tiles_reachable', { build: chosen.build, bytes: Number(total) });

  // 4. Disk: what the new files may take must still fit under the limit.
  const disk = await diskCheck(d);
  log('info', 'disk_ok', disk);

  const names = tileFileNames(chosen.build);
  const scratch = join(d.stagingDir, '.tmp');
  const plan = {
    basemap: extractArgs(b, 'basemap', url, join(scratch, names.basemap)),
    planet: extractArgs(b, 'planet', url, join(scratch, names.planet)),
  };
  if (o.dryRun) {
    d.out(`dry run: would stage build ${chosen.build} (tiles ${chosen.version}) from ${url}`);
    d.out(`disk: ${disk.used_pct}% used, ${disk.projected_pct}% with the new files (limit ${b.disk_max_pct}%)`);
    for (const kind of KINDS) d.out(`would run: ${d.pmtiles} ${plan[kind].join(' ')}`);
    return;
  }

  // 5. Extract into <staging>/.tmp, move each file under its final name, then write result.json.
  await mkdir(scratch, { mode: 0o700 });
  try {
    const files = {} as Record<Kind, TileFile>;
    for (const kind of KINDS) files[kind] = await extractOne(d, chosen.build, kind, scratch, plan[kind]);
    const entry: TilesEntry = {
      build: chosen.build,
      version: chosen.version,
      created_at: d
        .now()
        .toISOString()
        .replace(/\.[0-9]{3}Z$/, 'Z'),
      basemap: files.basemap,
      planet: files.planet,
    };
    // The same check promote makes, so a result it would refuse is never written.
    checkTilesManifest({ schema_version: 1, current: entry, previous: null });
    await writeFileAtomic(
      d.stagingDir,
      'result.json',
      `${JSON.stringify({ schema_version: 1, ...entry }, null, 2)}\n`,
      0o600,
    );
    log('info', 'staged', { build: chosen.build });
  } catch (e) {
    // Never leave a partial file, a temporary file or a result for promote to find.
    await emptyDir(d.stagingDir).catch(() => {});
    throw e;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** used + what the extracts may take, against the disk the staging directory is on (df's own reckoning). */
async function diskCheck(d: FetchDeps): Promise<{ used_pct: number; projected_pct: number }> {
  const { basemap: b } = d;
  let s: DiskStat;
  try {
    s = await (d.statfs ?? statfs)(d.stagingDir);
  } catch {
    throw new BasemapError('disk_unknown');
  }
  const used = (s.blocks - s.bfree) * s.bsize;
  const total = used + s.bavail * s.bsize;
  if (!(total > 0)) throw new BasemapError('disk_unknown');
  const projected = (used + b.extracts.basemap.max_bytes + b.extracts.planet.max_bytes) / total;
  const pct = (x: number) => Math.round(x * 1000) / 10;
  if (projected > b.disk_max_pct / 100) throw new BasemapError('disk');
  return { used_pct: pct(used / total), projected_pct: pct(projected) };
}

function extractArgs(b: BasemapFile, kind: Kind, url: string, out: string): string[] {
  const x = b.extracts[kind];
  return [
    'extract',
    '--quiet',
    url,
    out,
    ...('bbox' in x ? [`--bbox=${x.bbox.join(',')}`] : []),
    `--minzoom=${x.minzoom}`,
    `--maxzoom=${x.maxzoom}`,
    '--download-threads=4',
  ];
}

/** One go-pmtiles extract, then the checks that decide whether its file may be staged. */
async function extractOne(d: FetchDeps, build: string, kind: Kind, scratch: string, args: string[]): Promise<TileFile> {
  const name = tileFileNames(build)[kind];
  const partial = join(scratch, name);
  d.log('info', 'extract_started', { build, kind });
  const run = await runTool(d.pmtiles, args, {
    env: toolEnv(d.env, scratch),
    cwd: scratch,
    timeoutMs: d.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS,
    ...(d.signal === undefined ? {} : { signal: d.signal }),
  });
  if (!run.ok) {
    d.log('error', 'extract_failed', { kind, status: run.status, tail: run.tail });
    throw new BasemapError('extract_failed');
  }
  const opened = await openRegular(partial);
  if (opened === null) throw new BasemapError('extract_output');
  let sha256: string;
  try {
    if (opened.size === 0 || opened.size > d.basemap.extracts[kind].max_bytes) throw new BasemapError('extract_output');
    const h = await sha256Of(opened.fh, opened.size);
    if (h.bytes !== opened.size) throw new BasemapError('extract_output');
    sha256 = h.sha256;
    await opened.fh.sync();
    // The final name only after the whole file is complete and on disk.
    await rename(partial, join(d.stagingDir, name));
  } finally {
    await opened.fh.close();
  }
  await syncDir(d.stagingDir);
  d.log('info', 'extract_done', { build, kind, bytes: opened.size });
  return { file: name, sha256, bytes: opened.size };
}
