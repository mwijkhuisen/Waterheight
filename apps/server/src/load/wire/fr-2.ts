import type { TimeConvention } from '@rws/core';
import { TIME as FR2_TIME, normaliseElab } from '../../adapters/fr-2/normalise.ts';
import { parseElab } from '../../adapters/fr-2/parse.ts';
import type { Backfilled, DstProof, LoadAdapter } from '../adapters.ts';

// P14b: the loader wiring of FR-2 (Hub'Eau obs_elab, the daily aggregates QmnJ and HIXnJ), merged into load/adapters.ts. Backfill only: no live spec.
// Its rows go to the FR-1 aggregate twin series (`obsTarget: 'FR-1'`); the day is local (Europe/Paris) before
// 2007-03-23 and UTC from then on, so the convention is gated and the spec loads only through its PROOF.

export const SOURCE = 'FR-2';
export const TIME: TimeConvention | null = FR2_TIME;

export const ADAPTER: LoadAdapter | null = {
  version: 1,
  specs: {
    'fr-2-backfill-elab': {
      // The spec's max_bytes (16 MiB): a full answer (size=20000 records) is about 7.6 MB.
      maxBytes: 16 * 1024 * 1024,
      // The answer names its series (code_station and grandeur_hydro_elab on every record).
      needsVariant: false,
      backfill: true,
      obsTarget: 'FR-1',
      // ctx.registry is FR-1's (the target's); the window is the line's chunk.
      run: (body, ctx): Backfilled =>
        normaliseElab(parseElab(body).data, {
          registry: ctx.registry,
          fetchedAt: ctx.fetchedAt,
          ...(ctx.backfill === undefined ? {} : { backfill: ctx.backfill }),
        }),
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {
  'fr-2-backfill-elab': {
    fallBack: ['fr-2-elab-dst-fall-back.synthetic'],
    springForward: ['fr-2-elab-dst-spring-forward.synthetic'],
  },
};
