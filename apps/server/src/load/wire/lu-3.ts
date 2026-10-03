import { emptyNormalised, type TimeConvention } from '@rws/core';
import { combineStaged, TIME as LU3_TIME, normalisePart, PERCENTILES } from '../../adapters/lu-3/normalise.ts';
import { parsePercentile } from '../../adapters/lu-3/parse.ts';
import { REGISTRY_DIR, readSeed } from '../../capture/specs.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P8a: the loader wiring of LU-3 (AGE percentile forecasts, owner audience), merged into load/adapters.ts. A file is
// one percentile of one station (spec `lu-3-percentile`, variant `<slug>/<p>`); it becomes a staged part of its
// station and UTC fetch hour, and the loader stores one run per station once all five percentiles are there
// (`combine`, load/forecasts.ts). The run belongs to the station's LU-1 series (`refTarget`), found through the
// station id `lu.age.<slug>`; only the slugs of registry/seed/lu-3.csv load, any other is `unknown`. Perl,
// Stadtbredimus and Wasserbillig are not in the seed (LfU RLP-computed) and Gemünd's LU-1 series is `off`, so it stores
// nothing.

export const SOURCE = 'LU-3';
export const TIME: TimeConvention = LU3_TIME;

const MIB = 1024 * 1024;

/** LU-1 slug → the display limit in hours (registry/seed/lu-3.csv `limit_h`), null when the seed leaves it empty. */
let seed: ReadonlyMap<string, 24 | 48 | null> | undefined;

export function lu3Seed(): ReadonlyMap<string, 24 | 48 | null> {
  seed ??= new Map(
    readSeed(REGISTRY_DIR, 'lu-3').map((r) => {
      const limit = r.limit_h ?? '';
      if (limit !== '' && limit !== '24' && limit !== '48') throw new Error('lu-3 seed: bad limit_h');
      return [r.slug as string, limit === '' ? null : (Number(limit) as 24 | 48)] as const;
    }),
  );
  return seed;
}

export const ADAPTER: LoadAdapter = {
  version: 1,
  specs: {
    'lu-3-percentile': {
      maxBytes: MIB,
      needsVariant: true,
      refTarget: ['LU-1'],
      run: (body, ctx) => {
        const lu1 = ctx.refRegistries?.get('LU-1');
        // The station's one stage series in LU-1; a slug that is not in the seed has none (unknown, never guessed).
        const keyOf = (slug: string) => {
          if (!lu3Seed().has(slug)) return undefined;
          for (const [key, s] of lu1 ?? []) if (s.station === `lu.age.${slug}` && s.quantity === 'H') return key;
          return undefined;
        };
        const { part, dropped, unknown } = normalisePart(parsePercentile(body), { variant: ctx.variant, keyOf });
        return {
          ...emptyNormalised(),
          dropped,
          unknown,
          ...(part === null
            ? {}
            : {
                forecastPart: {
                  target: 'LU-1',
                  series: part.series,
                  slot: part.slug,
                  // The UTC hour of the fetch: the recorder asks all 55 files of an hour within seconds.
                  group: new Date(ctx.fetchedAt).toISOString().slice(0, 13),
                  part: String(part.percentile),
                  data: part,
                },
              }),
        };
      },
      combine: { parts: PERCENTILES.length, run: combineStaged },
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {};
