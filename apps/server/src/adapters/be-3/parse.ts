import { parseTable, parseValues, type ValuesItem } from '../_shared/kiwis/parse.ts';

// BE-3 SPW KiWIS (catalogue §2.4): the three answers the capture archives, read by the shared KiWIS client's strict
// schemas (adapters/_shared/kiwis/parse.ts: bounded before Zod, an error object is drift). Nothing of SPW is
// declared here that the shared client does not already hold; this file only names the BE-3 specs' payloads.

export { type LayerItem, parseLayer, parseTable, parseValues, type ValuesItem } from '../_shared/kiwis/parse.ts';

/** A list answer as records keyed by its header row (getStationList, getTimeseriesList). */
export type Table = ReturnType<typeof parseTable>;

/** What a `be-3-catchup` payload holds: the group's series list (the root) or the values of a batch (stage 2). */
export type Catchup = { kind: 'list'; rows: Table } | { kind: 'values'; items: ValuesItem[] };

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * The catch-up's two documents are told apart by their shape, never by the manifest: `[[` opens a table (a header
 * row, then rows), `[{` or `[]` a values answer. Anything else (an error object included) goes to the values
 * parser, which names it: `kiwis_too_many_results`, `kiwis_error` or `invalid_type`.
 */
export function parseCatchup(body: Uint8Array): Catchup {
  let i = 0;
  const next = (): number | undefined => {
    while (WS.has(body[i] as number)) i += 1;
    return body[i++];
  };
  const table = next() === 0x5b && next() === 0x5b;
  return table ? { kind: 'list', rows: parseTable(body) } : { kind: 'values', items: parseValues(body) };
}
