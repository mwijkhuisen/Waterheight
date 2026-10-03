// The class crosswalk (catalogue §4.9; ADR-0009): provider classes, alert levels and reference kinds onto the common
// scale no_ref < low < normal < elevated < high < extreme, as the owner signed it (D18, 2026-10-03, with its D22
// addendum). A row marked `flag` deviates from or adds to §4.9 and was decided in D18 or P7b as it stands here. The
// loader stores `level_norm` from CROSSWALK (1 low … 5 extreme, null no_ref) beside the provider's raw code and label;
// the classifier (classify.ts) maps the raw codes again through this table, so a changed row is an edit here, a
// regenerated docs/classification.md (scripts/gen-classification.ts) and, for the stored level, a replay of the
// class and warning specs (docs/runbooks/reference-change.md).

export const LEVELS = ['low', 'normal', 'elevated', 'high', 'extreme'] as const;
export type Level = (typeof LEVELS)[number];
/** level_norm as stored (A§6): 1 low … 5 extreme; no_ref is null. */
export const LEVEL_NORM: Readonly<Record<Level, 1 | 2 | 3 | 4 | 5>> = {
  low: 1,
  normal: 2,
  elevated: 3,
  high: 4,
  extreme: 5,
};

/** What a class measures: stage or discharge at a gauge, or an area (a river section, a region, a zone). */
export type Basis = 'stage' | 'discharge' | 'area';

/**
 * The priority group of a row (§4.7): operational thresholds and agency classes first, then statistical
 * references, then the provider's display classes (NL-4); area classes only where no gauge state exists.
 */
export type Group = 'operational' | 'statistical' | 'provider_class' | 'area';

/** One provider class: its scale (a source can publish several, never mixed), code, target level and basis. */
export type CrosswalkRow = {
  source: string;
  scale: string;
  code: string;
  level: Level | 'no_ref';
  basis: Basis;
  group: Group;
  audience: 'public' | 'owner';
  /** "No flood" (LHP 0, BAFU 1, Vigicrues green, LU-Alert information): only "not elevated", interval low..normal. */
  noFlood?: true;
  /** A source that needs a permission first (P13): in the table and tested on synthetic rows, captured nowhere. */
  gated?: true;
  /** Why the row deviates from or extends the §4.9 proposal. */
  flag?: string;
};

type RowOpts = { audience?: 'public' | 'owner'; gated?: true };

const rows = (
  source: string,
  scale: string,
  basis: Basis,
  group: Group,
  map: ReadonlyArray<readonly [string, Level | 'no_ref', ('noFlood' | string)?]>,
  opts: RowOpts = {},
): CrosswalkRow[] =>
  map.map(([code, level, note]) => ({
    source,
    scale,
    code,
    level,
    basis,
    group,
    audience: opts.audience ?? 'public',
    ...(note === 'noFlood' ? { noFlood: true as const } : note ? { flag: note } : {}),
    ...(opts.gated ? { gated: true as const } : {}),
  }));

export const CROSSWALK: readonly CrosswalkRow[] = [
  // LHP station class (integer −1…4; a feature without the key is "Ohne Hochwasser-Einstufung"): stage. The class
  // reaches the gauge's H series. 0 cannot say low: a statistical low (Kaub 9 cm under MNW 65) wins over it.
  ...rows('DE-6', 'station', 'stage', 'operational', [
    ['-1', 'no_ref'],
    ['none', 'no_ref'],
    ['0', 'normal', 'noFlood'],
    ['1', 'elevated'],
    ['2', 'high'],
    ['3', 'extreme'],
    ['4', 'extreme'],
  ]),
  // LHP alert class (a string, 1/2/4/5/6, no 3): an area scale of its own, never mixed with the station scale.
  // "2" (Vorwarnung) is drawn hatched in P10 (D18). Only Region (polygon) alerts attach to a station.
  ...rows('DE-6', 'alert', 'area', 'area', [
    ['1', 'normal', 'noFlood'],
    ['2', 'elevated'],
    ['4', 'high'],
    ['5', 'extreme'],
    ['6', 'extreme'],
  ]),
  // BAFU danger level (LINDAS dangerLevel): `undefined` is cube.link/Undefined, never 1. The basis is discharge for a
  // river; the class reaches the station's Q series, else its H series (a lake level, and the H-only stations), and
  // the state's basis is that series' quantity (KG-185, closed in P7b).
  ...rows('CH-1', 'danger', 'discharge', 'operational', [
    ['1', 'normal', 'noFlood'],
    ['2', 'elevated'],
    ['3', 'high'],
    ['4', 'extreme'],
    ['5', 'extreme'],
    ['undefined', 'no_ref'],
  ]),
  // BAFU warning sections: as the danger level; level 0 "Keine Gefahrenstufe". `river:<n>` and `lake:<n>` attach to
  // the station ch.bafu.<n>, a `hydro_region:<n>` polygon to the stations inside it.
  ...rows('CH-5', 'section', 'area', 'area', [
    ['0', 'no_ref', 'level 0 "Keine Gefahrenstufe" is not in §4.9: no_ref (D18)'],
    ['1', 'normal', 'noFlood'],
    ['2', 'elevated'],
    ['3', 'high'],
    ['4', 'extreme'],
    ['5', 'extreme'],
  ]),
  // Vigicrues section vigilance (NivInfViCr): attached to stations through TronEntVigiCru aNMoinsUn
  // (registry/vigicrues-sections.yaml); the Escaut, Scarpe and Deûle stations are in no section.
  ...rows('FR-5', 'section', 'area', 'area', [
    ['1', 'normal', 'noFlood'],
    ['2', 'elevated'],
    ['3', 'high'],
    ['4', 'extreme'],
  ]),
  // LU-Alert cb-eu-level: inverted numbering (1 is red); TEST is dropped before it is stored. A zone polygon
  // attaches to the stations inside it.
  ...rows('LU-5', 'zone', 'area', 'area', [
    ['ALERT_LVL_4', 'normal', 'noFlood'],
    ['ALERT_LVL_3', 'elevated'],
    ['ALERT_LVL_2', 'high'],
    ['ALERT_LVL_1', 'extreme'],
  ]),
  // RWS Waterinfo legend (NL-4): display classes, never warnings (C39). Matched on the label stem (the workbook
  // label without its bracketed bound); the band is [From, To). Stage for an H series, discharge for a Q series.
  ...rows('NL-4', 'stem', 'stage', 'provider_class', [
    ['Verlaagd', 'low'],
    ['Verlaagde waterstand', 'low'],
    ['Verlagde waterstand', 'low', 'a typo of the workbook, kept as published'],
    ['Verlaagde afvoer', 'low'],
    ['Laagwater', 'low'],
    ['Normaal', 'normal'],
    ['Normale waterstand', 'normal'],
    ['Normale afvoer', 'normal'],
    ['Licht verhoogd', 'elevated', '"Licht verhoogd" is elevated, a display class and never a warning (D18)'],
    ['Verhoogd', 'elevated'],
    ['Verhoogde waterstand', 'elevated'],
    ['Verhoogde afvoer', 'elevated'],
    ['Hoogwater', 'high'],
    ['Hoge afvoer', 'high'],
    ['Hoogwater / Stormvloed', 'high'],
    ['Stormvloed', 'high', 'RWS orders it at 2 with Hoogwater, below Extreem: high, not extreme (D18)'],
    ['Extreem', 'extreme'],
    ['Extreem hoogwater', 'extreme'],
    ['Extreme afvoer', 'extreme'],
    ['Geen klasse-indeling', 'no_ref'],
  ]),
  // SPW NIVCRU station attribute (`t<n>/<state>`): stored raw, its meaning is not documented (D18).
  ...rows(
    'BE-3',
    'nivcru',
    'stage',
    'operational',
    [['*', 'no_ref', 'NIVCRU meaning unknown: shown, never classifies (D18)']],
    {
      audience: 'owner',
    },
  ),
  // LfU RLP alert regions (P13, gated: needs consent; catalogue §0.8).
  ...rows(
    'DE-10',
    'region',
    'area',
    'area',
    [
      ['1', 'no_ref'],
      ['2', 'normal', 'noFlood'],
      ['3', 'elevated'],
      ['4', 'high'],
      ['5', 'extreme'],
      ['6', 'extreme'],
      ['7', 'extreme'],
    ],
    { gated: true },
  ),
];

/** The gauge-class scale of a source's `class_obs` rows, and the area scale of its `warning_area` rows. */
export const CLASS_SCALE: Readonly<Record<string, string>> = { 'DE-6': 'station', 'CH-1': 'danger', 'BE-3': 'nivcru' };
export const AREA_SCALE: Readonly<Record<string, string>> = {
  'DE-6': 'alert',
  'FR-5': 'section',
  'CH-5': 'section',
  'LU-5': 'zone',
  'DE-10': 'region',
};

const ROW_BY_CODE = new Map(CROSSWALK.map((r) => [`${r.source}\n${r.scale}\n${r.code}`, r]));

/** The row of a provider class: the exact code, else the source's `*` row; undefined when the table lacks it. */
export function crosswalkRow(source: string, scale: string, code: string): CrosswalkRow | undefined {
  return ROW_BY_CODE.get(`${source}\n${scale}\n${code}`) ?? ROW_BY_CODE.get(`${source}\n${scale}\n*`);
}

/**
 * The stored level of a provider class: 1–5, null for no_ref, undefined for a code the crosswalk does not have
 * (the adapter drops it as `unmapped_class`, alerted: a new provider class is a reviewed change).
 */
export function levelOf(source: string, scale: string, code: string): 1 | 2 | 3 | 4 | 5 | null | undefined {
  const row = crosswalkRow(source, scale, code);
  if (row === undefined) return undefined;
  return row.level === 'no_ref' ? null : LEVEL_NORM[row.level];
}

/**
 * How a set of references on one series decides (classify.ts):
 * - `scale`: an agency's full threshold scale; below its lowest defined level is `normal` (interval up to one below
 *   that level), as LHP 0 or BAFU 1 are;
 * - `stats`: statistics, not warnings; `normal` only between a low bound and an `elevated` bound (MNW < W < MHW);
 * - `percentile`: SPW long-term percentiles (D18 addendum): at or below the low bound `low`, otherwise `normal`,
 *   never an alert level.
 */
export type SetForm = 'scale' | 'stats' | 'percentile';

/**
 * How one reference kind takes part: a value at or above (`>=`), at or below (`<=`) or below (`<`) it reaches the
 * level; `op: null` is stored and shown, never classifies. `convention` (percentiles only) is the convention the
 * row must carry: a stored row with the other one is not this reference (C31: SPW non-exceedance, HIC exceedance).
 */
export type ReferenceRole = {
  source: string;
  kind: string;
  op: '>=' | '<=' | '<' | null;
  level: Level | null;
  basis: Basis;
  /** null for a kind that never classifies. */
  group: 'operational' | 'statistical' | null;
  form: SetForm | null;
  audience: 'public' | 'owner';
  /** Its name in a basis label: "WSV MNW 2010–2020". */
  short: string;
  convention?: 'exceedance' | 'non_exceedance';
  gated?: true;
  flag?: string;
};

type RefOpts = {
  audience?: 'public' | 'owner';
  convention?: 'exceedance' | 'non_exceedance';
  gated?: true;
  flag?: string;
};

const ref = (
  source: string,
  kind: string,
  op: ReferenceRole['op'],
  level: Level | null,
  group: ReferenceRole['group'],
  form: SetForm | null,
  short: string,
  opts: RefOpts = {},
  basis: Basis = 'stage',
): ReferenceRole => ({
  source,
  kind,
  op,
  level,
  basis,
  group,
  form,
  audience: opts.audience ?? 'public',
  short,
  ...(opts.convention ? { convention: opts.convention } : {}),
  ...(opts.gated ? { gated: true as const } : {}),
  ...(opts.flag ? { flag: opts.flag } : {}),
});

const shown = (source: string, kind: string, short: string, opts: RefOpts = {}, basis: Basis = 'stage') =>
  ref(source, kind, null, null, null, null, short, opts, basis);

const OWNER: RefOpts = { audience: 'owner' };
const GATED: RefOpts = { gated: true };

export const REFERENCE_ROLES: readonly ReferenceRole[] = [
  // PEGELONLINE (W only): statistics, not warnings. No extreme: it comes from the LHP class of the same gauge.
  ref('DE-1', 'MNW', '<=', 'low', 'statistical', 'stats', 'MNW'),
  ref('DE-1', 'MHW', '>=', 'elevated', 'statistical', 'stats', 'MHW'),
  ref('DE-1', 'HSW', '>=', 'high', 'statistical', 'stats', 'HSW', {
    flag: 'HSW (navigation stops) is high; PEGELONLINE has no extreme',
  }),
  shown('DE-1', 'MW', 'MW'),
  shown('DE-1', 'NNW', 'NNW'),
  shown('DE-1', 'HHW', 'HHW'),
  shown('DE-1', 'NW', 'NW', { flag: 'C22: a period extreme (Kaub "NW 25"), not NNW' }),
  shown('DE-1', 'HW', 'HW', { flag: 'C22: a period extreme (Kaub "HW 719"), not HHW' }),
  shown('DE-1', 'MARKE_I', 'Marke I', { flag: 'navigation mark: shown, never classifies (D18)' }),
  shown('DE-1', 'MARKE_II', 'Marke II', { flag: 'navigation mark (often = HSW): shown, never classifies (D18)' }),
  shown('DE-1', 'MARKE_III', 'Marke III', { flag: 'navigation mark: shown, never classifies (D18)' }),
  shown('DE-1', 'GLW', 'GlW', { flag: 'shown, never classifies (D18)' }),
  // LANUK (NRW): the Info levels exist only at "Infopegel".
  ref('DE-7', 'LANUV_INFO_1', '>=', 'elevated', 'operational', 'scale', 'Info 1'),
  ref('DE-7', 'LANUV_INFO_2', '>=', 'high', 'operational', 'scale', 'Info 2'),
  ref('DE-7', 'LANUV_INFO_3', '>=', 'extreme', 'operational', 'scale', 'Info 3'),
  ref('DE-7', 'LANUV_MNW', '<=', 'low', 'statistical', 'stats', 'MNW'),
  shown('DE-7', 'LANUV_MW', 'MW'),
  ref('DE-7', 'LANUV_MHW', '>=', 'elevated', 'statistical', 'stats', 'MHW', {
    flag: 'owner decision of 2026-10-03 (R-090): as DE-1 MHW; §4.7 lists NRW MNW/MHW as statistical references',
  }),
  // BAFU wl_1..wl_4: the lower bounds of danger levels 2–5; below WL2 is danger level 1. Discharge for a river; a
  // `masl` lake station's rows sit on its level series (the state's basis follows the series).
  ref('CH-2', 'WL2', '>=', 'elevated', 'operational', 'scale', 'WL2', {}, 'discharge'),
  ref('CH-2', 'WL3', '>=', 'high', 'operational', 'scale', 'WL3', {}, 'discharge'),
  ref('CH-2', 'WL4', '>=', 'extreme', 'operational', 'scale', 'WL4', {}, 'discharge'),
  ref('CH-2', 'WL5', '>=', 'extreme', 'operational', 'scale', 'WL5', {}, 'discharge'),
  shown('FR-5', 'CRUE', 'crue historique', { flag: 'CruesHistoriques (CRUE_<hash>): historical, never classifies' }),
  // AGE vigilance (owner view only, D22): 0 means undefined and is not stored, so most stations start at orange.
  ref('LU-4', 'LU4_YELLOW', '>=', 'elevated', 'operational', 'scale', 'yellow', OWNER),
  ref('LU-4', 'LU4_ORANGE', '>=', 'high', 'operational', 'scale', 'orange', OWNER),
  ref('LU-4', 'LU4_RED', '>=', 'extreme', 'operational', 'scale', 'red', OWNER),
  // AGE status classes (owner view only): lowerboundexceeded < MNQ low, mnq/mq normal, hq2 elevated, hq10/hq20
  // high, hq50/hq100 extreme, through the HQ levels (cm). P7a stores no MNQ or MQ, so `low` cannot fire today.
  ref('LU-4', 'MNQ', '<', 'low', 'statistical', 'scale', 'MNQ', {
    ...OWNER,
    flag: 'status class lowerboundexceeded: P7a stores no MNQ, so it is inert',
  }),
  shown('LU-4', 'MQ', 'MQ', { ...OWNER, flag: 'status classes mnq/mq are normal: below HQ2 is normal' }),
  ref('LU-4', 'HQ2', '>=', 'elevated', 'statistical', 'scale', 'HQ2', OWNER),
  shown('LU-4', 'HQ5', 'HQ5', { ...OWNER, flag: 'no status class for HQ5: shown, never classifies (D18)' }),
  ref('LU-4', 'HQ10', '>=', 'high', 'statistical', 'scale', 'HQ10', OWNER),
  ref('LU-4', 'HQ20', '>=', 'high', 'statistical', 'scale', 'HQ20', OWNER),
  ref('LU-4', 'HQ50', '>=', 'extreme', 'statistical', 'scale', 'HQ50', OWNER),
  ref('LU-4', 'HQ100', '>=', 'extreme', 'statistical', 'scale', 'HQ100', OWNER),
  shown('LU-4', 'LU4_CRUE_REF', 'crue de référence', {
    ...OWNER,
    flag: 'reference flood: historical, never classifies',
  }),
  // SPW long-term percentiles (owner view only; D18 addendum): non-exceedance (P90 > mean, C31).
  ref('BE-3', 'P05', '<=', 'low', 'statistical', 'percentile', 'P05', {
    ...OWNER,
    convention: 'non_exceedance',
    flag: 'D18 addendum: <= P05 low, else normal; never an alert level from percentiles',
  }),
  // HIC (P13, gated): prewaak/waak/alarm (m TAW) and exceedance percentiles (P10 > P90, C31).
  ref('BE-1', 'PREWAAK', '>=', 'elevated', 'operational', 'scale', 'prewaak', GATED),
  ref('BE-1', 'WAAK', '>=', 'high', 'operational', 'scale', 'waak', GATED),
  ref('BE-1', 'ALARM', '>=', 'extreme', 'operational', 'scale', 'alarm', GATED),
  ref('BE-1', 'P95', '<=', 'low', 'statistical', 'percentile', 'P95', {
    ...GATED,
    convention: 'exceedance',
    flag: 'not in §4.9: the exceedance P95 is the low tail (C31); proposal for P13',
  }),
  // NLWKN Meldestufen and the LfU RLP station legend (P13, gated).
  ref('DE-9', 'MELDESTUFE_1', '>=', 'elevated', 'operational', 'scale', 'Meldestufe 1', GATED),
  ref('DE-9', 'MELDESTUFE_2', '>=', 'high', 'operational', 'scale', 'Meldestufe 2', GATED),
  ref('DE-9', 'MELDESTUFE_3', '>=', 'extreme', 'operational', 'scale', 'Meldestufe 3', GATED),
  ref('DE-10', 'MNW', '<=', 'low', 'statistical', 'stats', 'MNW', {
    ...GATED,
    flag: 'owner decision of 2026-10-03 (R-090): "< mittleres Niedrigwasser" is low, as DE-1 and DE-7; MNW..MW is normal',
  }),
  shown('DE-10', 'MW', 'MW', { ...GATED, flag: '"< Mittelwasser" of the RLP legend: normal, not low (R-090)' }),
  ref('DE-10', 'HW2', '>=', 'elevated', 'statistical', 'stats', 'HW2', GATED),
  ref('DE-10', 'HW10', '>=', 'high', 'statistical', 'stats', 'HW10', GATED),
  ref('DE-10', 'HW20', '>=', 'extreme', 'statistical', 'stats', 'HW20', GATED),
  ref('DE-10', 'HW50', '>=', 'extreme', 'statistical', 'stats', 'HW50', GATED),
  ref('DE-10', 'HW100', '>=', 'extreme', 'statistical', 'stats', 'HW100', GATED),
];

const ROLE_BY_KIND = new Map(REFERENCE_ROLES.map((r) => [`${r.source}\n${r.kind}`, r]));

/** The role of a stored reference kind (FR-5's CRUE_<hash> rows are CRUE). */
export function referenceRole(source: string, kind: string): ReferenceRole | undefined {
  return ROLE_BY_KIND.get(`${source}\n${source === 'FR-5' && kind.startsWith('CRUE_') ? 'CRUE' : kind}`);
}

/** The agency named in a basis label. */
export const AGENCY: Readonly<Record<string, string>> = {
  'DE-1': 'WSV',
  'DE-6': 'LHP',
  'DE-7': 'LANUK',
  'DE-9': 'NLWKN',
  'DE-10': 'LfU RLP',
  'CH-1': 'BAFU',
  'CH-2': 'BAFU',
  'CH-5': 'BAFU',
  'NL-4': 'RWS Waterinfo',
  'FR-5': 'Vigicrues',
  'LU-4': 'AGE',
  'LU-5': 'LU-Alert',
  'BE-1': 'HIC',
  'BE-3': 'SPW',
};

/** Sources whose rows apply only in the owner view (D22): never in a public run, whatever reached it. */
export const OWNER_ONLY_SOURCES: ReadonlySet<string> = new Set(
  [...CROSSWALK, ...REFERENCE_ROLES].filter((r) => r.audience === 'owner').map((r) => r.source),
);

/**
 * How long after its source's last successful fetch a class or area is current, in minutes: max(3 × the capture
 * cadence, 45 min), pinned to registry/capture.yaml by a test (DE-6 and CH-1 every 10 min, FR-5 every 15, LU-5
 * every 5, CH-5 every 30).
 */
export const CLASS_WINDOW_MIN: Readonly<Record<string, number>> = {
  'DE-6': 45,
  'CH-1': 45,
  'FR-5': 45,
  'LU-5': 45,
  'CH-5': 90,
};

/** Sources that need a permission before use (registry/sources.yaml `permission_required`; pinned by a test). */
export const PERMISSION_REQUIRED: ReadonlySet<string> = new Set(['BE-1', 'DE-9', 'DE-10', 'DE-12', 'DE-13']);

/** The trend's dead band (classify.ts deltaH): H ± 2 cm; Q ± max(1 m³/s, 2 % of the start value). */
export const TREND_BAND = { cm: 2, qAbs: 1, qRel: 0.02 } as const;
