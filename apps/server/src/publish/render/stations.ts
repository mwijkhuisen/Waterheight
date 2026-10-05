import { createHash } from 'node:crypto';
import type { StaticStations } from '@rws/contracts';
import { readStations } from '../../api/data.ts';
import { attributionFor } from '../../attribution.ts';
import type { RenderCtx } from '../cycle.ts';
import { historyExcluded, readFacts } from './series.ts';

// P9a: stations.json, the API's /stations with each series' source. A series is listed iff latest.json may carry it
// (§9 C5: metadata only); schemaVersion 2 (P9b) adds `api` per series, and a station left without a series is dropped.

/** The first 16 hex digits of the sha256 of the series ids joined by ',' (stations.json's order; latest.json repeats it). */
export const seriesHash = (ids: readonly number[]): string =>
  createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);

export async function renderStations(c: RenderCtx): Promise<StaticStations> {
  const [all, facts] = await Promise.all([readStations(c.db, c.family), readFacts(c.db, c.family)]);
  const stations = all.stations.flatMap((st) => {
    const series = st.series.flatMap((s) => {
      const f = facts.get(s.id);
      return f === undefined || historyExcluded(f, 'latest') ? [] : [{ ...s, source: f.source, api: f.lic_api }];
    });
    return series.length === 0 ? [] : [{ ...st, series }];
  });
  const ids = stations.flatMap((st) => st.series.map((s) => s.id));
  return {
    schemaVersion: 2,
    seriesHash: seriesHash(ids),
    stations,
    attribution: attributionFor(c.attribution, new Set(stations.flatMap((st) => st.series.map((s) => s.source)))),
  };
}
