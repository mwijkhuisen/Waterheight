import type { Adapter } from '../../http/types.ts';

// DE-1 PEGELONLINE (catalogue §2.2): measurements.json?start=PT6H, stretched
// after an outage (P30D at most on schedule; the P31D seed is the §0.1b
// harvest; P60D is silently truncated upstream).

const HOUR = 3_600_000;

export function period(from: Date, to: Date): string {
  const hours = Math.ceil((to.getTime() - from.getTime()) / HOUR);
  return hours <= 72 ? `PT${Math.max(1, hours)}H` : `P${Math.min(31, Math.ceil(hours / 24))}D`;
}

/** First and last timestamps of a measurements.json array (seed report). */
function coverage(doc: unknown): { from: string; to: string } | null {
  if (!Array.isArray(doc) || doc.length === 0) return null;
  const ts = (doc as { timestamp?: unknown }[]).map((m) => Date.parse(String(m?.timestamp))).filter(Number.isFinite);
  if (ts.length === 0) return null;
  return { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString() };
}

export const adapter: Adapter = {
  coverage,
  build({ req, window }) {
    if (window === null) return req;
    const url = new URL(req.url);
    url.searchParams.set('start', period(window.from, window.to));
    return { ...req, url: url.href };
  },
};
