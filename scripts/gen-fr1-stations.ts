// Generates registry/stations/fr-1.yaml (the FR-1 station registry, Hub'Eau hydrométrie) and
// registry/stations/fr-3.yaml (the FR-3 Vigicrues twins of the key stations) from the recorded
// Hub'Eau referentiel fixtures (names, coordinates, country by commune), the series list
// registry/seed/fr-1-series.csv, the 18 Belgian partners (registry/seed/fr-1-be.csv) and the
// FR-3 key stations (registry/seed/fr-3.csv). Deterministic: the same input gives the same
// bytes; the output holds no timestamp of its own, and every derived value is stated in the
// row, none is inferred at read time. One file per source, because FR-1 and FR-3 share their
// provider keys (<code_station>/<H|Q>: FR-3 gap-fills the FR-1 series of the same key) and the
// loader maps one file to one source.
//
//   node scripts/gen-fr1-stations.ts
//   node scripts/gen-fr1-stations.ts --series <file.tsv | file.tsv.gz | page.json>...
//
// The second form derives registry/seed/fr-1-series.csv from one or more recordings of the
// observations: lines `code_station<TAB>grandeur(H|Q)<TAB>date_obs(ISO, Z)`, or FR-1 observation
// pages as JSON (the recorded fixtures; rows with a null code_station are skipped). The native step
// of each series is the modal gap between its consecutive timestamps over all recordings. The
// default form reads only committed inputs.
//
// Fails loudly on anything it does not know: a series whose station is not in the referentiel,
// a foreign station that is neither a partner nor a curated mirror, a tier-1 code without a
// series (unless it is in NOT_LIVE), a step outside the allowed set, a name that breaks the
// station label rule. Fixture text is data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import { REGISTRY_DIR, readSeed } from '../apps/server/src/capture/specs.ts';
import { type PublicStation, validateStations } from '../packages/contracts/src/stations.ts';
import { type NativeUnit, TO_CANONICAL } from '../packages/contracts/src/units.ts';

const root = join(import.meta.dirname, '..');
export const FIXTURE_DIR = 'apps/server/src/adapters/fr-1/fixtures';
export const OUTPUT_FR1 = join(root, 'registry/stations/fr-1.yaml');
export const OUTPUT_FR3 = join(root, 'registry/stations/fr-3.yaml');
export const SERIES_CSV = join(root, 'registry/seed/fr-1-series.csv');
/** The referentiel calls of the recorder (P1a): one fixture per code_station prefix. */
const REF_SUFFIXES = ['', '-B', '-D', '-E1', '-E2', '-E3'] as const;

/** The steps a Hub'Eau series may have (minutes → ISO duration). Any other modal gap is an error. */
const STEPS = new Map([
  [5, 'PT5M'],
  [6, 'PT6M'],
  [10, 'PT10M'],
  [12, 'PT12M'],
  [15, 'PT15M'],
  [20, 'PT20M'],
  [30, 'PT30M'],
  [60, 'PT1H'],
]);
const STEP_MINUTES = new Map([...STEPS].map(([minutes, iso]) => [iso, minutes]));
/** A series with no gap to measure (one observation, or none within an hour of the next): the step of the slowest senders. */
const ONE_POINT_STEP = 'PT1H';
const SLOWEST_STEP_MS = 60 * 60_000;
/** Fewer points than this is a sparse series: an unknown modal gap there is no step (see deriveSeries). */
const SPARSE = 12;

/**
 * The bold stations of catalogue §3.1–§3.4 (tier 1, first release): every row of them is tier 1.
 * Each needs a series in fr-1-series.csv, or an entry of NOT_LIVE.
 */
const TIER1 = new Set([
  'A061005051', // Rhin à Strasbourg
  'A228003001',
  'A302009050', // Rhin à Lauterbourg
  'A443064001', // Moselle à Épinal
  'A573061001', // Moselle à Toul
  'A692101001',
  'A701061001',
  'A743061001', // Moselle à Metz
  'A793061002',
  'A850061001', // Moselle à Uckange
  'A920107050',
  'A930108040',
  'B222001001',
  'B315002001', // Meuse à Stenay
  'B402101001',
  'B403101001',
  'B460101001',
  'B463101001',
  'B466010101',
  'B502001001', // Meuse à Sedan
  'B540001001', // Meuse à Charleville-Mézières
  'B611101001', // Semoy à Haulmé
  'B700001002',
  'B720000001', // Meuse à Chooz
  'D016221001',
  'D019801101',
  'D019223001', // Sambre à Marpent
  'E131000202',
  'E171551101',
  'E172751201',
  'E201000501', // Scarpe, Anzin-Saint-Aubin
  'E223000101', // Scarpe, Courchelettes
  'E207111003', // Scarpe, Brebières (VNF)
  'E237110501', // Scarpe, Mortagne-du-Nord
  'E240041101', // Escaut à Maulde
  'E364121002',
  'E364121001',
  'E367125002',
  'E381126501', // Lys à Bousbecque
]);

/**
 * Tier-1 stations with no series in the recorded input, with the reason. A tier-1 code that has a
 * series but is listed here fails: take it out of the table and register it. Empty since the day
 * export (a whole UTC day of live runs): every tier-1 station has a series.
 */
const NOT_LIVE = new Map<string, string>();

/** The stations of the Vigicrues forecast list (§3 "F"): the FR-4 forecasts of their series. */
const FORECAST = new Set([
  'A443064001',
  'A573061001',
  'A701061001',
  'A850061001',
  'B315002001',
  'B466010101',
  'B502001001',
  'B540001001',
  'B611101001',
  'D019801101',
]);

type Mirror = { source: 'CH-1' | 'DE-1'; code: string; country: PublicStation['country']; name: string };
/**
 * Gauges that another agency operates, which Hub'Eau republishes: role mirror, tier 2, never published.
 * Each names its primary by source and code (the registry test checks that row exists). Hanweiler
 * (decision D-e): WSV operates it on the federal Saar, DE-1 is public and tier 1 with a DHHN zero,
 * while the zero of Hub'Eau is off by +1.57 m (catalogue §4.1).
 */
export const MIRRORS = new Map<string, Mirror>([
  ['A021005050', { source: 'CH-1', code: '2289', country: 'CH', name: 'Basel' }],
  ['A040000101', { source: 'DE-1', code: '23300320', country: 'DE', name: 'Breisach' }],
  ['A060005050', { source: 'DE-1', code: '23300900', country: 'DE', name: 'Kehl' }],
  ['A355005050', { source: 'DE-1', code: '23500700', country: 'DE', name: 'Plittersdorf' }],
  ['A375005050', { source: 'DE-1', code: '23700200', country: 'DE', name: 'Maxau' }],
  ['A940000101', { source: 'DE-1', code: '26400100', country: 'DE', name: 'Hanweiler' }],
]);

/**
 * Stations that deliver no data (catalogue §3.4 pitfall 9) or do not drain to the Netherlands: never
 * registered, even when a series shows up. The Yser at Roesbrugge is outside the recorded code_entite
 * prefixes (E7…), so no referentiel row and no series ever reach the generator.
 */
const EXCLUDED = new Map([
  ['E240041201', 'Escaut at Tournai: no data in observations_tr or obs_elab (catalogue §3.4)'],
  ['D021000101', 'Sambre at Solre-Erquelinnes: no data in observations_tr or obs_elab (catalogue §3.4)'],
]);

/**
 * Foreign stations that Hub'Eau relays but that are no partner and no mirror of a registered primary:
 * registered tier 2, audience off (a narrowing needs no permission record), so that the loader knows
 * their series (stored nowhere, never counted unknown) and the pruner is not held back.
 */
const FOREIGN_OFF = new Map([
  [
    'A060005051',
    'Kehl-Kronenhof, station à pente mère: a slope station of the Kehl gauge, its own zero (sys 0, -0.509)',
  ],
  ['A937203050', 'Blies at Blieskastel (Saarland): a German gauge, not in the catalogue'],
  ['A937204050', 'Blies at Reinheim (Saarland): a German gauge, not in the catalogue'],
]);

/** INSEE codes of foreign countries (99…): the stations "en Belgique", "en Allemagne" and "en Suisse". */
const FOREIGN_COUNTRY = new Map<string, PublicStation['country']>([
  ['99131', 'BE'],
  ['99109', 'DE'],
  ['99140', 'CH'],
]);
const PARTNER_COMMUNE = '99131';

/** Max(3 × step, 90 min): Hub'Eau stations transmit hourly (latency 15-75 min), partners every hour. */
const staleness = (minutes: number) => {
  const limit = Math.max(3 * minutes, 90);
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
function num(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${at}: expected a finite number`);
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
const field = (row: Seed, name: string, at: string) => str(row[name], `${at}.${name}`);

/** Code-unit order (never locale). */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// --series: the series list from a recording

const CODE = /^[A-Z][0-9A-Z]{9}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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

/** One input of `--series`: its name and sha256 (the CSV header names both) and its text. */
export type Recording = { name: string; sha256: string; text: string };

/**
 * The observations of one recording into `times` (series key → distinct timestamps, ms). A recording is a TSV
 * (lines `code_station<TAB>H|Q<TAB>date_obs`) or an FR-1 observation page (JSON `{data: [...]}`, rows with a null
 * `code_station`, the site-level series, skipped).
 */
function readObservations(rec: Recording, times: Map<string, Set<number>>): void {
  const where = `series input ${rec.name}`;
  const add = (code: unknown, quantity: unknown, instant: unknown, at: string) => {
    if (
      typeof code !== 'string' ||
      !CODE.test(code) ||
      (quantity !== 'H' && quantity !== 'Q') ||
      typeof instant !== 'string' ||
      !INSTANT.test(instant) ||
      !Number.isFinite(Date.parse(instant))
    ) {
      throw new Error(`${at}: expected a code_station, H or Q and an instant YYYY-MM-DDTHH:MM:SSZ`);
    }
    const key = `${code}\t${quantity}`;
    times.set(key, (times.get(key) ?? new Set<number>()).add(Date.parse(instant)));
  };
  if (rec.text.trimStart().startsWith('{')) {
    let page: unknown;
    try {
      page = JSON.parse(rec.text);
    } catch {
      throw new Error(`${where}: not JSON`);
    }
    for (const [i, raw] of arr(obj(page, where).data, `${where}.data`).entries()) {
      const row = obj(raw, `${where}.data[${i}]`);
      if (row.code_station !== null) add(row.code_station, row.grandeur_hydro, row.date_obs, `${where}.data[${i}]`);
    }
    return;
  }
  const lines = rec.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [i, line] of lines.entries()) {
    const [code, quantity, instant, ...rest] = line.split('\t');
    if (rest.length > 0) throw new Error(`${where} line ${i + 1}: more than three fields`);
    add(code, quantity, instant, `${where} line ${i + 1}`);
  }
}

/**
 * The CSV text of registry/seed/fr-1-series.csv for one or more recordings. The native step of a series is the
 * modal gap between its consecutive distinct timestamps, over the union of the recordings, leaving out the gaps above
 * an hour (a tie takes the smaller gap); a series with no gap left (one point, or its points far apart) gets PT1H and
 * is listed in the header, and so does a sparse series (fewer than SPARSE points) whose modal gap is no known step
 * (an irregular, event-driven series such as A664031003 H: six off-grid points in a day). A dense series with an
 * unknown step still fails. One header line names each recording and its sha256.
 */
export function deriveSeries(recordings: Recording[]): string {
  const times = new Map<string, Set<number>>();
  for (const rec of recordings) readObservations(rec, times);
  if (times.size === 0) throw new Error('series input: no observation');

  const rows: { code: string; quantity: string; step: string; points: number }[] = [];
  const onePoint: string[] = [];
  const outside: string[] = [];
  for (const [key, set] of [...times].sort(([a], [b]) => byCode(a, b))) {
    const [code = '', quantity = ''] = key.split('\t');
    const sorted = [...set].sort((a, b) => a - b);
    let step = ONE_POINT_STEP;
    const sparse = sorted.length < SPARSE;
    // A gap above the slowest step is an outage or the space between two recordings, not a step.
    const counts = new Map<number, number>();
    for (let j = 1; j < sorted.length; j++) {
      const gap = (sorted[j] ?? 0) - (sorted[j - 1] ?? 0);
      if (gap <= SLOWEST_STEP_MS) counts.set(gap, (counts.get(gap) ?? 0) + 1);
    }
    if (counts.size === 0) onePoint.push(`${code}/${quantity}`);
    else {
      // The most frequent gap; on a tie the smaller one.
      const [modal = 0] = [...counts].sort(([ga, na], [gb, nb]) => nb - na || ga - gb)[0] ?? [];
      const iso = Number.isInteger(modal / 60_000) ? STEPS.get(modal / 60_000) : undefined;
      if (iso !== undefined) step = iso;
      else if (sparse) onePoint.push(`${code}/${quantity}`);
      else outside.push(`${code}/${quantity} (${modal / 60_000} min)`);
    }
    rows.push({ code, quantity, step, points: sorted.length });
  }
  if (outside.length > 0) {
    throw new Error(`series with a step outside ${[...STEPS.values()].join(', ')}: ${outside.join(', ')}`);
  }
  rows.sort((a, b) => byCode(a.code, b.code) || byCode(a.quantity, b.quantity));
  return [
    ...recordings.map((r) => `# derived by scripts/gen-fr1-stations.ts --series from ${r.name} sha256 ${r.sha256}`),
    ...(onePoint.length > 0
      ? comment(
          `step ${ONE_POINT_STEP} by rule (one point, no gap of an hour or less, or fewer than ${SPARSE} irregular points): ${onePoint.join(', ')}`,
          '#',
          '#  ',
        )
      : []),
    'code_station,quantity,native_step,points',
    ...rows.map((r) => `${r.code},${r.quantity},${r.step},${r.points}`),
    '',
  ].join('\n');
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Reads the recordings (plain or gzip, told by the magic bytes) and returns the series CSV. */
export function deriveSeriesFiles(paths: string[]): string {
  return deriveSeries(
    paths.map((path) => {
      const bytes = readFileSync(path);
      const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
      const text = (gzip ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes).toString('utf8');
      return { name: basename(path), sha256: sha256Of(bytes), text };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The registry files

export type Inputs = ReturnType<typeof readInputs>;

type RefStation = {
  code: string;
  name: string;
  water: string | null;
  lon: number;
  lat: number;
  commune: string;
};

function readRef(payloads: unknown[]): Map<string, RefStation> {
  const out = new Map<string, RefStation>();
  for (const [p, payload] of payloads.entries()) {
    for (const [i, raw] of arr(obj(payload, `referentiel ${p}`).data, `referentiel ${p}.data`).entries()) {
      const s = obj(raw, `referentiel ${p}.data[${i}]`);
      const code = str(s.code_station, `referentiel ${p}.data[${i}].code_station`);
      const at = `referentiel ${code}`;
      if (out.has(code)) throw new Error(`${at}: duplicate station`);
      out.set(code, {
        code,
        name: label(s.libelle_station, `${at}.libelle_station`),
        water: s.libelle_cours_eau === null ? null : label(s.libelle_cours_eau, `${at}.libelle_cours_eau`),
        lon: num(s.longitude_station, `${at}.longitude_station`),
        lat: num(s.latitude_station, `${at}.latitude_station`),
        commune: str(s.code_commune_station, `${at}.code_commune_station`),
      });
    }
  }
  return out;
}

type Series = { code: string; quantity: 'H' | 'Q'; step: string; minutes: number; points: number };

function readSeries(rows: Seed[]): Series[] {
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const at = `fr-1-series.csv row ${i + 1}`;
    const code = field(r, 'code_station', at);
    const quantity = field(r, 'quantity', at);
    if (quantity !== 'H' && quantity !== 'Q') throw new Error(`${at}: unknown quantity "${quantity}"`);
    const step = field(r, 'native_step', at);
    const minutes = STEP_MINUTES.get(step);
    if (minutes === undefined)
      throw new Error(`${at}: ${code}/${quantity} has the step "${step}", outside the allowed set`);
    const points = Number(field(r, 'points', at));
    if (!Number.isInteger(points) || points < 1) throw new Error(`${at}: points is not a positive integer`);
    if (seen.has(`${code}/${quantity}`)) throw new Error(`${at}: duplicate series ${code}/${quantity}`);
    seen.add(`${code}/${quantity}`);
    return { code, quantity, step, minutes, points };
  });
}

type Skips = {
  excluded: string[];
  notLive: string[];
  off: string[];
  partnersWithoutSeries: string[];
  mirrorsWithoutSeries: string[];
};

function build(inputs: Inputs): { fr1: PublicStation[]; fr3: PublicStation[]; skips: Skips } {
  const ref = readRef(inputs.ref);
  const series = readSeries(inputs.series);
  const partners = new Set(inputs.partners.map((r, i) => field(r, 'code_station', `fr-1-be.csv row ${i + 1}`)));
  const fr3Codes = inputs.fr3.map((r, i) => field(r, 'code', `fr-3.csv row ${i + 1}`));

  // The curated tables must not overlap, and every entry must be in the referentiel.
  const tableOf = new Map<string, string>();
  for (const [table, codes] of [
    ['mirror', [...MIRRORS.keys()]],
    ['excluded', [...EXCLUDED.keys()]],
    ['foreign off', [...FOREIGN_OFF.keys()]],
    ['partner', [...partners]],
    ['tier-1', [...TIER1]],
  ] as const) {
    for (const code of codes) {
      if (!ref.has(code)) throw new Error(`${table} station ${code} is not in the referentiel fixtures`);
      const other = tableOf.get(code);
      if (other !== undefined) throw new Error(`station ${code} is in the ${other} table and the ${table} table`);
      tableOf.set(code, table);
    }
  }
  for (const code of FORECAST) if (!TIER1.has(code)) throw new Error(`forecast station ${code} is not tier 1`);
  for (const code of NOT_LIVE.keys()) if (!TIER1.has(code)) throw new Error(`NOT_LIVE ${code} is not a tier-1 station`);
  for (const [code, mirror] of MIRRORS) {
    const found = ref.get(code);
    if (found !== undefined && FOREIGN_COUNTRY.get(found.commune) !== mirror.country) {
      throw new Error(`mirror ${code}: commune ${found.commune} is not in ${mirror.country}`);
    }
  }
  for (const code of partners) {
    if (ref.get(code)?.commune !== PARTNER_COMMUNE) {
      throw new Error(`partner ${code}: the commune is not ${PARTNER_COMMUNE} (Belgium)`);
    }
  }

  const byStation = new Map<string, Series[]>();
  for (const s of series) {
    if (!ref.has(s.code))
      throw new Error(`series ${s.code}/${s.quantity}: the station is not in the referentiel fixtures`);
    byStation.set(s.code, [...(byStation.get(s.code) ?? []), s]);
  }
  for (const code of TIER1) {
    const live = byStation.has(code);
    if (NOT_LIVE.has(code)) {
      if (live) throw new Error(`tier-1 station ${code} is in NOT_LIVE but has a series: register it`);
    } else if (!live) {
      throw new Error(`tier-1 station ${code} has no series (add it to NOT_LIVE?)`);
    }
  }

  const skips: Skips = {
    excluded: [...EXCLUDED.keys()].sort(byCode),
    notLive: [...NOT_LIVE.keys()].sort(byCode),
    off: [],
    partnersWithoutSeries: [...partners].filter((c) => !byStation.has(c)).sort(byCode),
    mirrorsWithoutSeries: [...MIRRORS.keys()].filter((c) => !byStation.has(c)).sort(byCode),
  };

  const fr1: PublicStation[] = [];
  for (const code of [...byStation.keys()].sort(byCode)) {
    if (EXCLUDED.has(code)) continue;
    const station = ref.get(code);
    if (station === undefined) continue;
    const at = `station ${code}`;
    const foreign = station.commune.startsWith('99');
    const country = foreign ? FOREIGN_COUNTRY.get(station.commune) : 'FR';
    const partner = partners.has(code);
    const mirror = MIRRORS.get(code);
    const off = FOREIGN_OFF.has(code);
    if (country === undefined) throw new Error(`${at}: unknown foreign commune ${station.commune}`);
    if (foreign && !partner && mirror === undefined && !off) {
      throw new Error(
        `${at}: a foreign (99…) station that is neither a partner nor a curated mirror (commune ${station.commune})`,
      );
    }
    if (off) skips.off.push(code);
    const tier1 = TIER1.has(code);
    for (const s of (byStation.get(code) ?? []).sort((a, b) => byCode(a.quantity, b.quantity))) {
      const h = s.quantity === 'H';
      const unit: NativeUnit = h ? 'mm' : 'l/s';
      fr1.push({
        id: `fr.sandre.${code}`,
        source: 'FR-1',
        provider_code: code,
        provider_key: `${code}/${s.quantity}`,
        name: station.name,
        water_name: station.water,
        country,
        lon: station.lon,
        lat: station.lat,
        quantity: s.quantity,
        tier: tier1 ? 1 : 2,
        role: mirror === undefined ? 'primary' : 'mirror',
        river: null,
        km: null,
        flags: { tidal: null, impounded: null },
        native_unit: unit,
        to_canonical: TO_CANONICAL[unit],
        value_kind: h ? 'stage' : null,
        native_step: s.step,
        expected_step: s.step,
        staleness_limit: staleness(s.minutes),
        expected_threshold_source: null,
        expected_forecast_source: FORECAST.has(code) ? 'FR-4' : null,
        licence_gate: 'open',
        first_release: tier1,
        audience: off ? 'off' : 'public',
        // The zero of an FR-1 gauge comes from the referentiel (the loader stores it, flagged untrusted by its datum).
        datum: h ? 'LOCAL' : null,
        gauge_zero: [],
      });
    }
  }

  // FR-3: the twin of each FR-1 series of a key station, on the same key (the gap-fill grid is the FR-1 step).
  const fr3: PublicStation[] = [];
  for (const code of [...fr3Codes].sort(byCode)) {
    const rows = fr1.filter((r) => r.provider_code === code);
    if (rows.length === 0) throw new Error(`fr-3.csv station ${code} is not registered by FR-1`);
    for (const r of rows) {
      const h = r.quantity === 'H';
      const unit: NativeUnit = h ? 'm' : 'm³/s';
      fr3.push({
        ...r,
        id: `fr.vigicrues.${code}`,
        source: 'FR-3',
        tier: 2,
        role: 'twin',
        native_unit: unit,
        to_canonical: TO_CANONICAL[unit],
        staleness_limit: 'PT12H',
        expected_threshold_source: null,
        expected_forecast_source: null,
        first_release: false,
      });
    }
  }

  // Duplicates, unit declarations and the schema; the test repeats this against the real sources.yaml.
  const sources = [
    { id: 'FR-1', audience: 'public' },
    { id: 'FR-3', audience: 'public' },
    { id: 'FR-4', audience: 'public' },
  ] as const;
  for (const [name, rows] of [
    ['FR-1', fr1],
    ['FR-3', fr3],
  ] as const) {
    const { problems } = validateStations({ stations: rows }, sources);
    if (problems.length > 0)
      throw new Error(`the generated ${name} rows fail validateStations:\n${problems.join('\n')}`);
  }
  return { fr1, fr3, skips };
}

function header(inputs: Inputs, file: 'FR-1' | 'FR-3', skips: Skips): string {
  const files = inputs.files.map((f) => `#   ${f.path}  sha256 ${f.sha256}`);
  const lines =
    file === 'FR-1'
      ? [
          "# FR-1 station registry (Hub'Eau hydrométrie, Sandre station codes): one row per station and series (H and Q).",
          '# GENERATED by scripts/gen-fr1-stations.ts from the inputs below. Do not edit by hand: change the generator (or an',
          '# input) and run `node scripts/gen-fr1-stations.ts`; registry/seed/fr-1-series.csv comes from a recording of the',
          '# observations through `node scripts/gen-fr1-stations.ts --series <file>` (its first line names the recording).',
        ]
      : [
          '# FR-3 station registry (Vigicrues): the twins of the FR-1 series of the 15 key stations of registry/seed/fr-3.csv.',
          '# GENERATED by scripts/gen-fr1-stations.ts from the inputs below, together with registry/stations/fr-1.yaml. Do not',
          '# edit by hand: change the generator (or an input) and run `node scripts/gen-fr1-stations.ts`.',
        ];
  return [
    ...lines,
    ...files,
    ...(file === 'FR-1'
      ? [
          '# provider_key = <code_station>/<H|Q>, the same key as the FR-3 twin (FR-3 gap-fills the FR-1 series). H is mm (x0.1,',
          '# stage, datum LOCAL: the gauge zero is read from the referentiel by the loader), Q is l/s (x0.001).',
          `# tier 1 (first_release) = the ${TIER1.size} bold stations of catalogue §3.1-§3.4; every other row is tier 2. native_step =`,
          '# expected_step = the modal gap of the series in the recording (PT1H for a series with one point); staleness_limit =',
          '# max(3 x step, PT90M). expected_forecast_source FR-4 = the Vigicrues forecast stations (§3 "F"); no thresholds.',
          '# country by commune: 99131 BE, 99109 DE, 99140 CH, otherwise FR. The 18 Belgian partners (registry/seed/fr-1-be.csv)',
          '# are primary rows, country BE (A§7.2 exception until a Belgian source is public, P13).',
          '# role mirror = a gauge another agency operates (never published), with its primary:',
          ...comment([...MIRRORS].map(([code, m]) => `${code} ${m.name} -> ${m.source} ${m.code}`).join(', ')),
          '# Not registered, or registered off:',
          ...comment(`excluded: ${skips.excluded.map((c) => `${c} (${EXCLUDED.get(c)})`).join('; ')}.`),
          ...comment(`tier-1 NOT_LIVE: ${skips.notLive.map((c) => `${c} (${NOT_LIVE.get(c)})`).join('; ') || 'none'}.`),
          ...comment(`foreign, audience off: ${skips.off.map((c) => `${c} (${FOREIGN_OFF.get(c)})`).join('; ')}.`),
          ...comment(
            `partners without a series in the recording: ${skips.partnersWithoutSeries.join(', ') || 'none'}.`,
          ),
          ...comment(`mirrors without a series in the recording: ${skips.mirrorsWithoutSeries.join(', ') || 'none'}.`),
        ]
      : [
          '# role twin, tier 2, never published. H is m (x100, stage, LOCAL), Q is m³/s; the step is the FR-1 step of the same',
          '# key (the gap-fill grid); staleness_limit PT12H. name, coordinates, country and audience are those of the FR-1 row.',
        ]),
    '',
  ].join('\n');
}

/**
 * The YAML texts of the two station files for the inputs. Pure: the same input gives byte-identical
 * output.
 */
export function generate(inputs: Inputs): { fr1: string; fr3: string } {
  const { fr1, fr3, skips } = build(inputs);
  // YAML 1.1 rules quote what a 1.1 reader would misread: numeric codes, dates, "off"/"no"/"on".
  const dump = (rows: PublicStation[]) => stringify({ stations: rows }, { version: '1.1', lineWidth: 0 });
  return {
    fr1: header(inputs, 'FR-1', skips) + dump(fr1),
    fr3: header(inputs, 'FR-3', skips) + dump(fr3),
  };
}

/** The inputs: the referentiel fixtures, the three seed lists and the sha256 of every file read. */
export function readInputs() {
  const files: { path: string; sha256: string }[] = [];
  const read = (path: string) => {
    const bytes = readFileSync(join(root, path));
    files.push({ path, sha256: sha256Of(bytes) });
    return bytes.toString('utf8');
  };
  const ref = REF_SUFFIXES.map((suffix) => JSON.parse(read(`${FIXTURE_DIR}/fr-1-ref${suffix}.raw`)) as unknown);
  for (const name of ['fr-1-series', 'fr-1-be', 'fr-3']) read(`registry/seed/${name}.csv`);
  return {
    files,
    ref,
    series: readSeed(REGISTRY_DIR, 'fr-1-series'),
    partners: readSeed(REGISTRY_DIR, 'fr-1-be'),
    fr3: readSeed(REGISTRY_DIR, 'fr-3'),
  };
}

if (import.meta.main) {
  const [flag, ...paths] = process.argv.slice(2);
  if (flag === '--series' && paths.length > 0) {
    const text = deriveSeriesFiles(paths);
    writeFileSync(SERIES_CSV, text);
    const rows = text.split('\n').filter((l) => /^[A-Z]\d{9},/.test(l)).length;
    console.log(`wrote ${SERIES_CSV}: ${rows} series from ${paths.map((p) => basename(p)).join(', ')}`);
  } else if (flag === undefined) {
    const inputs = readInputs();
    const { fr1, fr3 } = generate(inputs);
    writeFileSync(OUTPUT_FR1, fr1);
    writeFileSync(OUTPUT_FR3, fr3);
    const count = (text: string) => text.split('\n').filter((line) => line.startsWith('  - id: ')).length;
    console.log(`wrote ${OUTPUT_FR1}: ${count(fr1)} rows, ${OUTPUT_FR3}: ${count(fr3)} rows`);
  } else {
    console.error('usage: node scripts/gen-fr1-stations.ts [--series <file.tsv | file.tsv.gz | page.json>...]');
    process.exit(64);
  }
}
