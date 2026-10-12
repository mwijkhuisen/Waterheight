// Pacing and the off-peak window of the backfill runner (P14a, plan §3.3 steps 1 and 4). One Pacer per host: at
// least `minIntervalMs` between the starts of ANY two requests (probes included) and at most `maxPerHour` in any
// sliding hour. The clock and the sleep are injected, so the tests run on a fake clock.

export type Window = { from: string; to: string };

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Is `now` inside the UTC window [from, to)? `from > to` wraps midnight. */
export function inWindow(now: Date, w: Window): boolean {
  const m = (now.getTime() % DAY_MS) / 60_000;
  const [a, b] = [minutes(w.from), minutes(w.to)];
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** When the window that contains `now` closes. Only meaningful while `inWindow`. */
export function windowEnd(now: Date, w: Window): Date {
  const midnight = now.getTime() - (now.getTime() % DAY_MS);
  const end = midnight + minutes(w.to) * 60_000;
  return new Date(end > now.getTime() ? end : end + DAY_MS);
}

export class Pacer {
  private readonly minIntervalMs: number;
  private readonly maxPerHour: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Start times (epoch ms) of the requests of the last hour, oldest first. */
  private readonly starts: number[] = [];

  constructor(
    limits: { min_interval_ms: number; max_per_hour: number },
    now: () => Date,
    sleep: (ms: number) => Promise<void>,
  ) {
    this.minIntervalMs = limits.min_interval_ms;
    this.maxPerHour = limits.max_per_hour;
    this.now = now;
    this.sleep = sleep;
  }

  /**
   * Waits until a request may start, then records it. False (nothing recorded, nothing waited) when the wait
   * would end at or after `deadline` (epoch ms).
   */
  async wait(deadline: number): Promise<boolean> {
    const t = this.now().getTime();
    while (this.starts.length > 0 && (this.starts[0] as number) <= t - HOUR_MS) this.starts.shift();
    let at = t;
    const last = this.starts.at(-1);
    if (last !== undefined) at = Math.max(at, last + this.minIntervalMs);
    if (this.starts.length >= this.maxPerHour) at = Math.max(at, (this.starts[0] as number) + HOUR_MS);
    if (at >= deadline) return false;
    if (at > t) await this.sleep(at - t);
    this.starts.push(Math.max(at, this.now().getTime()));
    return true;
  }
}
