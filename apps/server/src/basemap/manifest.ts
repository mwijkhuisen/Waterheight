import { join } from 'node:path';
import { checkTilesManifest, parseTilesManifest, TILES_MANIFEST_MAX_BYTES, type TilesManifest } from '@rws/core';
import { BasemapError } from './errors.ts';
import { readSmallText, writeFileAtomic } from './fsutil.ts';

/** `<tiles>/manifest.json`: null when absent, `manifest_invalid` when present but not exactly ours. */
export async function readManifest(tilesDir: string): Promise<TilesManifest | null> {
  const text = await readSmallText(join(tilesDir, 'manifest.json'), TILES_MANIFEST_MAX_BYTES, 'manifest_invalid');
  if (text === null) return null;
  try {
    return parseTilesManifest(text);
  } catch {
    throw new BasemapError('manifest_invalid');
  }
}

/** Checks the manifest the way every reader will, then replaces `manifest.json` atomically (0644). */
export async function writeManifest(tilesDir: string, manifest: TilesManifest): Promise<void> {
  let text: string;
  try {
    text = `${JSON.stringify(checkTilesManifest(manifest), null, 2)}\n`;
    parseTilesManifest(text);
  } catch {
    throw new BasemapError('manifest_invalid');
  }
  await writeFileAtomic(tilesDir, 'manifest.json', text, 0o644);
}
