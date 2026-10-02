// Generates registry/stations/lu-2.yaml (the LU-2 station registry: AGE per-station JSON, owner audience) and
// registry/twins/lu-2.yaml (one twin pair per file: the LU-2 series against the LU-1 series of the same gauge) from
// registry/seed/lu-2.csv (the 39 files with each one's `ts_path` and unit) and registry/stations/lu-1.yaml (name,
// position, flags). Deterministic: the same input gives the same bytes.
//
//   node scripts/gen-lu2-stations.ts                     regenerate the two files
//   node scripts/gen-lu2-stations.ts --extract <dir>     fill the ts_path and unit columns of registry/seed/lu-2.csv
//                                                        from an owner export of the archive (outside the repository)
//
// LU-2 is a twin of LU-1 in both audiences, never primary (A§7.2, A§7.4 step 6): its rows are `role: twin`,
// `audience: owner`, identification only (invariant 11: no datum, zero, value, threshold or forecast; the strict
// OwnerStation schema refuses them). A file joins its LU-1 row by the normalisation `seedlists.test.ts` already holds
// for the capture list (NFD, no diacritics, lowercase, `[\s/_-]+` → `-`), never by fuzzy matching. The key is the
// file's `ts_path` (catalogue §2.6: AGE numbers, Service de la navigation numbers for the Moselle, the WSV number for
// Perl). Fails loudly on anything it does not know: a file that matches no LU-1 row or two, a withheld (off) LU-1
// row, a unit that is not the LU-1 row's kind (cm for a stage, m for the Esch-Sûre level), a malformed ts_path.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseJson as parseLu2 } from '../apps/server/src/adapters/lu-2/parse.ts';
import { type PublicStation, StationsFile, validateStations } from '../packages/contracts/src/stations.ts';
import { TO_CANONICAL } from '../packages/contracts/src/units.ts';
import { scanCsv } from '../packages/core/src/csv.ts';

const root = join(import.meta.dirname, '..');
export const SEED = 'registry/seed/lu-2.csv';
export const LU1_REGISTRY = 'registry/stations/lu-1.yaml';
export const OUTPUT = join(root, 'registry/stations/lu-2.yaml');
export const TWINS_OUTPUT = join(root, 'registry/twins/lu-2.yaml');

/** Every committed ts_path (`0/<number>/<parameter>/15m.Cmd.<suffix>`); --extract writes nothing else (review SR-6). */
export const TS_PATH = /^0\/[0-9A-Za-z_/]{1,80}\/15m\.Cmd\.[A-Za-z.]{1,30}$/;
const UNIT = /^(cm|m)$/;
const ID_PREFIX = 'lu.age-json.';

export type SeedRow = { file: string; ts_path: string; unit: string };
export type Inputs = { lu1: PublicStation[]; seed: SeedRow[]; comments: string[] };

/** The seedlists.test.ts normalisation of an AGE station name. */
export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\s/_-]+/g, '-');

type Row = Record<string, unknown>;

function build(inputs: Inputs): { rows: Row[]; twins: Row[] } {
  const rows: Row[] = [];
  const twins: Row[] = [];
  const seen = new Set<string>();
  for (const s of inputs.seed) {
    const at = `lu-2.csv ${s.file}`;
    const matches = inputs.lu1.filter((r) => norm(r.provider_key) === norm(s.file));
    if (matches.length !== 1) throw new Error(`${at}: matches ${matches.length} LU-1 rows, not one`);
    const lu1 = matches[0] as PublicStation;
    if (lu1.audience === 'off') throw new Error(`${at}: its LU-1 row is withheld (off): never fetched`);
    if (!TS_PATH.test(s.ts_path)) throw new Error(`${at}: ts_path is missing or malformed`);
    if (seen.has(s.ts_path)) throw new Error(`${at}: ts_path twice`);
    seen.add(s.ts_path);
    const unit = s.unit === 'cm' || s.unit === 'm' ? s.unit : null;
    if (unit === null || (unit === 'm') !== (lu1.value_kind === 'level') || lu1.native_unit !== unit) {
      throw new Error(`${at}: unit ${s.unit} is not the LU-1 row's (${lu1.native_unit}, ${lu1.value_kind})`);
    }
    const slug = lu1.id.slice('lu.age.'.length);
    rows.push({
      id: `${ID_PREFIX}${slug}`,
      source: 'LU-2',
      provider_code: lu1.provider_code,
      provider_key: s.ts_path,
      name: lu1.name,
      water_name: lu1.water_name,
      country: lu1.country,
      lon: lu1.lon,
      lat: lu1.lat,
      quantity: 'H',
      tier: 2,
      role: 'twin',
      river: lu1.river,
      km: lu1.km,
      flags: lu1.flags,
      native_unit: unit,
      to_canonical: TO_CANONICAL[unit],
      value_kind: lu1.value_kind,
      native_step: 'PT15M',
      expected_step: 'PT15M',
      // Fetched hourly; AGE publishes 11 to 60 minutes late (catalogue §2.6).
      staleness_limit: 'PT3H',
      expected_threshold_source: null,
      expected_forecast_source: null,
      licence_gate: 'owner-only',
      first_release: false,
      audience: 'owner',
    });
    twins.push({
      id: `${slug}-lu1-lu2-h`,
      a: { source: 'LU-1', provider_key: lu1.provider_key },
      b: { source: 'LU-2', provider_key: s.ts_path },
      relation: { kind: 'offset', expected: 0, tolerance: 0.05, unit: 'cm', min_share: 0.98 },
    });
  }
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  twins.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const check = validateStations({ stations: rows }, [
    { id: 'LU-2', audience: 'owner' },
    { id: 'LU-1', audience: 'public' },
  ]);
  if (check.problems.length > 0) throw new Error(check.problems.join('\n'));
  return { rows, twins };
}

const HEADER = `# LU-2 station registry (AGE per-station JSON, owner audience: catalogue §0.8, D22): one twin row per file.
# GENERATED by scripts/gen-lu2-stations.ts from registry/seed/lu-2.csv and registry/stations/lu-1.yaml. Do not edit by
# hand: change the generator or the seed and run \`node scripts/gen-lu2-stations.ts\`.
# Identification only (invariant 11): number, name and position as the LU-1 row of the same gauge has them; no datum,
# gauge zero, value, threshold or forecast. provider_key = the file's ts_path (catalogue §2.6). role twin in both
# audiences, never primary (A§7.2): the public LU-1 series is the gauge; each pair is in registry/twins/lu-2.yaml.
# Not fetched (and so not here): SN_Remich (404), Bollendorf and Gemünd_Our (LfU RLP-operated, catalogue §0.8).
`;

export function generate(inputs: Inputs): { stations: string; twins: string } {
  const { rows, twins } = build(inputs);
  return {
    stations: `${HEADER}# Rows: ${rows.length}.\n${stringify({ stations: rows }, { version: '1.1', lineWidth: 0 })}`,
    twins: `# The LU-1 ↔ LU-2 twin pairs (owner audience: their results are in the owner channel only, own twin checks).
# GENERATED by scripts/gen-lu2-stations.ts with registry/stations/lu-2.yaml. LU-2 states each value at its true time
# and LU-1 stores it after the measured label offset, so the two agree at shift 0 (A§7.4 steps 7 and 8).
${stringify({ twins }, { version: '1.1', lineWidth: 0 })}`,
  };
}

function readSeed(text: string): { seed: SeedRow[]; comments: string[] } {
  const comments = text.split('\n').filter((l) => l.startsWith('#'));
  const { header, rows } = scanCsv(text, { delimiter: ',', commentPrefix: '#' });
  if (header.join(',') !== 'file,ts_path,unit') throw new Error(`${SEED}: header is not file,ts_path,unit`);
  return { seed: rows.map((r) => ({ file: r[0] ?? '', ts_path: r[1] ?? '', unit: r[2] ?? '' })), comments };
}

export function readInputs(): Inputs {
  const lu1 = StationsFile.parse(parse(readFileSync(join(root, LU1_REGISTRY), 'utf8'))).stations.filter(
    (s): s is PublicStation => s.audience !== 'owner',
  );
  return { lu1, ...readSeed(readFileSync(join(root, SEED), 'utf8')) };
}

/** One seed line from a file's payload, or a fixed error: provider text reaches the CSV only through the patterns. */
export function seedLine(file: string, body: Uint8Array): string {
  const [series] = parseLu2(body);
  if (series === undefined) throw new Error(`${file}: an empty payload`);
  if (!TS_PATH.test(series.ts_path))
    throw new Error(`${file}: the export's ts_path does not match the ts_path pattern`);
  if (!UNIT.test(series.ts_unitsymbol)) throw new Error(`${file}: the export's unit is not cm or m`);
  return `${file},${series.ts_path},${series.ts_unitsymbol}`;
}

/**
 * --extract: the ts_path and unit of each listed file from the newest `lu-2-json` payload of that file in an owner
 * export (pairs `<spec>-<n>.raw` / `.line.json`), read through the LU-2 parser. Prints counts only.
 */
function extract(dir: string): void {
  const text = readFileSync(join(root, SEED), 'utf8');
  const comments = text.split('\n').filter((l) => l.startsWith('#'));
  const { rows } = scanCsv(text, { delimiter: ',', commentPrefix: '#' });
  const newest = new Map<string, { at: string; body: Buffer }>();
  for (const f of readdirSync(dir).filter((n) => /^lu-2-json-\d+\.line\.json$/.test(n))) {
    const line = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      variant?: string;
      fetched_at?: { start?: string };
    };
    const at = line.fetched_at?.start ?? '';
    const key = line.variant ?? '';
    if ((newest.get(key)?.at ?? '') < at)
      newest.set(key, { at, body: readFileSync(join(dir, f.replace(/\.line\.json$/, '.raw'))) });
  }
  const out: string[] = [];
  let found = 0;
  for (const r of rows) {
    const file = r[0] ?? '';
    const got = newest.get(file);
    if (got === undefined) throw new Error(`${file}: no lu-2-json payload of this file in the export`);
    out.push(seedLine(file, got.body));
    found += 1;
  }
  writeFileSync(join(root, SEED), `${[...comments, 'file,ts_path,unit', ...out].join('\n')}\n`);
  console.log(`${SEED}: ${found} files with their ts_path and unit`);
}

if (import.meta.main) {
  const i = process.argv.indexOf('--extract');
  if (i >= 0) {
    const dir = process.argv[i + 1];
    if (dir === undefined) {
      console.error('usage: node scripts/gen-lu2-stations.ts [--extract <export dir>]');
      process.exit(64);
    }
    extract(dir);
  } else {
    const { stations, twins } = generate(readInputs());
    writeFileSync(OUTPUT, stations);
    writeFileSync(TWINS_OUTPUT, twins);
    console.log(
      `wrote ${OUTPUT} and ${TWINS_OUTPUT}: ${stations.split('\n').filter((l) => l.startsWith('  - id: ')).length} rows`,
    );
  }
}
