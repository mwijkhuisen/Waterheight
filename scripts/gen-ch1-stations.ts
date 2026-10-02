// Generates registry/stations/ch-1.yaml (the CH-1 station registry, BAFU hydrodata on LINDAS) and
// registry/stations/ch-2.yaml (the CH-2 twins: the same stations in the hydrodaten.admin.ch map
// GeoJSON) from the recorded river-cube and lake-cube CSVs, the recorded CH-2 GeoJSON, the BAFU
// forecast stations (registry/seed/ch-4.csv) and, when it exists, the steps table
// registry/seed/ch-1-steps.csv. Deterministic: the same input gives the same bytes; the
// output holds no timestamp of its own, and every derived value is stated in the row, none is
// inferred at read time. One file per source, because the loader maps one file to one source.
//
//   node scripts/gen-ch1-stations.ts
//   node scripts/gen-ch1-stations.ts --steps <ch-1-day.csv | ch-1-day.csv.gz>
//
// The second form derives registry/seed/ch-1-steps.csv from the concatenated CH-1 payloads of one
// day (the repeated header lines are dropped): the step of a station is the modal gap between its
// distinct observation times. Without that file every CH series is PT10M (BAFU: every 10 minutes).
// The default form reads only committed inputs.
//
// Fails loudly on anything it does not know: a water body in neither scope table, a malformed
// WKT, a bad percent escape or name, a tier-1 station without a series, a CH-2 row that disagrees
// with its CH-1 series (unit, level or stage), a step outside the allowed set. Fixture text is data.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import { REGISTRY_DIR, readSeed } from '../apps/server/src/capture/specs.ts';
import { type PublicStation, validateStations } from '../packages/contracts/src/stations.ts';
import { type NativeUnit, TO_CANONICAL } from '../packages/contracts/src/units.ts';
import { scanCsv } from '../packages/core/src/csv.ts';

const root = join(import.meta.dirname, '..');
const CH1_FIXTURES = 'apps/server/src/adapters/ch-1/fixtures';
export const RIVER_FIXTURE = `${CH1_FIXTURES}/ch-1-lindas.raw`;
/** The lake cube (the same query, `cube: lake`); its stations carry `flags.lake`. */
export const LAKE_FIXTURE = `${CH1_FIXTURES}/ch-1-lindas-lake.raw`;
export const CH2_FIXTURE = 'apps/server/src/adapters/ch-2/fixtures/ch-2-pq.raw';
export const OUTPUT_CH1 = join(root, 'registry/stations/ch-1.yaml');
export const OUTPUT_CH2 = join(root, 'registry/stations/ch-2.yaml');
export const STEPS_CSV = join(root, 'registry/seed/ch-1-steps.csv');

/** The variables of the fixed LINDAS query (registry/capture.yaml): the header of both cubes. */
const HEADER = ['id', 'name', 'water', 'time', 'q', 'w', 't', 'dl', 'wkt'];
const UNDEFINED_LEVEL = 'https://cube.link/Undefined';

/** The steps a CH-1 station may have (minutes → ISO duration). */
const STEPS = new Map([
  [10, 'PT10M'],
  [20, 'PT20M'],
  [30, 'PT30M'],
  [60, 'PT1H'],
]);
const STEP_MINUTES = new Map([...STEPS].map(([minutes, iso]) => [iso, minutes]));
/** BAFU publishes every 10 minutes: the step of a station without a measured one (also a one-point day). */
const DEFAULT_STEP = 'PT10M';

/**
 * Catalogue §3.1 (Swiss table): the river-cube stations of tier 1, first release. CH tier 1 is every station of the
 * table, bold or not; FR-1 takes only the bold codes of §3.1-§3.4 (review CR-5).
 */
const TIER1_RIVER = new Set([
  '2473', // Rhein - Diepoldsau, Rietbrücke
  '2288', // Rhein - Neuhausen, Flurlingerbrücke
  '2044', // Thur - Andelfingen
  '2143', // Rhein - Rekingen
  '2135', // Aare - Bern, Schönau
  '2029', // Aare - Brügg, Aegerten
  '2063', // Aare - Murgenthal
  '2016', // Aare - Brugg
  '2018', // Reuss - Mellingen
  '2243', // Limmat - Baden, Limmatpromenade
  '2205', // Aare - Untersiggenthal, Stilli
  '2091', // Rhein - Rheinfelden
  '2106', // Birs - Münchenstein, Hofmatt
  '2289', // Rhein - Basel, Rheinhalle
  '2615', // Rhein - Basel, LHG
]);
/** The Bodensee stations (Obersee, Untersee), tier 1: in the lake cube. */
const TIER1_LAKE = new Set(['2032', '2043']);

/**
 * Owner decision Q2: the NL-bound scope is the Rhine basin. A water body of the CH-1 cubes is in exactly one
 * of the two tables; a body in neither fails the generator. A station on a NON_RHINE body is registered
 * with audience `off` (out of scope, stored nowhere, never counted unknown; the licence stays open), and so
 * is its CH-2 twin. Names are the percent-decoded last path segment of the `water` IRI.
 */
const NON_RHINE = new Set([
  // Rhône basin (Valais, Lake Geneva, Jura). Doubs: flows to the Saône; Allaine (Boncourt) joins it in France.
  'Lac Léman',
  'Lac des Brenets', // a widening of the Doubs at Les Brenets
  'Allaine',
  'Allondon',
  'Arve',
  'Aubonne',
  'Bisse kalte Wasser', // Simplonpass: the channel runs down the north slope to the Rhône (Valais)
  'Doubs',
  'Drance',
  'Drance de Bagnes',
  'Goneri', // Oberwald (Goms): a left tributary of the Rhône
  'Grande Eau',
  'Lonza',
  'Massa',
  'Promenthouse',
  'Rhône',
  'Saltina',
  'Sionne',
  'Venoge',
  'Veveyse', // Vevey, Coppet: into Lake Geneva
  'Vispa',
  // Klusmatten lies south of the Simplon pass, below it: the Simplon watershed splits the Rhône from the Po,
  // and either way the water does not reach the Rhine.
  'Krummbach',
  // Po basin (Ticino, the Lake Maggiore, Lugano and Como tributaries, Adda).
  'Lago Maggiore',
  'Lago di Lugano', // drains by the Tresa into the Lake Maggiore
  'Breggia',
  'Brenno',
  'Calancasca',
  'Canale industriale', // Le Prese: the Lago di Poschiavo, Adda
  'Cassarate',
  'Maggia',
  'Magliasina',
  'Melera', // Valle Morobbia: into the Ticino
  'Mera',
  'Moesa',
  'Poschiavino',
  'Riale di Calneggia',
  'Riale di Pincascia',
  'Riale di Roggiasca',
  'Ticino',
  'Tresa',
  'Vedeggio',
  'Verzasca',
  // Inn (Danube): the Engadin lakes from Maloja down to St. Moritz.
  'Silsersee',
  'Silvaplanersee',
  'St. Moritzersee',
  'Berninabach',
  'Chamuerabach',
  'Derivazione Spöl',
  'Inn',
  'Innabl. EKW',
  'Innableitung EKW', // Martina (CH-2 only): the EKW diversion of the Inn
  'Ova da Cluozza',
  'Ova dal Fuorn',
  'Rosegbach',
  // Adige.
  'Rom',
]);
/**
 * Rhine basin (Aare, Reuss, Limmat, Thur, the Jura lakes' tributaries and the Rhine itself). Resolved from the
 * station's name and coordinates in the fixture: Orbe (Le Chenit, Orbe), Broye, Canal de la Broye, Areuse, Seyon,
 * Menthue and Parimbot (Ecublens FR, near Rue) run to the Lakes of Neuchâtel and Murten, Birse, Sorne, Scheulte and
 * Birs to the Rhine at Basel, Suze and Zihlkanal to the Aare, Wiese and Aach to the Rhine; Dorfbachableitung
 * (Bürglen, EW Altdorf, to the Schächen and Reuss), Mühlbach and Untertorer Mühlbach (Chur), Werkkanal
 * (Gerlafingen, Emme), Betriebswasser KLL (Linthal, to the Linth) and Hölloch and Schlichenden Brünnen (Muotathal)
 * are named after a place, not a river, and all lie in Rhine catchments. The lakes of the lake cube: the Bodensee
 * (Ober- and Untersee), the lakes of the Aare, Reuss, Limmat and Linth, and the Lac de Joux, which drains by the Lac
 * Brenet to the Orbe and so to the Rhine; the Léman, the Lago Maggiore and Lugano, the Engadin lakes and the Lac des
 * Brenets are in NON_RHINE.
 */
const RHINE = new Set([
  'Aabach',
  'Aach',
  'Aare',
  'Aegerisee',
  'Albula',
  'Allenbach',
  'Alp',
  'Areuse',
  'Baldeggersee',
  'Betriebswasser KLL',
  'Biber',
  'Bielersee',
  'Birs',
  'Birse',
  'Bodensee, Obersee',
  'Bodensee, Untersee',
  'Brienzersee',
  'Broye',
  'Canal de la Broye',
  'Chli Schliere',
  'Dischmabach',
  'Dorfbachableitung',
  'Dünnern',
  'Emme',
  'Engelberger Aa',
  'Ergolz',
  'Glatt',
  'Glenner',
  'Goldach',
  'Greifensee',
  'Grossbach',
  'Grosstalbach',
  'Gürbe',
  'Hallwilersee',
  'Hinterrhein',
  'Hölloch',
  'Ilfis',
  'Julia',
  'Kander',
  'Kleine Emme',
  'Lac de Joux',
  'Lac de Neuchâtel',
  'Landquart',
  'Landwasser',
  'Langeten',
  'Lauerzersee',
  'Liechtensteiner Binnenkanal',
  'Limmat',
  'Linth',
  'Lorze',
  'Luthern',
  'Lütschine',
  'Menthue',
  'Minster',
  'Muota',
  'Murg',
  'Murtensee',
  'Mühlbach',
  'Necker',
  'Orbe',
  'Parimbot',
  'Pfäffikersee',
  'Plessur',
  'Rappengraben',
  'Rein da Sumvitg',
  'Reuss',
  'Rhein',
  'Rhein (Oberwasser)',
  'Rheintaler Binnenkanal',
  'Rietholzbach',
  'Rotenbach',
  'Saane',
  'Sarine',
  'Sarner Aa',
  'Sarnersee',
  'Scheulte',
  'Schlichenden Brünnen',
  'Schwändlibach',
  'Schächen',
  'Seez',
  'Sellenbodenbach',
  'Sempachersee',
  'Sense',
  'Seyon',
  'Sihl',
  'Simme',
  'Sionge',
  'Sitter',
  'Sorne',
  'Sperbelgraben',
  'Suhre',
  'Suze',
  'Thunersee',
  'Thur',
  'Töss',
  'Untertorer Mühlbach',
  'Vierwaldstättersee',
  'Vorderrhein',
  'Walensee',
  'Weisse Lütschine',
  'Werdenberger Binnenkanal',
  'Werkkanal',
  'Wiese',
  'Wigger',
  'Worble',
  'Zihlkanal',
  'Zugersee',
  'Zürichsee',
]);

/** A W value below this (metres) is a relative gauge (a stage), not a level above sea level (LN02). */
const RELATIVE_BELOW_M = 150;

/** Max(3 × step, 1 h): BAFU publishes every 10 minutes. */
const staleness = (minutes: number) => {
  const limit = Math.max(3 * minutes, 60);
  return limit % 60 === 0 ? `PT${limit / 60}H` : `PT${limit}M`;
};

// Input, validated by hand (as in gen-de1-stations.ts).
type Obj = Record<string, unknown>;

function obj(v: unknown, at: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${at}: expected an object`);
  return v as Obj;
}
function arr(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${at}: expected an array`);
  return v;
}
function str(v: unknown, at: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`${at}: expected a non-empty string`);
  return v;
}
/** Provider text as the registry takes it (the rule of the Label schema), checked here for a readable error. */
function label(v: unknown, at: string): string {
  const s = str(v, at);
  if (s.length > 200) throw new Error(`${at}: longer than 200 characters`);
  if (/[\p{Cc}\p{Cf}]/u.test(s)) throw new Error(`${at}: a control or format character`);
  return s;
}

type Seed = ReturnType<typeof readSeed>[number];

/** Code-unit order (never locale). */
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

const ID = /^\d{1,6}$/;
const NUMBER = /^-?\d{1,7}(?:\.\d{1,9})?(?:[eE][+-]?\d{1,3})?$/;
const WKT = /^POINT\((-?\d{1,3}(?:\.\d{1,20})?) (-?\d{1,2}(?:\.\d{1,20})?)\)$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

function checkHeader(header: string[], at: string): void {
  if (header.length !== HEADER.length || HEADER.some((h, i) => header[i] !== h)) {
    throw new Error(`${at}: the CSV header is not ${HEADER.join(',')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// --steps: the steps table from a day of payloads

/**
 * The CSV text of registry/seed/ch-1-steps.csv for a day of CH-1 payloads concatenated with their repeated
 * headers. The step of a station is the modal positive gap between its distinct observation times (a tie takes
 * the smaller gap); a station with a single time gets PT10M and is listed in the header. `name` and `sha256`
 * identify the day.
 */
export function deriveSteps(csv: string, name: string, sha256: string): string {
  const { header, rows } = scanCsv(csv, { delimiter: ',', maxRows: 2_000_000, extraField: false });
  checkHeader(header, 'steps input');
  const times = new Map<string, Set<number>>();
  for (const [i, r] of rows.entries()) {
    if (r[0] === 'id') {
      checkHeader(r, `steps input row ${i + 1}`);
      continue;
    }
    const [id = '', , , time = ''] = r;
    if (!ID.test(id) || !TIME.test(time) || !Number.isFinite(Date.parse(time))) {
      throw new Error(`steps input row ${i + 1}: not a station id and an observation time`);
    }
    times.set(id, (times.get(id) ?? new Set<number>()).add(Date.parse(time)));
  }
  if (times.size === 0) throw new Error('steps input: no observation');

  const out: { id: string; step: string; points: number }[] = [];
  const onePoint: string[] = [];
  const outside: string[] = [];
  for (const [id, set] of [...times].sort(([a], [b]) => byCode(a, b))) {
    const sorted = [...set].sort((a, b) => a - b);
    let step = DEFAULT_STEP;
    if (sorted.length < 2) onePoint.push(id);
    else {
      const counts = new Map<number, number>();
      for (let j = 1; j < sorted.length; j++) {
        const gap = (sorted[j] ?? 0) - (sorted[j - 1] ?? 0);
        counts.set(gap, (counts.get(gap) ?? 0) + 1);
      }
      // The most frequent gap; on a tie the smaller one.
      const [modal = 0] = [...counts].sort(([ga, na], [gb, nb]) => nb - na || ga - gb)[0] ?? [];
      const iso = Number.isInteger(modal / 60_000) ? STEPS.get(modal / 60_000) : undefined;
      if (iso === undefined) outside.push(`${id} (${modal / 60_000} min)`);
      else step = iso;
    }
    out.push({ id, step, points: sorted.length });
  }
  if (outside.length > 0) {
    throw new Error(`stations with a step outside ${[...STEPS.values()].join(', ')}: ${outside.join(', ')}`);
  }
  return [
    `# derived by scripts/gen-ch1-stations.ts --steps from ${name} sha256 ${sha256}`,
    ...(onePoint.length > 0
      ? comment(`one time only (step ${DEFAULT_STEP} by rule): ${onePoint.join(', ')}`, '#', '#  ')
      : []),
    'id,native_step,points',
    ...out.map((r) => `${r.id},${r.step},${r.points}`),
    '',
  ].join('\n');
}

/** Reads a day of payloads (plain or gzip, told by the magic bytes) and returns the steps CSV. */
export function deriveStepsFile(path: string): string {
  const bytes = readFileSync(path);
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = (gzip ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes).toString('utf8');
  return deriveSteps(text, basename(path), sha256Of(bytes));
}

// ---------------------------------------------------------------------------------------------
// The registry files

export type Inputs = {
  /** Path and sha256 of every file read. */
  files: { path: string; sha256: string }[];
  river: string;
  lake: string;
  ch2: unknown;
  ch4: Seed[];
  /** The steps table, or null while there is none (every station is then PT10M). */
  steps: Seed[] | null;
};

type Station = {
  id: string;
  name: string;
  /** Percent-decoded last path segment of the water IRI. */
  water: string;
  lon: number | null;
  lat: number | null;
  lake: boolean;
  hasW: boolean;
  hasQ: boolean;
  /** A W below RELATIVE_BELOW_M: a stage with a local zero, not a level above sea level. */
  relative: boolean;
  /** The latest observation states danger levels (not cube:Undefined). */
  dangerLevels: boolean;
};

/** The last path segment of an IRI, percent-decoded strictly (a bad escape fails). */
function waterName(iri: string, at: string): string {
  const segment = iri.slice(iri.lastIndexOf('/') + 1);
  if (segment === '' || /[?#]/.test(segment)) throw new Error(`${at}: the water IRI has no plain last path segment`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`${at}: a bad percent escape in the water IRI`);
  }
  return label(decoded, `${at}.water`);
}

/** One cube: a station per id, from its latest observation (a station may appear twice; the first of equal times wins). */
function readCube(text: string, lake: boolean, at: string): Map<string, Station> {
  const { header, rows } = scanCsv(text, { delimiter: ',', maxRows: 2000, extraField: false });
  checkHeader(header, at);
  type Row = { name: string; water: string; time: number; q: string; w: string; dl: string; wkt: string };
  const byId = new Map<string, Row[]>();
  for (const [i, r] of rows.entries()) {
    const [id = '', name = '', water = '', time = '', q = '', w = '', , dl = '', wkt = ''] = r;
    const where = `${at} row ${i + 1}`;
    if (!ID.test(id)) throw new Error(`${where}: bad station id`);
    if (!TIME.test(time) || !Number.isFinite(Date.parse(time))) throw new Error(`${where}: bad observation time`);
    for (const n of [q, w]) if (n !== '' && !NUMBER.test(n)) throw new Error(`${where}: bad number`);
    byId.set(id, [...(byId.get(id) ?? []), { name, water, time: Date.parse(time), q, w, dl, wkt }]);
  }
  const out = new Map<string, Station>();
  for (const [id, list] of byId) {
    const where = `${at} station ${id}`;
    let latest = list[0];
    for (const r of list) if (latest === undefined || r.time > latest.time) latest = r;
    if (latest === undefined) continue;
    const levels = list.filter((r) => r.w !== '').map((r) => Number(r.w));
    const relative = levels.some((w) => w < RELATIVE_BELOW_M);
    if (relative && levels.some((w) => w >= RELATIVE_BELOW_M)) {
      throw new Error(`${where}: W values on both sides of ${RELATIVE_BELOW_M} m`);
    }
    let lon: number | null = null;
    let lat: number | null = null;
    if (latest.wkt !== '') {
      const m = WKT.exec(latest.wkt);
      if (m === null) throw new Error(`${where}: the WKT is not POINT(lon lat)`);
      lon = Number(m[1]);
      lat = Number(m[2]);
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error(`${where}: the WKT is outside the globe`);
    }
    if (latest.water === '') throw new Error(`${where}: no water body (add it to a scope table by hand)`);
    out.set(id, {
      id,
      name: label(latest.name, `${where}.name`),
      water: waterName(latest.water, where),
      lon,
      lat,
      lake,
      hasW: levels.length > 0,
      hasQ: list.some((r) => r.q !== ''),
      relative,
      dangerLevels: latest.dl !== '' && latest.dl !== UNDEFINED_LEVEL,
    });
  }
  return out;
}

type Ch2 = {
  key: string;
  label: string;
  water: string | null;
  kind: 'river' | 'lake';
  /** The unit text of `sensor_discharge_last_value` (`m³/s` or `l/s`), null when the feature has no discharge sensor. */
  discharge: string | null;
  /** The unit text of `sensor_waterlevel_last_value` (`m ü.M.` or a relative `m`), null when it has no level sensor. */
  level: string | null;
};

const LEVEL_UNITS = new Map<string, { kind: 'stage' | 'level'; datum: 'LN02' | 'LOCAL' }>([
  ['m ü.M.', { kind: 'level', datum: 'LN02' }],
  ['m', { kind: 'stage', datum: 'LOCAL' }],
]);
const DISCHARGE_UNITS = new Map<string, NativeUnit>([
  ['m³/s', 'm³/s'],
  ['l/s', 'l/s'],
]);

/** The unit of a sensor string `<number> <unit>` (null when the sensor is absent); another shape fails. */
function sensorUnit(value: unknown, units: ReadonlyMap<string, unknown>, at: string): string | null {
  if (value === null || value === undefined) return null;
  const m = /^-?\d+(?:\.\d+)? (.+)$/.exec(str(value, at));
  if (m === null) throw new Error(`${at} is not "<number> <unit>"`);
  const unit = m[1] ?? '';
  if (!units.has(unit)) throw new Error(`${at}: unknown unit "${unit}"`);
  return unit;
}

/**
 * The features of the CH-2 GeoJSON: a Q twin for every one with `sensor_discharge_last_value`, an H twin for every one
 * with `sensor_waterlevel_last_value`, whatever its `metric` says (a lake gauge on a canal has both).
 */
function readCh2(payload: unknown): Map<string, Ch2> {
  const out = new Map<string, Ch2>();
  for (const [i, raw] of arr(obj(payload, 'ch-2').features, 'ch-2.features').entries()) {
    const p = obj(obj(raw, `ch-2.features[${i}]`).properties, `ch-2.features[${i}].properties`);
    const key = str(p.key, `ch-2.features[${i}].key`);
    const at = `ch-2 feature ${key}`;
    if (!ID.test(key)) throw new Error(`${at}: bad key`);
    if (out.has(key)) throw new Error(`${at}: duplicate key`);
    const kind = str(p.kind, `${at}.kind`);
    if (kind !== 'river' && kind !== 'lake') throw new Error(`${at}: unknown kind "${kind}"`);
    const discharge = sensorUnit(p.sensor_discharge_last_value, DISCHARGE_UNITS, `${at}.sensor_discharge_last_value`);
    const level = sensorUnit(p.sensor_waterlevel_last_value, LEVEL_UNITS, `${at}.sensor_waterlevel_last_value`);
    if (discharge === null && level === null) throw new Error(`${at}: no sensor value`);
    const water = typeof p.hydro_body_name === 'string' && p.hydro_body_name !== '' ? p.hydro_body_name : null;
    out.set(key, {
      key,
      label: label(p.label, `${at}.label`),
      water: water === null ? null : label(water, `${at}.hydro_body_name`),
      kind,
      discharge,
      level,
    });
  }
  return out;
}

type Skips = {
  /** Stations of the cubes without a W or a Q value in the recording. */
  noSeries: string[];
  /** CH-2 keys that are no CH-1 station: registered on their own water body, without coordinates. */
  ch2Only: string[];
  /** Water bodies of the `off` audience, and the number of stations on them. */
  offWaters: string[];
  offStations: number;
};

function build(inputs: Inputs): { ch1: PublicStation[]; ch2: PublicStation[]; skips: Skips } {
  const stations = readCube(inputs.river, false, 'river cube');
  for (const [id, s] of readCube(inputs.lake, true, 'lake cube')) {
    if (stations.has(id)) throw new Error(`station ${id} is in the river cube and the lake cube`);
    stations.set(id, s);
  }
  const forecast = new Set(inputs.ch4.map((r, i) => str(r.id, `ch-4.csv row ${i + 1}.id`)));
  const ch2 = readCh2(inputs.ch2);

  // Tier 1 against the cubes: nothing may have drifted silently.
  for (const id of TIER1_RIVER) {
    const s = stations.get(id);
    if (s === undefined || s.lake) throw new Error(`tier-1 station ${id} is not in the river cube`);
    if (!s.hasW && !s.hasQ) throw new Error(`tier-1 station ${id} has no series`);
    if (NON_RHINE.has(s.water)) throw new Error(`tier-1 station ${id} is on the non-Rhine water body ${s.water}`);
  }
  for (const id of TIER1_LAKE) {
    const s = stations.get(id);
    if (s === undefined || !s.lake) throw new Error(`tier-1 station ${id} is not in the lake cube`);
    if (!s.hasW) throw new Error(`tier-1 station ${id} has no series`);
    if (NON_RHINE.has(s.water)) throw new Error(`tier-1 station ${id} is on the non-Rhine water body ${s.water}`);
  }

  // The scope tables: every water body of the cubes, and of the CH-2 features that are no CH-1 station, in exactly
  // one, and no entry left over.
  for (const name of RHINE) if (NON_RHINE.has(name)) throw new Error(`water body ${name} is in both scope tables`);
  const waters = new Set([...stations.values()].map((s) => s.water));
  for (const f of ch2.values()) {
    if (stations.has(f.key)) continue;
    if (f.water === null) throw new Error(`ch-2 feature ${f.key}: no CH-1 station and no water body to classify`);
    waters.add(f.water);
  }
  const unknown = [...waters].filter((w) => !RHINE.has(w) && !NON_RHINE.has(w)).sort(byCode);
  if (unknown.length > 0)
    throw new Error(`water bodies in neither scope table (RHINE, NON_RHINE): ${unknown.join(', ')}`);
  for (const name of [...RHINE, ...NON_RHINE]) {
    if (!waters.has(name)) throw new Error(`scope table entry ${name} is in no cube any more`);
  }

  const steps = new Map<string, { step: string; minutes: number }>();
  for (const [i, r] of (inputs.steps ?? []).entries()) {
    const at = `ch-1-steps.csv row ${i + 1}`;
    const id = str(r.id, `${at}.id`);
    const step = str(r.native_step, `${at}.native_step`);
    const minutes = STEP_MINUTES.get(step);
    if (minutes === undefined) throw new Error(`${at}: station ${id} has the step "${step}", outside the allowed set`);
    if (!stations.has(id)) throw new Error(`${at}: station ${id} is in no cube`);
    if (steps.has(id)) throw new Error(`${at}: duplicate station ${id}`);
    steps.set(id, { step, minutes });
  }
  const stepOf = (id: string) => steps.get(id) ?? { step: DEFAULT_STEP, minutes: STEP_MINUTES.get(DEFAULT_STEP) ?? 10 };

  const ch1: PublicStation[] = [];
  const skips: Skips = { noSeries: [], ch2Only: [], offWaters: [], offStations: 0 };
  const offWaters = new Set<string>();
  for (const id of [...stations.keys()].sort(byCode)) {
    const s = stations.get(id);
    if (s === undefined) continue;
    if (!s.hasW && !s.hasQ) {
      skips.noSeries.push(id);
      continue;
    }
    const off = NON_RHINE.has(s.water);
    if (off) {
      offWaters.add(s.water);
      skips.offStations += 1;
    }
    const tier1 = TIER1_RIVER.has(id) || TIER1_LAKE.has(id);
    const { step, minutes } = stepOf(id);
    for (const [quantity, present] of [
      ['H', s.hasW],
      ['Q', s.hasQ],
    ] as const) {
      if (!present) continue;
      const h = quantity === 'H';
      const unit: NativeUnit = h ? 'm' : 'm³/s';
      ch1.push({
        id: `ch.bafu.${id}`,
        source: 'CH-1',
        provider_code: id,
        provider_key: `${id}/${h ? 'W' : 'Q'}`,
        name: s.name,
        water_name: s.water,
        country: 'CH',
        lon: s.lon,
        lat: s.lat,
        quantity,
        tier: tier1 ? 1 : 2,
        role: 'primary',
        river: null,
        km: null,
        flags: s.lake ? { tidal: null, impounded: null, lake: true } : { tidal: null, impounded: null },
        native_unit: unit,
        to_canonical: TO_CANONICAL[unit],
        value_kind: h ? (s.relative ? 'stage' : 'level') : null,
        native_step: step,
        expected_step: step,
        staleness_limit: staleness(minutes),
        // BAFU's danger levels (`dl` 1-5); a station whose latest observation says cube:Undefined has none.
        expected_threshold_source: s.dangerLevels ? 'CH-1' : null,
        expected_forecast_source: forecast.has(id) ? 'CH-4' : null,
        licence_gate: 'open',
        first_release: tier1,
        audience: off ? 'off' : 'public',
        datum: h ? (s.relative ? 'LOCAL' : 'LN02') : null,
        gauge_zero: [],
      });
    }
  }
  skips.offWaters = [...offWaters].sort(byCode);

  // CH-2: a twin per sensor of every feature, on the same id as its CH-1 station. Where CH-1 has a W series, the unit
  // text of the level must agree with it (level or stage). A feature that is no CH-1 station takes the audience of its
  // own water body and has no coordinates (the feed gives them in the Swiss grid).
  const twins: PublicStation[] = [];
  for (const key of [...ch2.keys()].sort(byCode)) {
    const f = ch2.get(key);
    if (f === undefined) continue;
    const s = stations.get(key);
    if (s === undefined) skips.ch2Only.push(key);
    const at = `ch-2 feature ${key}`;
    const { step, minutes } = stepOf(key);
    const lake = s === undefined ? f.kind === 'lake' : s.lake;
    const common: Omit<
      PublicStation,
      'provider_key' | 'quantity' | 'native_unit' | 'to_canonical' | 'value_kind' | 'datum'
    > = {
      id: `ch.bafu-pq.${key}`,
      source: 'CH-2',
      provider_code: key,
      name: f.label,
      water_name: f.water,
      country: 'CH',
      lon: s?.lon ?? null,
      lat: s?.lat ?? null,
      tier: 2,
      role: 'twin',
      river: null,
      km: null,
      flags: lake ? { tidal: null, impounded: null, lake: true } : { tidal: null, impounded: null },
      native_step: step,
      expected_step: step,
      staleness_limit: staleness(minutes),
      expected_threshold_source: null,
      expected_forecast_source: null,
      licence_gate: 'open',
      first_release: false,
      audience: NON_RHINE.has(s?.water ?? f.water ?? '') ? 'off' : 'public',
      gauge_zero: [],
    };
    if (f.level !== null) {
      const rule = LEVEL_UNITS.get(f.level);
      if (rule === undefined) throw new Error(`${at}: unknown level unit "${f.level}"`);
      if (s?.hasW && rule.kind !== (s.relative ? 'stage' : 'level')) {
        throw new Error(`${at}: the level unit says ${rule.kind}, CH-1 says ${s.relative ? 'stage' : 'level'}`);
      }
      twins.push({
        ...common,
        provider_key: `${key}/W`,
        quantity: 'H',
        native_unit: 'm',
        to_canonical: TO_CANONICAL.m,
        value_kind: rule.kind,
        datum: rule.datum,
      });
    }
    const discharge = f.discharge === null ? undefined : DISCHARGE_UNITS.get(f.discharge);
    if (discharge !== undefined) {
      twins.push({
        ...common,
        provider_key: `${key}/Q`,
        quantity: 'Q',
        native_unit: discharge,
        to_canonical: TO_CANONICAL[discharge],
        value_kind: null,
        datum: null,
      });
    }
  }
  // H before Q on the same key (the loop pushes H first).

  // Duplicates, unit declarations and the schema; the test repeats this against the real sources.yaml.
  const sources = [
    { id: 'CH-1', audience: 'public' },
    { id: 'CH-2', audience: 'public' },
    { id: 'CH-4', audience: 'public' },
  ] as const;
  for (const [name, rows] of [
    ['CH-1', ch1],
    ['CH-2', twins],
  ] as const) {
    const { problems } = validateStations({ stations: rows }, sources);
    if (problems.length > 0)
      throw new Error(`the generated ${name} rows fail validateStations:\n${problems.join('\n')}`);
  }
  return { ch1, ch2: twins, skips };
}

function header(inputs: Inputs, file: 'CH-1' | 'CH-2', skips: Skips): string {
  const files = inputs.files.map((f) => `#   ${f.path}  sha256 ${f.sha256}`);
  const lines =
    file === 'CH-1'
      ? [
          '# CH-1 station registry (BAFU hydrodata on LINDAS): one row per station and series (W is H, Q is Q).',
          '# GENERATED by scripts/gen-ch1-stations.ts from the inputs below. Do not edit by hand: change the generator (or an',
          '# input) and run `node scripts/gen-ch1-stations.ts`; registry/seed/ch-1-steps.csv comes from a day of payloads',
          '# through `node scripts/gen-ch1-stations.ts --steps <file>` (its first line names the day).',
        ]
      : [
          '# CH-2 station registry (BAFU hydrodata map GeoJSON): the twins of the CH-1 series of the same station id.',
          '# GENERATED by scripts/gen-ch1-stations.ts from the inputs below, together with registry/stations/ch-1.yaml. Do not',
          '# edit by hand: change the generator (or an input) and run `node scripts/gen-ch1-stations.ts`.',
        ];
  return [
    ...lines,
    ...files,
    ...(file === 'CH-1'
      ? [
          '# provider_key = <id>/<W|Q>. H is m (x100): an LN02 level (value_kind level), except a relative gauge (a W below',
          `# ${RELATIVE_BELOW_M} m): stage, datum LOCAL. Q is m³/s. name and coordinates come from the latest observation of the`,
          '# station in the cube (a station may appear twice); water_name is the percent-decoded last segment of its water IRI.',
          '# tier 1 (first_release) = all 17 stations of the catalogue §3.1 Swiss table, bold or not (FR-1 takes only the bold codes',
          '# of §3.1-§3.4); the Bodensee 2032 and 2043 are in the lake cube.',
          '# expected_threshold_source CH-1 = BAFU danger levels (dl 1-5) in the latest observation, none when it says cube:Undefined;',
          '# expected_forecast_source CH-4 = the stations of registry/seed/ch-4.csv. native_step = expected_step = the station step',
          `# (registry/seed/ch-1-steps.csv; ${DEFAULT_STEP} without an entry); staleness_limit = max(3 x step, PT1H).`,
          '# Scope (owner decision Q2): the Rhine basin is public; a station on a non-Rhine water body is audience off. That is a',
          '# scope decision for the NL-bound site, not a licence gate (licence_gate stays open).',
          ...comment(`off: ${skips.offStations} stations on ${skips.offWaters.join(', ')}.`),
          '# The lake cube stations (Bodensee 2032 and 2043 among them) carry flags.lake true; their W is the lake level.',
          ...comment(
            `stations without a W or Q value in the recording (not registered): ${skips.noSeries.join(', ') || 'none'}.`,
          ),
        ]
      : [
          '# role twin, tier 2, never published: a Q twin for every feature with a discharge sensor, an H twin for every one with a',
          '# level sensor, whatever its metric says. name = the CH-2 label, water_name = its hydro_body_name; coordinates, country,',
          '# audience and step come from the CH-1 station of the same id. Q is m³/s or l/s (x0.001), as the sensor string says; H is m:',
          '# an LN02 level when the unit text is "m ü.M.", a stage (datum LOCAL) when it is "m", and it agrees with the CH-1 W series',
          '# where CH-1 has one.',
          ...comment(
            `CH-2 keys that are no CH-1 station (audience from their own water body, no coordinates): ${skips.ch2Only.join(', ') || 'none'}.`,
          ),
        ]),
    '',
  ].join('\n');
}

/**
 * The YAML texts of the two station files for the inputs. Pure: the same input gives byte-identical
 * output.
 */
export function generate(inputs: Inputs): { ch1: string; ch2: string } {
  const { ch1, ch2, skips } = build(inputs);
  // YAML 1.1 rules quote what a 1.1 reader would misread: numeric codes, dates, "off"/"no"/"on".
  const dump = (rows: PublicStation[]) => stringify({ stations: rows }, { version: '1.1', lineWidth: 0 });
  return { ch1: header(inputs, 'CH-1', skips) + dump(ch1), ch2: header(inputs, 'CH-2', skips) + dump(ch2) };
}

/** The inputs: the cubes, the CH-2 GeoJSON, the forecast stations and the optional steps table, with their sha256. */
export function readInputs(): Inputs {
  const files: Inputs['files'] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    files.push({ path, sha256: sha256Of(bytes) });
    return bytes.toString('utf8');
  };
  const river = read(RIVER_FIXTURE);
  const lake = read(LAKE_FIXTURE);
  const ch2 = JSON.parse(read(CH2_FIXTURE)) as unknown;
  read('registry/seed/ch-4.csv');
  const hasSteps = existsSync(STEPS_CSV);
  if (hasSteps) read('registry/seed/ch-1-steps.csv');
  return {
    files,
    river,
    lake,
    ch2,
    ch4: readSeed(REGISTRY_DIR, 'ch-4'),
    steps: hasSteps ? readSeed(REGISTRY_DIR, 'ch-1-steps') : null,
  };
}

if (import.meta.main) {
  const [flag, path, ...rest] = process.argv.slice(2);
  if (flag === '--steps' && path !== undefined && rest.length === 0) {
    const text = deriveStepsFile(path);
    writeFileSync(STEPS_CSV, text);
    const rows = text.split('\n').filter((l) => /^\d+,PT/.test(l)).length;
    console.log(`wrote ${STEPS_CSV}: ${rows} stations from ${basename(path)}`);
  } else if (flag === undefined) {
    const { ch1, ch2 } = generate(readInputs());
    writeFileSync(OUTPUT_CH1, ch1);
    writeFileSync(OUTPUT_CH2, ch2);
    const count = (text: string) => text.split('\n').filter((line) => line.startsWith('  - id: ')).length;
    console.log(`wrote ${OUTPUT_CH1}: ${count(ch1)} rows, ${OUTPUT_CH2}: ${count(ch2)} rows`);
  } else {
    console.error('usage: node scripts/gen-ch1-stations.ts [--steps <file.csv | file.csv.gz>]');
    process.exit(64);
  }
}
