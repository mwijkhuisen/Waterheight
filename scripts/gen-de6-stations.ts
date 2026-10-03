// Generates registry/classes/de-6.yaml (the LHP station table of DE-6: which LHP station features are our DE-1 and
// DE-7 stations, with their state, and which state operates the gauge) from the recorded LHP stations payload and
// the DE-1 and DE-7 station registries. Deterministic: the same input gives the same bytes; the output holds no
// timestamp of its own.
//
//   node scripts/gen-de6-stations.ts [--check]
//
// An LHP feature is one of our stations when the numeric part of its id (`RP_23900200`) equals the station's
// provider_code (a DE-1 or DE-7 primary public stage series) and lies within 500 m of it (catalogue §4.9). A
// curated ALIAS names the few features whose number differs (the Bavarian ids of Kleinheubach and Obernau, the
// Perl number), and the same 500 m rule applies to them. Several features of one station are an LHP duplicate
// group: the curated OPERATOR table decides which state operates the gauge (a single feature is its own
// operator). `--check` compares the committed file with the output and exits 1 on a difference.
//
// Fails loudly on anything it does not know: a duplicate group without an OPERATOR entry, an OPERATOR or ALIAS
// entry that no longer fits the payload, a number that two stations share, an unknown state. Fixture text is data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseStations, type StationFeature } from '../apps/server/src/adapters/de-6/parse.ts';
import { LhpStationsFile } from '../packages/contracts/src/tables.ts';

const root = join(import.meta.dirname, '..');
export const FIXTURE = 'apps/server/src/adapters/de-6/fixtures/de-6-stations.raw';
export const REGISTRIES = ['registry/stations/de-1.yaml', 'registry/stations/de-7.yaml'] as const;
export const OUTPUT = join(root, 'registry/classes/de-6.yaml');

/** The most a feature may lie from our station (catalogue §4.9). Detzem (RP_26700200, 678 m) and HE Kleinheubach (625 m) are further out and stay unmapped. */
export const NEAR_M = 500;

/**
 * Who operates a gauge that several states list (station id → state). Catalogue §4.9: the state whose flood centre
 * issues the Meldestufen: RP for the WSV gauges Worms, Mainz, Kaub and Perl. [U] D18: BY for Kleinheubach and
 * Obernau (the Main gauges in Bavaria; Kleinheubach's HE copy is 625 m away, so only Obernau is a group here) and
 * RP for Kalkofen-neu on the Lahn (HE_25800600 and RP_25800600 share the number and the position; not named in the
 * catalogue, the Lahn gauge lies in Rhineland-Palatinate).
 */
const OPERATOR: ReadonlyMap<string, string> = new Map([
  ['de.wsv.23900200', 'RP'],
  ['de.wsv.24700302', 'BY'],
  ['de.wsv.25100100', 'RP'],
  ['de.wsv.25700100', 'RP'],
  ['de.wsv.25800600', 'RP'],
  ['de.wsv.26100100', 'RP'],
]);

/**
 * Features whose number is not our provider_code: the LHP id → the provider_code of our station. BY numbers its
 * Main gauges apart (BY_24064003 Kleinheubach, BY_24070006 Obernau), and Saarland and Rhineland-Palatinate list
 * Perl as 26100102 where PEGELONLINE has 26100100.
 */
const ALIAS: ReadonlyMap<string, string> = new Map([
  ['BY_24064003', '24700200'],
  ['BY_24070006', '24700302'],
  ['RP_26100102', '26100100'],
  ['SL_26100102', '26100100'],
]);

type Obj = Record<string, unknown>;
type Station = { id: string; provider_code: string; lon: number; lat: number };
export type Inputs = {
  file: { path: string; sha256: string; recorded_at: string };
  features: StationFeature[];
  /** Our primary public stage series, DE-1 and DE-7. */
  stations: Station[];
};
type Row = { lhp: string; station: string; state: string; operator: boolean };

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Great-circle distance in metres. */
function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

/** The table rows for the inputs. Pure. */
export function build({ features, stations }: Inputs): Row[] {
  const byCode = new Map<string, Station>();
  for (const s of stations) {
    if (byCode.has(s.provider_code)) throw new Error(`provider_code ${s.provider_code} is on two stations`);
    byCode.set(s.provider_code, s);
  }
  const ids = new Set(features.map((f) => f.id));
  for (const lhp of ALIAS.keys()) if (!ids.has(lhp)) throw new Error(`ALIAS ${lhp}: not in the payload`);
  for (const [lhp, code] of ALIAS) if (!byCode.has(code)) throw new Error(`ALIAS ${lhp}: no station ${code}`);

  const found: { feature: StationFeature; station: Station; state: string }[] = [];
  for (const f of features) {
    const code = ALIAS.get(f.id) ?? /^[A-Z]{2}_(\d+)$/.exec(f.id)?.[1];
    const station = code === undefined ? undefined : byCode.get(code);
    if (station === undefined) continue;
    const [lon, lat] = f.geometry.coordinates;
    if (metres(lon, lat, station.lon, station.lat) > NEAR_M) {
      if (ALIAS.has(f.id)) throw new Error(`ALIAS ${f.id}: more than ${NEAR_M} m from ${station.id}`);
      continue;
    }
    found.push({ feature: f, station, state: f.id.slice(0, 2) });
  }

  const groups = new Map<string, typeof found>();
  for (const x of found) groups.set(x.station.id, [...(groups.get(x.station.id) ?? []), x]);
  for (const station of OPERATOR.keys())
    if ((groups.get(station)?.length ?? 0) < 2) throw new Error(`OPERATOR ${station}: not a duplicate group`);
  const rows: Row[] = [];
  for (const [station, group] of groups) {
    const operator = OPERATOR.get(station);
    if (group.length > 1 && operator === undefined)
      throw new Error(`${station}: ${group.map((g) => g.feature.id).join(', ')} is a duplicate group without OPERATOR`);
    if (operator !== undefined && !group.some((g) => g.state === operator))
      throw new Error(`OPERATOR ${station}: ${operator} has no feature in the group`);
    for (const g of group)
      rows.push({
        lhp: g.feature.id,
        station,
        state: g.state,
        operator: operator === undefined || g.state === operator,
      });
  }
  // Two features of the operating state in one group would be two operators (the schema refuses it too).
  for (const station of groups.keys())
    if (rows.filter((r) => r.station === station && r.operator).length !== 1)
      throw new Error(`${station}: not one operator`);
  return rows.sort((a, b) => byText(a.station, b.station) || byText(a.lhp, b.lhp));
}

/** The YAML text of the table for the inputs. Pure: the same input gives byte-identical output. */
export function generate(inputs: Inputs): string {
  const rows = build(inputs);
  LhpStationsFile.parse({ stations: rows });
  const groups = new Set(rows.filter((r) => !r.operator).map((r) => r.station));
  const header = [
    '# DE-6 LHP station table: the LHP station features that are one of our DE-1 or DE-7 stations (same number, within 500 m;',
    '# a curated alias for the few whose number differs), with the state of the feature and whether that state operates the gauge.',
    '# GENERATED by scripts/gen-de6-stations.ts from the recorded payload below and registry/stations/de-1.yaml and',
    '# de-7.yaml (primary public stage series). Do not edit by hand: change the generator (or re-record the fixture) and run',
    '# `node scripts/gen-de6-stations.ts`.',
    `#   ${inputs.file.path}  recorded_at ${inputs.file.recorded_at}  sha256 ${inputs.file.sha256}`,
    '# The loader hands this table to the DE-6 normaliser. Features of one station are an LHP duplicate group (catalogue',
    '# §4.9): the class of the operating state, else the worst other class, with the state as provenance. The operating state',
    '# of a group is the curated OPERATOR table of the generator ([U] D18: BY for Obernau; RP for Kalkofen-neu).',
    `# Rows: ${rows.length} features on ${new Set(rows.map((r) => r.station)).size} stations, ${groups.size} duplicate groups.`,
    '',
  ].join('\n');
  return header + stringify({ stations: rows }, { version: '1.1', lineWidth: 0 });
}

export function readInputs(): Inputs {
  const bytes = readFileSync(join(root, FIXTURE));
  const meta = JSON.parse(readFileSync(join(root, FIXTURE.replace(/\.raw$/, '.meta.json')), 'utf8')) as Obj;
  if (typeof meta.recorded_at !== 'string' || meta.synthetic !== false)
    throw new Error(`${FIXTURE}: the meta has no recorded_at or is not a real recording`);
  const stations: Station[] = [];
  for (const path of REGISTRIES) {
    const doc = parse(readFileSync(join(root, path), 'utf8')) as { stations?: Obj[] };
    for (const s of doc.stations ?? [])
      if (s.role === 'primary' && s.quantity === 'H' && s.audience === 'public')
        stations.push({
          id: String(s.id),
          provider_code: String(s.provider_code),
          lon: Number(s.lon),
          lat: Number(s.lat),
        });
  }
  return {
    file: { path: FIXTURE, sha256: sha256Of(bytes), recorded_at: meta.recorded_at },
    features: parseStations(bytes).features,
    stations,
  };
}

if (import.meta.main) {
  const text = generate(readInputs());
  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(OUTPUT, 'utf8');
    } catch {
      // A missing file is a difference.
    }
    if (committed !== text) {
      console.error('gen-de6-stations: registry/classes/de-6.yaml differs from the generator output');
      process.exit(1);
    }
    console.log('gen-de6-stations: OK');
  } else {
    writeFileSync(OUTPUT, text);
    console.log(`wrote ${OUTPUT}: ${text.split('\n').filter((line) => line.startsWith('  - lhp: ')).length} rows`);
  }
}
