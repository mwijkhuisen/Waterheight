import { join } from 'node:path';
import type { TileFile } from '@rws/core';
import { BasemapError, type Log } from './errors.ts';
import { openRegular, requireDir, sha256Of } from './fsutil.ts';
import { readManifest, writeManifest } from './manifest.ts';

// `basemap rollback`: no network. The previous extract becomes current again and
// the current one becomes previous (a second rollback undoes the first). The
// previous files are re-checked first: they must still be exactly the bytes the
// manifest names. Retention is not run: both extracts stay referenced.

export type RollbackDeps = {
  tilesDir: string;
  log: Log;
  /** The plan of a dry run. */
  out: (line: string) => void;
};

async function checkFile(tilesDir: string, want: TileFile): Promise<void> {
  const opened = await openRegular(join(tilesDir, want.file));
  if (opened === null) throw new BasemapError('previous_missing');
  try {
    const h = await sha256Of(opened.fh, opened.size);
    if (h.bytes !== want.bytes || h.sha256 !== want.sha256) throw new BasemapError('previous_changed');
  } finally {
    await opened.fh.close();
  }
}

export async function runRollback(d: RollbackDeps, o: { dryRun: boolean }): Promise<void> {
  await requireDir(d.tilesDir, 'tiles_dir');
  const manifest = await readManifest(d.tilesDir);
  if (manifest === null) throw new BasemapError('no_manifest');
  if (manifest.previous === null) throw new BasemapError('no_previous');
  await checkFile(d.tilesDir, manifest.previous.basemap);
  await checkFile(d.tilesDir, manifest.previous.planet);
  const swapped = { schema_version: 1 as const, current: manifest.previous, previous: manifest.current };
  if (o.dryRun) {
    d.out(`dry run: would make ${swapped.current.build} current again (previous ${swapped.previous.build})`);
    return;
  }
  await writeManifest(d.tilesDir, swapped);
  d.log('info', 'rolled_back', { current: swapped.current.build, previous: swapped.previous.build });
}
