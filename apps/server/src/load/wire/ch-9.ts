import type { TimeConvention } from '@rws/core';
import { TIME as CH9_TIME, normaliseRecords } from '../../adapters/ch-9/normalise.ts';
import { parseRecords } from '../../adapters/ch-9/parse.ts';
import type { Backfilled, DstProof, LoadAdapter } from '../adapters.ts';

// P14b: the loader wiring of CH-9 (data.bs.ch, Rhine 2289 and Birs 2106), merged into load/adapters.ts. Backfill only: no live spec.
// Its grid-aligned rows go to the CH-1 series of the same gauge (`obsTarget: 'CH-1'`), raw, never validated. The
// dataset id is the manifest variant (the body does not name it), so a `recovered` line cannot load.

const MIB = 1024 * 1024;

export const SOURCE = 'CH-9';
export const TIME: TimeConvention | null = CH9_TIME;

export const ADAPTER: LoadAdapter | null = {
  version: 1,
  specs: {
    'ch-9-backfill-bs': {
      maxBytes: 4 * MIB,
      needsVariant: true,
      backfill: true,
      obsTarget: 'CH-1',
      run: (b, c): Backfilled =>
        normaliseRecords(parseRecords(b, c.variant), {
          registry: c.registry,
          fetchedAt: c.fetchedAt,
          dataset: c.variant,
          backfill: c.backfill,
        }),
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {};
