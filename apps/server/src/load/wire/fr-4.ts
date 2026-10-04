import type { TimeConvention } from '@rws/core';
import { TIME as FR4_TIME, normalise } from '../../adapters/fr-4/normalise.ts';
import { parseDocument } from '../../adapters/fr-4/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8b: the loader wiring of FR-4 (Vigicrues forecasts, public), merged into load/adapters.ts. The spec `fr-4` carries
// two kinds of body: the national list (variant `H` or `Q`), which stores nothing, and one station's forecast
// (variant `<CdEntVigiCru>/<GrdSimul>`). A station body names its own station and parameter, so a `recovered` line
// loads too (`needsVariant` false); a variant, when there is one, must agree with the body. The run attaches to the
// station's FR-1 series `<code>/<H|Q>` (`refTarget`): a station FR-1 does not register counts `unknown` (all but the
// Rhine, Meuse and Scheldt basins: the capture fetches only those), a mirror takes no run, and the run's own source
// (FR-4) decides the audience.

export const SOURCE = 'FR-4';
export const TIME: TimeConvention = FR4_TIME;

export const ADAPTER: LoadAdapter = {
  version: 1,
  specs: {
    'fr-4': {
      // The spec's max_bytes (4 MiB): the largest recorded body is 70 KB.
      maxBytes: 4 * 1024 * 1024,
      needsVariant: false,
      refTarget: ['FR-1'],
      run: (body, ctx) => normalise(parseDocument(body), { variant: ctx.variant }),
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {};
