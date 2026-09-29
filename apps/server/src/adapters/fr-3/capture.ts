import type { Adapter } from '../../http/types.ts';

// FR-3 Vigicrues observations (catalogue §2.5; the ~2-month seed only):
// `ObssHydro` holds [epoch ms UTC, value] pairs.
export const adapter: Adapter = {
  coverage(doc) {
    const obs = (doc as { Serie?: { ObssHydro?: unknown } } | null)?.Serie?.ObssHydro;
    if (!Array.isArray(obs)) return null;
    const ts = (obs as unknown[][]).map((o) => Number(o?.[0])).filter(Number.isFinite);
    if (ts.length === 0) return null;
    return { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString() };
  },
};
