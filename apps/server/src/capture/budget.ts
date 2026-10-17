import { CronPattern } from 'croner';
import type { Registry } from './specs.ts';

// Request budgets (A§7.3), computed from registry/capture.yaml × the seed CSVs:
// every scheduled run over one simulated UTC week, counted per host and minute,
// then the busiest sliding 60-minute window. Stage-2 requests (pages, listed
// stations, new files) are data-driven and not part of this count.

const WEEK_MIN = 7 * 24 * 60;
const WEEK_S = WEEK_MIN * 60;
/**
 * The modelled time of one request. ponytail: a constant, every request takes 1 s whatever the payload; the
 * real runtime cap is the undici Agent of http/client.ts (`connections: 2`, proven by
 * apps/server/test/http/transport.test.ts), so a slower provider queues instead of exceeding it. Measure the
 * latencies (status.json) and turn this into a per-spec figure if the model ever needs to be tighter.
 */
export const LATENCY_MS = 1000;

export type HostBudget = { host: string; peakPerHour: number; perWeek: number };

const hostOf = (url: string) => new URL(url.replace(/\{!?[a-z_]+\}/g, 'x')).hostname;

/**
 * Seconds into the simulated week (it starts on a Monday) at which each run of a cron starts, read from croner's
 * parsed pattern. A cron restricted by day of month, month, year, `L`, `W` or an nth weekday (`5#1`, `5L`) can
 * fall on any weekday in some week, so it is projected onto every day of the week at its time of day (the worst
 * case); a plain weekday list is read as it is. Every second the pattern allows counts, at its own minute. A cron
 * that yields no run throws: a spec the model cannot read must not count 0.
 */
function runStarts(cron: string): number[] {
  const p = new CronPattern(cron, 'UTC');
  // 63 is croner's "every occurrence" mask of a weekday; any other non-zero value is an nth or last one.
  const nth = Array.from(p.dayOfWeek).some((v) => v !== 0 && v !== 63);
  const projected =
    !p.starDOM ||
    !p.starYear ||
    p.lastDayOfMonth ||
    p.lastWeekday ||
    nth ||
    p.nearestWeekdays.some(Boolean) ||
    !p.month.every((x) => x === 1);
  const out: number[] = [];
  for (let m = 0; m < WEEK_MIN; m += 1) {
    const dow = (1 + Math.floor(m / 1440)) % 7;
    if (!p.minute[m % 60] || !p.hour[Math.floor(m / 60) % 24] || !(projected || p.dayOfWeek[dow])) continue;
    for (let sec = 0; sec < 60; sec += 1) if (p.second[sec]) out.push(m * 60 + sec);
  }
  if (out.length === 0) throw new Error(`budget: cron "${cron}" has no run in the simulated week`);
  return out;
}

/** Row j of a run starts j × (latency + space_ms) after the run: rows are sequential, each followed by the pause. */
const rowStepMs = (spec: Registry['specs'][number]) => LATENCY_MS + (spec.variants?.space_ms ?? 0);

/**
 * Start (ms into the simulated week) of every request of a seed with `utc_hours`, in every night of the week (the
 * worst case: a seed that is not finished runs again the next night). seeds.ts paces a row `pace_ms` after the
 * previous request ends, so one request per max(pace_ms, LATENCY_MS) is the ceiling: floor(3,600,000 / that) in
 * each hour of the window.
 */
export function seedStarts(spec: Registry['specs'][number]): number[] {
  const seed = spec.seed;
  if (seed?.utc_hours === undefined) return [];
  const step = Math.max(seed.pace_ms, LATENCY_MS);
  const out: number[] = [];
  for (let day = 0; day < 7; day += 1)
    for (let h = seed.utc_hours[0]; h < seed.utc_hours[1]; h += 1)
      for (let k = 0; k < Math.floor(3_600_000 / step); k += 1) out.push((day * 24 + h) * 3600_000 + k * step);
  return out;
}

/**
 * The seeds of a host as one stream. runSeeds (seeds.ts) runs the unfinished seeds strictly one after the other,
 * one request at a time (`for … await seedOne`, a round starts only after the previous one ends), so the seeds of a
 * host never add up: each minute (second) takes the busiest seed, not their sum. test/capture/budget.test.ts proves
 * the sequencing (runSeeds over the three catch-up specs: one request in flight). ponytail: every seed fills every night; a finished seed frees its share, which only lowers the real figure.
 */
function seedStream(registry: Registry, size: number, unit: number): Map<string, Uint32Array> {
  const byHost = new Map<string, Uint32Array>();
  for (const spec of registry.specs) {
    const starts = seedStarts(spec);
    if (starts.length === 0) continue;
    const mine = new Uint32Array(size);
    for (const t of starts) {
      const i = Math.floor(t / unit) % size;
      mine[i] = (mine[i] as number) + 1;
    }
    const host = hostOf(spec.request.url);
    const acc = byHost.get(host) ?? new Uint32Array(size);
    byHost.set(host, acc);
    for (let i = 0; i < size; i += 1) acc[i] = Math.max(acc[i] as number, mine[i] as number);
  }
  return byHost;
}

export function requestsPerMinute(registry: Registry): Map<string, Uint32Array> {
  const byHost = new Map<string, Uint32Array>();
  for (const spec of registry.specs) {
    if (spec.cron === null) continue;
    const host = hostOf(spec.request.url);
    const minutes = byHost.get(host) ?? new Uint32Array(WEEK_MIN);
    byHost.set(host, minutes);
    const step = rowStepMs(spec);
    for (const start of runStarts(spec.cron)) {
      // A run that spills past Sunday 23:59 continues on Monday, as the sliding window wraps.
      for (let j = 0; j < spec.rows.length; j += 1) {
        const m = Math.floor((start * 1000 + j * step) / 60_000) % WEEK_MIN;
        minutes[m] = (minutes[m] as number) + 1;
      }
    }
  }
  for (const [host, seeds] of seedStream(registry, WEEK_MIN, 60_000)) {
    const minutes = byHost.get(host) ?? new Uint32Array(WEEK_MIN);
    byHost.set(host, minutes);
    for (let i = 0; i < WEEK_MIN; i += 1) minutes[i] = (minutes[i] as number) + (seeds[i] as number);
  }
  return byHost;
}

/**
 * Requests in flight per second of the simulated week, per host (same runs as requestsPerMinute): rows are
 * sequential within a run, each LATENCY_MS long, space_ms apart. Two runs of one host can overlap, and the
 * transport allows two connections per origin, so the peak must stay at 2. Seeds are not in this count: they are one
 * sequential stream (seedStream), at most one request at a time (seedStarts are ≥ LATENCY_MS apart), and a seed
 * request that meets two scheduled ones queues behind the transport's two connections for the rest of that second.
 */
export function inFlightPerSecond(registry: Registry): Map<string, Uint8Array> {
  const byHost = new Map<string, Uint8Array>();
  for (const spec of registry.specs) {
    if (spec.cron === null) continue;
    const host = hostOf(spec.request.url);
    const seconds = byHost.get(host) ?? new Uint8Array(WEEK_S);
    byHost.set(host, seconds);
    const step = rowStepMs(spec);
    for (const start of runStarts(spec.cron)) {
      for (let j = 0; j < spec.rows.length; j += 1) {
        const from = start * 1000 + j * step;
        for (let sec = Math.floor(from / 1000); sec <= Math.floor((from + LATENCY_MS - 1) / 1000); sec += 1) {
          seconds[sec % WEEK_S] = (seconds[sec % WEEK_S] as number) + 1;
        }
      }
    }
  }
  return byHost;
}

export function budgets(registry: Registry): HostBudget[] {
  const out: HostBudget[] = [];
  for (const [host, minutes] of requestsPerMinute(registry)) {
    let window = 0;
    let peak = 0;
    let total = 0;
    // Sliding over the week, wrapping around so Sunday 23:xx meets Monday 00:xx.
    for (let i = 0; i < WEEK_MIN + 60; i += 1) {
      window += minutes[i % WEEK_MIN] as number;
      if (i >= 60) window -= minutes[(i - 60) % WEEK_MIN] as number;
      if (i < WEEK_MIN) total += minutes[i] as number;
      peak = Math.max(peak, window);
    }
    out.push({ host, peakPerHour: peak, perWeek: total });
  }
  return out.sort((a, b) => b.peakPerHour - a.peakPerHour);
}

/** The dry-run schedule: one line per spec, then the per-host peaks. */
export function schedule(registry: Registry): string {
  const lines = ['spec                 source audience cron                cadence_s variants req/h'];
  for (const s of registry.specs) {
    const perHour = s.cadence_s === null ? 0 : (s.rows.length * 3600) / s.cadence_s;
    lines.push(
      `${s.id.padEnd(20)} ${s.source.padEnd(6)} ${s.audience.padEnd(8)} ${String(s.cron ?? '(seed only)').padEnd(19)} ${String(s.cadence_s ?? '-').padStart(9)} ${String(s.rows.length).padStart(8)} ${perHour.toFixed(1).padStart(6)}`,
    );
  }
  lines.push('', 'host                                          peak requests in any 60 min');
  for (const b of budgets(registry)) lines.push(`${b.host.padEnd(45)} ${b.peakPerHour}`);
  return lines.join('\n');
}
