import type { Renderers } from '../cycle.ts';
import { renderForecast } from './forecast.ts';
import { renderFrames } from './frames.ts';
import { renderLatest } from './latest.ts';
import { renderMeta } from './meta.ts';
import { renderStation } from './series.ts';
import { renderSnapshot } from './snapshot.ts';
import { sources } from './sources.ts';
import { renderStations } from './stations.ts';
import { status } from './status.ts';
import { warnings } from './warnings.ts';

// P9a: the renderers of the publisher, one module per output (render/*.ts).

export const RENDERERS: Renderers = {
  stations: renderStations,
  latest: renderLatest,
  snapshot: renderSnapshot,
  frames: renderFrames,
  forecast: renderForecast,
  warnings,
  sources,
  station: renderStation,
  status,
  meta: renderMeta,
};
