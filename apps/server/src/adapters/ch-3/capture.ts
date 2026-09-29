import type { Adapter } from '../../http/types.ts';

// CH-3 hydrodaten 40-day plot JSON (catalogue §2.7; the seed only): the first
// trace's x axis holds local times with an explicit offset.
export const adapter: Adapter = {
  coverage(doc) {
    const traces = (doc as { plot?: { data?: { x?: unknown }[] } } | null)?.plot?.data;
    const x = Array.isArray(traces) && Array.isArray(traces[0]?.x) ? (traces[0].x as unknown[]) : [];
    const ts = x.map((v) => Date.parse(String(v))).filter(Number.isFinite);
    if (ts.length === 0) return null;
    return { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString() };
  },
};
