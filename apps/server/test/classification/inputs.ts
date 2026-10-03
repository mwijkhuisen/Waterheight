import { readFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import {
  type AreaIn,
  type ClassIn,
  type ClassRow,
  classify,
  classSeries,
  type Datum,
  durationMs,
  type Normalised,
  napHeight,
  type ObsRow,
  obsParts,
  type ReferenceRow,
  type RefIn,
  type SeriesIn,
  type WarningRow,
} from '@rws/core';
import { parse } from 'yaml';
import { normaliseCube } from '../../src/adapters/ch-1/normalise.ts';
import { parseCube } from '../../src/adapters/ch-1/parse.ts';
import { normaliseFeatures } from '../../src/adapters/ch-2/normalise.ts';
import { parseFeatures } from '../../src/adapters/ch-2/parse.ts';
import { normaliseBasin, normaliseMeta } from '../../src/adapters/de-1/normalise.ts';
import { parseStations as parseDe1 } from '../../src/adapters/de-1/parse.ts';
import { normaliseStations as lhpClasses } from '../../src/adapters/de-6/normalise.ts';
import { parseStations as parseLhp } from '../../src/adapters/de-6/parse.ts';
import { normaliseObservations as fr1Obs, normaliseStations as fr1Ref } from '../../src/adapters/fr-1/normalise.ts';
import { parseObservations as parseFr1, parseStations as parseFr1Ref } from '../../src/adapters/fr-1/parse.ts';
import { normaliseVigilance } from '../../src/adapters/fr-5/normalise.ts';
import { parseVigilance } from '../../src/adapters/fr-5/parse.ts';
import { normalise as lu1Normalise } from '../../src/adapters/lu-1/normalise.ts';
import { parseCsv as parseLu1 } from '../../src/adapters/lu-1/parse.ts';
import { normalise as nl1Normalise } from '../../src/adapters/nl-1/normalise.ts';
import { parseWaarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { H_DESCRIPTION, Q_DESCRIPTION } from '../../src/adapters/nl-4/normalise.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { lhpStations, vigicruesSectionCodes, vigicruesSections } from '../../src/load/tables.ts';
import { readThresholds } from '../../src/load/thresholds.ts';
import { rawFixture, registryOf } from '../adapters/registry.ts';

// The inputs of the classification tests: rows that the REAL adapters produce from the committed real fixtures,
// turned into what `classify()` takes, the way the server's readStates builds it from the stored rows. Nothing here
// is invented except where a function says so.

export type Row = ReturnType<typeof StationsFile.parse>['stations'][number];

const REGISTRY = new URL('../../../../registry/', import.meta.url);
export const rowsOf = (source: string): Row[] =>
  StationsFile.parse(parse(readFileSync(new URL(`stations/${source.toLowerCase()}.yaml`, REGISTRY), 'utf8'))).stations;
export const fetchedAt = (source: string, name: string) => Date.parse(rawFixture(source, name).meta.recorded_at);

const once = <T>(make: () => T): (() => T) => {
  let v: T | undefined;
  return () => {
    if (v === undefined) v = make();
    return v;
  };
};
const latest = (obs: Iterable<ObsRow>) => {
  const m = new Map<string, ObsRow>();
  for (const o of obs) {
    const prev = m.get(o.series);
    if (prev === undefined || o.ts > prev.ts) m.set(o.series, o);
  }
  return m;
};
const refIn = (source: string, r: ReferenceRow): RefIn => ({
  source,
  kind: r.kind,
  value: r.value,
  unit: r.unit,
  convention: r.convention,
  period: r.period,
  seasonFrom: r.season_from_md,
  seasonTo: r.season_to_md,
  priority: r.priority,
  label: r.basis_label,
});
const refsOfSeries = (source: string, refs: readonly ReferenceRow[] | undefined, key: string, t: number): RefIn[] =>
  (refs ?? [])
    .filter((r) => r.series === key && (r.valid_from === null || Date.parse(r.valid_from) <= t))
    .map((r) => refIn(source, r));
const classIn = (source: string, c: ClassRow | undefined): ClassIn[] =>
  c === undefined ? [] : [{ source, code: c.code, fresh: true }];

/** What the golden needs of one value: the series row, its value and every row that reaches it. */
export type Case = {
  row: Row;
  obs: ObsRow;
  refs: RefIn[];
  classes: ClassIn[];
  areas: AreaIn[];
  /** The gauge zero valid at t, or null. */
  zero: { valueM: number; datum: Datum } | null;
};

/** The classifier's input of a case; `fresh` is true everywhere (the golden is about the mapping, not capture health). */
export function seriesIn(c: Case): SeriesIn {
  return {
    quantity: c.row.quantity,
    valueKind: c.row.value_kind,
    value: c.obs.value,
    qc: c.obs.qc,
    ageMs: 0,
    stalenessMs: durationMs(c.row.staleness_limit),
    t: Date.parse(c.obs.ts),
    refs: c.refs,
    classes: c.classes,
    areas: c.areas,
    tidal: c.row.flags.tidal ?? false,
    impounded: c.row.flags.impounded ?? false,
  };
}
export const napOf = (c: Case) =>
  napHeight({
    source: c.row.source,
    quantity: c.row.quantity,
    valueKind: c.row.value_kind,
    datum: 'datum' in c.row ? (c.row.datum as Datum | null) : null,
    valueCm: c.obs.value,
    zero: c.zero,
  });
export const classified = (c: Case) => classify(seriesIn(c), 'public');

/** The series of a station that a gauge class of `source` reaches (classSeries: stage → H, discharge → Q, else other). */
const reaches = (source: string, rows: readonly Row[], station: string, row: Row) =>
  classSeries(
    source,
    rows.filter((r) => r.id === station && r.role === 'primary'),
  )?.provider_key === row.provider_key;
const pick = (rows: readonly Row[], station: string, quantity: 'H' | 'Q') => {
  const row = rows.find((r) => r.id === station && r.quantity === quantity && r.role === 'primary');
  if (row === undefined) throw new Error(`no ${quantity} series of ${station}`);
  return row;
};
const last = (m: ReadonlyMap<string, ObsRow>, row: Row) => {
  const o = m.get(row.provider_key);
  if (o === undefined) throw new Error(`no value of ${row.provider_key}`);
  return o;
};

// --- DE-1 + DE-6 ---------------------------------------------------------------------------------------------------

export const de1 = once(() => {
  const registry = registryOf('DE-1');
  const at = (n: string) => fetchedAt('DE-1', n);
  const basin = normaliseBasin(parseDe1(rawFixture('DE-1', 'de-1-basin').body), {
    registry,
    fetchedAt: at('de-1-basin'),
    variant: '',
  });
  const meta = normaliseMeta(parseDe1(rawFixture('DE-1', 'de-1-meta').body), {
    registry,
    fetchedAt: at('de-1-meta'),
    variant: '',
  });
  const lhp = lhpClasses(
    parseLhp(rawFixture('DE-6', 'de-6-stations').body),
    lhpStations(),
    fetchedAt('DE-6', 'de-6-stations'),
  );
  return {
    rows: rowsOf('DE-1'),
    latest: latest(basin.obs),
    meta,
    lhp: new Map((lhp.classes ?? []).map((c) => [c.station, c])),
  };
}) as () => {
  rows: Row[];
  latest: Map<string, ObsRow>;
  meta: Normalised;
  lhp: Map<string, ClassRow>;
};

/** A DE-1 value of the recorded basin payload with the MNW/MHW/HSW of the meta payload and its LHP station class. */
export function de1Case(station: string, quantity: 'H' | 'Q' = 'H'): Case {
  const w = de1();
  const row = pick(w.rows, station, quantity);
  const obs = last(w.latest, row);
  const t = Date.parse(obs.ts);
  const z = w.meta.gaugeZeros.find(
    (g) => g.series === row.provider_key && (g.valid_from === null || Date.parse(g.valid_from) <= t),
  );
  return {
    row,
    obs,
    refs: refsOfSeries('DE-1', w.meta.references, row.provider_key, t),
    classes: reaches('DE-6', w.rows, station, row) ? classIn('DE-6', w.lhp.get(station)) : [],
    areas: [],
    zero: z === undefined ? null : { valueM: z.value_m, datum: z.datum as Datum },
  };
}

// --- DE-7 ----------------------------------------------------------------------------------------------------------

export const de7 = once(async () => {
  const registry = registryOf('DE-7');
  const ctx = (name: string) => ({
    registry,
    fetchedAt: fetchedAt('DE-7', name),
    variant: '',
    unitMismatch: new Set<string>(),
  });
  const run = async (spec: string, name: string) =>
    (await LOAD_ADAPTERS['DE-7']?.specs[spec]?.run(rawFixture('DE-7', name).body, ctx(name))) as Normalised;
  const values = await run('de-7-messwerte', 'de-7-messwerte-blocks');
  const pegel = await run('de-7-pegeldaten', 'de-7-pegeldaten-blocks');
  return { rows: rowsOf('DE-7'), latest: latest([...obsParts(values)].flat()), refs: pegel.references };
});

/** A DE-7 value of the recorded messwerte blocks with the LANUV levels of the recorded pegeldaten blocks. */
export async function de7Case(station: string): Promise<Case> {
  const w = await de7();
  const row = pick(w.rows, station, 'H');
  const obs = last(w.latest, row);
  return {
    row,
    obs,
    refs: refsOfSeries('DE-7', w.refs, row.provider_key, Date.parse(obs.ts)),
    classes: [],
    areas: [],
    zero: null,
  };
}

// --- NL-1 + NL-4 ---------------------------------------------------------------------------------------------------

export const nl1 = once(() => {
  const registry = registryOf('NL-1');
  const obs: ObsRow[] = [];
  for (const n of ['nl-1-obs-key', 'nl-1-obs-key-eijsden-grens-h', 'nl-1-obs-other-lobith-bovenrijn-tolkamer-q']) {
    obs.push(
      ...nl1Normalise(parseWaarnemingen(rawFixture('NL-1', n).body), {
        registry,
        fetchedAt: fetchedAt('NL-1', n),
      } as never).obs,
    );
  }
  const thresholds = readThresholds(readFileSync(new URL('thresholds/nl-4.csv', REGISTRY), 'utf8')).rows;
  return { rows: rowsOf('NL-1'), latest: latest(obs), thresholds };
});

/**
 * The NL-4 rows of a series as the registry sync stores them (registry-sync.ts nl4Bounds): the class rows of the
 * station code and the series' quantity, each as an NL4_FROM and an NL4_TO bound where it has one.
 */
export function nl4Refs(row: Row): RefIn[] {
  const want = row.quantity === 'H' ? H_DESCRIPTION : Q_DESCRIPTION;
  const unit = row.quantity === 'H' ? 'cm' : 'm³/s';
  const out: RefIn[] = [];
  for (const r of nl1().thresholds) {
    if (r.code !== row.provider_code || r.description !== want || r.from_md === null || r.to_md === null) continue;
    const base = { source: 'NL-4', unit, convention: null, period: null, seasonFrom: r.from_md, seasonTo: r.to_md };
    const rest = { priority: r.priority, label: r.label };
    if (r.from !== null) out.push({ ...base, ...rest, kind: 'NL4_FROM', value: r.from });
    if (r.to !== null) out.push({ ...base, ...rest, kind: 'NL4_TO', value: r.to });
  }
  return out;
}

/** An NL-1 value of the recorded REST payloads with its NL-4 classes. */
export function nl1Case(station: string, quantity: 'H' | 'Q' = 'H'): Case {
  const w = nl1();
  const row = rows(w.rows, station, quantity);
  return { row, obs: last(w.latest, row), refs: nl4Refs(row), classes: [], areas: [], zero: null };
}
const rows = (all: readonly Row[], station: string, quantity: 'H' | 'Q') => {
  const row = all.find(
    (r) => r.id === station && r.quantity === quantity && r.role === 'primary' && !('datum' in r && r.datum === 'TAW'),
  );
  if (row === undefined) throw new Error(`no ${quantity} series of ${station}`);
  return row;
};

/**
 * A tidal NL-1 value: no REST payload of a tidal station is recorded, so the value is the one of the NL-2 WFS snapshot
 * (the layer of last values; production never stores it: it shows stale values under fresh timestamps). Used here
 * only to put a real number through the D12 rule.
 */
export function nl1WfsCase(station: string): Case {
  const w = nl1();
  const row = rows(w.rows, station, 'H');
  const doc = JSON.parse(rawFixture('NL-2', 'nl-2-wfs').body.toString('utf8')) as {
    features: { properties: Record<string, string | number> }[];
  };
  const p = doc.features.find(
    (f) =>
      `${f.properties.CODE}/${f.properties.GROOTHEIDCODE}/${f.properties.HOEDANIGHEIDCODE}/${f.properties.WAARDEBEPALINGSMETHODECODE}` ===
      row.provider_key,
  )?.properties;
  if (p === undefined) throw new Error(`${row.provider_key} is not in the WFS snapshot`);
  const obs: ObsRow = {
    series: row.provider_key,
    ts: new Date(String(p.TIJDSTIP_LAATSTE_METING)).toISOString(),
    value: Number(p.WAARDE_LAATSTE_METING),
    qc: 0,
  };
  return { row, obs, refs: nl4Refs(row), classes: [], areas: [], zero: null };
}

// --- CH-1, CH-2 ----------------------------------------------------------------------------------------------------

export const ch = once(() => {
  const registry = registryOf('CH-1');
  const cubes = ['ch-1-lindas', 'ch-1-lindas-lake'].map((n) =>
    normaliseCube(parseCube(rawFixture('CH-1', n).body), { registry, fetchedAt: fetchedAt('CH-1', n) }),
  );
  const pq = normaliseFeatures(parseFeatures(rawFixture('CH-2', 'ch-2-pq').body), {
    registry: registryOf('CH-2'),
    fetchedAt: fetchedAt('CH-2', 'ch-2-pq'),
    refRegistries: new Map([['CH-1', registry]]),
  });
  return {
    rows: rowsOf('CH-1'),
    latest: latest(cubes.flatMap((c) => c.obs)),
    classes: new Map(cubes.flatMap((c) => c.classes ?? []).map((c) => [c.station, c])),
    refs: pq.references,
  };
});

/** A CH-1 value (river or lake cube) with its BAFU danger level and the CH-2 WL thresholds of its series. */
export function chCase(station: string, quantity: 'H' | 'Q'): Case {
  const w = ch();
  const row = pick(w.rows, station, quantity);
  const obs = last(w.latest, row);
  return {
    row,
    obs,
    refs: refsOfSeries('CH-2', w.refs, row.provider_key, Date.parse(obs.ts)),
    classes: reaches('CH-1', w.rows, station, row) ? classIn('CH-1', w.classes.get(station)) : [],
    areas: [],
    zero: null,
  };
}

// --- FR-1, FR-5 ----------------------------------------------------------------------------------------------------

export const fr = once(() => {
  const registry = registryOf('FR-1');
  const obs = fr1Obs(parseFr1(rawFixture('FR-1', 'fr-1-obs').body).data, {
    registry,
    fetchedAt: fetchedAt('FR-1', 'fr-1-obs'),
  } as never);
  const zeros = new Map<string, { valueM: number; datum: Datum }>();
  for (const n of ['fr-1-ref', 'fr-1-ref-B', 'fr-1-ref-D', 'fr-1-ref-E1', 'fr-1-ref-E2', 'fr-1-ref-E3']) {
    const out = fr1Ref(parseFr1Ref(rawFixture('FR-1', n).body), { registry, fetchedAt: fetchedAt('FR-1', n) } as never);
    for (const z of out.gaugeZeros) zeros.set(z.series, { valueM: z.value_m, datum: z.datum as Datum });
  }
  return { rows: rowsOf('FR-1'), latest: latest(obs.obs), zeros };
});

/** The section rows of a recorded vigilance map (FR-5), by section code. */
export function vigilance(
  name: string,
  sections: ReadonlySet<string> = vigicruesSectionCodes(),
): Map<string, WarningRow> {
  const out = normaliseVigilance(parseVigilance(rawFixture('FR-5', name).body), {
    fetchedAt: fetchedAt('FR-5', name),
    sections,
  });
  return new Map((out.warnings?.rows ?? []).map((r) => [r.area_key, r]));
}

/** The area class of a vigilance section row, as readStates hands it in. */
export const areaOf = (source: string, r: WarningRow): AreaIn => ({
  source,
  key: r.area_key,
  name: r.name,
  levelRaw: r.level_raw,
  fresh: true,
});

/** An FR-1 value of the recorded observations with the Vigicrues section of its station (registry/vigicrues-sections.yaml). */
export function frCase(
  station: string,
  quantity: 'H' | 'Q',
  map: ReadonlyMap<string, WarningRow>,
  sections: ReadonlyMap<string, string> = vigicruesSections(),
): Case {
  const w = fr();
  const row = pick(w.rows, station, quantity);
  const section = sections.get(station);
  const hit = section === undefined ? undefined : map.get(section);
  return {
    row,
    obs: last(w.latest, row),
    refs: [],
    classes: [],
    areas: hit === undefined ? [] : [areaOf('FR-5', hit)],
    zero: w.zeros.get(row.provider_key) ?? null,
  };
}

// --- LU-1 ----------------------------------------------------------------------------------------------------------

export const lu1 = once(() => {
  const n = 'lu-1-csv';
  const out = lu1Normalise(parseLu1(rawFixture('LU-1', n).body), {
    registry: registryOf('LU-1'),
    fetchedAt: fetchedAt('LU-1', n),
    labelOffsets: { days: { '2026-09-20': 15 } },
  } as never);
  return { rows: rowsOf('LU-1'), latest: latest(out.obs) };
});

/** An LU-1 value of the recorded CSV (no public reference or class exists for LU-1). */
export function lu1Case(station: string, areas: AreaIn[] = []): Case {
  const w = lu1();
  const row = pick(w.rows, station, 'H');
  return { row, obs: last(w.latest, row), refs: [], classes: [], areas, zero: null };
}
