// Generates registry/stations/lu-1.yaml (the LU-1 station registry: AGE `Water-Levels-LocalTime.csv`, CC0) from the
// recorded CSV (the names and units of its 42 rows) and the recorded geoportail.lu station points (LU-6: WGS84
// coordinates by the AGE fiche number). Deterministic: the same input gives the same bytes; the output holds no
// timestamp of its own, and every derived value is stated in the row, none is inferred at read time.
//
//   node scripts/gen-lu1-stations.ts
//
// The CSV has no station number (its `Number` column is always empty), so the registry joins its rows to the LU-6
// fiches by an explicit curated table (CSV Name → slug and fiche code), never by fuzzy matching. The inputs are read
// through the adapters (`parseCsv` of LU-1, `parseFeatures` of LU-6).
//
// Fails loudly on anything it does not know: a CSV name that is not in the table, a table name that is not in the
// CSV, a fiche code that LU-6 does not have, has twice or has out of service, a unit that is not the table's, a twin
// whose DE-1 series is not a primary stage row. Fixture text is data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseCsv, type Table } from '../apps/server/src/adapters/lu-1/parse.ts';
import { parseFeatures, type Station } from '../apps/server/src/adapters/lu-6/parse.ts';
import { type PublicStation, validateStations } from '../packages/contracts/src/stations.ts';
import { TO_CANONICAL } from '../packages/contracts/src/units.ts';

const root = join(import.meta.dirname, '..');
export const CSV_FIXTURE = 'apps/server/src/adapters/lu-1/fixtures/lu-1-csv.raw';
export const GEO_FIXTURE = 'apps/server/src/adapters/lu-6/fixtures/lu-6-geo.raw';
export const DE1_REGISTRY = 'registry/stations/de-1.yaml';
export const OUTPUT = join(root, 'registry/stations/lu-1.yaml');

/**
 * The 42 rows of the CSV: the name exactly as the CSV states it → the slug of the station id (`lu.age.<slug>`, the
 * key of a `series` override in registry/sources.yaml) and the number of its LU-6 fiche (the file name of the
 * `Hyperlinks` link starts with it). LU-6 has two `Kautenbach` (14 and 104) and two `Niederfeulen` (27 in service,
 * 77 out of service): the code decides. Perl has no LU-6 point (it is the German side of the Moselle; the AGE number
 * 26100100 is the WSV number of the DE-1 gauge it copies).
 */
const TABLE: readonly (readonly [name: string, slug: string, fiche: string | null])[] = [
  ['Heiderscheidergrund', 'heiderscheidergrund', '19'],
  ['Müllerthal', 'mullerthal', '39'],
  ['Bissen', 'bissen', '10'],
  ['Walferdange', 'walferdange', '30'],
  ['Steinsel', 'steinsel', '04'],
  ['SN_Wasserbillig', 'wasserbillig', '0029151'],
  ['Ubersyren', 'ubersyren', '109'],
  ['Schoenfels', 'schoenfels', '05'],
  ['Esch-Sure', 'esch-sure', '40'],
  ['Perl', 'perl', null],
  ['Ettelbrück / Alzette', 'ettelbruck-alzette', '42'],
  ['Clervaux', 'clervaux', '35'],
  ['Bollendorf', 'bollendorf', '15'],
  ['Eischen', 'eischen', '107'],
  ['Welscheid', 'welscheid', '28'],
  ['SN_Remich', 'remich', '00229150'],
  ['Dasbourg', 'dasbourg', '13'],
  ['Wiltz', 'wiltz', '38'],
  ['Pfaffenthal', 'pfaffenthal', '03'],
  ['SN_Stadtbredimus', 'stadtbredimus', '02610012'],
  ['Hunnebuer', 'hunnebuer', '06'],
  ['SN_Grevenmacher', 'grevenmacher', '02610015'],
  ['Reichlange', 'reichlange', '09'],
  ['Livange', 'livange', '01'],
  ['Welscheid-Village', 'welscheid-village', '29'],
  ['Mertert', 'mertert', '32'],
  ['Kautenbach', 'kautenbach', '14'],
  ['Pétange', 'petange', '33'],
  ['Diekirch', 'diekirch', '11'],
  ['Gemünd_Our', 'gemund-our', '2626030300'],
  ['Niederfeulen', 'niederfeulen', '27'],
  ['Rosport', 'rosport', '16'],
  ['Vianden', 'vianden', '12'],
  ['Roodt sur Syre', 'roodt-sur-syre', '52'],
  ['Troisvierges', 'troisvierges', '37'],
  ['Larochette', 'larochette', '43'],
  ['Ettelbrück / Wark', 'ettelbruck-wark', '41'],
  ['Bigonville', 'bigonville', '17'],
  ['Mondorf-les-bains', 'mondorf-les-bains', '108'],
  ['Hesperange', 'hesperange', '02'],
  ['Michelau', 'michelau', '34'],
  ['Mersch', 'mersch', '07'],
];

/** The provider_code of Perl, which has no fiche: the WSV number of the DE-1 gauge it copies. */
const PERL_CODE = '26100100';

/**
 * Twins (role twin, tier 2): the same physical gauge as a DE-1 primary stage series, which the twin check compares.
 * Owner decision 2026-10-02: DE-1 stays primary, the LU-1 copy is a twin (up to 3 cm apart). Name → DE-1 provider_code.
 */
const TWINS = new Map([
  ['Perl', '26100100'],
  ['SN_Stadtbredimus', '26100130'],
  ['SN_Grevenmacher', '26100200'],
]);

/** LfU RLP-operated gauges inside the CC0 file: audience off and licence_gate withheld until C4 or C11 (catalogue §0.2, §0.8). */
const WITHHELD = new Set(['Bollendorf', 'Gemünd_Our']);

/** The bold LU gauges of catalogue §3.2 (tier 1); Bollendorf is one of them but withheld, so not first release. */
const TIER1 = new Set([
  'SN_Remich',
  'SN_Wasserbillig',
  'Bigonville',
  'Wiltz',
  'Clervaux',
  'Mersch',
  'Ettelbrück / Alzette',
  'Diekirch',
  'Vianden',
  'Rosport',
  'Bollendorf',
]);

/** The dam reservoir Esch-Sûre: the only row in metres NN (an absolute level, datum NG95). */
const RESERVOIR = 'Esch-Sure';

/** On the German side of the Moselle (Perl) or the Sauer/Our border (Bollendorf, Gemünd): country DE. */
const GERMAN = new Set(['Perl', 'Bollendorf', 'Gemünd_Our']);

/** The impounded Moselle (barrages): the four Moselle gauges of the AGE file and Perl. */
const IMPOUNDED = new Set(['SN_Remich', 'SN_Stadtbredimus', 'SN_Grevenmacher', 'SN_Wasserbillig', 'Perl']);

type Obj = Record<string, unknown>;

/** Provider text as the registry takes it (the rule of the Label schema), checked here for a readable error. */
function label(s: string, at: string): string {
  if (s === '') throw new Error(`${at}: empty`);
  if (s.length > 200) throw new Error(`${at}: longer than 200 characters`);
  if (/[\p{Cc}\p{Cf}]/u.test(s)) throw new Error(`${at}: a control or format character`);
  return s;
}

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Indented `#` comment lines of at most 118 characters; a long line continues further indented. */
function comment(text: string, first = '#  ', next = '#    '): string[] {
  const lines: string[] = [];
  let line = first;
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > 118 && line !== first) {
      lines.push(line);
      line = next;
    }
    line = `${line} ${word}`;
  }
  return [...lines, line];
}

export type Inputs = {
  /** Path, sha256 and `recorded_at` (from the fixture's .meta.json) of every fixture read. */
  files: { path: string; sha256: string; recorded_at: string }[];
  /** The LU-1 CSV (`parseCsv`). */
  table: Table;
  /** The LU-6 fiches (`parseFeatures`). */
  fiches: Station[];
  /** The rows of registry/stations/de-1.yaml that the twins refer to. */
  de1: { provider_code: string; role: string; quantity: string; value_kind: string | null }[];
};

function build(inputs: Inputs): PublicStation[] {
  // The curated table against the CSV: every name once, both ways.
  const slugs = new Set<string>();
  for (const [name, slug] of TABLE) {
    if (slugs.has(slug)) throw new Error(`curated table: the slug ${slug} twice`);
    slugs.add(slug);
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`curated table: the slug ${slug} of ${name} is not [a-z0-9-]+`);
  }
  const wanted = new Map(TABLE.map((t) => [t[0], t]));
  if (wanted.size !== TABLE.length) throw new Error('curated table: a name twice');
  const csv = new Map<string, Table['rows'][number]>();
  for (const r of inputs.table.rows) {
    if (csv.has(r.name)) throw new Error(`the CSV has ${r.name} twice`);
    csv.set(r.name, r);
  }
  const unknown = [...csv.keys()].filter((n) => !wanted.has(n)).sort(byCode);
  if (unknown.length > 0) throw new Error(`CSV names that are not in the curated table: ${unknown.join(', ')}`);
  const gone = [...wanted.keys()].filter((n) => !csv.has(n)).sort(byCode);
  if (gone.length > 0) throw new Error(`curated table names that are not in the CSV: ${gone.join(', ')}`);
  for (const set of [TWINS.keys(), WITHHELD, TIER1, GERMAN, IMPOUNDED, [RESERVOIR]]) {
    for (const name of set) if (!wanted.has(name)) throw new Error(`a rule names ${name}, which is not in the table`);
  }

  const byFiche = new Map<string, Station[]>();
  for (const f of inputs.fiches) if (f.code !== null) byFiche.set(f.code, [...(byFiche.get(f.code) ?? []), f]);

  const rows: PublicStation[] = [];
  for (const [name, slug, fiche] of TABLE) {
    const at = `station ${name}`;
    const csvRow = csv.get(name);
    if (csvRow === undefined) continue;
    const reservoir = name === RESERVOIR;
    if (csvRow.unit !== (reservoir ? 'm' : 'cm')) throw new Error(`${at}: the CSV unit is "${csvRow.unit}"`);

    let lon: number | null = null;
    let lat: number | null = null;
    if (fiche !== null) {
      const found = byFiche.get(fiche) ?? [];
      if (found.length === 0) throw new Error(`${at}: the fiche ${fiche} is not in LU-6`);
      if (found.length > 1) throw new Error(`${at}: the fiche ${fiche} is in LU-6 ${found.length} times`);
      const f = found[0] as Station;
      if (!f.inService) throw new Error(`${at}: the fiche ${fiche} is out of service in LU-6`);
      ({ lon, lat } = f);
    }
    const twinOf = TWINS.get(name);
    if (twinOf !== undefined) {
      const mate = inputs.de1.filter((r) => r.provider_code === twinOf && r.quantity === 'H');
      if (mate.length !== 1 || mate[0]?.role !== 'primary' || mate[0]?.value_kind !== 'stage') {
        throw new Error(`${at}: the DE-1 gauge ${twinOf} is not exactly one primary stage row`);
      }
    }
    const off = WITHHELD.has(name);
    const tier1 = TIER1.has(name);
    rows.push({
      id: `lu.age.${slug}`,
      source: 'LU-1',
      provider_code: name === 'Perl' ? PERL_CODE : (fiche as string),
      provider_key: label(name, `${at} name`),
      name,
      water_name: null,
      country: GERMAN.has(name) ? 'DE' : 'LU',
      lon,
      lat,
      quantity: 'H',
      tier: tier1 ? 1 : 2,
      role: twinOf === undefined ? 'primary' : 'twin',
      river: null,
      km: null,
      flags: {
        tidal: null,
        impounded: IMPOUNDED.has(name) ? true : null,
        ...(reservoir ? { reservoir: true } : {}),
      },
      native_unit: reservoir ? 'm' : 'cm',
      to_canonical: TO_CANONICAL[reservoir ? 'm' : 'cm'],
      value_kind: reservoir ? 'level' : 'stage',
      native_step: 'PT15M',
      expected_step: 'PT15M',
      staleness_limit: 'PT90M',
      expected_threshold_source: null,
      expected_forecast_source: null,
      licence_gate: off ? 'withheld' : 'open',
      first_release: tier1 && !off,
      audience: off ? 'off' : 'public',
      datum: reservoir ? 'NG95' : 'LOCAL',
      // The zeros of the LU gauges come from LU-4 (owner audience): none here.
      gauge_zero: [],
    });
  }
  rows.sort((a, b) => byCode(a.id, b.id));

  const { problems } = validateStations({ stations: rows }, [{ id: 'LU-1', audience: 'public' }]);
  if (problems.length > 0) throw new Error(`the generated rows fail validateStations:\n${problems.join('\n')}`);
  return rows;
}

function header(inputs: Inputs, rows: PublicStation[]): string {
  const files = inputs.files.map((f) => `#   ${f.path}  recorded_at ${f.recorded_at}  sha256 ${f.sha256}`);
  const navigation = TABLE.map((t) => t[0]).filter((n) => n.startsWith('SN_'));
  const count = (pred: (r: PublicStation) => boolean) => rows.filter(pred).length;
  return [
    '# LU-1 station registry (AGE Water-Levels-LocalTime.csv, CC0): one row per CSV row, H only.',
    '# GENERATED by scripts/gen-lu1-stations.ts from the inputs below. Do not edit by hand: change the generator (or re-record',
    '# a fixture) and run `node scripts/gen-lu1-stations.ts`.',
    ...files,
    ...comment(
      'The CSV has no station number, so its rows are joined to the LU-6 fiches by the curated table of the generator (CSV Name, slug, fiche code), never by fuzzy matching. ' +
        'provider_key = name = the CSV Name verbatim; provider_code = the fiche code (Perl: the WSV number 26100100 of the DE-1 gauge it copies); ' +
        'lon and lat are the LU-6 point of the fiche (Perl has none). H is cm (value_kind stage, datum LOCAL; the zeros come from LU-4, an owner source: gauge_zero is empty), ' +
        'native_step = expected_step PT15M, staleness_limit PT90M.',
      '#',
      '#  ',
    ),
    ...comment(
      'Esch-Sure is the dam reservoir (flags.reservoir true): metres NN (native_unit m, x100), an absolute level (value_kind level, datum NG95).',
      '#',
      '#  ',
    ),
    ...comment(
      'tier 1 (first_release) = the bold LU gauges of catalogue §3.2: SN_Remich, SN_Wasserbillig, Bigonville, Wiltz, Clervaux, Mersch, Ettelbrück / Alzette, Diekirch, Vianden, Rosport. ' +
        'Bollendorf is tier 1 too, but withheld (not first release).',
      '#',
      '#  ',
    ),
    ...comment(
      'Twins (role twin, tier 2, the same gauge as a DE-1 primary stage series, which the twin check compares): Perl (DE-1 26100100), SN_Stadtbredimus (26100130), SN_Grevenmacher (26100200). ' +
        'Owner decision 2026-10-02: DE-1 stays primary, the LU-1 copy is a twin (up to 3 cm apart).',
      '#',
      '#  ',
    ),
    ...comment(
      'Withheld (audience off, licence_gate withheld, not first release): Bollendorf and Gemünd_Our, LfU RLP-operated gauges inside the CC0 file, until C4 or C11 (catalogue §0.2, §0.8). ' +
        'Their series overrides in registry/sources.yaml are bollendorf and gemund-our.',
      '#',
      '#  ',
    ),
    ...comment(
      `country DE: ${[...GERMAN].join(', ')}. flags.impounded true (the impounded Moselle): ${[...IMPOUNDED].join(', ')}.`,
      '#',
      '#  ',
    ),
    ...comment(
      `Rows: ${rows.length} (${count((r) => r.role === 'primary' && r.audience === 'public')} primary public, ${count((r) => r.role === 'twin')} twins, ${count((r) => r.audience === 'off')} off).`,
      '#',
      '#  ',
    ),
    ...comment(
      `[U] The Service de la navigation gauges ${navigation.join(', ')} are published under the AGE CC0 file; whether that covers them is unverified (C4).`,
      '#',
      '#  ',
    ),
    '',
  ].join('\n');
}

/** The YAML text of the station file for the inputs. Pure: the same input gives byte-identical output. */
export function generate(inputs: Inputs): string {
  const rows = build(inputs);
  // YAML 1.1 rules quote what a 1.1 reader would misread: numeric codes (04, 00229150), dates, "off"/"no"/"on".
  return header(inputs, rows) + stringify({ stations: rows }, { version: '1.1', lineWidth: 0 });
}

/** The inputs: the CSV and the LU-6 points with their sha256 and `recorded_at`, and the DE-1 rows the twins name. */
export function readInputs(): Inputs {
  const files: Inputs['files'] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    const meta = JSON.parse(readFileSync(join(root, path.replace(/\.raw$/, '.meta.json')), 'utf8')) as Obj;
    if (typeof meta.recorded_at !== 'string' || meta.synthetic !== false) {
      throw new Error(`${path}: the meta has no recorded_at or is not a real recording`);
    }
    files.push({ path, sha256: sha256Of(bytes), recorded_at: meta.recorded_at });
    return bytes;
  };
  const table = parseCsv(read(CSV_FIXTURE));
  const fiches = parseFeatures(read(GEO_FIXTURE));
  const doc = parse(readFileSync(join(root, DE1_REGISTRY), 'utf8')) as { stations?: Obj[] };
  const mates = new Set(TWINS.values());
  const de1 = (doc.stations ?? [])
    .filter((s) => typeof s.provider_code === 'string' && mates.has(s.provider_code))
    .map((s) => ({
      provider_code: String(s.provider_code),
      role: String(s.role),
      quantity: String(s.quantity),
      value_kind: typeof s.value_kind === 'string' ? s.value_kind : null,
    }));
  return { files, table, fiches, de1 };
}

if (import.meta.main) {
  const text = generate(readInputs());
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT}: ${text.split('\n').filter((line) => line.startsWith('  - id: ')).length} rows`);
}
