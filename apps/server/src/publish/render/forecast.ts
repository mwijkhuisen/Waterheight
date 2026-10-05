import type { StaticForecastLatest } from '@rws/contracts';
import type { RenderCtx } from '../cycle.ts';
import { attributionFor } from './attribution.ts';
import { sourceDates } from './dates.ts';
import { forecastOnce } from './series.ts';

// P9a: forecast/latest.json, the API's forecast document of the family at the cycle's clock (one read a cycle, shared
// with the station files) and the attribution of the runs' sources. Forecasts are not history: no window rule.

export async function renderForecast(c: RenderCtx): Promise<StaticForecastLatest> {
  const doc = await forecastOnce(c);
  const dates = await sourceDates(c.db, c.family, c.attribution);
  return { ...doc, attribution: attributionFor(c.attribution, new Set(doc.runs.map((r) => r.source)), dates) };
}
