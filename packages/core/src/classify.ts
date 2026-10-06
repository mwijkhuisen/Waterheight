import {
  AGENCY,
  AREA_SCALE,
  type Basis,
  CLASS_SCALE,
  CROSSWALK,
  crosswalkRow,
  type Group,
  LEVEL_NORM,
  LEVELS,
  type Level,
  OWNER_ONLY_SOURCES,
  type ReferenceRole,
  referenceRole,
} from './crosswalk.ts';
import { SUSPECT_BITS } from './qc.ts';

// The pure classifier (ADR-0009; PHASES P7b): one ordinal state per value, `no_ref < low < normal < elevated < high
// < extreme`, with the basis it was taken from. No I/O: the server reads the rows valid at t through one view family
// and hands them in. The rules are written out in docs/classification.md (generated from crosswalk.ts):
// - every source of evidence gives an interval on low..extreme and, where it decides, a point level;
// - candidates are taken in the priority operational > statistical > provider class, and within operational the
//   agency's gauge class before its thresholds; each narrows the interval when it agrees with it and is skipped
//   when it does not (the higher priority wins);
// - the state is the interval when one level is left, else the first point inside it, else no_ref: a station
//   without a deciding reference is never given a guess (no neighbour, default or interpolated threshold);
// - an area class (a section, region or zone) colours the value only where no gauge state exists, with
//   `section: true`; otherwise it is returned alongside.

export type Family = 'public' | 'owner';
export type State = 'no_ref' | Level;
export const STATES = ['no_ref', ...LEVELS] as const;

/** A reference_value row valid at t, as the family's reference view shows it. */
export type RefIn = {
  source: string;
  kind: string;
  /** In the unit of `unit`, which must be the series' canonical unit (cm for H, m³/s for Q). */
  value: number;
  unit: string;
  convention: 'exceedance' | 'non_exceedance' | null;
  /** The first and last day of a statistical period (YYYY-MM-DD), or null. */
  period: readonly [string, string | null] | null;
  seasonFrom: number;
  seasonTo: number;
  priority: number;
  /** The stored basis_label: provider text, inert. */
  label: string | null;
};
/** The latest class_obs row of the station and source at or before t; `fresh` per the freshness rule. */
export type ClassIn = { source: string; code: string; fresh: boolean };
/** A warning_area row valid at t that is attached to the station. */
export type AreaIn = { source: string; key: string; name: string | null; levelRaw: string | null; fresh: boolean };

export type SeriesIn = {
  quantity: 'H' | 'Q';
  /** Relative to a gauge zero (stage) or absolute (level); null for Q. */
  valueKind: 'stage' | 'level' | null;
  /** The canonical value at t (LOCF within the staleness limit), or null when the series has none. */
  value: number | null;
  qc: number;
  ageMs: number;
  stalenessMs: number;
  /** The instant classified (epoch ms): NL-4 seasons are read from it. */
  t: number;
  refs: readonly RefIn[];
  /** The gauge classes that reach this series (classSeries). */
  classes: readonly ClassIn[];
  /** The area classes attached to the series' station. */
  areas: readonly AreaIn[];
  tidal: boolean;
  impounded: boolean;
};

/** What a state measures: a stage, an absolute level (a lake, a NAP level series), a discharge or an area. */
export type Measure = Basis | 'level';

export type BasisOut = {
  source: string;
  kind: Group;
  /** What the state measures: the series' own quantity for a gauge state (KG-185), `area` for a section state. */
  measure: Measure;
  /** Our code: the reference kinds used (`MNW/MHW`), the class code (`RP:0`), the NL-4 stem or the area key. */
  ref: string;
  /** "WSV MNW 2010–2020", "LHP RP:0", "Licht verhoogd (>200cm)" (NL-4): may hold provider text, inert. */
  label: string;
};

/** The contract's maxima of a basis (StateBasis): longer provider text is cut, never a failed snapshot (SR-6). */
const LABEL_MAX = 700;
const REF_MAX = 200;
/** A text cut to `max` UTF-16 units, without a lone high surrogate at the cut. */
const cut = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/[\uD800-\uDBFF]$/, ''));
const bounded = (b: BasisOut): BasisOut => ({ ...b, ref: cut(b.ref, REF_MAX), label: cut(b.label, LABEL_MAX) });

export type Classified = {
  state: State;
  basis: BasisOut | null;
  section: boolean;
  area: { state: Level; basis: BasisOut } | null;
  flags: { stale: boolean; suspect: boolean; tidal: boolean; impounded: boolean };
  /**
   * Every source whose row shaped the state, its basis (both parts of a two-part basis) or the area beside it: not
   * served, it lets the public boundary check sources a label only names (review R2-2).
   */
  sources: readonly string[];
};

const n = (l: Level) => LEVEL_NORM[l];
const LEVEL_AT: readonly Level[] = ['low', 'low', 'normal', 'elevated', 'high', 'extreme'];

type Cand = { group: Group; lo: number; hi: number; point: number | null; basis: BasisOut };
type Used = { role: ReferenceRole; ref: RefIn };

const years = (p: readonly [string, string | null] | null) =>
  p === null ? '' : ` ${p[0].slice(0, 4)}–${p[1] === null ? '' : p[1].slice(0, 4)}`;

/** A percentile's number, or null for a kind that is not a plain percentile (P05 … P95). */
const percent = (kind: string) => (/^P([0-9]{2})$/.test(kind) ? Number(kind.slice(1)) : null);

/**
 * A set of percentiles must order as its declared convention says (C31): non-exceedance values rise with the
 * percentile (SPW: P90 > mean), exceedance values fall (HIC: P10 > P90). A set that contradicts its convention is
 * not used.
 */
export function conventionHolds(refs: readonly RefIn[]): boolean {
  for (const convention of ['exceedance', 'non_exceedance'] as const) {
    const pts = refs
      .filter((r) => r.convention === convention && percent(r.kind) !== null)
      .map((r) => [percent(r.kind) as number, r.value] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pts.length; i++) {
      const [, prev] = pts[i - 1] as readonly [number, number];
      const [, cur] = pts[i] as readonly [number, number];
      if (convention === 'non_exceedance' ? cur < prev : cur > prev) return false;
    }
  }
  return true;
}

/** The candidate of one source's references of one group on one series, or null when they decide nothing. */
function setCandidate(
  used: readonly Used[],
  all: readonly RefIn[],
  v: number,
  measure: Measure,
  skipLow: boolean,
): Cand | null {
  const first = used[0] as Used;
  const { source, group, form } = first.role;
  if (group === null || form === null) return null;
  if (form === 'percentile' && !conventionHolds(all.filter((r) => r.source === source))) return null;
  const lows = skipLow ? [] : used.filter((u) => u.role.op === '<=' || u.role.op === '<');
  const low = lows.reduce<Used | undefined>(
    (a, u) => (a === undefined || u.ref.value > a.ref.value ? u : a),
    undefined,
  );
  const uppers = used.filter((u) => u.role.op === '>=').sort((a, b) => a.ref.value - b.ref.value);
  const lvl = (u: Used) => n(u.role.level as Level);
  const isLow = low !== undefined && (low.role.op === '<' ? v < low.ref.value : v <= low.ref.value);
  const passed = uppers.filter((u) => v >= u.ref.value);
  const above = uppers.filter((u) => v < u.ref.value);
  let lo: number;
  let hi = 5;
  let point: number | null = null;
  let decisive: Used[] = [];
  let below = false; // the value is under the lowest level of a scale: "LANUK < Info 1"
  if (isLow) {
    if (passed.length > 0) return null; // a low bound above a passed threshold: the set contradicts itself
    lo = 1;
    hi = 1;
    point = 1;
    decisive = [low];
  } else {
    lo = low === undefined ? 1 : 2;
    const top = passed.reduce<Used | undefined>((a, u) => (a === undefined || lvl(u) >= lvl(a) ? u : a), undefined);
    if (top !== undefined) lo = Math.max(lo, lvl(top));
    // A threshold above the value with a lower level than one it passed: the set is out of order, no guess.
    if (top !== undefined && above.some((u) => lvl(u) < lvl(top))) return null;
    // The next level up caps the interval; a further threshold of the passed level (WL4 and WL5, HQ10 and HQ20)
    // caps nothing.
    const next = above
      .filter((u) => top === undefined || lvl(u) > lvl(top))
      .reduce<Used | undefined>((a, u) => (a === undefined || lvl(u) < lvl(a) ? u : a), undefined);
    if (next !== undefined) hi = lvl(next) - 1;
    if (lo > hi) return null; // a low bound above the lowest threshold: the set contradicts itself
    if (top !== undefined) {
      point = lvl(top);
      decisive = [top];
    } else if (form === 'scale' && next !== undefined) {
      point = 2;
      decisive = [next];
      below = true;
    } else if (form === 'stats' && low !== undefined && next !== undefined && lvl(next) === n('elevated')) {
      point = 2;
      decisive = [low, next];
    } else if (form === 'percentile' && low !== undefined) {
      point = 2;
      decisive = [low];
    } else {
      decisive = [...(low ? [low] : []), ...(next ? [next] : [])];
    }
  }
  const period = decisive.find((u) => u.ref.period !== null)?.ref.period ?? null;
  const ref = decisive.map((u) => u.role.kind).join('/');
  const label = `${AGENCY[source] ?? source} ${below ? '< ' : ''}${decisive.map((u) => u.role.short).join('/')}${years(period)}`;
  return { group, lo, hi, point, basis: { source, kind: group, measure, ref, label } };
}

/** The MMDD of an instant in Europe/Amsterdam, the calendar of the NL-4 seasons. */
export function monthDay(t: number): number {
  const z = Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO('Europe/Amsterdam');
  return z.month * 100 + z.day;
}

/** A season `from`–`to` (MMDD, both inclusive; wraps the year when from > to) contains `md`. */
export const inSeason = (md: number, from: number, to: number) =>
  from <= to ? md >= from && md <= to : md >= from || md <= to;

/** The NL-4 stem of a workbook label: the label without its bracketed bound (cut at the first `(`). */
export const nl4Stem = (label: string) => {
  const i = label.indexOf('(');
  return (i < 0 ? label : label.slice(0, i)).trim();
};

/**
 * The NL-4 display class of a value (provider class): the classes valid at t whose season contains t, their
 * `NL4_FROM` and `NL4_TO` rows paired by (season, priority); a class holds [From, To) (KG-083); where bands overlap
 * the lowest Priority wins; a band with neither bound never matches; an unknown stem decides nothing.
 */
function nl4Candidate(refs: readonly RefIn[], v: number, t: number, measure: Measure): Cand | null {
  const md = monthDay(t);
  const bands = new Map<string, { from?: number; to?: number; label: string; priority: number }>();
  for (const r of refs) {
    if (r.source !== 'NL-4' || (r.kind !== 'NL4_FROM' && r.kind !== 'NL4_TO')) continue;
    if (!inSeason(md, r.seasonFrom, r.seasonTo) || r.label === null) continue;
    const key = `${r.seasonFrom}/${r.seasonTo}/${r.priority}`;
    const band = bands.get(key) ?? { label: r.label, priority: r.priority };
    if (r.kind === 'NL4_FROM') band.from = r.value;
    else band.to = r.value;
    bands.set(key, band);
  }
  let best: { label: string; priority: number } | undefined;
  for (const b of bands.values()) {
    if (b.from === undefined && b.to === undefined) continue;
    if ((b.from === undefined || v >= b.from) && (b.to === undefined || v < b.to)) {
      if (best === undefined || b.priority < best.priority) best = b;
    }
  }
  if (best === undefined) return null;
  const stem = nl4Stem(best.label);
  const row = crosswalkRow('NL-4', 'stem', stem);
  if (row === undefined || row.level === 'no_ref') return null;
  const l = n(row.level);
  return {
    group: 'provider_class',
    lo: l,
    hi: l,
    point: l,
    // The workbook label only: basis.source names RWS Waterinfo, and the web adds the legend's disclaimer (C39).
    basis: { source: 'NL-4', kind: 'provider_class', measure, ref: stem, label: best.label },
  };
}

/** The candidate of a gauge class (LHP, BAFU), or null for no_ref and unknown codes. */
function classCandidate(c: ClassIn, measure: Measure): Cand | null {
  const scale = CLASS_SCALE[c.source];
  if (scale === undefined) return null;
  const row = crosswalkRow(c.source, scale, c.code.replace(/^[A-Z]{2}:/, ''));
  if (row === undefined || row.level === 'no_ref') return null;
  const l = n(row.level);
  const basis: BasisOut = {
    source: c.source,
    kind: row.group,
    measure,
    ref: c.code,
    label: `${AGENCY[c.source] ?? c.source} ${c.code}`,
  };
  return row.noFlood
    ? { group: row.group, lo: 1, hi: 2, point: 2, basis }
    : { group: row.group, lo: l, hi: l, point: l, basis };
}

/** The level of an area class, or null. */
export function areaLevel(a: Pick<AreaIn, 'source' | 'levelRaw'>): Level | null {
  const scale = AREA_SCALE[a.source];
  if (scale === undefined || a.levelRaw === null) return null;
  const row = crosswalkRow(a.source, scale, a.levelRaw);
  return row === undefined || row.level === 'no_ref' ? null : row.level;
}

const ORDER: readonly Group[] = ['operational', 'statistical', 'provider_class'];

/** The state of one value, from the rows of one audience family. */
export function classify(s: SeriesIn, family: Family): Classified {
  const visible = (source: string) => family === 'owner' || !OWNER_ONLY_SOURCES.has(source);
  const unit = s.quantity === 'H' ? 'cm' : 'm³/s';
  const measure: Measure = s.quantity === 'Q' ? 'discharge' : s.valueKind === 'level' ? 'level' : 'stage';
  const refs = s.refs.filter((r) => visible(r.source) && r.unit === unit);
  const cands: Cand[] = [];
  // The agency's published gauge class first: within the operational group it outranks our own comparison of the
  // value with the agency's thresholds (§4.9), which can lag it (DE-7 hourly against LHP every 10 minutes) or
  // disagree at a boundary (BAFU danger level 2 with Q under WL2).
  for (const c of s.classes) {
    if (!c.fresh || !visible(c.source)) continue;
    const cand = classCandidate(c, measure);
    if (cand) cands.push(cand);
  }
  if (s.value !== null) {
    const v = s.value;
    const sets = new Map<string, Used[]>();
    for (const r of refs) {
      const role = referenceRole(r.source, r.kind);
      if (role === undefined || role.op === null || role.group === null) continue;
      if (role.convention !== undefined && r.convention !== role.convention) continue;
      const key = `${role.group}\n${r.source}`;
      sets.set(key, [...(sets.get(key) ?? []), { role, ref: r }]);
    }
    const skipLow = s.impounded && s.valueKind === 'stage';
    for (const [key, used] of [...sets].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const c = setCandidate(used, refs, v, measure, skipLow && key.startsWith('statistical'));
      if (c) cands.push(c);
    }
    const nl4 = nl4Candidate(refs, v, s.t, measure);
    if (nl4) cands.push(nl4);
  }
  // Operational classes, then operational reference sets (the order they were pushed in), then statistics, then
  // display classes. D12: a tidal reach is classed from operational sources only.
  const ordered = ORDER.flatMap((g) => cands.filter((c) => c.group === g)).filter(
    (c) => !s.tidal || c.group === 'operational',
  );
  // A lower-priority candidate that disagrees is outranked, but it shows which way the value leans: the interval
  // collapses to its nearest edge. Below AGE orange (low..elevated) with HQ10 passed (high) is elevated, not the
  // scale's normal, and a later candidate cannot pull it back, so a higher value never gives a lower level.
  let range: [number, number] | null = null;
  let narrowed: Cand | null = null;
  let puller: Cand | null = null;
  for (const c of ordered) {
    if (range === null) {
      range = [c.lo, c.hi];
      narrowed = c;
      continue;
    }
    const lo = Math.max(range[0], c.lo);
    const hi = Math.min(range[1], c.hi);
    if (lo > hi) {
      const edge: number = c.lo > range[1] ? range[1] : range[0];
      if (range[0] !== range[1]) puller ??= c;
      range = [edge, edge];
      continue;
    }
    if (lo !== range[0] || hi !== range[1]) narrowed = c;
    range = [lo, hi];
  }
  let level: number | null = null;
  if (range !== null) {
    const [lo, hi] = range;
    level = lo === hi ? lo : (ordered.find((c) => c.point !== null && c.point >= lo && c.point <= hi)?.point ?? null);
  }
  // The basis: the first candidate whose point is the state; after a collapse that no point names, both decisive
  // candidates ("AGE < orange / AGE HQ10": the one that narrowed the interval and the one that moved it to the edge).
  let gauge: BasisOut | null = null;
  if (level !== null) {
    const b = (narrowed as Cand).basis;
    gauge =
      ordered.find((c) => c.point === level)?.basis ??
      (puller === null
        ? b
        : { ...b, ref: `${b.ref}/${puller.basis.ref}`, label: `${b.label} / ${puller.basis.label}` });
  }

  let area: Classified['area'] = null;
  for (const a of s.areas) {
    if (!a.fresh || !visible(a.source)) continue;
    const l = areaLevel(a);
    if (l === null || (area !== null && n(l) <= n(area.state))) continue;
    area = {
      state: l,
      basis: bounded({
        source: a.source,
        kind: 'area',
        measure: 'area',
        ref: a.key,
        label: `${AGENCY[a.source] ?? a.source} ${a.name ?? a.key}`,
      }),
    };
  }
  const flags = {
    stale: s.value !== null && s.ageMs > s.stalenessMs,
    suspect: (s.qc & SUSPECT_BITS) !== 0,
    tidal: s.tidal,
    impounded: s.impounded,
  };
  const areaSources = area === null ? [] : [area.basis.source];
  if (level !== null && gauge !== null) {
    const sources = [gauge.source, ...(puller === null ? [] : [puller.basis.source]), ...areaSources];
    return { state: LEVEL_AT[level] as Level, basis: bounded(gauge), section: false, area, flags, sources };
  }
  if (area !== null) {
    return { state: area.state, basis: area.basis, section: true, area: null, flags, sources: areaSources };
  }
  return { state: 'no_ref', basis: null, section: false, area: null, flags, sources: [] };
}

/**
 * Which of a station's series a gauge class reaches: the series of the class's basis quantity (stage → H,
 * discharge → Q), else the station's other series (a CH-1 lake or an H-only station).
 */
export function classSeries<S extends { quantity: 'H' | 'Q' }>(source: string, series: readonly S[]): S | undefined {
  const basis = CROSSWALK.find((r) => r.source === source && r.scale === CLASS_SCALE[source])?.basis;
  const want = basis === 'discharge' ? 'Q' : 'H';
  return series.find((x) => x.quantity === want) ?? series[0];
}

// --- Area attachment ---------------------------------------------------------------------------------------------

type Ring = readonly (readonly number[])[];

const inRing = (lon: number, lat: number, ring: Ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = Number.NaN, yi = Number.NaN] = ring[i] as readonly number[];
    const [xj = Number.NaN, yj = Number.NaN] = ring[j] as readonly number[];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (lon: number, lat: number, rings: unknown) =>
  Array.isArray(rings) &&
  rings.reduce((inside: boolean, ring: Ring) => (inRing(lon, lat, ring) ? !inside : inside), false);

/**
 * Whether a GeoJSON geometry (Polygon or MultiPolygon, holes by the even-odd rule) contains the point. A line, a
 * point or anything else contains nothing: a River alert or a river section is not an area a station lies in.
 */
export function pointIn(lon: number, lat: number, geometry: unknown): boolean {
  if (typeof geometry !== 'object' || geometry === null) return false;
  const g = geometry as { type?: unknown; coordinates?: unknown; geometry?: unknown };
  if (g.type === 'Feature') return pointIn(lon, lat, g.geometry);
  if (g.type === 'Polygon') return inPolygon(lon, lat, g.coordinates);
  if (g.type === 'MultiPolygon')
    return Array.isArray(g.coordinates) && g.coordinates.some((p: unknown) => inPolygon(lon, lat, p));
  return false;
}

/**
 * The stations an area class is attached to: FR-5 through the TronEntVigiCru section table, CH-5 `river:<n>` and
 * `lake:<n>` to the BAFU station `ch.bafu.<n>`, and polygons (LU-5 zones, DE-6 Region alerts, CH-5 hydro regions,
 * DE-10 regions) to the stations inside them.
 */
export function attachArea(
  area: { source: string; key: string; geometry: unknown },
  stations: readonly { id: string; lon: number | null; lat: number | null }[],
  sections: ReadonlyMap<string, string>,
): string[] {
  if (area.source === 'FR-5') return stations.filter((s) => sections.get(s.id) === area.key).map((s) => s.id);
  const m = /^(?:river|lake):([0-9]{1,6})$/.exec(area.key);
  if (area.source === 'CH-5' && m) {
    const id = `ch.bafu.${m[1]}`;
    return stations.some((s) => s.id === id) ? [id] : [];
  }
  return stations
    .filter((s) => s.lon !== null && s.lat !== null && pointIn(s.lon, s.lat, area.geometry))
    .map((s) => s.id);
}
