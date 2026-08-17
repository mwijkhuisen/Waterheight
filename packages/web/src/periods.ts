/**
 * Chart period presets and the resolution each one asks for.
 *
 * The client picks a resolution rather than leaving it to the server so that a
 * one-year view never starts by requesting 52,000 raw points. The server may
 * still coarsen further under its point cap, and always reports what it
 * actually served.
 */

import type { Resolution } from '@rws/shared';

export interface Period {
  id: string;
  label: string;
  hours: number;
  resolution: Resolution;
}

export const PERIODS: Period[] = [
  { id: '24h', label: '24h', hours: 24, resolution: 'raw' },
  // The brief's default view.
  { id: '48h', label: '48h', hours: 48, resolution: 'raw' },
  { id: '7d', label: '7d', hours: 24 * 7, resolution: 'hourly' },
  { id: '30d', label: '30d', hours: 24 * 30, resolution: 'hourly' },
  { id: '1y', label: '1y', hours: 24 * 365, resolution: 'daily' },
];

export const DEFAULT_PERIOD = PERIODS.find((p) => p.id === '48h')!;

export function windowFor(period: Period, now = Date.now()): { from: Date; to: Date } {
  return { from: new Date(now - period.hours * 3_600_000), to: new Date(now) };
}
