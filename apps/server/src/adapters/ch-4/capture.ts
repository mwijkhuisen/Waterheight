import type { Adapter } from '../../http/types.ts';

// CH-4 BAFU forecasts (catalogue §2.7): there is no run id, so a new run is a
// new Last-Modified plus a new run start. The run start is the latest first
// time step across the traces (the measured trace starts a day earlier).
// Unreadable → null, and the body is stored.

type Plot = { plot?: { data?: { x?: unknown }[] } };

export function runStart(doc: unknown): string | null {
  const traces = (doc as Plot | null)?.plot?.data;
  if (!Array.isArray(traces)) return null;
  const firsts = traces
    .map((t) => (Array.isArray(t?.x) ? t.x[0] : undefined))
    .filter((x): x is string => typeof x === 'string');
  return firsts.length === 0 ? null : firsts.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export const adapter: Adapter = {
  /** The forecast station list (ch-4-stations): a change is reported. */
  alertKey(doc) {
    const features = (doc as { features?: { properties?: { key?: unknown } }[] } | null)?.features;
    if (!Array.isArray(features)) return null;
    return features
      .map((f) => String(f?.properties?.key))
      .sort()
      .join(',');
  },
  gateKey(doc, headers) {
    const start = runStart(doc);
    return start === null ? null : `${headers['last-modified'] ?? ''}|${start}`;
  },
};
