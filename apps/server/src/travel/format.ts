import type { TravelEmpirical } from '@rws/contracts';

/**
 * The text of registry/travel-empirical.yaml and of `main.js travel-times` (P14f, plan section 3.6): the same header,
 * one JSON flow mapping per pair on its own line (valid YAML, diffable, the style of registry/rivernet.yaml), pairs
 * sorted, so the same data gives the same bytes. `test/travel/format.test.ts` holds the shipped file to this function.
 */
export const TRAVEL_EMPIRICAL_HEADER = `# Empirical travel times between two public stations of one reach (P14f, issue #29, plan section 3.6): the lag at
# which the changes of one station's level or discharge best match the other's, by flow class, measured on our own
# stored history. Written by \`node apps/server/dist/main.js travel-times\` (the \`publish\` service, \`rws_publish\`, the
# public views only), adopted by a reviewed data PR, and read by the geo build
# (tools/geo/rivernet/place.ts, scripts/gen-rivernet.ts) beside registry/rivers.yaml: a sourced pair of rivers.yaml
# always wins, a pair here names public stations only (anything else fails the build), and the next geo release
# carries it as reach.travel_time_h and as a derived pair that the site shows as "indicative (derived)".
#   h        [lo, hi] hours, the envelope of the flow classes below
#   classes  low, mid, high: the terciles of the upstream flow; [floor(P25), ceil(P75)] of the windows' lags, a class
#            with fewer windows than \`travel.min_windows\` of registry/climatology.yaml is left out
#   quantity Q or H: the series whose changes were correlated (discharge where both ends have it)
#   years    first and last UTC year of the windows behind the classes; windows: how many
# Shipped empty: the values exist only after the command has run in production.
`;

type PairKey = Pick<TravelEmpirical['pairs'][number], 'from_station' | 'to_station'>;

/** The file's order: by upstream station, then downstream (code-unit order, as every registry sort). */
export const comparePairs = (a: PairKey, b: PairKey): number =>
  (a.from_station < b.from_station ? -1 : a.from_station > b.from_station ? 1 : 0) ||
  (a.to_station < b.to_station ? -1 : a.to_station > b.to_station ? 1 : 0);

export function formatTravelEmpirical(file: TravelEmpirical): string {
  const pairs = [...file.pairs].sort(comparePairs);
  const rows = pairs
    .map((p) => {
      const classes: Record<string, [number, number]> = {};
      for (const c of ['low', 'mid', 'high'] as const) if (p.classes[c] !== undefined) classes[c] = p.classes[c];
      return `  - ${JSON.stringify({
        from_station: p.from_station,
        to_station: p.to_station,
        h: p.h,
        classes,
        quantity: p.quantity,
        years: p.years,
        windows: p.windows,
      })}\n`;
    })
    .join('');
  return `${TRAVEL_EMPIRICAL_HEADER}version: 1\ngenerated: ${JSON.stringify(file.generated)}\npairs:${rows === '' ? ' []\n' : `\n${rows}`}`;
}
