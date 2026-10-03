import type { DATUMS } from '@rws/contracts';

// Vertical datums anchored on NAP (catalogue §4.1). A datum belongs to the
// series; heights are converted only for the station detail, never stored.

export type Datum = (typeof DATUMS)[number];

export type NapRelation =
  | { converted: true /** H_NAP = H_datum + offsetM */; offsetM: number; uncertaintyM: number; source: string }
  | { converted: false; reason: string };

const NOT_CONVERTED_FR = 'no usable NAP offset: the published offsets are contradicted at shared gauges (C40, D16)';

export const TO_NAP: Readonly<Record<Datum, NapRelation>> = {
  NAP: { converted: true, offsetM: 0, uncertaintyM: 0, source: 'reference (EPSG:5709)' },
  TAW: {
    converted: true,
    offsetM: -2.33,
    uncertaintyM: 0.02,
    source: 'EPSG:5710; live pairs Eijsden, Stevensweert, Maaseik',
  },
  /** The French name of TAW (SPW). */
  DNG: {
    converted: true,
    offsetM: -2.33,
    uncertaintyM: 0.02,
    source: 'EPSG:5710; live pairs Eijsden, Stevensweert, Maaseik',
  },
  NHN: { converted: true, offsetM: 0.01, uncertaintyM: 0.02, source: 'EPSG:7837/7838 (DHHN2016)' },
  NN: { converted: true, offsetM: 0.01, uncertaintyM: 0.08, source: 'DHHN12; NHN − NN is −80…+42 mm across Germany' },
  LN02: { converted: true, offsetM: -0.31, uncertaintyM: 0.05, source: 'derived at Basel: LN02 ≈ NHN + 0.32 m' },
  NG95: { converted: true, offsetM: 0, uncertaintyM: 0.01, source: 'tied to NAP; within 1 cm of NHN at Perl' },
  IGN69: { converted: false, reason: NOT_CONVERTED_FR },
  NGF1884: { converted: false, reason: NOT_CONVERTED_FR },
  LOCAL: { converted: false, reason: 'local gauge zero without a known height' },
  MSL: { converted: false, reason: 'station-specific datum' },
};

export type NapHeight =
  | { converted: true; heightM: number; uncertaintyM: number; source: string }
  | { converted: false; reason: string };

/** An absolute height in `datum` as "≈ m NAP (± uncertainty)", or "not converted": never a guessed number. */
export function toNap(datum: Datum, heightM: number): NapHeight {
  const rel = TO_NAP[datum];
  if (!rel.converted) return rel;
  return {
    converted: true,
    heightM: Number((heightM + rel.offsetM).toFixed(3)),
    uncertaintyM: rel.uncertaintyM,
    source: rel.source,
  };
}

/** Sources whose gauge zeros come only from Hub'Eau metadata (incl. the §0.6 Belgian partners): never converted (D16). */
export const HUBEAU_ZERO_SOURCES: ReadonlySet<string> = new Set(['FR-1']);
/** Datums whose zero is shown as published, unverified, and never converted (C40, D16). */
const UNVERIFIED_ZERO: ReadonlySet<Datum> = new Set(['IGN69', 'NGF1884']);

export type HeightIn = {
  /** The series' source. */
  source: string;
  quantity: 'H' | 'Q';
  valueKind: 'stage' | 'level' | null;
  /** The series' datum (a level's own datum). */
  datum: Datum | null;
  /** The canonical value: cm. */
  valueCm: number;
  /** The gauge zero valid at t, or null. */
  zero: { valueM: number; datum: Datum } | null;
};

/**
 * The detail view's "≈ x.xx m NAP (± y)" (D16; catalogue §4.1, §4.7(5)): a level in its own datum, a stage as the
 * gauge zero valid at t plus W/100 in the zero's datum. A French (IGN69, NGF-1884) or Hub'Eau-only zero gives no
 * height: it is returned as published (`zero`) to be shown as unverified. Discharge, a local or unknown datum and a
 * stage without a zero give null. Never on the map scale.
 */
export function napHeight(
  h: HeightIn,
): { nap: { m: number; pm: number } } | { zero: { m: number; datum: Datum } } | null {
  if (h.quantity !== 'H') return null;
  if (h.valueKind === 'level') {
    if (h.datum === null) return null;
    const r = toNap(h.datum, h.valueCm / 100);
    return r.converted ? { nap: { m: r.heightM, pm: r.uncertaintyM } } : null;
  }
  if (h.zero === null) return null;
  if (HUBEAU_ZERO_SOURCES.has(h.source) || UNVERIFIED_ZERO.has(h.zero.datum)) {
    return { zero: { m: h.zero.valueM, datum: h.zero.datum } };
  }
  const r = toNap(h.zero.datum, h.zero.valueM + h.valueCm / 100);
  return r.converted ? { nap: { m: r.heightM, pm: r.uncertaintyM } } : null;
}
