import { Cron, CronPattern } from 'croner';
import type { Registry } from './specs.ts';

// Request budgets (A§7.3), computed from registry/capture.yaml × the seed CSVs:
// every scheduled run over one simulated UTC week, counted per host and minute,
// then the busiest sliding 60-minute window. Stage-2 requests (pages, listed
// stations, new files) are data-driven and not part of this count.

const WEEK_MIN = 7 * 24 * 60;
const START = Date.parse('2026-10-05T00:00:00Z'); // a Monday

export type HostBudget = { host: string; peakPerHour: number; perWeek: number };

export function requestsPerMinute(registry: Registry): Map<string, Uint32Array> {
  const byHost = new Map<string, Uint32Array>();
  for (const spec of registry.specs) {
    if (spec.cron === null) continue;
    const host = new URL(spec.request.url.replace(/\{!?[a-z_]+\}/g, 'x')).hostname;
    const minutes = byHost.get(host) ?? new Uint32Array(WEEK_MIN);
    byHost.set(host, minutes);
    const p = new CronPattern(spec.cron, 'UTC');
    const simple =
      p.second[0] === 1 && p.second.indexOf(1, 1) < 0 && p.day.every((d) => d === 1) && p.month.every((m) => m === 1);
    if (simple) {
      // Minute, hour and weekday fields only (all of capture.yaml): read croner's parsed flags per minute.
      for (let m = 0; m < WEEK_MIN; m += 1) {
        const dow = (1 + Math.floor(m / 1440)) % 7; // START is a Monday
        if (p.minute[m % 60] && p.hour[Math.floor(m / 60) % 24] && p.dayOfWeek[dow]) {
          minutes[m] = (minutes[m] as number) + spec.rows.length;
        }
      }
      continue;
    }
    const job = new Cron(spec.cron, { timezone: 'UTC', paused: true });
    let t: Date | null = new Date(START - 1000);
    for (;;) {
      t = job.nextRun(t);
      if (t === null) break;
      const m = Math.floor((t.getTime() - START) / 60_000);
      if (m >= WEEK_MIN) break;
      minutes[m] = (minutes[m] as number) + spec.rows.length;
    }
    job.stop();
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
