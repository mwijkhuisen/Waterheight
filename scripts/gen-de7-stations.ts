// Generates registry/stations/de-7.yaml (the DE-7 station registry: LANUK NRW, Hochwasserportal.NRW downloads)
// from the recorded `messwerte.txt` (which gauges deliver, and at what step), the recorded OpenHygon station file of
// DE-8 (names, WGS84 coordinates, whether LANUK states warning levels) and the recorded hydro station file of DE-8
// (the gauge zero `Nullpunkt` and the operator `Betreiber`). Deterministic: the same input gives the same bytes;
// the output holds no timestamp of its own, and every derived value is stated in the row, none is inferred at read
// time.
//
//   node scripts/gen-de7-stations.ts
//
// The inputs are read through the adapters (the loader's own ZIP guard and the strict DE-7 and DE-8 parsers), never
// by a parser of its own. The registry must never hold a WSV gauge (site_no 102): messwerte.txt carries no site_no,
// so only registered series load (adapters/de-7/normalise.ts), and this generator fails on a DE-7 station that
// looks like a DE-1 one: the same number, a station within 300 m, or the same name (case and accents aside) on
// the same quantity. (LANUK numbers have 13 digits and WSV ones 7 or 8, so the number alone rarely meets; review
// L4 of P5b.) test/registry-precedence.test.ts holds the published registry to the same 300 m.
//
// Fails loudly on anything it does not know: a station in messwerte.txt that the station file does not list (the
// placeholders aside), a modal step other than PT5M or PT15M, a station that looks like a DE-1 one, a tier-1 gauge
// without data, a duplicate hydro or station row, a name that breaks the station label rule. Fixture text is data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { PLACEHOLDERS } from '../apps/server/src/adapters/de-7/normalise.ts';
import { lineSink } from '../apps/server/src/adapters/de-7/parse.ts';
import {
  HYDRO_MEMBER,
  type HydroRow,
  parseHydro,
  parseStations,
  STATIONS_HEADER,
  type Station,
} from '../apps/server/src/adapters/de-8/parse.ts';
import { checkZip, flatNames, lineSplitter } from '../apps/server/src/http/guards.ts';
import { type PublicStation, validateStations } from '../packages/contracts/src/stations.ts';
import { TO_CANONICAL } from '../packages/contracts/src/units.ts';
import { scanCsv } from '../packages/core/src/csv.ts';

const root = join(import.meta.dirname, '..');
export const MESSWERTE_FIXTURE = 'apps/server/src/adapters/de-7/fixtures/de-7-messwerte.raw';
export const STATIONS_FIXTURE = 'apps/server/src/adapters/de-8/fixtures/de-8-stations.raw';
export const HYDRO_FIXTURE = 'apps/server/src/adapters/de-8/fixtures/de-8-hydro.raw';
export const WATERS_CSV = 'registry/seed/de-7-waters.csv';
export const DE1_REGISTRY = 'registry/stations/de-1.yaml';
export const OUTPUT = join(root, 'registry/stations/de-7.yaml');

/** The member of `messwerte.zip` (the last 7 days; `pegel_messwerte.txt` is the 2-month seed). */
const MESSWERTE_MEMBER = 'messwerte.txt';
/** LANUK's own operator text in the hydro file; any other is a third-party gauge (an [U] item). */
const LANUK = 'LANUV, NRW';

/** The steps a DE-7 gauge may have (minutes → ISO duration). Any other modal gap fails the generator. */
const STEPS = new Map([
  [5, 'PT5M'],
  [15, 'PT15M'],
]);

/**
 * Tier 1 (first release): the bold codes of catalogue §3.1, §3.3, §3.5 and §3.6, plus the most downstream NRW gauge
 * of a listed river that has none in bold (Bocholter Aa, Ems, Vechte). Station number → name in the station file.
 */
const TIER1 = new Map([
  ['9284730000100', 'Ammeloe'],
  ['9281700000200', 'Isselburg'],
  ['9282570000100', 'Rhedebruegge'],
  ['2829100000100', 'Stah'],
  ['2849900000100', 'Landesgrenze'],
  ['2869500000200', 'Goch'],
  ['3190000000100', 'Haskenau'],
  ['9286190000100', 'Bilk'],
  ['9286455000200', 'Gronau'],
]);

type Obj = Record<string, unknown>;

/** Provider text as the registry takes it (the rule of the Label schema), checked here for a readable error. */
function label(s: string, at: string): string {
  if (s === '') throw new Error(`${at}: empty`);
  if (s.length > 200) throw new Error(`${at}: longer than 200 characters`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) throw new Error(`${at}: a control, format or line separator character`);
  return s;
}

/** A DE-7 station this close to a DE-1 one is taken for the same gauge (as test/registry-precedence.test.ts). */
export const NEAR_M = 300;

/** Metres between two WGS84 points (equirectangular; exact enough below a kilometre). */
function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  return 6_371_000 * Math.hypot(x, (b.lat - a.lat) * rad);
}

/** A name compared with case and accents aside (NFD without its combining marks, lower case). */
const nameKey = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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

export type Inputs = {
  /** Path, sha256 and `recorded_at` (from the fixture's .meta.json) of every fixture read. */
  files: { path: string; sha256: string; recorded_at: string }[];
  /** station_no → the distinct, ascending instants (ms) of its readings in messwerte.txt; placeholders included. */
  readings: Map<string, number[]>;
  /** The OpenHygon station file. */
  stations: Station[];
  /** Station number → LANUV_Info_1 (the first warning level) is stated. */
  warns: Map<string, boolean>;
  /** The hydro file (the rows of `NA` aside). */
  hydro: HydroRow[];
  /** Station number → the published water body (`WTO_OBJECT`; registry/seed/de-7-waters.csv). */
  waters: Map<string, string>;
  /** The rows of registry/stations/de-1.yaml (WSV gauges): code, name, quantity and WGS84 position. */
  de1: De1Row[];
};

export type De1Row = { code: string; name: string; quantity: string; lon: number | null; lat: number | null };

type Plan = {
  stations: PublicStation[];
  /** Master stations without readings (not registered). */
  silent: string[];
  /** Placeholder numbers found in the readings. */
  placeholders: string[];
  /** Registered stations whose hydro operator is not LANUK: number → operator. */
  thirdParty: [string, string][];
  /** Registered stations the hydro file does not list (operator unknown, no gauge zero). */
  noHydro: number;
};

/** The modal positive gap of ascending distinct instants, in minutes; a tie takes the smaller gap. */
function modalStep(times: readonly number[], at: string): string {
  const counts = new Map<number, number>();
  for (let j = 1; j < times.length; j++) {
    const gap = (times[j] ?? 0) - (times[j - 1] ?? 0);
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  const [gap = 0] = [...counts].sort(([ga, na], [gb, nb]) => nb - na || ga - gb)[0] ?? [];
  const minutes = gap / 60_000;
  const step = Number.isInteger(minutes) ? STEPS.get(minutes) : undefined;
  if (step === undefined) {
    throw new Error(
      `${at}: the modal step is ${gap === 0 ? 'unknown' : `${minutes} min`}, outside ${[...STEPS.values()].join(', ')}`,
    );
  }
  return step;
}

function build(inputs: Inputs): Plan {
  const master = new Map<string, Station>();
  for (const s of inputs.stations) {
    if (master.has(s.no)) throw new Error(`station file: ${s.no} twice`);
    master.set(s.no, s);
  }
  const hydro = new Map<string, HydroRow>();
  for (const h of inputs.hydro) {
    if (hydro.has(h.id)) throw new Error(`hydro file: ${h.id} twice`);
    hydro.set(h.id, h);
  }

  // The placeholders belong to no gauge (catalogue §2.3): never registered, whatever the files say.
  const placeholders = [...inputs.readings.keys()].filter((no) => PLACEHOLDERS.has(no)).sort(byCode);
  const delivering = [...inputs.readings.keys()].filter((no) => !PLACEHOLDERS.has(no)).sort(byCode);

  // WSV gauges never load from here: no DE-7 station may be a DE-1 one by its number, its place or its name.
  const de1Codes = new Set(inputs.de1.map((r) => r.code));
  const wsv = delivering.filter((no) => de1Codes.has(no));
  if (wsv.length > 0) throw new Error(`DE-7 station numbers that DE-1 registers (WSV gauges): ${wsv.join(', ')}`);
  const near: string[] = [];
  const named: string[] = [];
  for (const no of delivering) {
    const s = master.get(no);
    if (s === undefined) continue;
    for (const r of inputs.de1) {
      if (r.lon !== null && r.lat !== null && metres(s, { lon: r.lon, lat: r.lat }) <= NEAR_M) {
        near.push(`${no} (DE-1 ${r.code}, ${Math.round(metres(s, { lon: r.lon, lat: r.lat }))} m)`);
      }
      // A DE-7 series is H (W); a DE-1 station of that quantity and name is the same gauge.
      if (r.quantity === 'H' && nameKey(r.name) === nameKey(s.name)) named.push(`${no} (DE-1 ${r.code})`);
    }
  }
  if (near.length > 0) throw new Error(`DE-7 stations within ${NEAR_M} m of a DE-1 station: ${near.join(', ')}`);
  if (named.length > 0) throw new Error(`DE-7 stations named like a DE-1 station of H: ${named.join(', ')}`);

  for (const [no, name] of TIER1) {
    if (PLACEHOLDERS.has(no)) throw new Error(`tier-1 station ${no} is a placeholder`);
    const s = master.get(no);
    if (s === undefined) throw new Error(`tier-1 station ${no} is not in the station file`);
    if (s.name !== name) throw new Error(`tier-1 station ${no} is "${s.name}" in the station file, expected "${name}"`);
    if (!inputs.readings.has(no)) throw new Error(`tier-1 station ${no} has no readings`);
  }

  const stray = [...inputs.waters.keys()].filter((no) => !inputs.readings.has(no) || PLACEHOLDERS.has(no));
  if (stray.length > 0) throw new Error(`${WATERS_CSV}: stations that are not registered: ${stray.join(', ')}`);
  const unlisted = delivering.filter((no) => !master.has(no));
  if (unlisted.length > 0)
    throw new Error(`stations in messwerte.txt that the station file does not list: ${unlisted.join(', ')}`);
  const silent = [...master.keys()].filter((no) => !PLACEHOLDERS.has(no) && !inputs.readings.has(no)).sort(byCode);
  const thirdParty: [string, string][] = [];
  let noHydro = 0;
  const stations: PublicStation[] = [];
  for (const no of delivering) {
    const s = master.get(no);
    const times = inputs.readings.get(no);
    if (s === undefined || times === undefined) continue;
    const at = `station ${no}`;
    const step = modalStep(times, at);
    const h = hydro.get(no);
    if (h === undefined) noHydro += 1;
    else if (h.operator !== LANUK) thirdParty.push([no, label(h.operator, `${at} operator`)]);
    const tier1 = TIER1.has(no);
    stations.push({
      id: `de.lanuk.${no}`,
      source: 'DE-7',
      provider_code: no,
      provider_key: `${no}/W`,
      name: label(s.name, `${at} name`),
      water_name: inputs.waters.get(no) ?? null,
      country: 'DE',
      lon: s.lon,
      lat: s.lat,
      quantity: 'H',
      tier: tier1 ? 1 : 2,
      role: 'primary',
      river: null,
      km: null,
      flags: { tidal: null, impounded: null },
      native_unit: 'cm',
      to_canonical: TO_CANONICAL.cm,
      value_kind: 'stage',
      native_step: step,
      expected_step: step,
      // The capture is hourly while the pruner is a dry run; two hours leave one missed fetch.
      staleness_limit: 'PT2H',
      expected_threshold_source: inputs.warns.get(no) === true ? 'DE-7' : null,
      expected_forecast_source: null,
      licence_gate: 'open',
      first_release: tier1,
      audience: 'public',
      datum: 'NHN',
      gauge_zero:
        h === undefined || h.zero === null ? [] : [{ value_m: h.zero, datum: 'NHN', valid_from: null, valid_to: null }],
    });
  }

  const { problems } = validateStations({ stations }, [{ id: 'DE-7', audience: 'public' }]);
  if (problems.length > 0) throw new Error(`the generated rows fail validateStations:\n${problems.join('\n')}`);
  return { stations, silent, placeholders, thirdParty, noHydro };
}

function header(inputs: Inputs, plan: Plan): string {
  const files = inputs.files.map((f) => `#   ${f.path}  recorded_at ${f.recorded_at}  sha256 ${f.sha256}`);
  return [
    '# DE-7 station registry (LANUK NRW, Hochwasserportal.NRW downloads): one row per gauge, W only (NRW publishes no real-time Q).',
    '# GENERATED by scripts/gen-de7-stations.ts from the inputs below. Do not edit by hand: change the generator (or re-record',
    '# a fixture) and run `node scripts/gen-de7-stations.ts`.',
    ...files,
    '# Which gauges deliver, and each native_step = expected_step (PT5M or PT15M), come from messwerte.txt: the modal gap between',
    '# the consecutive timestamps of the gauge (any other gap fails the generator). name = station_name verbatim and the WGS84',
    '# coordinates come from the OpenHygon station file; the hydro file gives the gauge zero (`Nullpunkt`, m on DHHN2016: datum',
    "# NHN, no validity dates) and the operator (`Betreiber`). water_name is the station list's `WTO_OBJECT` (registry/seed/de-7-waters.csv,",
    '# recorded by tools/geo/rivernet/record-nrw-waters.ts), null where the list names none. expected_threshold_source DE-7 where the station file states',
    '# LANUV_Info_1 (the warning levels), else none. H is cm above the gauge zero (value_kind stage). staleness_limit PT2H (the',
    '# capture is hourly while the pruner is a dry run).',
    ...comment(
      'tier 1 (first_release) = the bold codes of catalogue §3.1, §3.3, §3.5 and §3.6, plus the most downstream NRW gauge of a listed river that has none in bold (Bocholter Aa, Ems, Vechte): ' +
        `${[...TIER1].map(([no, name]) => `${no} ${name}`).join(', ')}.`,
      '#',
      '#  ',
    ),
    ...comment(
      `Never registered: the placeholder numbers ${[...PLACEHOLDERS].join(', ')} (catalogue §2.3; present in the recording: ${plan.placeholders.join(', ') || 'none'}), ` +
        `and any WSV gauge (site_no 102, which messwerte.txt does not carry): the generator fails on a DE-7 station with the number of a DE-1 station, within ${NEAR_M} m of one, or with its name on H (case and accents aside).`,
      '#',
      '#  ',
    ),
    ...comment(
      `station-file stations without readings in the recording (not registered): ${plan.silent.join(', ') || 'none'}.`,
    ),
    ...comment(
      `[U] third-party operators: the hydro file names ${plan.thirdParty.length} registered gauges whose operator is not "${LANUK}": ` +
        `${plan.thirdParty.map(([no, op]) => `${no} (${op})`).join(', ') || 'none'}; and ${plan.noHydro} registered gauges are not in the hydro file ` +
        "(operator unknown). The DL-DE Zero licence covers LANUK's publication; whether it covers other operators' gauges is unverified (owner item).",
    ),
    '',
  ].join('\n');
}

/** The YAML text of the station file for the inputs. Pure: the same input gives byte-identical output. */
export function generate(inputs: Inputs): string {
  const plan = build(inputs);
  // YAML 1.1 rules quote what a 1.1 reader would misread: numeric codes, dates, "off"/"no"/"on".
  return header(inputs, plan) + stringify({ stations: plan.stations }, { version: '1.1', lineWidth: 0 });
}

/** The messwerte.txt lines of the fixture ZIP, through the loader's own guard and the strict DE-7 sink. */
async function readMesswerte(zip: Buffer): Promise<Map<string, number[]>> {
  const sink = lineSink(MESSWERTE_MEMBER, { ascii: true });
  await checkZip(zip, {
    names: flatNames([MESSWERTE_MEMBER]),
    onMember: (name) => {
      if (name !== MESSWERTE_MEMBER) return undefined;
      const split = lineSplitter(sink.line, 'utf-8', 1024, { fatal: true });
      return { data: split.push, end: split.end };
    },
  });
  const r = sink.end();
  // Every time string carries its +01:00 offset (a fixed one all year): the instant is the string's own.
  const ms = r.times.map((t) => Date.parse(t));
  if (ms.some((t) => !Number.isFinite(t))) throw new Error('messwerte.txt: an unreadable time');
  const sets = r.stations.map(() => new Set<number>());
  for (let i = 0; i < r.station.length; i++) sets[r.station[i] as number]?.add(ms[r.time[i] as number] as number);
  return new Map(r.stations.map((no, s) => [no, [...(sets[s] as Set<number>)].sort((a, b) => a - b)]));
}

async function readMember(zip: Buffer, member: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  await checkZip(zip, {
    names: flatNames([member]),
    onMember: (name) => (name === member ? { data: (c) => parts.push(c.slice()), end: () => undefined } : undefined),
  });
  return Buffer.concat(parts);
}

/** The inputs: the three fixtures with their sha256 and `recorded_at`, and the DE-1 stations. */
export async function readInputs(): Promise<Inputs> {
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
  const readings = await readMesswerte(read(MESSWERTE_FIXTURE));
  const stationBytes = read(STATIONS_FIXTURE);
  const stations = parseStations(stationBytes);
  // LANUV_Info_1 is not part of the adapter's Station: read the column of the same file, row for row.
  const csv = scanCsv(new TextDecoder('utf-8', { fatal: true }).decode(stationBytes).replace(/^﻿/, ''), {
    delimiter: ';',
    extraField: false,
  });
  if (csv.header.join(';') !== STATIONS_HEADER || csv.rows.length !== stations.length) {
    throw new Error('the station file does not read the same through both scans');
  }
  const warns = new Map<string, boolean>();
  for (const [i, r] of csv.rows.entries()) {
    if (r[3] !== stations[i]?.no) throw new Error(`station file row ${i + 1}: the scans disagree`);
    warns.set(r[3] as string, (r[6] ?? '') !== '');
  }
  const waterText = readFileSync(join(root, WATERS_CSV));
  const retrieved = /^# source \S+, retrieved (\d{4}-\d{2}-\d{2}) \(UTC\)/m.exec(waterText.toString('utf8'))?.[1];
  if (retrieved === undefined) throw new Error(`${WATERS_CSV}: no retrieval date in the header`);
  files.push({ path: WATERS_CSV, sha256: sha256Of(waterText), recorded_at: retrieved });
  const waters = new Map<string, string>();
  const wcsv = scanCsv(waterText.toString('utf8').replace(/^#.*\n/gm, ''), { delimiter: ';', extraField: false });
  if (wcsv.header.join(';') !== 'station_no;water') throw new Error(`${WATERS_CSV}: unexpected header`);
  for (const [no, water] of wcsv.rows) {
    if (no === undefined || water === undefined || waters.has(no))
      throw new Error(`${WATERS_CSV}: a bad or repeated row`);
    waters.set(no, label(water, `${WATERS_CSV} ${no}`));
  }
  const hydro = parseHydro(await readMember(read(HYDRO_FIXTURE), HYDRO_MEMBER));
  const doc = parse(readFileSync(join(root, DE1_REGISTRY), 'utf8')) as { stations?: Obj[] };
  const de1: De1Row[] = (doc.stations ?? []).map((s) => {
    const { provider_code: code, name, quantity, lon, lat } = s;
    const place = (v: unknown) => v === null || typeof v === 'number';
    if (
      typeof code !== 'string' ||
      typeof name !== 'string' ||
      typeof quantity !== 'string' ||
      !place(lon) ||
      !place(lat)
    )
      throw new Error(`${DE1_REGISTRY}: a row without a provider_code, name, quantity or position`);
    return { code, name, quantity, lon: lon as number | null, lat: lat as number | null };
  });
  if (de1.length === 0) throw new Error(`${DE1_REGISTRY}: no station`);
  return { files, readings, stations, warns, waters, hydro, de1 };
}

if (import.meta.main) {
  const text = generate(await readInputs());
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT}: ${text.split('\n').filter((line) => line.startsWith('  - id: ')).length} rows`);
}
