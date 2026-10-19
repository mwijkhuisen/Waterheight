import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { parse } from 'yaml';
import type { RiversFile } from '../../../packages/contracts/src/rivers.ts';
import { validateWaterbodies, type WaterbodiesFile } from '../../../packages/contracts/src/waterbodies.ts';
import { BuildError, ROOT } from './build.ts';
import { readAreaSeq } from './geojsonseq.ts';
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
export function readWaterbodies(rivers: RiversFile, path = WATERBODIES_PATH): WaterbodiesFile {
  const { problems, waterbodies } = validateWaterbodies(parse(readFileSync(path, 'utf8')), rivers);
  if (waterbodies === undefined) throw new BuildError('waterbodies_invalid', problems);
  return waterbodies;
}

/**
 * The yaml with its polygons from the osmium export at `areasPath` (geojsonseq, `.gz` read decompressed): every body
 * with `osm` must assemble (BuildError('waterbody_unassembled', ids)) exactly once (BuildError('waterbody_duplicate',
 * [osm key])), and the export holds no other area (BuildError('waterbody_unexpected', [osm key]): extract.sh strips the
 * tags of the referenced ways, so an island ring is no area of its own); caps as geojsonseq.ts readAreaSeq.
 */
export async function loadWaterbodyInput(file: WaterbodiesFile, areasPath: string): Promise<WaterbodyInput> {
  const byKey = new Map<string, string>();
  for (const w of file.waterbodies) if (w.osm !== null) byKey.set(`${w.osm.type[0]}${w.osm.id}`, w.id);
  const stream = createReadStream(areasPath);
  // pipeline passes a read error on to the gunzip stream and destroys both when the reader stops early; the reader's
  // maxTotalBytes bounds what is inflated.
  const chunks: AsyncIterable<Uint8Array> = areasPath.endsWith('.gz')
    ? pipeline(stream, createGunzip(), () => {})
    : stream;
  const areas = new Map<string, WaterbodyArea>();
  for await (const a of readAreaSeq(chunks)) {
    const key = `${a.type[0]}${a.id}`;
    const id = byKey.get(key);
    if (id === undefined) throw new BuildError('waterbody_unexpected', [key]);
    if (areas.has(id)) throw new BuildError('waterbody_duplicate', [key]);
    areas.set(id, { id, polygons: a.polygons });
  }
  const missing = [...byKey.values()].filter((id) => !areas.has(id)).sort();
  if (missing.length > 0) throw new BuildError('waterbody_unassembled', missing);
  return { file, areas };
}
