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
