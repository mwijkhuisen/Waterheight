import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BasemapFile, validateBasemap } from '@rws/contracts';
import { type TilesEntry, tileFileNames } from '@rws/core';
import { parse } from 'yaml';
import type { Log } from '../../src/basemap/errors.ts';
import type { FetchDeps } from '../../src/basemap/fetch.ts';
import type { PromoteDeps } from '../../src/basemap/promote.ts';
import { fakeResolver, mswTransport } from '../helpers.ts';

// Shared pieces of the basemap tests: a registry that matches the committed
// fixtures, a sandbox of temporary directories, and a FAKE go-pmtiles (a shell
// script the test writes): it copies a fixture for `extract`, exits as told for
// `verify` and prints a header for `show`. The real binary is not used in unit tests.

const FIXTURES = new URL('../../../../tools/geo/fixtures/', import.meta.url).pathname;
export const LOBITH = join(FIXTURES, 'lobith-z14.pmtiles');
export const PLANET = join(FIXTURES, 'planet-z2.pmtiles');
const REGISTRY = new URL('../../../../registry/basemap.yaml', import.meta.url).pathname;

const digest = (path: string) => {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};
export const LOBITH_SUM = digest(LOBITH);
export const PLANET_SUM = digest(PLANET);

export const BUILD = '20261001';
export const BUILDS_URL = 'https://build-metadata.protomaps.dev/builds.json';
export const TILES_BASE = 'https://build.protomaps.com/';
export const NOW = new Date('2026-10-01T12:00:00Z');

/** The real registry, with extracts that the two fixtures satisfy (bounds inside the bbox, z0-14 and z0-2). */
export function testBasemap(over: { basemapMax?: number; planetMax?: number; buildsMax?: number } = {}): BasemapFile {
  const doc = parse(readFileSync(REGISTRY, 'utf8')) as BasemapFile;
  doc.extracts.basemap = {
    bbox: [6, 51.8, 6.2, 51.9],
    minzoom: 0,
    maxzoom: 14,
    max_bytes: over.basemapMax ?? 10_000_000,
  };
  doc.extracts.planet = { minzoom: 0, maxzoom: 2, max_bytes: over.planetMax ?? 5_000_000 };
  if (over.buildsMax !== undefined) doc.protomaps.builds_max_bytes = over.buildsMax;
  const { basemap, problems } = validateBasemap(doc);
  if (basemap === undefined) throw new Error(`test registry: ${problems.join('; ')}`);
  return basemap;
}

export const BASEMAP_HEADER = {
  tile_compression: 'gzip',
  tile_type: 'mvt',
  minzoom: 0,
  maxzoom: 14,
  bounds: [6.04, 51.82, 6.16, 51.88],
  center: [6.1, 51.85, 0],
};
export const PLANET_HEADER = {
  tile_compression: 'gzip',
  tile_type: 'mvt',
  minzoom: 0,
  maxzoom: 2,
  bounds: [-180, -85.0511287, 180, 85.0511287],
  center: [0, 0, 0],
};

export type FakeOptions = {
  /** `extract` of this kind writes a partial file and exits 3. */
  failExtract?: 'basemap' | 'planet';
  verifyExit?: number;
  /** The text `show` prints per kind (default: the fixtures' real headers). */
  basemapHeader?: unknown;
  planetHeader?: unknown;
  /** `verify` appends a byte to the file it is given (a file that changes under the check). */
  tamperOnVerify?: boolean;
  /** `verify` of the planet file appends a byte to the basemap file next to it (one that changes after its own check). */
  tamperPeer?: boolean;
  /** `extract` becomes `exec sleep <s>` (a go-pmtiles that never ends). */
  hang?: number;
};

export type Sandbox = { root: string; tiles: string; staging: string; work: string; bin: string };
const made: string[] = [];

/** Temporary tiles dir (with its `.staging`), a work dir and the fake binary. */
export async function sandbox(fake: FakeOptions = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'rws-basemap-'));
  made.push(root);
  const sb: Sandbox = {
    root,
    tiles: join(root, 'tiles'),
    staging: join(root, 'tiles', '.staging'),
    work: join(root, 'work'),
    bin: join(root, 'work', 'pmtiles'),
  };
  await mkdir(sb.staging, { recursive: true, mode: 0o700 });
  await mkdir(sb.work);
  await fakePmtiles(sb, fake);
  return sb;
}

export async function cleanSandboxes(): Promise<void> {
  for (const root of made.splice(0)) await rm(root, { recursive: true, force: true });
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export async function fakePmtiles(sb: Sandbox, o: FakeOptions = {}): Promise<void> {
  const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  await writeFile(join(sb.work, 'header-basemap.json'), text(o.basemapHeader ?? BASEMAP_HEADER));
  await writeFile(join(sb.work, 'header-planet.json'), text(o.planetHeader ?? PLANET_HEADER));
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${q(join(sb.work, 'calls.log'))}
case "$1" in
extract)
  shift
  env | sort > ${q(join(sb.work, 'env.log'))}
  ${o.hang === undefined ? '' : `exec sleep ${o.hang}`}
  bbox=0; pos=0; out=''
  for a in "$@"; do
    case "$a" in
      --bbox=*) bbox=1 ;;
      --*) ;;
      *) pos=$((pos+1)); if [ "$pos" -eq 2 ]; then out=$a; fi ;;
    esac
  done
  if [ "$bbox" = 1 ]; then kind=basemap; src=${q(LOBITH)}; else kind=planet; src=${q(PLANET)}; fi
  if [ "$kind" = ${q(o.failExtract ?? 'none')} ]; then echo partial > "$out"; exit 3; fi
  cp "$src" "$out"
  exit 0 ;;
verify)
  for a in "$@"; do last=$a; done
  ${o.tamperOnVerify ? 'printf x >> "$last"' : ':'}
  ${o.tamperPeer ? 'case "$last" in *planet-z6-*) for f in "$(dirname "$last")"/basemap-*.pmtiles; do printf x >> "$f"; done ;; esac' : ':'}
  exit ${o.verifyExit ?? 0} ;;
show)
  case "$*" in
    *planet-z6-*) cat ${q(join(sb.work, 'header-planet.json'))} ;;
    *) cat ${q(join(sb.work, 'header-basemap.json'))} ;;
  esac
  exit 0 ;;
esac
exit 64
`;
  await writeFile(sb.bin, script);
  await chmod(sb.bin, 0o755);
}

export function logs() {
  const lines: { level: string; code: string; [k: string]: unknown }[] = [];
  const log: Log = (level, code, fields) => {
    lines.push({ ...fields, level, code });
  };
  return { log, lines, codes: () => lines.map((l) => l.code) };
}

const ENV = { PATH: process.env.PATH, RWS_CONTACT_EMAIL: 'owner@example.org', EXTRA_VAR: 'from-the-parent-process' };

export function fetchDeps(sb: Sandbox, over: Partial<FetchDeps> = {}) {
  const l = logs();
  const out: string[] = [];
  const deps: FetchDeps = {
    basemap: testBasemap(),
    tilesDir: sb.tiles,
    stagingDir: sb.staging,
    pmtiles: sb.bin,
    env: ENV,
    userAgent: 'rivierstanden/test (+https://example.invalid/over; owner@example.org)',
    transport: mswTransport,
    resolver: fakeResolver(),
    log: l.log,
    out: (line) => out.push(line),
    now: () => NOW,
    // 4 TB disk, 10% used
    statfs: async () => ({ blocks: 1e9, bfree: 9e8, bavail: 9e8, bsize: 4096 }),
    ...over,
  };
  return { deps, out, ...l };
}

export function promoteDeps(sb: Sandbox, over: Partial<PromoteDeps> = {}) {
  const l = logs();
  const out: string[] = [];
  const deps: PromoteDeps = {
    basemap: testBasemap(),
    tilesDir: sb.tiles,
    pmtiles: sb.bin,
    env: ENV,
    log: l.log,
    out: (line) => out.push(line),
    ...over,
  };
  return { deps, out, ...l };
}

/** Fetch's output, as the promote job finds it: both files under final names, and result.json. */
export async function stage(sb: Sandbox, build = BUILD, version = '4.15.2'): Promise<TilesEntry> {
  const names = tileFileNames(build);
  await copyFile(LOBITH, join(sb.staging, names.basemap));
  await copyFile(PLANET, join(sb.staging, names.planet));
  const entry: TilesEntry = {
    build,
    version,
    created_at: '2026-10-01T09:00:00Z',
    basemap: { file: names.basemap, ...LOBITH_SUM },
    planet: { file: names.planet, ...PLANET_SUM },
  };
  await writeFile(join(sb.staging, 'result.json'), `${JSON.stringify({ schema_version: 1, ...entry }, null, 2)}\n`);
  return entry;
}

/** A tile file placed straight into the served directory (a promoted or stale one). */
export function place(dir: string, name: string, from = LOBITH): void {
  copyFileSync(from, join(dir, name));
}
