import type { TimeConvention } from '@rws/core';
import {
  driftReport,
  TIME as FR5_TIME,
  normaliseLinks,
  normaliseStation,
  normaliseVigilance,
} from '../../adapters/fr-5/normalise.ts';
import { parseStation, parseTron, parseVigilance } from '../../adapters/fr-5/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';
import { vigicruesSectionCodes, vigicruesSectionTable } from '../tables.ts';

// P7a: the loader wiring of FR-5 (its specs, its time convention and, for a gated convention, its DST proof),
// merged into load/adapters.ts. A wiring file may use the guards and the registry tables; the adapter stays pure.
// `fr-5-ref` (the daily territory and station lists) is not listed: its payloads stay archived, unparsed.

const MIB = 1024 * 1024;

export const SOURCE = 'FR-5';
export const ADAPTER: LoadAdapter | null = {
  version: 1,
  specs: {
    // The whole-France map; only the sections of registry/vigicrues-sections.yaml are stored (areas, snapshot).
    'fr-5-vigilance': {
      maxBytes: 16 * MIB,
      needsVariant: false,
      run: (b, c) =>
        normaliseVigilance(parseVigilance(b), { fetchedAt: c.fetchedAt, sections: vigicruesSectionCodes() }),
    },
    // The territory documents and TronEntVigiCru per section (a stage-2 expansion) store nothing: the daily
    // payload reports drift against the section table. Only the first payload of a UTC day is compared (the
    // loader's once-a-day rule per spec), so a section that drifts is found when its document comes first.
    'fr-5-sections': {
      maxBytes: 4 * MIB,
      needsVariant: false,
      run: (b) => normaliseLinks(parseTron(b)),
      drift: (b) => driftReport(parseTron(b), vigicruesSectionTable()),
    },
    // station.json names its station: the historical floods become references of the FR-1 stage series.
    'fr-5-stations': {
      maxBytes: 4 * MIB,
      needsVariant: false,
      run: (b) => normaliseStation(parseStation(b)),
      refTarget: ['FR-1'],
    },
  },
};
export const TIME: TimeConvention | null = FR5_TIME;
export const PROOF: Readonly<Record<string, DstProof>> = {};
