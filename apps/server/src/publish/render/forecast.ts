import type { StaticForecastLatest } from '@rws/contracts';
import { attributionFor, sourceDates } from '../../attribution.ts';
import type { RenderCtx } from '../cycle.ts';
import { forecastOnce, readFacts } from './series.ts';

// P9a: forecast/latest.json, the API's forecast document of the family at the cycle's clock (one read a cycle, shared
// with the station files) and the attribution of the runs' sources and of the series they sit on (P9b: every series
// id names its series' source, as the API's /series/{id}/forecast does). Forecasts are not history: no window rule.

export async function renderForecast(c: RenderCtx): Promise<StaticForecastLatest> {
  const doc = await forecastOnce(c);
  const dates = await sourceDates(c.db, c.family, c.attribution);
  const facts = await readFacts(c.db, c.family);
  const sources = new Set(
    doc.runs.flatMap((r) => {
      const on = facts.get(r.series)?.source;
      return on === undefined ? [r.source] : [r.source, on];
    }),
  );
  return { ...doc, attribution: attributionFor(c.attribution, sources, dates) };
}
