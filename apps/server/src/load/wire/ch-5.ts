import type { TimeConvention } from '@rws/core';
import { TIME as CH5_TIME, normaliseWarnings } from '../../adapters/ch-5/normalise.ts';
import { parseWarnings } from '../../adapters/ch-5/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P7a: the loader wiring of CH-5 (its specs, its time convention and, for a gated convention, its DST proof),
// merged into load/adapters.ts. A wiring file may use the guards and the registry tables; the adapter stays pure.

const MIB = 1024 * 1024;

export const SOURCE = 'CH-5';
export const ADAPTER: LoadAdapter | null = {
  version: 1,
  specs: {
    // One payload per language (the manifest variant); the German one is stored, the English one is parsed for drift.
    'ch-5-warn': {
      maxBytes: 8 * MIB,
      needsVariant: true,
      run: (b, c) => normaliseWarnings(parseWarnings(b), { fetchedAt: c.fetchedAt, variant: c.variant }),
    },
  },
};
export const TIME: TimeConvention | null = CH5_TIME;
export const PROOF: Readonly<Record<string, DstProof>> = {};
