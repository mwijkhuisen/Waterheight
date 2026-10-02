// Generates registry/stations/be-3.yaml (the BE-3 station registry: SPW Wallonia KiWIS, owner audience) and
// registry/twins/be-3.yaml (the owner twin pairs) from registry/seed/be-3-stations.csv (one row per observed series of
// the groups 1962373 and 1962340: identification only) and the public registry rows the twins name (FR-1, NL-1).
// Deterministic: the same input gives the same bytes.
//
//   node scripts/gen-be3-stations.ts                      regenerate the two files
//   node scripts/gen-be3-stations.ts --extract <dir>      write registry/seed/be-3-stations.csv from an owner export of
//                                                         the archive (the newest be-3-meta lists; outside the repo)
//   node scripts/gen-be3-stations.ts --explain            the SPW candidates near each FR-1 Belgian partner and each
//                                                         public primary within 1 km (to curate SAME_GAUGE)
//
// Every H, H_sonde, Habs, Habs_sonde, Q and QADM series of the two groups is registered (owner decision Q2,
// 2026-10-02), keyed `<station_no>/<stationparameter_no>` (never a name: "HASTIERE" 8622 is on the Hermeton, DCENN
// "Dinant" L8470 on the Fonds de Leffe). Rows identify only (invariant 11: no datum, zero, value, threshold or
// forecast; the strict OwnerStation schema refuses them). Per station and quantity one series is primary by the
// preference H > Habs > H_sonde > Habs_sonde and Q > QADM, the next one a twin (unpaired: the same gauge measured
// twice is not shown twice), and a third fails. The FR-1 §0.6 partner stations operated by SPW stay FR-1 primary in
// both audiences (A§7.2): their SPW series are twins, paired with a `constant` relation (two gauge zeros of one
// gauge, the difference detected, not declared). Steps by operator (catalogue §2.4): DGH 5 min, DCENN 10 min, QADM
// hourly; the layer is fetched every 10 minutes, so the expected step is at least 10 minutes. Fails loudly on
// anything it does not know: an operator, parameter or unit outside the tables, a station whose rows disagree on its
// name or position, a curated station number the list lacks.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseTable } from '../apps/server/src/adapters/_shared/kiwis/parse.ts';
import { type PublicStation, StationsFile, validateStations } from '../packages/contracts/src/stations.ts';
import { TO_CANONICAL } from '../packages/contracts/src/units.ts';
import { scanCsv } from '../packages/core/src/csv.ts';

const root = join(import.meta.dirname, '..');
export const SEED = 'registry/seed/be-3-stations.csv';
export const OUTPUT = join(root, 'registry/stations/be-3.yaml');
export const TWINS_OUTPUT = join(root, 'registry/twins/be-3.yaml');
/** The station files of the other sources (owner files are this generator's and LU-2's). */
const OWNER_FILES: ReadonlySet<string> = new Set(['be-3.yaml', 'lu-2.yaml']);
const COLUMNS = ['station_no', 'operator', 'parameter', 'unit', 'name', 'lat', 'lon', 'water_name'] as const;

export type SeedRow = Record<(typeof COLUMNS)[number], string>;
export type Inputs = { seed: SeedRow[]; publicRows: PublicStation[] };

/** The parameters registered, in preference order per quantity, with unit, value kind and the canonical factor. */
const PARAMETERS: Readonly<
  Record<string, { quantity: 'H' | 'Q'; rank: number; unit: 'm' | 'm³/s'; kind: 'stage' | 'level' | null }>
> = {
  H: { quantity: 'H', rank: 0, unit: 'm', kind: 'stage' },
  Habs: { quantity: 'H', rank: 1, unit: 'm', kind: 'level' },
  H_sonde: { quantity: 'H', rank: 2, unit: 'm', kind: 'stage' },
  Habs_sonde: { quantity: 'H', rank: 3, unit: 'm', kind: 'level' },
  Q: { quantity: 'Q', rank: 0, unit: 'm³/s', kind: null },
  QADM: { quantity: 'Q', rank: 1, unit: 'm³/s', kind: null },
};
/** The native step by operator (`site_no`), and QADM's own. */
/**
 * EUP and GIL are the Eupen and Gileppe dam lakes (one absolute `Habs` each, flagged reservoir): on the 5-minute grid
 * in the layers of 2026-10-02.
 */
const STEP: Readonly<Record<string, string>> = { DGH: 'PT5M', DCENN: 'PT10M', EUP: 'PT5M', GIL: 'PT5M' };
const RESERVOIR_OPERATORS: ReadonlySet<string> = new Set(['EUP', 'GIL']);
const MINUTES: Readonly<Record<string, number>> = { PT5M: 5, PT10M: 10, PT1H: 60 };

/** Tier 1 (first-release key gauges of the owner view): the bold Walloon gauges of catalogue §3.2–§3.4. */
export const TIER1: ReadonlySet<string> = new Set([
  '8702', // Chooz (Meuse)
  '8078', // Waulsort
  '8221', // Gendron (Lesse)
  '8059', // Dinant (DGH; not DCENN L8470)
  '7319', // Salzinnes-Ronet (Sambre)
  '8001', // Namur
  '7141', // Huy
  '5921', // Tabreux (Ourthe)
  '6621', // Martinrive (Amblève)
  '6228', // Chaudfontaine Piscine (Vesdre)
  '7102', // Liège
  '5451', // Visé
  '5447', // Lixhe Bief Amont
  '5436', // Lixhe Aval
  '5291', // Kelmis (Geul)
  'L6660', // Sippenaeken (Geul, at the NL border)
  '3282', // Tournai (Escaut)
  '3270', // Pecq (Escaut)
  'L5610', // Martelange (Sûre)
]);

/**
 * The navigable Meuse and Sambre: weir-controlled stages (catalogue §2.4), flagged impounded; Q is the flow signal.
 * SPW names the reach (`Basse Meuse`, `Meuse moyenne`, `Haute Meuse (amont Dinant)`, `Haute Sambre`, `Basse Sambre`):
 * on 2026-10-02 the 25 stations so named were all DGH gauges on the two rivers themselves, none on a tributary.
 */
const IMPOUNDED_WATER = /\b(?:meuse|sambre)\b/i;

/**
 * The public gauges SPW also measures, curated with `--explain` on the lists of 2026-10-02 (positions within 50 m,
 * names checked): public station (source, provider_code) → SPW station number. The public series stay primary in
 * both audiences (A§7.2, A§7.4 step 6); the SPW series of the same quantity is a twin, paired with a `constant`
 * relation (the two sides may state their stage against different gauge zeros: the difference is detected).
 */
export const SAME_GAUGE: readonly {
  source: 'FR-1' | 'NL-1';
  code: string;
  spw: string;
  /** Only this quantity (default: every quantity both stations have). */
  quantity?: 'H' | 'Q';
  /** A wider bound than SAME_GAUGE_M, with its reason in the comment. */
  within?: number;
}[] = [
  // The §0.6 Belgian partner stations in FR-1: Hub'Eau's copies of SPW gauges.
  { source: 'FR-1', code: 'B400101101', spw: 'L6023' }, // Chiers, Athus (16 m)
  { source: 'FR-1', code: 'B422431101', spw: '9741' }, // Chiers, Torgny (19 m)
  { source: 'FR-1', code: 'B423000102', spw: 'L5520' }, // Ton, Harnoncourt (29 m)
  { source: 'FR-1', code: 'B610000201', spw: '9434' }, // Semois, Membre (20 m)
  { source: 'FR-1', code: 'B610000301', spw: '9561' }, // Semois, Tintigny (49 m)
  { source: 'FR-1', code: 'B610000401', spw: '9541' }, // Semois, Chiny (27 m)
  { source: 'FR-1', code: 'B610000601', spw: '9461' }, // Semois, Bouillon (27 m)
  { source: 'FR-1', code: 'B610000701', spw: '9571' }, // Semois, Sainte-Marie (12 m)
  { source: 'FR-1', code: 'B610000801', spw: '9651' }, // Semois, Straimont (7 m)
  { source: 'FR-1', code: 'B713000101', spw: '9021' }, // Viroin, Treignes (17 m)
  { source: 'FR-1', code: 'B713000201', spw: '9071' }, // Viroin, Couvin (9 m)
  { source: 'FR-1', code: 'B713000301', spw: '9081' }, // Viroin, Nismes (12 m)
  { source: 'FR-1', code: 'B732201101', spw: '8661' }, // Houille, Felenne (43 m)
  { source: 'FR-1', code: 'D022000101', spw: '7978' }, // Thure, Bersillies-l'Abbaye (8 m)
  { source: 'FR-1', code: 'D022000201', spw: 'L6880' }, // Hante, Beaumont (17 m)
  { source: 'FR-1', code: 'D022000301', spw: '7944' }, // Hante, Wiheries (8 m)
  { source: 'FR-1', code: 'E182702501', spw: 'L6710' }, // Trouille, Givry (1 m)
  // French gauges on the border that SPW measures too.
  { source: 'FR-1', code: 'B720000002', spw: '8702' }, // Meuse, Chooz Île Graviat (24 m)
  { source: 'FR-1', code: 'D015850401', spw: 'L7950' }, // Helpe Majeure, Moustier-en-Fagne (9 m)
  { source: 'FR-1', code: 'E182701002', spw: 'L7260' }, // Hogneau, Gussignies (22 m)
  { source: 'FR-1', code: 'E182702602', spw: 'L6870' }, // Aunelle, Marchipont (10 m)
  // RWS's copy of SPW's gauge below the last weir before NL.
  { source: 'NL-1', code: 'lixhebiefaval', spw: '5436' }, // Lixhe Aval (27 m)
  // RWS's discharge at the border, 224 m below Lixhe Aval: whether it is SPW's own figure relayed is unverified, so
  // the owner view shows the public one, and the twin check reports how SPW's relates to it.
  { source: 'NL-1', code: 'eijsden.grens', spw: '5436', quantity: 'Q', within: 300 }, // Eijsden-grens (224 m)
];
/** How far apart a curated pair's two positions may be. */
const SAME_GAUGE_M = 100;

type Row = Record<string, unknown>;

/** Metres between two WGS84 points (haversine). */
export function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function build(inputs: Inputs): { rows: Row[]; twins: Row[] } {
  const byStation = new Map<string, SeedRow[]>();
  for (const s of inputs.seed) {
    const p = PARAMETERS[s.parameter];
    if (p === undefined)
      throw new Error(`${s.station_no}: parameter ${s.parameter} is not registered (a reviewed decision)`);
    if (!Object.hasOwn(STEP, s.operator)) throw new Error(`${s.station_no}: operator ${s.operator} unknown`);
    const unit = s.unit === 'm3/s' || s.unit === 'cumec' ? 'm³/s' : s.unit;
    if (unit !== p.unit) throw new Error(`${s.station_no}/${s.parameter}: unit ${s.unit} is not ${p.unit}`);
    byStation.set(s.station_no, [...(byStation.get(s.station_no) ?? []), s]);
  }
  for (const no of TIER1) if (!byStation.has(no)) throw new Error(`TIER1 ${no}: not in the groups`);
  const twinOf = new Map<string, PublicStation>();
  const pairs: Row[] = [];
  for (const g of SAME_GAUGE) {
    const spw = byStation.get(g.spw);
    const pub = inputs.publicRows.filter((r) => r.source === g.source && r.provider_code === g.code);
    if (spw === undefined || pub.length === 0) throw new Error(`SAME_GAUGE ${g.source} ${g.code} ~ ${g.spw}: missing`);
    for (const r of pub.filter((x) => g.quantity === undefined || x.quantity === g.quantity)) {
      if (r.role === 'twin' && g.source === 'NL-1') continue; // eijsden.grens's TAW copy: already a twin
      if (r.role !== 'primary' || r.audience !== 'public')
        throw new Error(`SAME_GAUGE ${g.source} ${g.code}: not a public primary`);
      const at = { lon: Number(spw[0]?.lon), lat: Number(spw[0]?.lat) };
      const limit = g.within ?? SAME_GAUGE_M;
      if (r.lon === null || r.lat === null || metres(at, { lon: r.lon, lat: r.lat }) > limit)
        throw new Error(`SAME_GAUGE ${g.source} ${g.code} ~ ${g.spw}: more than ${limit} m apart`);
      const mate = spw.find((s) => PARAMETERS[s.parameter]?.quantity === r.quantity);
      if (mate !== undefined) twinOf.set(`${g.spw}/${mate.parameter}`, r);
    }
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const [no, series] of [...byStation].sort(([a], [b]) => a.localeCompare(b))) {
    const first = series[0] as SeedRow;
    for (const s of series) {
      if (s.name !== first.name || s.lat !== first.lat || s.lon !== first.lon || s.water_name !== first.water_name) {
        throw new Error(`${no}: its series disagree on name, position or water`);
      }
    }
    const lon = Number(first.lon);
    const lat = Number(first.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`${no}: no position`);
    for (const quantity of ['H', 'Q'] as const) {
      const of = series
        .filter((s) => PARAMETERS[s.parameter]?.quantity === quantity)
        .sort((a, b) => (PARAMETERS[a.parameter]?.rank ?? 0) - (PARAMETERS[b.parameter]?.rank ?? 0));
      if (of.length > 2) throw new Error(`${no}/${quantity}: ${of.length} series (one primary and one twin at most)`);
      // A series a public primary already shows is a twin; then the station has no other of that quantity.
      const paired = of.filter((s) => twinOf.has(`${no}/${s.parameter}`));
      if (paired.length > 0 && of.length > 1) throw new Error(`${no}/${quantity}: a paired series beside another`);
      of.forEach((s, i) => {
        const key = `${no}/${s.parameter}`;
        used.add(key);
        const p = PARAMETERS[s.parameter] as (typeof PARAMETERS)[string];
        const native = s.parameter === 'QADM' ? 'PT1H' : (STEP[s.operator] as string);
        const expected = (MINUTES[native] as number) < 10 ? 'PT10M' : native;
        const staleMin = Math.max(3 * (MINUTES[expected] as number), 45);
        rows.push({
          id: `be.spw.${no}`,
          source: 'BE-3',
          provider_code: no,
          provider_key: key,
          name: first.name,
          water_name: first.water_name === '' ? null : first.water_name,
          country: 'BE',
          lon,
          lat,
          quantity,
          tier: TIER1.has(no) ? 1 : 2,
          role: twinOf.has(key) || i > 0 ? 'twin' : 'primary',
          river: null,
          km: null,
          flags: {
            tidal: null,
            impounded: IMPOUNDED_WATER.test(first.water_name) ? true : null,
            ...(RESERVOIR_OPERATORS.has(s.operator) ? { reservoir: true } : {}),
          },
          native_unit: p.unit,
          to_canonical: TO_CANONICAL[p.unit],
          value_kind: p.kind,
          native_step: native,
          expected_step: expected,
          staleness_limit: staleMin % 60 === 0 ? `PT${staleMin / 60}H` : `PT${staleMin}M`,
          expected_threshold_source: null,
          expected_forecast_source: null,
          licence_gate: 'owner-only',
          first_release: false,
          audience: 'owner',
        });
        const mate = twinOf.get(key);
        if (mate !== undefined) {
          pairs.push({
            id: `${mate.provider_code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${mate.source.toLowerCase().replace('-', '')}-be3-${quantity.toLowerCase()}`,
            a: { source: mate.source, provider_key: mate.provider_key },
            b: { source: 'BE-3', provider_key: key },
            relation: {
              kind: 'constant',
              tolerance: quantity === 'Q' ? 0.01 : 1,
              unit: quantity === 'Q' ? 'm³/s' : 'cm',
              min_share: 0.95,
            },
          });
        }
      });
    }
  }
  for (const spw of twinOf.keys()) if (!used.has(spw)) throw new Error(`twin ${spw}: not a registered SPW series`);
  pairs.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const check = validateStations({ stations: rows }, [{ id: 'BE-3', audience: 'owner' }]);
  if (check.problems.length > 0) throw new Error(check.problems.slice(0, 10).join('\n'));
  return { rows, twins: pairs };
}

const HEADER = `# BE-3 station registry (SPW Wallonia KiWIS, owner audience: catalogue §0.8, D22): one row per observed series of the
# groups 1962373 (levels) and 1962340 (discharge).
# GENERATED by scripts/gen-be3-stations.ts from registry/seed/be-3-stations.csv (identification only, extracted from the
# owner's archive export) and the curated tables of the generator. Do not edit by hand: change the generator or the seed
# and run \`node scripts/gen-be3-stations.ts\`.
# Identification only (invariant 11): number, name as published, position, water; no datum, gauge zero, value,
# threshold or forecast (the gauge zeros come from be-3-meta at load time, never from the repository).
# provider_key = <station_no>/<stationparameter_no>; never a name (HASTIERE 8622 is on the Hermeton; DCENN Dinant L8470
# is on the Fonds de Leffe, DGH DINANT 8059 on the Meuse).
`;

export function generate(inputs: Inputs): { stations: string; twins: string } {
  const { rows, twins } = build(inputs);
  const stations = new Set(rows.map((r) => r.id)).size;
  return {
    stations: `${HEADER}# Rows: ${rows.length} series at ${stations} stations; tier 1: ${TIER1.size} stations.\n${stringify({ stations: rows }, { version: '1.1', lineWidth: 0 })}`,
    twins: `# The SPW twins of public primaries (owner audience: their results are in the owner channel only): the §0.6 FR-1
# partner stations operated by SPW, and any other public gauge SPW also measures. \`constant\`: the difference of the
# two gauge zeros is detected (the median), not declared.
# GENERATED by scripts/gen-be3-stations.ts with registry/stations/be-3.yaml.
${stringify({ twins }, { version: '1.1', lineWidth: 0 })}`,
  };
}

function readSeed(text: string): SeedRow[] {
  const { header, rows } = scanCsv(text, { delimiter: ',', commentPrefix: '#' });
  if (header.join(',') !== COLUMNS.join(',')) throw new Error(`${SEED}: header is not ${COLUMNS.join(',')}`);
  return rows.map((r) => Object.fromEntries(COLUMNS.map((c, i) => [c, r[i] ?? ''])) as SeedRow);
}

export function readInputs(): Inputs {
  const files = readdirSync(join(root, 'registry/stations'))
    .filter((f) => f.endsWith('.yaml') && !OWNER_FILES.has(f))
    .sort();
  const publicRows = files.flatMap((f) =>
    StationsFile.parse(parse(readFileSync(join(root, 'registry/stations', f), 'utf8'))).stations.filter(
      (s): s is PublicStation => s.audience !== 'owner',
    ),
  );
  return { seed: readSeed(readFileSync(join(root, SEED), 'utf8')), publicRows };
}

const csvField = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** The newest be-3-meta payload of a variant in an owner export (pairs `<spec>-<n>.raw` / `.line.json`). */
function newestMeta(dir: string, variant: string): Buffer {
  let best: { at: string; file: string } | null = null;
  for (const f of readdirSync(dir).filter((n) => /^be-3-meta-\d+\.line\.json$/.test(n))) {
    const line = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      variant?: string;
      fetched_at?: { start?: string };
    };
    const at = line.fetched_at?.start ?? '';
    if (line.variant === variant && (best === null || best.at < at)) best = { at, file: f };
  }
  if (best === null) throw new Error(`no be-3-meta ${variant} payload in the export`);
  return readFileSync(join(dir, best.file.replace(/\.line\.json$/, '.raw')));
}

/** --extract: identification of every registered-parameter series of both groups. Prints counts only. */
function extract(dir: string): void {
  const stations = new Map(parseTable(newestMeta(dir, 'stations')).map((r) => [String(r.station_no), r]));
  const out: string[] = [];
  for (const group of ['1962373', '1962340']) {
    for (const r of parseTable(newestMeta(dir, `timeseries-${group}`))) {
      const parameter = String(r.stationparameter_no ?? '');
      if (!(parameter in PARAMETERS)) continue;
      const no = String(r.station_no ?? '');
      const st = stations.get(no);
      out.push(
        [
          no,
          String(r.site_no ?? ''),
          parameter,
          String(r.ts_unitsymbol ?? ''),
          String(r.station_name ?? ''),
          String(r.station_latitude ?? ''),
          String(r.station_longitude ?? ''),
          String(st?.river_name ?? ''),
        ]
          .map(csvField)
          .join(','),
      );
    }
  }
  const lines = [...new Set(out)].sort();
  writeFileSync(
    join(root, SEED),
    `# BE-3 SPW KiWIS series of the groups 1962373 and 1962340 with a registered parameter (H, H_sonde, Habs, Habs_sonde,
# Q, QADM): identification only (station number, operator, parameter, unit, name, WGS84 position and water as SPW
# publishes them; invariant 11). Extracted by \`node scripts/gen-be3-stations.ts --extract <export dir>\` from the owner's
# archive export of be-3-meta (never committed); the generator turns it into registry/stations/be-3.yaml.
${COLUMNS.join(',')}
${lines.join('\n')}
`,
  );
  console.log(`${SEED}: ${lines.length} series`);
}

/** --explain: the SPW stations within 1 km of each FR-1 Belgian partner and of each public primary (curation aid). */
function explain(): void {
  const { seed, publicRows } = readInputs();
  const spw = [...new Map(seed.map((s) => [s.station_no, s])).values()];
  for (const p of publicRows.filter(
    (r) => r.role === 'primary' && r.audience === 'public' && r.lon !== null && r.lat !== null,
  )) {
    const near = spw
      .map((s) => ({
        s,
        d: metres({ lon: Number(s.lon), lat: Number(s.lat) }, { lon: p.lon as number, lat: p.lat as number }),
      }))
      .filter((x) => x.d <= 1000)
      .sort((a, b) => a.d - b.d);
    if (near.length === 0 && !(p.source === 'FR-1' && p.country === 'BE')) continue;
    console.log(
      `${p.source}/${p.provider_key} ${p.name}: ${near.map((x) => `${x.s.station_no} ${x.s.name} (${Math.round(x.d)} m)`).join('; ') || 'none within 1 km'}`,
    );
  }
}

if (import.meta.main) {
  const i = process.argv.indexOf('--extract');
  if (i >= 0) {
    const dir = process.argv[i + 1];
    if (dir === undefined) {
      console.error('usage: node scripts/gen-be3-stations.ts [--extract <export dir> | --explain]');
      process.exit(64);
    }
    extract(dir);
  } else if (process.argv.includes('--explain')) {
    explain();
  } else {
    const { stations, twins } = generate(readInputs());
    writeFileSync(OUTPUT, stations);
    writeFileSync(TWINS_OUTPUT, twins);
    console.log(`wrote ${OUTPUT} and ${TWINS_OUTPUT}`);
  }
}
