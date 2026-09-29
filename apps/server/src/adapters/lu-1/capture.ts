import type { Adapter } from '../../http/types.ts';

// LU-1 AGE CSV (catalogue §2.6): the header carries one column per time step,
// "dd.mm.yyyy HH:MM" in local time without offset (read here only to count
// the days the first CSV covers, for the seed report).
export const adapter: Adapter = {
  coverage(doc) {
    const header = (doc as { header?: unknown } | null)?.header;
    if (!Array.isArray(header)) return null;
    const ts = (header as unknown[])
      .map((h) => /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(String(h)))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])));
    if (ts.length === 0) return null;
    return { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString() };
  },
};
