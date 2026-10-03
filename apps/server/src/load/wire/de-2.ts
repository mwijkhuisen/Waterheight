import type { TimeConvention } from '@rws/core';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8a: the loader wiring of DE-2 (BfG `WV`, owner audience until the P12 BfG gate), merged into load/adapters.ts.
// Package S2 fills ADAPTER (spec `de-2-wv`: needsVariant, refTarget ['DE-1']).

export const SOURCE = 'DE-2';
export const TIME: TimeConvention = { kind: 'iso-offset' };

export const ADAPTER: LoadAdapter | null = null;

export const PROOF: Readonly<Record<string, DstProof>> = {};
