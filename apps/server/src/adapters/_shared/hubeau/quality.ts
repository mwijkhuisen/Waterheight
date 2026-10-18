import { QC } from '@rws/core';

// Hub'Eau hydrométrie codes (catalogue §2.5, §4.8), shared by FR-1 (observations_tr) and FR-2 (obs_elab): both
// state `code_statut` and the qualification with the same codes.
//  - code_statut 0, 4, 8 and 12 (no validation, raw, corrected, pre-validated) → qc "raw"; 16 → "validated";
//  - qualification 16 "Non qualifiée" and 20 "Bonne" set no bit, 12 "Douteuse" sets "provider-suspect".
// A code that is not here is unknown to the caller, which withholds the value (`unknown_quality`).
// Maps, not objects: a provider value must not find an inherited property.

export const STATUT: ReadonlyMap<number, number> = new Map([
  [0, QC.RAW],
  [4, QC.RAW],
  [8, QC.RAW],
  [12, QC.RAW],
  [16, QC.VALIDATED],
]);

export const QUALIFICATION: ReadonlyMap<number, number> = new Map([
  [12, QC.PROVIDER_SUSPECT],
  [16, 0],
  [20, 0],
]);
