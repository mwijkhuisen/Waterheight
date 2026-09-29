import type { Adapter } from '../../http/types.ts';

// LU-2 AGE per-station JSON (owner audience; catalogue §2.6): [{ data: [[time, value], …] }].
// Read only to report how many days the first capture covers (owner status).
export const adapter: Adapter = {
  coverage(doc) {
    const data = Array.isArray(doc) ? (doc[0] as { data?: unknown } | undefined)?.data : undefined;
    if (!Array.isArray(data)) return null;
    const ts = (data as unknown[][]).map((d) => Date.parse(String(d?.[0]))).filter(Number.isFinite);
    if (ts.length === 0) return null;
    return { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString() };
  },
};
