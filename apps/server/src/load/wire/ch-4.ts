import type { TimeConvention } from '@rws/core';
import { TIME as CH4_TIME, normalise } from '../../adapters/ch-4/normalise.ts';
import { parseForecast } from '../../adapters/ch-4/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8b: the loader wiring of CH-4 (BAFU discharge forecasts, public), merged into load/adapters.ts. The spec
// `ch-4-forecast` (variant = the BAFU station id) states one run per capture; it attaches to that station's CH-1
// series (`<id>/Q`, or `<id>/W` for a lake level: `refTarget`), so the run's own source (CH-4) decides its audience
// and channels, whatever those of the CH-1 series it sits on. Only the `_de` figures are fetched; the figure's trace
// layout is checked by position and name in normalise (drift = quarantine, never a mislabelled run).

export const SOURCE = 'CH-4';
export const TIME: TimeConvention = CH4_TIME;

export const ADAPTER: LoadAdapter = {
  version: 1,
  specs: {
    'ch-4-forecast': {
      // The spec's max_bytes (2 MiB): the real figure is about 29 KB.
      maxBytes: 2 * 1024 * 1024,
      // The figure does not name its station: the manifest variant (the id) does.
      needsVariant: true,
      refTarget: ['CH-1'],
      run: (body, ctx) => normalise(parseForecast(body), { variant: ctx.variant }),
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {};
