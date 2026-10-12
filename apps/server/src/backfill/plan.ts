// The planner (P14a): a job's range cut into chunks, and the request budget that stops a runaway.

export type Chunk = { from: Date; to: Date };

/** `[from, to)` in pieces of `chunkMs`, the last one shorter: the chunks tile the range exactly. */
export function planChunks(from: Date, to: Date, chunkMs: number): Chunk[] {
  const out: Chunk[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += chunkMs) {
    out.push({ from: new Date(t), to: new Date(Math.min(t + chunkMs, to.getTime())) });
  }
  return out;
}

/** The chunk that starts at `cursor` (the runner asks this after every commit). */
export function nextChunk(cursor: Date, rangeTo: Date, chunkMs: number): Chunk {
  return { from: cursor, to: new Date(Math.min(cursor.getTime() + chunkMs, rangeTo.getTime())) };
}

/** Calendar years `[from, to)` touches: the probe's upper bound of requests. */
export function probeYears(from: Date, to: Date): number {
  return new Date(to.getTime() - 1).getUTCFullYear() - from.getUTCFullYear() + 1;
}

/** Chunks plus probes with 20 % to spare: retries count, a runaway does not go on. */
export const requestBudget = (chunks: number, years: number): number => Math.ceil((chunks + years) * 1.2);

/** The end of the probe year that contains `at`, capped at `rangeTo`. */
export const yearEnd = (at: Date, rangeTo: Date): Date =>
  new Date(Math.min(Date.UTC(at.getUTCFullYear() + 1, 0, 1), rangeTo.getTime()));
