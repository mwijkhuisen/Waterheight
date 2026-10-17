import { Cron, CronPattern } from 'croner';
import type { Registry } from './specs.ts';

// Request budgets (A§7.3), computed from registry/capture.yaml × the seed CSVs:
// every scheduled run over one simulated UTC week, counted per host and minute,
// then the busiest sliding 60-minute window. Stage-2 requests (pages, listed
// stations, new files) are data-driven and not part of this count.

const WEEK_MIN = 7 * 24 * 60;
const WEEK_S = WEEK_MIN * 60;
const START = Date.parse('2026-10-05T00:00:00Z'); // a Monday
/**
 * The modelled time of one request. ponytail: a constant, every request takes 1 s whatever the payload; the
 * real runtime cap is the undici Agent of http/client.ts (`connections: 2`, proven by
 * apps/server/test/http/transport.test.ts), so a slower provider queues instead of exceeding it. Measure the
 * latencies (status.json) and turn this into a per-spec figure if the model ever needs to be tighter.
 */
export const LATENCY_MS = 1000;

export type HostBudget = { host: string; peakPerHour: number; perWeek: number };

const hostOf = (url: string) => new URL(url.replace(/\{!?[a-z_]+\}/g, 'x')).hostname;

/** Seconds into the simulated week at which each run of a cron starts. */
function runStarts(cron: string): number[] {
  const p = new CronPattern(cron, 'UTC');
  const out: number[] = [];
  if (p.second[0] === 1 && p.second.indexOf(1, 1) < 0) {
    // A day-of-month restriction (a monthly spec) is projected onto every day of the week at its time of day: the
    // 1st can be any weekday, so the worst case is every day. The month field is ignored for the same reason.
    const monthly = !p.day.every((d) => d === 1) || !p.month.every((x) => x === 1);
    for (let m = 0; m < WEEK_MIN; m += 1) {
      const dow = (1 + Math.floor(m / 1440)) % 7; // START is a Monday
      if (p.minute[m % 60] && p.hour[Math.floor(m / 60) % 24] && (monthly || p.dayOfWeek[dow])) {
        out.push(m * 60);
      }
    }
    return out;
  }
  const job = new Cron(cron, { timezone: 'UTC', paused: true });
  let t: Date | null = new Date(START - 1000);
  for (;;) {
    t = job.nextRun(t);
    if (t === null) break;
    const sec = Math.floor((t.getTime() - START) / 1000);
    if (sec >= WEEK_S) break;
    out.push(sec);
  }
  job.stop();
  return out;
}

/** Row j of a run starts j × (latency + space_ms) after the run: rows are sequential, each followed by the pause. */
const rowStepMs = (spec: Registry['specs'][number]) => LATENCY_MS + (spec.variants?.space_ms ?? 0);

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
  return byHost;
}

/**
 * Requests in flight per second of the simulated week, per host (same runs as requestsPerMinute): rows are
 * sequential within a run, each LATENCY_MS long, space_ms apart. Two runs of one host can overlap, and the
 * transport allows two connections per origin, so the peak must stay at 2.
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
