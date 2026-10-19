import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { RiversFile } from '../../../packages/contracts/src/rivers.ts';
import { validateWaterbodies, type WaterbodiesFile } from '../../../packages/contracts/src/waterbodies.ts';
import { BuildError, ROOT } from './build.ts';
import type { LonLat } from './network.ts';

// P17b: the water bodies the placement reads. registry/waterbodies.yaml gives identity, names and kind; the polygons
// come from the osmium export of the water-body ids (rivernet.waterbodies.geojsonseq), keyed back to the yaml by the
// OSM object. A point-only body has no area.

/** One body's polygon: polygons → rings (the first the outer ring, the rest holes) → [lon, lat] (closed rings). */
export interface WaterbodyArea {
  id: string;
  polygons: LonLat[][][];
}

export interface WaterbodyInput {
  file: WaterbodiesFile;
  /** Per water-body id with `osm` set, its assembled polygon. */
  areas: ReadonlyMap<string, WaterbodyArea>;
}

export const WATERBODIES_PATH = join(ROOT, 'registry/waterbodies.yaml');

/** registry/waterbodies.yaml, validated against the rivers' mouths; BuildError('waterbodies_invalid'). */
export function readWaterbodies(rivers: RiversFile, path = WATERBODIES_PATH): WaterbodiesFile | null {
  // L0 transitional: B4a creates the file; the null branch goes then.
  if (!existsSync(path)) return null;
  const { problems, waterbodies } = validateWaterbodies(parse(readFileSync(path, 'utf8')), rivers);
  if (waterbodies === undefined) throw new BuildError('waterbodies_invalid', problems);
  return waterbodies;
}

/**
 * The yaml with its polygons from the osmium export at `areasPath` (geojsonseq, `.gz` read decompressed): every body
 * with `osm` must assemble (BuildError('waterbody_unassembled', ids)); caps as geojsonseq.ts readAreaSeq.
 */
export async function loadWaterbodyInput(file: WaterbodiesFile, areasPath: string): Promise<WaterbodyInput> {
  void areasPath;
  throw new BuildError('not_implemented', [`loadWaterbodyInput (${file.waterbodies.length} bodies): B2`]);
}
