import type { TimeConvention } from '@rws/core';
import { TIME as DE2_TIME, normalise } from '../../adapters/de-2/normalise.ts';
import { parseForecast } from '../../adapters/de-2/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8a: the loader wiring of DE-2 (BfG `WV` water-level forecast, owner audience until the P12 BfG gate), merged into
// load/adapters.ts. The spec `de-2-wv` (variant = the PEGELONLINE station uuid) states one run per capture; it
// attaches to that station's DE-1 stage series `<uuid>/W` (`refTarget`), so the run's own source (DE-2) decides its
// audience: it reaches the owner views only, whatever the audience of the DE-1 series it sits on.

export const SOURCE = 'DE-2';
export const TIME: TimeConvention = DE2_TIME;

export const ADAPTER: LoadAdapter = {
  version: 1,
  specs: {
    'de-2-wv': {
      // The spec's max_bytes (1 MiB): the real document is about 7 KB.
      maxBytes: 1024 * 1024,
      // The document does not name its station: the manifest variant (the uuid) does.
      needsVariant: true,
      refTarget: ['DE-1'],
      run: (body, ctx) => normalise(parseForecast(body), { variant: ctx.variant }),
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {};
