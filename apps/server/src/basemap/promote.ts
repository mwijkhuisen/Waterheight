import { lstat, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BasemapFile } from '@rws/contracts';
import {
  checkTilesManifest,
  referencedFiles,
  TILE_FILE_RE,
  TILES_MANIFEST_MAX_BYTES,
  type TileFile,
  type TilesEntry,
  type TilesManifest,
} from '@rws/core';
import { BasemapError, type Log } from './errors.ts';
import {
  emptyDir,
  isMissing,
  type Opened,
  openRegular,
  readSmallText,
  requireDir,
  sha256Of,
  syncDir,
  unchanged,
} from './fsutil.ts';
import { readManifest, writeManifest } from './manifest.ts';
import { headerProblem, readHeader, type ToolDeps, verifyArchive } from './pmtiles.ts';

// `basemap promote`: no network. It validates what `fetch` staged in
// <tiles>/.staging and moves it into <tiles>, the directory Caddy serves, then
// writes manifest.json. Files there are immutable once named, so a name that
// holds other bytes is refused; every step is idempotent, so a run that was cut
// short is finished by the next one (result.json is removed last).

const KINDS = ['basemap', 'planet'] as const;
type Kind = (typeof KINDS)[number];

export type PromoteDeps = {
  basemap: BasemapFile;
  tilesDir: string;
  pmtiles: string;
  env: Readonly<Record<string, string | undefined>>;
  log: Log;
  /** The plan of a dry run. */
  out: (line: string) => void;
};

export type PromoteOptions = { dryRun: boolean };

/** result.json as fetch writes it: the keys of a manifest entry plus `schema_version`, nothing else. */
function parseResult(text: string): TilesEntry {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    const { schema_version: version, ...entry } = doc;
    if (version !== 1) throw new Error('schema_version');
    return checkTilesManifest({ schema_version: 1, current: entry, previous: null }).current;
  } catch {
    throw new BasemapError('result_invalid');
  }
}

/** The manifest after promoting `entry`: the entry on top, what was current below it (a re-run keeps its previous). */
export function nextManifest(current: TilesManifest | null, entry: TilesEntry): TilesManifest {
  const previous = current === null ? null : current.current.build === entry.build ? current.previous : current.current;
  return { schema_version: 1, current: entry, previous };
}

/** A tile file may be served only when it is the staged bytes, an archive go-pmtiles accepts, and the registry's extract. */
async function checkTile(d: PromoteDeps, tool: ToolDeps, o: Opened, want: TileFile, kind: Kind, shaCode: string) {
  try {
    const x = d.basemap.extracts[kind];
    if (o.size > x.max_bytes) throw new BasemapError('file_too_large');
    const h = await sha256Of(o.fh, o.size);
    if (h.bytes !== want.bytes || h.sha256 !== want.sha256) throw new BasemapError(shaCode);
    await verifyArchive(tool, o.path);
    const problem = headerProblem(await readHeader(tool, o.path), kind, x, 'bbox' in x ? x.bbox : undefined);
    if (problem !== null) throw new BasemapError(problem);
    // The path was checked by name, after the descriptor was hashed: it must still be the same file.
    if (!(await unchanged(o))) throw new BasemapError('file_changed');
  } catch (e) {
    // Which of the two files, next to the code the caller logs.
    if (e instanceof BasemapError) d.log('error', 'file_refused', { kind, reason: e.code });
    throw e;
  }
}

type Step =
  | { kind: Kind; action: 'move'; opened: Opened; staged: string; final: string }
  | { kind: Kind; action: 'keep' };

export async function runPromote(d: PromoteDeps, o: PromoteOptions): Promise<void> {
  const { log } = d;
  await requireDir(d.tilesDir, 'tiles_dir');
  const staging = join(d.tilesDir, '.staging');
  const stat = await lstat(staging).catch((e: unknown) => {
    if (isMissing(e)) return null;
    throw new BasemapError('staging_dir');
  });
  // A link would let the staged names point anywhere: the staging directory is a real directory or nothing.
  if (stat !== null && !stat.isDirectory()) throw new BasemapError('staging_dir');
  const text =
    stat === null
      ? null
      : await readSmallText(join(staging, 'result.json'), TILES_MANIFEST_MAX_BYTES, 'result_invalid');
  if (text === null) {
    log('info', 'nothing_staged');
    d.out('nothing staged');
    return;
  }
  const entry = parseResult(text);
  const current = await readManifest(d.tilesDir);
  const tool: ToolDeps = { pmtiles: d.pmtiles, env: d.env, scratch: staging };

  const steps: Step[] = [];
  try {
    // 1. Validate both files before anything is moved.
    for (const kind of KINDS) {
      const want = entry[kind];
      const final = join(d.tilesDir, want.file);
      const staged = join(staging, want.file);
      const existing = await openRegular(final);
      if (existing !== null) {
        // Already there (an earlier run was cut short, or this is a re-run): fine only if it is these very bytes.
        try {
          await checkTile(d, tool, existing, want, kind, 'exists_different');
        } finally {
          await existing.fh.close();
        }
        steps.push({ kind, action: 'keep' });
        continue;
      }
      const opened = await openRegular(staged);
      if (opened === null) throw new BasemapError('staged_missing');
      try {
        await checkTile(d, tool, opened, want, kind, 'sha_mismatch');
      } catch (e) {
        await opened.fh.close();
        throw e;
      }
      steps.push({ kind, action: 'move', opened, staged, final });
    }

    const next = nextManifest(current, entry);
    checkTilesManifest(next);
    const stale = (await readdir(d.tilesDir)).filter((n) => TILE_FILE_RE.test(n) && !referencedFiles(next).includes(n));
    if (o.dryRun) {
      d.out(`dry run: would promote build ${entry.build} (tiles ${entry.version})`);
      for (const s of steps) d.out(`${s.action === 'move' ? 'move' : 'keep'} ${entry[s.kind].file}`);
      d.out(`manifest: current ${next.current.build}, previous ${next.previous?.build ?? 'none'}`);
      for (const name of stale) d.out(`would delete ${name}`);
      return;
    }

    // 2. Move: the same file that was checked, still unchanged, readable by Caddy.
    for (const s of steps) {
      if (s.action !== 'move') continue;
      if (!(await unchanged(s.opened))) throw new BasemapError('file_changed');
      await s.opened.fh.chmod(0o644);
      await rename(s.staged, s.final);
      log('info', 'file_moved', { kind: s.kind, build: entry.build });
    }
    await syncDir(d.tilesDir);

    // 3. The manifest makes the new build current.
    await writeManifest(d.tilesDir, next);
    log('info', 'promoted', { build: entry.build, previous: next.previous?.build ?? null });

    // 4. Retention: only tile files no manifest entry names; a link is removed, never followed.
    let failed = 0;
    for (const name of stale) {
      try {
        const path = join(d.tilesDir, name);
        if ((await lstat(path)).isDirectory()) continue;
        await unlink(path);
        log('info', 'retention_deleted', { file: name });
      } catch (e) {
        if (!isMissing(e)) failed += 1;
      }
    }

    // 5. Done: result.json goes last, so a crash before this point is finished by the next run.
    await emptyDir(staging, ['result.json']);
    if (failed > 0) {
      log('error', 'retention_failed', { n: failed });
      throw new BasemapError('retention_failed');
    }
  } finally {
    for (const s of steps) if (s.action === 'move') await s.opened.fh.close().catch(() => {});
  }
}
