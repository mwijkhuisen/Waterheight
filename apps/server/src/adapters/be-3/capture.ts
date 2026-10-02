import type { Adapter } from '../../http/types.ts';
import { tableRecords } from '../_shared/kiwis/parse.ts';
import { valuesRequests } from '../_shared/kiwis/request.ts';

// BE-3 SPW KiWIS (catalogue §2.4): the catch-up seed (`be-3-catchup`, P5c). Its root is a group's series list, the
// ts_path → ts_id resolution of this run (never a wildcard listing); stage 2 is getTimeseriesValues for every
// observed level and discharge series of the group over the seed's window, built by the shared KiWIS client (≤ 100
// ts_ids and ≤ 250,000 values a call). The host, path and datasource are the registry's: only digit ts_ids and the
// window reach the URL. A call already fetched (its seen id) is not asked again, so a resumed seed goes on.

/** The parameters the loader stores (A§6: H stage or level, Q discharge). */
export const PARAMETERS: ReadonlySet<string> = new Set(['H', 'H_sonde', 'Habs', 'Habs_sonde', 'Q', 'QADM']);

const TS_ID = /^\d{1,12}$/;

export const adapter: Adapter = {
  expand({ req, doc, seen, seed, window, checkUrl }) {
    // Only the seed has a window to catch up; a list that is not one is drift for the loader, not a request plan.
    if (!seed || window === null) return { reqs: [] };
    let rows: ReturnType<typeof tableRecords>;
    try {
      rows = tableRecords(doc);
    } catch {
      return { reqs: [] };
    }
    const ids = [
      ...new Set(
        rows
          .filter((r) => PARAMETERS.has(String(r.stationparameter_no)))
          .map((r) => String(r.ts_id))
          .filter((id) => TS_ID.test(id)),
      ),
    ].sort((a, b) => Number(a) - Number(b));
    const group = new URL(req.url).searchParams.get('timeseriesgroup_id') ?? '';
    if (!/^\d{1,12}$/.test(group)) return { reqs: [] };
    const reqs = valuesRequests(req.url, ids, window, {
      // Named by the batch's first ts_id, not its index: a series SPW adds before a resumed round shifts the
      // batches, and a call already fetched must still be the same call.
      variant: (from, _batch, batchIds) => `values/${group}/${from.toISOString().slice(0, 10)}/${batchIds[0]}`,
    });
    const out = [];
    for (const { values: _, ...r } of reqs) {
      if (seen.has(r.seen_id)) continue;
      const url = checkUrl(r.url);
      if (url !== null) out.push({ ...r, url });
    }
    return { reqs: out };
  },
  coverage(doc) {
    if (!Array.isArray(doc)) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const item of doc as { columns?: unknown; data?: unknown }[]) {
      if (typeof item?.columns !== 'string' || !Array.isArray(item.data)) continue;
      const at = item.columns.split(',').indexOf('Timestamp');
      if (at < 0) continue;
      for (const row of item.data as unknown[][]) {
        const t = Date.parse(String(row?.[at]));
        if (t < min) min = t;
        if (t > max) max = t;
      }
    }
    if (max === Number.NEGATIVE_INFINITY) return null;
    return { from: new Date(min).toISOString(), to: new Date(max).toISOString() };
  },
};
