// Generates registry/stations/de-1.yaml (the DE-1 station registry) from the two
// recorded PEGELONLINE fixtures: the basin call (stations, units, steps, km,
// coordinates) and the all-stations metadata call (gauge zero, characteristic
// values). Deterministic: the same input gives the same bytes; the output holds
// no timestamp of its own, and every derived value is stated in the row, none
// is inferred at read time.
//
//   node scripts/gen-de1-stations.ts
//
// Fails loudly on anything it does not know: a unit, a gauge-zero unit, a water,
// an agency, or a tier-1 or mirror gauge whose number and UUID no longer agree
// with the fixture. Fixture text is data.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { type NativeUnit, type PublicStation, StationsFile, TO_CANONICAL } from '../packages/contracts/src/stations.ts';

const root = join(import.meta.dirname, '..');
export const FIXTURE_DIR = join(root, 'apps/server/src/adapters/de-1/fixtures');
export const OUTPUT = join(root, 'registry/stations/de-1.yaml');

type Datum = NonNullable<PublicStation['datum']>;
type Mirror = { uuid: string | null; country: PublicStation['country'] };

/** Catalogue §3.1 and §3.2 key gauges (tier 1, first release): number and the UUID the catalogue prints. */
const TIER1 = new Map<string, string>([
  ['23300130', '06b978dd-8c4d-48ac-a0c8-2c16681ed281'], // Rheinweiler
  ['23300900', '23af9b02-5c82-4f6e-acb8-f92a06e5e4da'], // Kehl-Kronenhof
  ['23500600', 'b02be240-1364-4c97-8bb6-675d7d842332'], // Iffezheim
  ['23700200', 'b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea'], // Maxau
  ['23700600', '2cb8ae5b-c5c9-4fa8-bac0-bb724f2754f4'], // Speyer
  ['23700700', '57090802-c51a-4d09-8340-b4453cd0e1f5'], // Mannheim
  ['23900200', '844a620f-f3b8-4b6b-8e3c-783ae2aa232a'], // Worms
  ['25100100', 'a37a9aa3-45e9-4d90-9df6-109f3a28a5af'], // Mainz
  ['25100300', '665be0fe-5e38-43f6-8b04-02a93bdbeeb4'], // Oestrich
  ['25300200', '0309cd61-90c9-470e-99d4-2ee4fb2c5f84'], // Bingen
  ['25700100', '1d26e504-7f9e-480a-b52c-5932be6549ab'], // Kaub
  ['25900700', '4c7d796a-39f2-4f26-97a9-3aad01713e29'], // Koblenz
  ['27100400', '5735892a-ec65-4b29-97c5-50939aa9584e'], // Andernach
  ['2710080', '593647aa-9fea-43ec-a7d6-6476a76ae868'], // Bonn
  ['2730010', 'a6ee8177-107b-47dd-bcfd-30960ccc6e9c'], // Köln
  ['2750010', '8f7e5f92-1153-4f93-acba-ca48670c8ca9'], // Düsseldorf
  ['27600090', '12a3037f-cbf3-49d3-8da5-77fb38730bba'], // Ruhrwehr OW
  ['2770010', 'c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1'], // Duisburg-Ruhrort
  ['2770040', 'f33c3cc9-dc4b-4b77-baa9-5a5f10704398'], // Wesel
  ['2790010', '2f025389-fac8-4557-94d3-7d0428878c86'], // Rees
  ['2790020', '9598e4cb-0849-401e-bba0-689234b27644'], // Emmerich
  ['23800100', 'be7ce40e-5fff-42df-8386-b42694ca86da'], // Plochingen
  ['23800500', '8559d1a0-4a03-410a-8910-44a089a07df8'], // Lauffen
  ['23800690', '4c00a166-7d6d-48d7-b4dc-673b96b4041e'], // Rockenau SKA
  ['23800760', '827b2685-47ec-44df-a90f-980f5e0c1591'], // Heidelberg UP
  ['23800900', '25582d3f-dc5f-4c70-bd08-e84fd13201ca'], // Mannheim Neckar
  ['24300600', '915d76e1-3bf9-4e37-9a9a-4d144cd771cc'], // Würzburg
  ['24700404', '66ff3eb4-513b-478b-abd2-2f5126ea66fd'], // Frankfurt Osthafen
  ['24900108', 'db1684c1-7ffc-4e8a-b8cf-8240a0d03519'], // Raunheim
  ['25800200', '32807065-b887-49f0-935a-80033e5f3cb0'], // Leun neu
  ['25800600', '64f735fd-88b6-42ea-9cdd-dc18d3806c34'], // Kalkofen neu
  ['26100100', 'c263ea53-ca4d-41f5-b3f5-6178fec302aa'], // Perl
  // The catalogue prints no UUID for the next three; taken from the fixture (recorded 2026-09-29).
  ['26100130', 'dfdf753b-75bd-46f0-8cde-15545be9bfba'], // Stadtbredimus UP (fixture UUID)
  ['26100140', 'bb5560fc-7995-40a2-b92f-3d828c67dcfa'], // Wincheringen (fixture UUID)
  ['26100200', '69308142-f78e-4877-9af8-e7221b01d303'], // Grevenmacher UP (fixture UUID)
  ['26500100', '3bec53ca-444e-4014-a7b0-07b3591e954b'], // Trier UP
  ['26900400', '768df4e9-ed5a-4141-901b-e25ac404d559'], // Cochem
  ['26900510', '16578824-88de-4700-ab09-f61dbb1182bd'], // Alken
  ['26400100', 'eeaba884-d4c5-4a83-88fb-adcd79adbc50'], // Hanweiler
  ['26400220', 'a9ca43e9-ef92-4f1c-ac02-a6c8ccad7b9f'], // Sankt Arnual
  ['26400550', 'fe72ee98-88e9-4d19-aba1-f97f61b7d4de'], // Fremersdorf
]);

/**
 * Gauges that other agencies operate, published by PEGELONLINE as mirrors (catalogue
 * §3.1; their canonical source is another one). Number and UUID are both checked;
 * a null UUID marks a gauge that is not in the basin call today (checked if present).
 */
const MIRRORS = new Map<string, Mirror>([
  ['2790050', { uuid: 'efe13a3d-f239-4655-9c13-4ac56dfa4478', country: 'NL' }], // Lobith (RWS; NL-1)
  ['2790060', { uuid: '3046493f-971f-4d22-9f29-7ef8e3b645a4', country: 'NL' }], // Pannerdense Kop (RWS; NL-1)
  ['2310010', { uuid: '94f6eff1-4f3f-4850-82e0-a086198e9ffd', country: 'CH' }], // Basel-Rheinhalle (BAFU; CH-1)
  ['3329', { uuid: 'e020e651-e422-46d3-ae28-34887c5a4a8e', country: 'DE' }], // Konstanz-Rhein (RP Freiburg; fixture UUID)
  ['2769510000100', { uuid: 'c0594fb5-77ff-4287-9b8d-7ff326afe9ff', country: 'DE' }], // Hattingen (Ruhrverband)
  // RWS placeholder gauges: outside the basin call today.
  ...['123456781', '123456782', '123456783', '123456784', '123456785', '123456786', '852369741'].map(
    (number): [string, Mirror] => [number, { uuid: null, country: 'NL' }],
  ),
]);

/** Ems estuary gauges, tidal (true). Every other gauge is null (unknown), not false. */
const TIDAL = new Set([
  '3790010', // Papenburg
  '3790020', // Weener
  '3910010', // Leerort
  '3910020', // Terborg
  '3950020', // Pogum
  '3970010', // Emden Neue Seeschleuse
  '3990010', // Knock
  '3990020', // Dukegat
  '9340010', // Emshörn
]);

/** The agencies of the recorded fixture. WSV offices publish their own gauges. */
const WSV_AGENCIES = new Set([
  'ASCHAFFENBURG',
  'DUISBURG-MEIDERICH',
  'MARBURG',
  'RHEINE',
  'SCHWEINFURT',
  'STANDORT BINGEN',
  'STANDORT DUISBURG',
  'STANDORT EMDEN',
  'STANDORT FREIBURG',
  'STANDORT HEIDELBERG',
  'STANDORT KOBLENZ',
  'STANDORT KÖLN',
  'STANDORT MANNHEIM',
  'STANDORT MEPPEN',
  'STANDORT SAARBRÜCKEN',
  'STANDORT STUTTGART',
  'STANDORT TRIER',
]);
/** Third-party agencies whose gauges PEGELONLINE only mirrors: each must be in the mirror table. */
const MIRROR_AGENCIES = new Set([
  'RIJKSWATERSTAAT',
  'BUNDESAMT FÜR UMWELT CH',
  'REGIERUNGSPRÄSIDIUM FREIBURG',
  'RUHRVERBAND',
]);
/** A third-party agency whose gauge stays a primary tier-2 row. [U] The licence of that data is unverified. */
const OTHER_AGENCIES = new Set(['DEICHINFORMATIONSZENTRUM NEUWIED']);

const RIVERS = new Map([
  ['RHEIN', 'rhine'],
  ['MOSEL', 'moselle'],
  ['SAAR', 'saar'],
  ['MAIN', 'main'],
  ['NECKAR', 'neckar'],
  ['LAHN', 'lahn'],
  ['RUHR', 'ruhr'],
  ['EMS', 'ems'],
  ['DEK', 'dortmund-ems-kanal'],
]);

type UnitRule = { unit: NativeUnit; kind: 'stage' | 'level' | null; datum: Datum | null };
/** Timeseries shortname → provider unit → what we declare for it. Any other unit is an error. */
const UNIT_RULES = {
  W: new Map<string, UnitRule>([
    ['cm', { unit: 'cm', kind: 'stage', datum: null }],
    ['m+NN', { unit: 'm+NN', kind: 'level', datum: 'NN' }],
    ['m+PNP', { unit: 'm+PNP', kind: 'stage', datum: null }],
  ]),
  Q: new Map<string, UnitRule>([['m³/s', { unit: 'm³/s', kind: null, datum: null }]]),
};
/** The datum a gaugeZero unit names. Any other string is an error. */
const GAUGE_ZERO_DATUM = new Map<string, Datum>([
  ['m. ü. NHN', 'NHN'],
  ['m. ü. NN', 'NN'],
  ['mü.M.', 'LN02'], // Basel-Rheinhalle
]);

// Fixture input, validated by hand: zod is not a root dependency, and these are small.
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
function minutes(v: unknown, at: string): number {
  const n = num(v, at);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${at}: expected a whole number of minutes, got ${n}`);
  return n;
}
function date(v: unknown, at: string): string {
  const s = str(v, at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${at}: expected YYYY-MM-DD, got ${s}`);
  return s;
}
const orNull = <T>(v: unknown, at: string, read: (v: unknown, at: string) => T): T | null =>
  v === undefined ? null : read(v, at);

type BasinSeries = { shortname: string; unit: string; equidistance: number };
type BasinStation = {
  uuid: string;
  number: string;
  longname: string;
  agency: string;
  km: number | null;
  lon: number | null;
  lat: number | null;
  water: { shortname: string; longname: string };
  series: BasinSeries[];
};

function readBasin(payload: unknown): BasinStation[] {
  const stations = arr(payload, 'basin').map((raw, i): BasinStation => {
    const at = `basin[${i}]`;
    const s = obj(raw, at);
    const water = obj(s.water, `${at}.water`);
    return {
      uuid: str(s.uuid, `${at}.uuid`),
      number: str(s.number, `${at}.number`),
      longname: str(s.longname, `${at}.longname`),
      agency: str(s.agency, `${at}.agency`),
      km: orNull(s.km, `${at}.km`, num),
      lon: orNull(s.longitude, `${at}.longitude`, num),
      lat: orNull(s.latitude, `${at}.latitude`, num),
      water: {
        shortname: str(water.shortname, `${at}.water.shortname`),
        longname: str(water.longname, `${at}.water.longname`),
      },
      series: arr(s.timeseries, `${at}.timeseries`).map((t, j) => {
        const ts = obj(t, `${at}.timeseries[${j}]`);
        const where = `${at}.timeseries[${j}]`;
        return {
          shortname: str(ts.shortname, `${where}.shortname`),
          unit: str(ts.unit, `${where}.unit`),
          equidistance: minutes(ts.equidistance, `${where}.equidistance`),
        };
      }),
    };
  });
  for (const key of ['number', 'uuid'] as const) {
    const seen = new Set<string>();
    for (const s of stations) {
      if (seen.has(s[key])) throw new Error(`basin: duplicate station ${key} ${s[key]}`);
      seen.add(s[key]);
    }
  }
  return stations;
}

type MetaSeries = {
  gaugeZero: { unit: string; value: number; validFrom: string } | null;
  /** True when the series has an MNW or MHW characteristic value: the source of its thresholds. */
  thresholds: boolean;
};

/** The meta call, indexed by station UUID. Only the series a basin station needs are read in depth. */
function readMeta(payload: unknown): (uuid: string, shortname: string) => MetaSeries {
  const byUuid = new Map(
    arr(payload, 'meta').map((raw, i) => [str(obj(raw, `meta[${i}]`).uuid, `meta[${i}].uuid`), raw]),
  );
  return (uuid, shortname) => {
    const at = `meta ${uuid}/${shortname}`;
    const known = byUuid.get(uuid);
    if (known === undefined) throw new Error(`${at}: the station is not in the meta fixture`);
    const station = obj(known, `meta ${uuid}`);
    const raw = arr(station.timeseries, `${at}.timeseries`).find((t) => obj(t, at).shortname === shortname);
    if (raw === undefined) throw new Error(`${at}: the series is not in the meta fixture`);
    const ts = obj(raw, at);
    const zero = orNull(ts.gaugeZero, `${at}.gaugeZero`, (v, where) => {
      const g = obj(v, where);
      return {
        unit: str(g.unit, `${where}.unit`),
        value: num(g.value, `${where}.value`),
        validFrom: date(g.validFrom, `${where}.validFrom`),
      };
    });
    const values = arr(ts.characteristicValues ?? [], `${at}.characteristicValues`);
    const thresholds = values.some((v) => ['MNW', 'MHW'].includes(str(obj(v, at).shortname, `${at}.shortname`)));
    return { gaugeZero: zero, thresholds };
  };
}

/** The tier-1, mirror and agency tables against the fixture: nothing may have drifted silently. */
function checkTables(stations: BasinStation[]): void {
  const byNumber = new Map(stations.map((s) => [s.number, s]));
  for (const [number, uuid] of TIER1) {
    const found = byNumber.get(number);
    if (found === undefined) throw new Error(`tier-1 station ${number} is not in the basin fixture`);
    if (found.uuid !== uuid)
      throw new Error(`tier-1 station ${number}: UUID ${uuid} differs from the fixture ${found.uuid}`);
    if (MIRRORS.has(number)) throw new Error(`tier-1 station ${number} is also in the mirror table`);
  }
  for (const [number, mirror] of MIRRORS) {
    const found = byNumber.get(number);
    if (found === undefined) {
      if (mirror.uuid !== null) throw new Error(`mirror ${number} is not in the basin fixture`);
    } else if (mirror.uuid !== null && found.uuid !== mirror.uuid) {
      throw new Error(`mirror ${number}: UUID ${mirror.uuid} differs from the fixture ${found.uuid}`);
    }
  }
  for (const number of TIDAL) {
    if (!byNumber.has(number)) throw new Error(`tidal station ${number} is not in the basin fixture`);
  }
  for (const s of stations) {
    const known = WSV_AGENCIES.has(s.agency) || MIRROR_AGENCIES.has(s.agency) || OTHER_AGENCIES.has(s.agency);
    if (!known) throw new Error(`station ${s.number} ${s.longname}: new agency: review "${s.agency}"`);
    if (MIRROR_AGENCIES.has(s.agency) && !MIRRORS.has(s.number)) {
      throw new Error(
        `station ${s.number} ${s.longname}: agency ${s.agency} is not WSV, so the gauge must be a listed mirror`,
      );
    }
  }
}

function rowsOf(s: BasinStation, meta: ReturnType<typeof readMeta>): PublicStation[] {
  const river = RIVERS.get(s.water.shortname);
  if (river === undefined) throw new Error(`station ${s.number}: unknown water ${s.water.shortname}`);
  const mirror = MIRRORS.get(s.number);
  const tier1 = TIER1.has(s.number);
  const rows: PublicStation[] = [];
  // H (timeseries W) before Q; any other timeseries is ignored.
  for (const [shortname, quantity] of [
    ['W', 'H'],
    ['Q', 'Q'],
  ] as const) {
    const series = s.series.find((t) => t.shortname === shortname);
    if (series === undefined) continue;
    const at = `station ${s.number} ${shortname}`;
    const rule = UNIT_RULES[shortname].get(series.unit);
    if (rule === undefined) throw new Error(`${at}: unknown unit "${series.unit}"`);
    const found = meta(s.uuid, shortname);

    // A stage series carries its gauge zero (when the provider publishes one); a level series is absolute.
    let datum = rule.datum;
    const gaugeZero: PublicStation['gauge_zero'] = [];
    if (rule.kind === 'stage' && found.gaugeZero !== null) {
      datum = GAUGE_ZERO_DATUM.get(found.gaugeZero.unit) ?? null;
      if (datum === null) throw new Error(`${at}: unknown gauge-zero unit "${found.gaugeZero.unit}"`);
      gaugeZero.push({ value_m: found.gaugeZero.value, datum, valid_from: found.gaugeZero.validFrom, valid_to: null });
    }

    const expectedStep = series.equidistance < 5 ? 15 : series.equidistance;
    rows.push({
      id: `de.wsv.${s.number}`,
      source: 'DE-1',
      provider_code: s.number,
      provider_key: `${s.uuid}/${shortname}`,
      name: s.longname,
      water_name: s.water.longname,
      country: mirror?.country ?? 'DE',
      lon: s.lon,
      lat: s.lat,
      quantity,
      tier: tier1 ? 1 : 2,
      role: mirror === undefined ? 'primary' : 'mirror',
      river,
      km: s.km === null ? null : { system: `${s.water.shortname}-km (PEGELONLINE)`, value: s.km },
      flags: { tidal: TIDAL.has(s.number) ? true : null, impounded: null },
      native_unit: rule.unit,
      to_canonical: TO_CANONICAL[rule.unit],
      value_kind: rule.kind,
      native_step: `PT${series.equidistance}M`,
      expected_step: `PT${expectedStep}M`,
      staleness_limit: `PT${Math.max(3 * expectedStep, 45)}M`,
      expected_threshold_source: quantity === 'H' && found.thresholds ? 'DE-1' : null,
      // DE-2 is owner-audience: a public row may not name it.
      expected_forecast_source: null,
      licence_gate: 'open',
      first_release: tier1,
      audience: 'public',
      datum,
      gauge_zero: gaugeZero,
    });
  }
  return rows;
}

const header = (recordedAt: { basin: string; meta: string }) =>
  [
    '# DE-1 station registry (PEGELONLINE, WSV/GDWS): one row per station and quantity (W is H, Q is Q).',
    '# GENERATED by scripts/gen-de1-stations.ts from the recorded fixtures below. Do not edit by hand:',
    '# change the generator (or re-record a fixture) and run `node scripts/gen-de1-stations.ts`.',
    `#   apps/server/src/adapters/de-1/fixtures/de-1-basin.raw  recorded_at ${recordedAt.basin}  stations, units, steps, km, coordinates`,
    `#   apps/server/src/adapters/de-1/fixtures/de-1-meta.raw   recorded_at ${recordedAt.meta}  gauge zero, characteristic values`,
    '# tier 1 (first_release) = the catalogue §3.1/§3.2 key gauges. role mirror = a gauge another agency operates, which',
    '# PEGELONLINE republishes (canonical source elsewhere). tidal null = unknown. NEUWIED STADT (27100370) is a',
    '# third-party agency: the licence of that data is unverified [U].',
    '',
  ].join('\n');

/**
 * The YAML text of the DE-1 station file for the two fixture payloads. Pure: the same
 * input gives byte-identical output. `recordedAt` are the fixtures' recorded_at values.
 */
export function generate(basin: unknown, meta: unknown, recordedAt: { basin: string; meta: string }): string {
  const stations = readBasin(basin);
  checkTables(stations);
  const metaOf = readMeta(meta);
  // Station number as a string (code-point order), then H before Q.
  const sorted = [...stations].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  const stationRows = sorted.flatMap((s) => rowsOf(s, metaOf));
  StationsFile.parse({ stations: stationRows });
  // YAML 1.1 rules quote what a 1.1 reader would misread: numeric codes, dates, "off"/"no"/"on".
  return header(recordedAt) + stringify({ stations: stationRows }, { version: '1.1', lineWidth: 0 });
}

/** The recorded fixtures: payloads and the recorded_at of each .meta.json. */
export function readInputs(dir = FIXTURE_DIR) {
  const json = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const recorded = (spec: string) => str(obj(json(`${spec}.meta.json`), spec).recorded_at, `${spec}.recorded_at`);
  return {
    basin: json('de-1-basin.raw'),
    meta: json('de-1-meta.raw'),
    recordedAt: { basin: recorded('de-1-basin'), meta: recorded('de-1-meta') },
  };
}

if (import.meta.main) {
  const { basin, meta, recordedAt } = readInputs();
  const text = generate(basin, meta, recordedAt);
  writeFileSync(OUTPUT, text);
  const rows = text.split('\n').filter((line) => line.startsWith('  - id: ')).length;
  console.log(`wrote ${OUTPUT}: ${rows} rows from ${arr(basin, 'basin').length} stations`);
}
