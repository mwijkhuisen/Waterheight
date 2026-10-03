import { TIME as DE6_TIME, normaliseAlerts, normaliseStations } from '../../adapters/de-6/normalise.ts';
import { parseAlerts, parseStations } from '../../adapters/de-6/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';
import { lhpStations } from '../tables.ts';

// P7a: the loader wiring of DE-6 (its specs, its time convention and, for a gated convention, its DST proof),
// merged into load/adapters.ts. A wiring file may use the guards and the registry tables; the adapter stays pure.
//
// DE-6 states no value, only station classes and regional alerts: both specs are 8 MiB at most (the stations
// answer is 0.6 MB, the alerts one a few hundred KB in a flood). The station table (registry/classes/de-6.yaml) is
// read once, on the first station payload, and handed to the normaliser; the DST proof runs with an empty registry
// and needs only that table.

export const SOURCE = 'DE-6';

const MIB = 1024 * 1024;

export const ADAPTER: LoadAdapter | null = {
  version: 1,
  specs: {
    'de-6-stations': {
      maxBytes: 8 * MIB,
      needsVariant: false,
      run: (b, c) => normaliseStations(parseStations(b), lhpStations(), c.fetchedAt),
    },
    'de-6-alerts': {
      maxBytes: 8 * MIB,
      needsVariant: false,
      run: (b, c) => normaliseAlerts(parseAlerts(b), c.fetchedAt),
    },
  },
};

/** Feature `timestamp`s are offset-less Europe/Berlin time: gated (A§7.4 step 2). */
export const TIME = DE6_TIME;

export const PROOF: Readonly<Record<string, DstProof>> = {
  'de-6-stations': {
    fallBack: ['de-6-stations-dst-fall-back.synthetic', 'de-6-stations-dst-fall-back-first.synthetic'],
    springForward: ['de-6-stations-dst-spring-forward.synthetic'],
  },
  'de-6-alerts': {
    fallBack: ['de-6-alerts-dst-fall-back.synthetic'],
    springForward: ['de-6-alerts-dst-spring-forward.synthetic'],
  },
};
