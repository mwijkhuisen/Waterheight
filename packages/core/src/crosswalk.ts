// The class crosswalk (catalogue §4.9; ADR-0009): provider classes and alert levels onto the common scale
// no_ref < low < normal < elevated < high < extreme. P7a: the DRAFT, the §4.9 proposal as it stands while the
// owner's sign-off (D18) is open; a row marked `flag` deviates from or adds to §4.9 and waits for D18. The
// loader stores `level_norm` from it (1 low … 5 extreme, null no_ref) beside the provider's raw code and label,
// so a changed row is an edit here plus a replay of the class and warning specs (docs/runbooks/reference-change.md).
// P7b extends it (thresholds, priority, gauge vs area) and generates docs/classification.md from it.

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

export type Basis = 'stage' | 'discharge' | 'area';

/** One provider class: its scale (a source can publish several, never mixed), code, target level and basis. */
export type CrosswalkRow = {
  source: string;
  scale: string;
  code: string;
  level: Level | 'no_ref';
  basis: Basis;
  audience: 'public' | 'owner';
  /** Why the row deviates from or extends the §4.9 proposal (open for D18). */
  flag?: string;
};

const rows = (
  source: string,
  scale: string,
  basis: Basis,
  audience: 'public' | 'owner',
  map: ReadonlyArray<readonly [string, Level | 'no_ref', string?]>,
): CrosswalkRow[] =>
  map.map(([code, level, flag]) => ({ source, scale, code, level, basis, audience, ...(flag ? { flag } : {}) }));

export const CROSSWALK: readonly CrosswalkRow[] = [
  // LHP station class (integer −1…4; a feature without the key is "Ohne Hochwasser-Einstufung"): stage.
  ...rows('DE-6', 'station', 'stage', 'public', [
    ['-1', 'no_ref'],
    ['none', 'no_ref'],
    ['0', 'normal'],
    ['1', 'elevated'],
    ['2', 'high'],
    ['3', 'extreme'],
    ['4', 'extreme'],
  ]),
  // LHP alert class (a string, 1/2/4/5/6, no 3): an area scale of its own, never mixed with the station scale.
  ...rows('DE-6', 'alert', 'area', 'public', [
    ['1', 'normal'],
    ['2', 'elevated'],
    ['4', 'high'],
    ['5', 'extreme'],
    ['6', 'extreme'],
  ]),
  // BAFU danger level (LINDAS dangerLevel): discharge, lakes level; `undefined` is cube.link/Undefined, never 1.
  ...rows('CH-1', 'danger', 'discharge', 'public', [
    ['1', 'normal'],
    ['2', 'elevated'],
    ['3', 'high'],
    ['4', 'extreme'],
    ['5', 'extreme'],
    ['undefined', 'no_ref'],
  ]),
  // BAFU warning sections: as the danger level; level 0 "Keine Gefahrenstufe".
  ...rows('CH-5', 'section', 'area', 'public', [
    ['0', 'no_ref', 'level 0 "Keine Gefahrenstufe" is not in §4.9: no_ref'],
    ['1', 'normal'],
    ['2', 'elevated'],
    ['3', 'high'],
    ['4', 'extreme'],
    ['5', 'extreme'],
  ]),
  // Vigicrues section vigilance (NivInfViCr): an area class, attached to stations through TronEntVigiCru.
  ...rows('FR-5', 'section', 'area', 'public', [
    ['1', 'normal'],
    ['2', 'elevated'],
    ['3', 'high'],
    ['4', 'extreme'],
  ]),
  // LU-Alert cb-eu-level: inverted numbering (1 is red); TEST is dropped before it is stored.
  ...rows('LU-5', 'zone', 'area', 'public', [
    ['ALERT_LVL_4', 'normal'],
    ['ALERT_LVL_3', 'elevated'],
    ['ALERT_LVL_2', 'high'],
    ['ALERT_LVL_1', 'extreme'],
  ]),
  // SPW NIVCRU station attribute (`t<n>/<state>`): stored raw, its meaning is not documented.
  ...rows('BE-3', 'nivcru', 'stage', 'owner', [
    ['*', 'no_ref', 'NIVCRU meaning unknown: stored raw, never classifies'],
  ]),
];

/**
 * The stored level of a provider class: 1–5, null for no_ref, undefined for a code the crosswalk does not have
 * (the adapter drops it as `unmapped_class`, alerted: a new provider class is a reviewed change).
 */
export function levelOf(source: string, scale: string, code: string): 1 | 2 | 3 | 4 | 5 | null | undefined {
  const row =
    CROSSWALK.find((r) => r.source === source && r.scale === scale && r.code === code) ??
    CROSSWALK.find((r) => r.source === source && r.scale === scale && r.code === '*');
  if (row === undefined) return undefined;
  return row.level === 'no_ref' ? null : LEVEL_NORM[row.level];
}

/**
 * How each reference kind takes part in a classification (P7b): the level a value at or above (`>=`) or at or
 * below (`<=`) the reference reaches, or none (a reference that is stored and shown, never classifies). A draft
 * of the §4.9 rows; P7b decides partial sets and priority (operational > statistical > provider class).
 */
export type ReferenceRole = {
  source: string;
  kind: string;
  op: '>=' | '<=' | null;
  level: Level | null;
  basis: Basis;
  audience: 'public' | 'owner';
  flag?: string;
};

const ref = (
  source: string,
  kind: string,
  op: '>=' | '<=' | null,
  level: Level | null,
  basis: Basis,
  audience: 'public' | 'owner' = 'public',
  flag?: string,
): ReferenceRole => ({ source, kind, op, level, basis, audience, ...(flag ? { flag } : {}) });

export const REFERENCE_ROLES: readonly ReferenceRole[] = [
  ref('DE-1', 'MNW', '<=', 'low', 'stage'),
  ref('DE-1', 'MW', null, null, 'stage'),
  ref('DE-1', 'MHW', '>=', 'elevated', 'stage'),
  ref('DE-1', 'HSW', '>=', 'high', 'stage'),
  ref('DE-1', 'MARKE_I', null, null, 'stage', 'public', 'navigation mark, not in §4.9'),
  ref('DE-1', 'MARKE_II', null, null, 'stage', 'public', 'navigation mark (often = HSW), not in §4.9'),
  ref('DE-1', 'MARKE_III', null, null, 'stage', 'public', 'navigation mark, not in §4.9'),
  ref('DE-1', 'GLW', null, null, 'stage', 'public', 'not in §4.9'),
  ref('DE-1', 'NNW', null, null, 'stage'),
  ref('DE-1', 'HHW', null, null, 'stage'),
  ref('DE-1', 'NW', null, null, 'stage', 'public', 'C22: a period extreme (Kaub "NW 25"), not NNW'),
  ref('DE-1', 'HW', null, null, 'stage', 'public', 'C22: a period extreme (Kaub "HW 719"), not HHW'),
  ref('DE-7', 'LANUV_MNW', '<=', 'low', 'stage'),
  ref('DE-7', 'LANUV_MW', null, null, 'stage'),
  ref('DE-7', 'LANUV_MHW', null, null, 'stage', 'public', 'not in §4.9'),
  ref('DE-7', 'LANUV_INFO_1', '>=', 'elevated', 'stage'),
  ref('DE-7', 'LANUV_INFO_2', '>=', 'high', 'stage'),
  ref('DE-7', 'LANUV_INFO_3', '>=', 'extreme', 'stage'),
  ref('CH-2', 'WL2', '>=', 'elevated', 'discharge'),
  ref('CH-2', 'WL3', '>=', 'high', 'discharge'),
  ref('CH-2', 'WL4', '>=', 'extreme', 'discharge'),
  ref('CH-2', 'WL5', '>=', 'extreme', 'discharge'),
  ref('LU-4', 'LU4_YELLOW', '>=', 'elevated', 'stage', 'owner'),
  ref('LU-4', 'LU4_ORANGE', '>=', 'high', 'stage', 'owner'),
  ref('LU-4', 'LU4_RED', '>=', 'extreme', 'stage', 'owner'),
  ref('LU-4', 'HQ2', '>=', 'elevated', 'stage', 'owner'),
  ref('LU-4', 'HQ5', null, null, 'stage', 'owner', 'no status class for HQ5: stored, not mapped'),
  ref('LU-4', 'HQ10', '>=', 'high', 'stage', 'owner'),
  ref('LU-4', 'HQ20', '>=', 'high', 'stage', 'owner'),
  ref('LU-4', 'HQ50', '>=', 'extreme', 'stage', 'owner'),
  ref('LU-4', 'HQ100', '>=', 'extreme', 'stage', 'owner'),
  ref('LU-4', 'LU4_CRUE_REF', null, null, 'stage', 'owner', 'reference flood: historical, never classifies'),
  ref('BE-3', 'P05', '<=', 'low', 'stage', 'owner', 'D18 addendum: <= P05 low, else normal; never an alert level'),
  ref('FR-5', 'CRUE', null, null, 'stage', 'public', 'CruesHistoriques: historical, never classifies'),
];
