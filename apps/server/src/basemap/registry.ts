import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type BasemapFile, validateBasemap } from '@rws/contracts';
import { parse as parseYaml } from 'yaml';
import { REGISTRY_DIR } from '../capture/specs.ts';
import { BasemapError, EXIT_CONFIG } from './errors.ts';

// registry/basemap.yaml, next to the other registry files (the P1b image keeps
// the repository layout). The job's fetch targets come only from here (invariant 1).

export const DEFAULT_REGISTRY = fileURLToPath(new URL('basemap.yaml', REGISTRY_DIR));
/** The file is about 2 KB; anything near this cap is not ours. */
const MAX_BYTES = 64 * 1024;

/** The validated registry; `registry_unreadable` or `registry_invalid` (exit 78) otherwise. */
export function loadBasemap(path: string = DEFAULT_REGISTRY): BasemapFile {
  let text: string;
  try {
    if (statSync(path).size > MAX_BYTES) throw new BasemapError('registry_invalid', EXIT_CONFIG);
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw e instanceof BasemapError ? e : new BasemapError('registry_unreadable', EXIT_CONFIG);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    throw new BasemapError('registry_invalid', EXIT_CONFIG);
  }
  const { basemap } = validateBasemap(doc);
  if (basemap === undefined) throw new BasemapError('registry_invalid', EXIT_CONFIG);
  return basemap;
}
