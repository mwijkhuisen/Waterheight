import { emptyNormalised, type TimeConvention } from '@rws/core';
import { TIME as DE3_TIME, isSixWeek, normalise } from '../../adapters/de-3/normalise.ts';
import { parseTable } from '../../adapters/de-3/parse.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8b: the loader wiring of DE-3 (BfG 14-day quantile forecasts, owner audience), merged into load/adapters.ts. The
// spec `de-3-files` (variant = the file's path under https://vorhersage.bafg.de/) states one file per gauge; a
// `14-Tage-Vorhersage/` file becomes one quantile run on that gauge's DE-1 stage series `<uuid>/W` (`refTarget`),
// found through its PEGELONLINE number (station `de.wsv.<number>`); the run's own source (DE-3) decides its audience,
// so it reaches the owner views only, whatever the audience of the DE-1 series it sits on. A `6-Wochen-Vorhersage/`
// file is another structure and is not read (no parse, no drift: its raw payload stays in the archive); a gauge DE-1
// does not register is `unknown`. The labels are CET all year (`start-of-interval`, +01:00): the spec loads only with
// its DST proof (PROOF), and the gate admits it.

export const SOURCE = 'DE-3';
export const TIME: TimeConvention = DE3_TIME;

export const ADAPTER: LoadAdapter = {
  version: 2,
  specs: {
    'de-3-files': {
      // The spec's max_bytes (1 MiB): a 14-day file is about 1.2 KB.
      maxBytes: 1024 * 1024,
      // The file does not name its gauge: the manifest variant (its path, with the PEGELONLINE number) does.
      needsVariant: true,
      refTarget: ['DE-1'],
      run: (body, ctx) => {
        if (isSixWeek(ctx.variant)) return emptyNormalised();
        const de1 = ctx.refRegistries?.get('DE-1');
        // The station's stage series in DE-1 (the number is the PEGELONLINE `de.wsv.<number>`); none is unknown.
        const keyOf = (number: string) => {
          for (const [key, s] of de1 ?? []) if (s.station === `de.wsv.${number}` && s.quantity === 'H') return key;
          return undefined;
        };
        return normalise(parseTable(body), { variant: ctx.variant, keyOf });
      },
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {
  'de-3-files': {
    fallBack: ['de-3-files-dst-fall-back.synthetic'],
    springForward: ['de-3-files-dst-spring-forward.synthetic'],
  },
};
