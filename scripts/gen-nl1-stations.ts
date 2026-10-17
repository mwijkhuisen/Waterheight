// Generates registry/stations/nl-1.yaml (the NL-1 station registry) from the series P1
// captures (registry/seed/nl-1.csv), the recorded RWS catalogue (codes, names,
// coordinates), the recorded NL-2 WFS snapshot (the one live method of each series),
// the forecast locations and the NL-4 Waterinfo classes. Deterministic: the same input
// gives the same bytes; the output holds no timestamp of its own, and every derived
// value is stated in the row, none is inferred at read time.
//
//   node scripts/gen-nl1-stations.ts
//
// Fails loudly on anything it does not know: a seed row of an unknown kind, a code the
// catalogue lacks, a series with no live method or with more than one, a unit or a
// coordinate that disagrees, and a curated table entry that no longer matches the
// inputs. Fixture text is data.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { STALE_SERIES } from '../apps/server/src/adapters/nl-1/normalise.ts';
import { H_DESCRIPTION, Q_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { REGISTRY_DIR, readSeed } from '../apps/server/src/capture/specs.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { type PublicStation, validateStations } from '../packages/contracts/src/stations.ts';
import { CATALOGUE, locations, WFS } from './rws-inventory.ts';

const root = join(import.meta.dirname, '..');
export const OUTPUT = join(root, 'registry/stations/nl-1.yaml');
const THRESHOLDS = 'registry/thresholds/nl-4.csv';

/** The curated key stations (tier 1, first release): every row of these stations is tier 1. */
const TIER1 = new Set([
  'lobith.bovenrijn.tolkamer',
  'millingenaanderijn',
  'millingenaanderijn.pannerdensekop',
  'pannerden.pannerdenschkanaal',
  'nijmegen.waal',
  'tiel.waal',
  'zaltbommel',
  'driel.boven',
  'amerongen.boven',
  'hagestein.boven',
  'westervoort.ijsselkop',
  'westervoort.1',
  'doesburg.ijssel',
  'zutphen.ijssel',
  'deventer',
  'olst',
  'zwolle.ijssel',
  'kampen.ijssel',
  'eijsden.grens',
  'maastricht.sintpieter',
  'maastricht.borgharen.maas.beneden',
  'stevensweert',
  'roermond.boven',
  'venlo',
  'grave.boven',
  'megen.maas',
  'lith.boven',
  'holtheme.vecht',
  'ommen.vecht',
  'dalfsen.vechterweerd',
  'epen.geul.cottessen',
]);

/**
 * Sea and estuary gauges: tidal true. The tier-1 stations are river gauges (false);
 * every other station is null, because RWS metadata cannot tell river from tide (catalogue §2.1).
 * Antwerpen (a seed row on Belgian soil, P5a) is on the tidal Scheldt.
 */
const TIDAL = new Set([
  'vlissingen',
  'terneuzen',
  'hansweert',
  'rilland.bath',
  'delfzijl',
  'nieuwestatenzijl.dollard',
  'antwerpen',
]);

/**
 * P16b: the water bodies of the new rows, only where the RWS code or the catalogue name contains the water's name
 * (`evident()` checks it, letters and digits only, case aside). Everything else stays null: RWS publishes no water
 * body, and a name is never inferred from a position. A roadmap-1 station is never named (its bytes are fixed).
 */
export const WATERS: ReadonlyMap<string, string> = new Map([
  ['brouwershavensche.gat.08', 'Brouwershavensche Gat'],
  ['bruinisse.krammersluis.oosterschelde.2', 'Oosterschelde'],
  ['denoever.ijsselmeer.binnenhaven', 'IJsselmeer'],
  ['denoever.waddenzee.voorhaven', 'Waddenzee'],
  ['dinteloord.volkerak', 'Volkerak'],
  ['dronten.reevesluis.drontermeer', 'Drontermeer'],
  ['dronten.reevesluis.vossemeer', 'Vossemeer'],
  ['eemshaven.waddenzee', 'Waddenzee'],
  ['gouda.hollandscheijssel', 'Hollandsche IJssel'],
  ['hank.bergschemaas', 'Bergsche Maas'],
  ['haringvliet.10', 'Haringvliet'],
  ['harlingen.waddenzee', 'Waddenzee'],
  ['ijgeul.1', 'IJgeul'],
  ['kadoelen.zwanediep', 'Zwanediep'],
  ['ketelhaven.ketelmeer', 'Ketelmeer'],
  ['kornwerderzand.ijsselmeer.binnenhaven', 'IJsselmeer'],
  ['kornwerderzand.waddenzee.buitenhaven', 'Waddenzee'],
  ['krabbersgat.ijsselmeer', 'IJsselmeer'],
  ['krabbersgat.markermeer', 'Markermeer'],
  ['krimpenaandeijssel.hollandscheijssel', 'Hollandsche IJssel'],
  ['lauwersoog.waddenzee', 'Waddenzee'],
  ['lemmer.ijsselmeer', 'IJsselmeer'],
  ['lemmer.ijsselmeer.woudagemaal', 'IJsselmeer'],
  ['markermeer.midden', 'Markermeer'],
  ['markermeer.trintelzand', 'Markermeer'],
  ['nijkerk.nijkerkernauw', 'Nijkerkernauw'],
  ['nijkerk.nuldernauw', 'Nuldernauw'],
  ['oosterschelde.14', 'Oosterschelde'],
  ['oosterschelde.4', 'Oosterschelde'],
  ['oosterschelde.roompotsluis.binnen', 'Oosterschelde'],
  ['oosterschelde.roompotsluis.buiten', 'Oosterschelde'],
  ['ramspolbrug.ramsdiep', 'Ramsdiep'],
  ['ramspolkering.ketelmeer', 'Ketelmeer'],
  ['rotterdam.nieuwemaas.boerengat', 'Nieuwe Maas'],
  ['rotterdamsehoek.ijsselmeer', 'IJsselmeer'],
  ['schiermonnikoog.waddenzee', 'Waddenzee'],
  ['sintannaland.oosterschelde', 'Oosterschelde'],
  ['spijkenisse.oudemaas', 'Oude Maas'],
  ['swifterbant.ketelmeer', 'Ketelmeer'],
  ['terschelling.noordzee', 'Noordzee'],
  ['texel.noordzee', 'Noordzee'],
  ['willemstad.hollandschdiep', 'Hollandsch Diep'],
  ['willemstad.volkerak', 'Volkerak'],
  ['zuidland.spui', 'Spui'],
]);
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** True if the water's name is in the RWS code or the catalogue name. */
export const evident = (water: string, code: string, name: string) =>
  letters(`${code}${name}`).includes(letters(water));

/** Seed series RWS does not publish today (`<code>/<Grootheid>/<Hoedanigheid>`), with the reason. */
const NOT_LIVE = new Map([['hedel/WATHTE/NAP', 'no feature in the WFS snapshot']]);

/**
 * Series that two live features share (the WFS shows two methods under one key; the registry declares one, and the
 * normaliser drops the other as `unregistered_method`). P16b: both are canal discharges at inlets; F058 is the method
 * of the other canal discharges (the NBXX_INWAT feature), and the RIKZ_AFVOER feature (F007) is left out. A reviewed
 * choice: change it here and run the generator.
 */
const CHOSEN = new Map([
  ['eindhoven.gender/Q/NVT', 'other:F058'],
  ['sonenbreugel.wilhelminakanaal/Q/NVT', 'other:F058'],
]);

/** Staleness overrides: Eijsden Q (F216) comes about 75 min late (catalogue §2.1, §6.5). */
const STALENESS = new Map([['eijsden.grens/Q/NVT', 'PT2H']]);

type Kind = {
  grootheid: 'WATHTE' | 'Q';
  hoedanigheid: 'NAP' | 'NVT' | 'TAW';
  /** The Hoedanigheid values the seed column may state (an empty column means `hoedanigheid`). */
  allowed: readonly string[];
  /** The payload unit the series must have (the normaliser drops any other). */
  unit: 'cm' | 'm3/s';
  role: 'primary' | 'twin';
  /** Fetched every 10 min (key, twin) or every 30 min (other), plus about 25 min RWS latency and the 10 min step. */
  staleness: string;
  notes: readonly string[];
};
/** Seed quantity/tier → the series it asks for. Any other combination is an error. */
const KINDS = new Map<string, Kind>([
  [
    'H/key',
    {
      grootheid: 'WATHTE',
      hoedanigheid: 'NAP',
      allowed: ['NAP'],
      unit: 'cm',
      role: 'primary',
      staleness: 'PT1H',
      notes: [''],
    },
  ],
  [
    'H/other',
    {
      grootheid: 'WATHTE',
      hoedanigheid: 'NAP',
      allowed: ['NAP'],
      unit: 'cm',
      role: 'primary',
      staleness: 'PT90M',
      notes: ['', 'be'],
    },
  ],
  [
    'Q/other',
    {
      grootheid: 'Q',
      hoedanigheid: 'NVT',
      allowed: ['NVT'],
      unit: 'm3/s',
      role: 'primary',
      staleness: 'PT90M',
      notes: ['', 'be'],
    },
  ],
  [
    'H/twin',
    {
      grootheid: 'WATHTE',
      hoedanigheid: 'TAW',
      allowed: ['TAW'],
      unit: 'cm',
      role: 'twin',
      staleness: 'PT1H',
      notes: ['taw'],
    },
  ],
  // P16b: the sea, wide and slow tiers. H is NAP, MSL (offshore) or TAW (a second Meuse series: a twin); Q is NVT.
  // Staleness: the capture cadence (10 min, 30 min, 60 min) plus the RWS latency and the step.
  ...(
    [
      ['sea', 'PT1H'],
      ['wide', 'PT90M'],
      ['slow', 'PT3H'],
    ] as const
  ).flatMap(([tier, staleness]) => [
    [
      `H/${tier}`,
      {
        grootheid: 'WATHTE',
        hoedanigheid: 'NAP',
        allowed: ['NAP', 'MSL', 'TAW'],
        unit: 'cm',
        role: 'primary',
        staleness,
        notes: [''],
      },
    ] as [string, Kind],
    // The sea tier is H only.
    ...(tier === 'sea'
      ? []
      : [
          [
            `Q/${tier}`,
            {
              grootheid: 'Q',
              hoedanigheid: 'NVT',
              allowed: ['NVT'],
              unit: 'm3/s',
              role: 'primary',
              staleness,
              notes: [''],
            },
          ] as [string, Kind],
        ]),
  ]),
]);

/** The water types RWS gauges are tidal in (rws-inventory TABLE). */
const TIDAL_TYPES = new Set(['coast', 'scheldt', 'delta', 'offshore']);
/** Seed tiers added in P16a; their stations are never first release. */
const NEW_TIERS = new Set(['sea', 'wide', 'slow']);

/** The WFS and catalogue coordinates of one station must agree within this (degrees). */
const COORDINATE_TOLERANCE = 1e-4;

const stale = (key: string) => STALE_SERIES.some((s) => key === s || key.startsWith(`${s}/`));

// Fixture input, validated by hand (as in gen-de1-stations.ts).
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

type Location = { name: string; lon: number; lat: number };

/** The catalogue's locations by code; a location is read in depth only when a row needs it. */
function readCatalogue(payload: unknown): (code: string) => Location | undefined {
  const byCode = new Map<string, Obj>();
  for (const [i, raw] of arr(obj(payload, 'catalogue').LocatieLijst, 'catalogue.LocatieLijst').entries()) {
    const l = obj(raw, `LocatieLijst[${i}]`);
    const code = str(l.Code, `LocatieLijst[${i}].Code`);
    if (byCode.has(code)) throw new Error(`catalogue: duplicate location ${code}`);
    byCode.set(code, l);
  }
  return (code) => {
    const l = byCode.get(code);
    if (l === undefined) return undefined;
    const at = `catalogue ${code}`;
    const crs = str(l.Coordinatenstelsel, `${at}.Coordinatenstelsel`);
    if (crs !== 'ETRS89') throw new Error(`${at}: unknown coordinate system "${crs}"`);
    return { name: str(l.Naam, `${at}.Naam`), lon: num(l.Lon, `${at}.Lon`), lat: num(l.Lat, `${at}.Lat`) };
  };
}

type Feature = { method: string; unit: string; lon: number; lat: number };

/** The WFS features by `<CODE>/<GROOTHEIDCODE>/<HOEDANIGHEIDCODE>`. */
function readWfs(payload: unknown): Map<string, Feature[]> {
  const out = new Map<string, Feature[]>();
  for (const [i, raw] of arr(obj(payload, 'wfs').features, 'wfs.features').entries()) {
    const at = `features[${i}]`;
    const f = obj(raw, at);
    const p = obj(f.properties, `${at}.properties`);
    const prop = (name: string) => str(p[name], `${at}.${name}`);
    const [lon, lat] = arr(obj(f.geometry, `${at}.geometry`).coordinates, `${at}.coordinates`);
    const key = `${prop('CODE')}/${prop('GROOTHEIDCODE')}/${prop('HOEDANIGHEIDCODE')}`;
    const feature = {
      method: prop('WAARDEBEPALINGSMETHODECODE'),
      unit: prop('EENHEIDCODE'),
      lon: num(lon, `${at}.lon`),
      lat: num(lat, `${at}.lat`),
    };
    out.set(key, [...(out.get(key) ?? []), feature]);
  }
  return out;
}

export type Inputs = ReturnType<typeof readInputs>;
type Skipped = { code: string; quantity: 'H' | 'Q'; reason: 'stale' | 'not live'; why?: string | undefined };

function build(inputs: Inputs): { rows: PublicStation[]; skipped: Skipped[]; off: [string, string][] } {
  const location = readCatalogue(inputs.catalogue);
  const live = readWfs(inputs.wfs);
  const places = locations(inputs.catalogue, inputs.wfs);
  const forecast = new Set(inputs.forecast.map((r) => `${r.code}/${r.quantity}`));
  const classes = (description: string) =>
    new Set(inputs.thresholds.filter((r) => r.description === description).map((r) => r.code));
  const withClasses = { H: classes(H_DESCRIPTION), Q: classes(Q_DESCRIPTION) };
  // Tier 1 = the roadmap-1 key stations and every station with a row of the seed tier `sea` (P16b, Q3).
  const seaCodes = new Set(inputs.seed.filter((r) => r.tier === 'sea').map((r) => r.code));
  const newCodes = new Set(inputs.seed.filter((r) => NEW_TIERS.has(r.tier ?? '')).map((r) => r.code));

  const rows: PublicStation[] = [];
  const skipped: Skipped[] = [];
  const notLiveSeen = new Set<string>();
  const chosenSeen = new Set<string>();
  for (const [i, r] of inputs.seed.entries()) {
    const code = str(r.code, `seed[${i}].code`);
    const quantity = r.quantity;
    const kind = KINDS.get(`${quantity}/${r.tier}`);
    if (kind === undefined || (quantity !== 'H' && quantity !== 'Q')) {
      throw new Error(`seed ${code}: unknown quantity/tier ${quantity}/${r.tier}`);
    }
    const note = r.note ?? '';
    if (!kind.notes.includes(note)) throw new Error(`seed ${code} ${quantity}/${r.tier}: unknown note "${note}"`);
    const hoedanigheid = (r.hoedanigheid ?? '') === '' ? kind.hoedanigheid : (r.hoedanigheid as string);
    if (!kind.allowed.includes(hoedanigheid)) {
      throw new Error(`seed ${code} ${quantity}/${r.tier}: unknown hoedanigheid "${r.hoedanigheid}"`);
    }
    const series = `${code}/${kind.grootheid}/${hoedanigheid}`;
    const at = `series ${series}`;
    // Deduplicated on (CODE, GROOTHEIDCODE, HOEDANIGHEIDCODE, method): the snapshot repeats a few features.
    const features = live.get(series) ?? [];
    const methods = [...new Set(features.map((f) => f.method))].filter((m) => !stale(`${series}/${m}`));
    if (stale(series) || (features.length > 0 && methods.length === 0)) {
      skipped.push({ code, quantity, reason: 'stale' });
      continue;
    }
    if (NOT_LIVE.has(series)) {
      notLiveSeen.add(series);
      if (features.length > 0) throw new Error(`${at} is in NOT_LIVE but the WFS shows it live: register it`);
      skipped.push({ code, quantity, reason: 'not live', why: NOT_LIVE.get(series) });
      continue;
    }
    const chosen = CHOSEN.get(series);
    if (chosen !== undefined) {
      chosenSeen.add(series);
      if (methods.length < 2 || !methods.includes(chosen))
        throw new Error(`${at}: CHOSEN ${chosen} is not one of ${methods.join(', ')}`);
    }
    const [method, ...others] = chosen === undefined ? methods : [chosen];
    if (method === undefined) throw new Error(`${at}: no live feature in the WFS snapshot (add it to NOT_LIVE?)`);
    if (others.length > 0) throw new Error(`${at}: ${methods.length} live methods (${methods.join(', ')})`);

    const loc = location(code);
    if (loc === undefined) throw new Error(`${at}: ${code} is not in the catalogue`);
    for (const f of features) {
      if (f.unit !== kind.unit) throw new Error(`${at}: unit "${f.unit}" in the WFS, expected ${kind.unit}`);
      if (Math.abs(f.lon - loc.lon) > COORDINATE_TOLERANCE || Math.abs(f.lat - loc.lat) > COORDINATE_TOLERANCE) {
        throw new Error(`${at}: WFS coordinates ${f.lon} ${f.lat} disagree with the catalogue ${loc.lon} ${loc.lat}`);
      }
    }

    const tier1 = TIER1.has(code) || seaCodes.has(code);
    const twin = kind.role === 'twin' || hoedanigheid === 'TAW';
    const type = places.get(code)?.row.type;
    const lake = type === 'lake';
    const tidal = TIDAL.has(code) || (type !== undefined && TIDAL_TYPES.has(type));
    const water = newCodes.has(code) ? (WATERS.get(code) ?? null) : null;
    if (WATERS.has(code) && !newCodes.has(code)) throw new Error(`WATERS ${code} is a roadmap-1 station`);
    if (water !== null && !evident(water, code, loc.name)) throw new Error(`WATERS ${code}: no evidence for ${water}`);
    // The NL-4 classes and the RWS forecasts are in NAP: a TAW twin and an MSL series have neither.
    const nap = hoedanigheid === 'NAP' || hoedanigheid === 'NVT';
    rows.push({
      id: `nl.rws.${code}`,
      source: 'NL-1',
      provider_code: code,
      provider_key: `${series}/${method}`,
      name: loc.name,
      water_name: water,
      // The 9 seed rows noted `be` are the RWS points on Belgian soil (catalogue §0.6, P5a): primary rows, country BE.
      country: note === 'be' ? 'BE' : 'NL',
      lon: loc.lon,
      lat: loc.lat,
      quantity,
      tier: tier1 ? 1 : 2,
      role: twin ? 'twin' : 'primary',
      river: null,
      km: null,
      flags: { tidal: tidal ? true : tier1 ? false : null, impounded: null, ...(lake ? { lake: true } : {}) },
      native_unit: quantity === 'H' ? 'cm' : 'm³/s',
      to_canonical: 1,
      value_kind: quantity === 'H' ? 'level' : null,
      native_step: 'PT10M',
      expected_step: 'PT10M',
      staleness_limit: STALENESS.get(series) ?? kind.staleness,
      // The NL-4 classes and the RWS forecasts are in NAP: the TAW twin has neither.
      expected_threshold_source: nap && !twin && withClasses[quantity].has(code) ? 'NL-4' : null,
      expected_forecast_source: nap && !twin && forecast.has(`${code}/${quantity}`) ? 'NL-1' : null,
      licence_gate: 'open',
      // first_release = public, primary and tier 1 (the repository rule, pinned by classification-pins).
      first_release: tier1 && !twin,
      audience: 'public',
      datum: quantity === 'Q' ? null : (hoedanigheid as 'NAP' | 'TAW' | 'MSL'),
      gauge_zero: [],
    });
  }

  // The structure-internal locations (lock chambers, gate slots, pumping stations, the Pannerden control works):
  // registered, audience off, so that the loader knows them and stores nothing. Never in a seed or a spec.
  const off: [string, string][] = [];
  const seedCodes0 = new Set(inputs.seed.map((r) => r.code));
  for (const [code, place] of places) {
    if (place.row.type !== 'structure') continue;
    if (seedCodes0.has(code)) throw new Error(`structure-internal ${code} is in the seed`);
    const loc = location(code);
    if (loc === undefined) throw new Error(`structure-internal ${code} is not in the catalogue`);
    off.push([code, place.row.reason ?? '']);
    for (const s of place.series) {
      const quantity = s.quantity;
      const hoedanigheid = quantity === 'Q' ? 'NVT' : 'NAP';
      if (s.hoedanigheid !== hoedanigheid)
        throw new Error(`structure ${code}/${quantity}: Hoedanigheid ${s.hoedanigheid}`);
      for (const method of s.methods) {
        rows.push({
          id: `nl.rws.${code}`,
          source: 'NL-1',
          provider_code: code,
          provider_key: `${code}/${quantity === 'H' ? 'WATHTE' : 'Q'}/${hoedanigheid}/${method}`,
          name: loc.name,
          water_name: null,
          country: 'NL',
          lon: loc.lon,
          lat: loc.lat,
          quantity,
          tier: 2,
          role: 'primary',
          river: null,
          km: null,
          flags: { tidal: null, impounded: null },
          native_unit: quantity === 'H' ? 'cm' : 'm³/s',
          to_canonical: 1,
          value_kind: quantity === 'H' ? 'level' : null,
          native_step: 'PT10M',
          expected_step: 'PT10M',
          staleness_limit: 'PT3H',
          expected_threshold_source: null,
          expected_forecast_source: null,
          licence_gate: 'open',
          first_release: false,
          audience: 'off',
          datum: quantity === 'H' ? 'NAP' : null,
          gauge_zero: [],
        });
      }
    }
  }

  // The curated tables against the result: nothing may have drifted silently.
  const codes = new Set(rows.map((r) => r.provider_code));
  const seedCodes = new Set(inputs.seed.map((r) => r.code));
  for (const code of TIER1) {
    if (!seedCodes.has(code)) throw new Error(`tier-1 station ${code} is not in the seed`);
    if (location(code) === undefined) throw new Error(`tier-1 station ${code} is not in the catalogue`);
    if (!codes.has(code)) throw new Error(`tier-1 station ${code} ends up with no row`);
  }
  for (const code of TIDAL) {
    if (TIER1.has(code)) throw new Error(`tidal station ${code} is also tier 1`);
    if (!codes.has(code)) throw new Error(`tidal station ${code} ends up with no row`);
  }
  for (const [code, water] of WATERS) {
    if (!rows.some((r) => r.provider_code === code && r.water_name === water)) {
      throw new Error(`WATERS ${code} matches no row`);
    }
  }
  for (const r of rows) {
    // MSL is the offshore platforms' datum: every MSL row is offshore and every offshore H row is MSL.
    if (r.audience === 'off') continue;
    const offshore = places.get(r.provider_code)?.row.type === 'offshore';
    if (r.quantity === 'H' && (r.datum === 'MSL') !== offshore) {
      throw new Error(`${r.id}: datum ${r.datum} on a ${offshore ? 'offshore' : 'non-offshore'} location`);
    }
  }
  for (const series of CHOSEN.keys()) {
    if (!chosenSeen.has(series)) throw new Error(`CHOSEN ${series} is no longer a seed row`);
  }
  for (const series of NOT_LIVE.keys()) {
    if (!notLiveSeen.has(series)) throw new Error(`NOT_LIVE ${series} is no longer a seed row`);
  }
  for (const series of STALENESS.keys()) {
    if (!rows.some((r) => r.provider_key.startsWith(`${series}/`))) {
      throw new Error(`staleness override ${series} matches no row`);
    }
  }

  // Code (code-unit order, never locale; \0 sorts a code before its longer namesakes), H before Q, primary before twin.
  const sortKey = (r: PublicStation) => `${r.provider_code}\0${r.quantity}${r.role === 'twin' ? 1 : 0}`;
  rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  // Duplicates, unit declarations and the schema; the test repeats this against the real sources.yaml.
  const sources = [
    { id: 'NL-1', audience: 'public' },
    { id: 'NL-4', audience: 'public' },
  ] as const;
  const { problems } = validateStations({ stations: rows }, sources);
  if (problems.length > 0) throw new Error(`the generated rows fail validateStations:\n${problems.join('\n')}`);
  return { rows, skipped, off };
}

/** Indented `#` comment lines of at most 118 characters; a long line continues further indented. */
function comment(text: string): string[] {
  const lines: string[] = [];
  let line = '#  ';
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > 118 && line !== '#  ') {
      lines.push(line);
      line = '#    ';
    }
    line = `${line} ${word}`;
  }
  return [...lines, line];
}

function header(inputs: Inputs, skipped: Skipped[], off: [string, string][]): string {
  const list = (reason: Skipped['reason']) =>
    skipped
      .filter((s) => s.reason === reason)
      .map((s) => `${s.code} ${s.quantity}${s.why === undefined ? '' : ` (${s.why})`}`)
      .join(', ');
  return [
    '# NL-1 station registry (Rijkswaterstaat WaterWebservices): one row per station and series (WATHTE is H, Q is Q).',
    '# GENERATED by scripts/gen-nl1-stations.ts from the inputs below. Do not edit by hand: change the generator (or',
    '# re-record a fixture) and run `node scripts/gen-nl1-stations.ts`.',
    '#   registry/seed/nl-1.csv                                     the series captured (tiers key, other, twin, sea, wide, slow)',
    '#   registry/seed/nl-1-forecast.csv                            the RWS forecast locations',
    `#   ${CATALOGUE}  recorded_at ${inputs.recordedAt.catalogue}  codes, names, coordinates`,
    `#   ${WFS}  recorded_at ${inputs.recordedAt.wfs}  the live method of each series`,
    `#   registry/thresholds/nl-4.csv                               edition ${inputs.edition}  Waterinfo display classes`,
    '# provider_key = <code>/<Grootheid>/<Hoedanigheid>/<WaardeBepalingsMethode>, as the NL-1 normaliser builds it.',
    '# tier 1 (first_release) = the curated key stations of the Rhine branches, IJssel, Meuse, Geul and Vecht; every row',
    '# of such a station is tier 1. role twin = eijsden.grens asked in TAW (registry/twins.yaml): tier 1, not first_release.',
    '# country BE = the 9 seed rows noted `be` (catalogue §0.6: the 7 RWS points on Belgian soil, antwerpen, lixhebiefaval,',
    '# maaseik, herenlaak, lanaken, smeermaas.zuidwillemsvaart and kanne): ordinary tier-2 primary rows, public (A§7.2 exception',
    '# until a Belgian source is public, P13). kanne has no river until the water body is verified (catalogue §10 R9).',
    '# P16b: tier 1 also holds every station with a seed row of tier `sea` (the owner-reviewed coastal gauges and the two lake',
    '# references); tier 1 is first_release for a primary row (the repository rule), so these join the first release. The sea, wide and slow tiers (tide, lakes, canals,',
    '# regulated water, offshore platforms) have their kinds in the generator; their Hoedanigheid is the seed column: NAP, MSL',
    '# (offshore platforms: the datum of every offshore H row) or TAW (a second Meuse series: role twin, no pair).',
    '# tidal true = the curated roadmap-1 sea and estuary gauges and every location of the water types coast (Wadden Sea',
    '# included), Scheldt estuaries, tidal delta and offshore of scripts/rws-inventory.ts, false = the other tier-1 gauges,',
    '# null = unknown (RWS metadata cannot tell river from tide). lake true = the water type lake. river and km are null;',
    '# water_name is null but for the new rows whose RWS code or catalogue name contains the water (WATERS in the generator).',
    '# Seed rows not registered:',
    ...comment(`stale at the provider (STALE_SERIES of the NL-1 normaliser): ${list('stale')}.`),
    ...comment(`not live (NOT_LIVE in the generator): ${list('not live')}.`),
    '# Structure-internal locations (lock chambers, gate slots, pumping stations, the Pannerden control works; never shown),',
    '# registered with audience off so that the loader knows them and stores nothing:',
    ...comment(`${off.map(([code, reason]) => `${code} (${reason})`).join(', ')}.`),
    '',
  ].join('\n');
}

/**
 * The YAML text of the NL-1 station file for the inputs. Pure: the same input gives
 * byte-identical output.
 */
export function generate(inputs: Inputs): string {
  const { rows, skipped, off } = build(inputs);
  // YAML 1.1 rules quote what a 1.1 reader would misread: numeric codes, dates, "off"/"no"/"on".
  return header(inputs, skipped, off) + stringify({ stations: rows }, { version: '1.1', lineWidth: 0 });
}

/** The inputs: the two seed lists, the recorded fixtures with their recorded_at, and the NL-4 classes. */
export function readInputs() {
  const text = (path: string) => readFileSync(join(root, path), 'utf8');
  const recorded = (spec: string) =>
    str(obj(JSON.parse(text(`${spec}.meta.json`)), spec).recorded_at, `${spec}.recorded_at`);
  const thresholds = readThresholds(text(THRESHOLDS));
  return {
    seed: readSeed(REGISTRY_DIR, 'nl-1'),
    forecast: readSeed(REGISTRY_DIR, 'nl-1-forecast'),
    catalogue: JSON.parse(text(CATALOGUE)) as unknown,
    wfs: JSON.parse(text(WFS)) as unknown,
    thresholds: thresholds.rows,
    edition: thresholds.edition,
    recordedAt: { catalogue: recorded(CATALOGUE.replace(/\.raw$/, '')), wfs: recorded(WFS.replace(/\.raw$/, '')) },
  };
}

if (import.meta.main) {
  const inputs = readInputs();
  const text = generate(inputs);
  writeFileSync(OUTPUT, text);
  const rows = text.split('\n').filter((line) => line.startsWith('  - id: ')).length;
  console.log(`wrote ${OUTPUT}: ${rows} rows from ${inputs.seed.length} seed rows`);
}
