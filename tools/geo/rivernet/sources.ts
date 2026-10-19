// The fetch targets of the river-network pipeline (P6a; invariant 1): registry/geo-sources.yaml, strictly
// validated. Every URL is https on one of four hosts. CLI:
//
//   node tools/geo/rivernet/sources.ts --ids                  # the region ids, one per line
//   node tools/geo/rivernet/sources.ts --selection <dir>      # <dir>/relations.txt and <dir>/qids.txt for osmium,
//                                                             # and (P17b) <dir>/waterbodies.txt and <dir>/probe-names.txt
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { validateRivers } from '../../../packages/contracts/src/rivers.ts';
import { validateWaterbodies, type WaterbodiesFile } from '../../../packages/contracts/src/waterbodies.ts';

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const ALLOWED_HOSTS = [
  'download.geofabrik.de',
  'image.discomap.eea.europa.eu',
  'query.wikidata.org',
  'www.hochwasserportal.nrw',
] as const;

const Url = z.url().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && (ALLOWED_HOSTS as readonly string[]).includes(u.hostname) && u.username === '';
  } catch {
    return false;
  }
}, 'must be an https URL on an allowed host');
const Bytes = z.number().int().positive();
const Qid = z.string().regex(/^Q[1-9][0-9]{0,9}$/);

const Region = z.strictObject({
  id: z.string().regex(/^[a-z][a-z-]{1,40}$/),
  url: Url.refine((s) => s.endsWith('-latest.osm.pbf'), 'must end in -latest.osm.pbf'),
  max_bytes: Bytes,
});

const CanalTrap = z
  .strictObject({
    name: z.string().min(1).max(80),
    osm_relation_id: z.number().int().positive().nullable(),
    wikidata: Qid.nullable(),
    evidence: z.string().min(1).max(500),
  })
  .refine((t) => t.osm_relation_id !== null || t.wikidata !== null, 'needs a relation or a wikidata id');

export const Sources = z
  .strictObject({
    version: z.literal(1),
    geofabrik: z.strictObject({ index_url: Url, index_max_bytes: Bytes, regions: z.array(Region).min(1) }),
    euhydro: z.strictObject({
      base_url: Url,
      layers: z.array(z.number().int().nonnegative()).min(1),
      max_requests: Bytes,
      min_interval_ms: Bytes,
      timeout_ms: Bytes,
      max_body_bytes: Bytes,
      max_minutes: Bytes,
    }),
    wikidata: z.strictObject({ sparql_url: Url, max_requests: Bytes }),
    nrw_stations: z.strictObject({ url: Url, max_bytes: Bytes }),
    canal_traps: z.array(CanalTrap),
  })
  .refine(
    (s) => new Set(s.geofabrik.regions.map((r) => r.id)).size === s.geofabrik.regions.length,
    'duplicate region id',
  );
export type SourcesFile = z.infer<typeof Sources>;

export function readSources(path = join(ROOT, 'registry/geo-sources.yaml')): SourcesFile {
  const r = Sources.safeParse(parse(readFileSync(path, 'utf8')));
  if (!r.success) throw new Error(`geo-sources.yaml is invalid: ${z.prettifyError(r.error)}`);
  return r.data;
}

type RiverSel = { osm_relation_id: number | null; osm_way_name: string | null; wikidata: string };

/** The osmium selections: curated relation ids (rivers and canal traps) and the QIDs of way-selected rivers and traps. */
export function selection(
  rivers: { rivers: readonly RiverSel[] },
  sources: Pick<SourcesFile, 'canal_traps'>,
): { relations: string; qids: string } {
  const ids = new Set<number>();
  const qids = new Set<string>();
  for (const r of rivers.rivers) {
    if (r.osm_relation_id !== null) ids.add(r.osm_relation_id);
    else if (r.osm_way_name !== null) qids.add(r.wikidata);
  }
  for (const t of sources.canal_traps) {
    if (t.osm_relation_id !== null) ids.add(t.osm_relation_id);
    else if (t.wikidata !== null) qids.add(t.wikidata);
  }
  const num = (q: string) => Number(q.slice(1));
  return {
    relations: [...ids]
      .sort((a, b) => a - b)
      .map((i) => `r${i}\n`)
      .join(''),
    qids: [...qids].sort((a, b) => num(a) - num(b)).join(','),
  };
}

/**
 * P17b: the osmium id file of the water-body polygons (`r<id>` or `w<id>` per line, relations first, each by number);
 * a point-only body has none. Never part of relations.txt or qids.txt: the bodies are extracted on their own.
 */
export function waterbodyIds(file: WaterbodiesFile): string {
  return file.waterbodies
    .flatMap((w) => (w.osm === null ? [] : [w.osm]))
    .sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'relation' ? -1 : 1))
    .map((o) => `${o.type[0]}${o.id}\n`)
    .join('');
}

/** P17b: the names of the one-off OSM name probe (extract.sh with RWS_GEO_PROBE=1): every name_nl and published spelling. */
export function probeNames(file: WaterbodiesFile): string {
  const names = new Set(file.waterbodies.flatMap((w) => [w.name_nl, ...Object.values(w.names).flat()]));
  return [...names]
    .sort()
    .map((n) => `${n}\n`)
    .join('');
}

if (import.meta.main) {
  const [flag, dir, ...rest] = process.argv.slice(2);
  try {
    if (flag === '--ids' && dir === undefined) {
      process.stdout.write(
        readSources()
          .geofabrik.regions.map((r) => `${r.id}\n`)
          .join(''),
      );
    } else if (flag === '--selection' && dir !== undefined && rest.length === 0) {
      const { problems, rivers } = validateRivers(parse(readFileSync(join(ROOT, 'registry/rivers.yaml'), 'utf8')));
      if (rivers === undefined) throw new Error(`registry/rivers.yaml is invalid (${problems.length} problems)`);
      const sel = selection(rivers, readSources());
      const wb = validateWaterbodies(parse(readFileSync(join(ROOT, 'registry/waterbodies.yaml'), 'utf8')), rivers);
      if (wb.waterbodies === undefined)
        throw new Error(`registry/waterbodies.yaml is invalid (${wb.problems.length} problems)`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'relations.txt'), sel.relations);
      writeFileSync(join(dir, 'qids.txt'), sel.qids === '' ? '' : `${sel.qids}\n`);
      writeFileSync(join(dir, 'waterbodies.txt'), waterbodyIds(wb.waterbodies));
      writeFileSync(join(dir, 'probe-names.txt'), probeNames(wb.waterbodies));
    } else {
      console.error('usage: node tools/geo/rivernet/sources.ts --ids | --selection <dir>');
      process.exitCode = 64;
    }
  } catch (err) {
    console.error(`sources: ${err instanceof Error ? err.message : 'failed'}`);
    process.exitCode = 1;
  }
}
