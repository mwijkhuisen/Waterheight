import type { TimeConvention } from '@rws/core';
import { TIME as LU3_TIME } from '../../adapters/lu-3/normalise.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8a: the loader wiring of LU-3 (AGE percentile forecasts, owner audience), merged into load/adapters.ts.
// Package S3 fills ADAPTER (spec `lu-3-percentile`: needsVariant, refTarget ['LU-1'], `combine` of five parts).

export const SOURCE = 'LU-3';
export const TIME: TimeConvention = LU3_TIME;

export const ADAPTER: LoadAdapter | null = null;

export const PROOF: Readonly<Record<string, DstProof>> = {};
