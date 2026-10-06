import type { Change } from '../../lib/data/change.ts';
import { type DhBin, dhBin } from '../legend/palette.ts';

// Table paging and the Δh cell (P10a T7), pure.

export const PAGE_SIZE = 100;

export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));
/** Clamp a page (0-based) into range. */
export const clampPage = (page: number, total: number): number => Math.min(Math.max(0, page), pageCount(total) - 1);
/** The 1-based inclusive range shown on a page; 0–0 when empty. */
export function pageRange(page: number, total: number): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const p = clampPage(page, total);
  return { from: p * PAGE_SIZE + 1, to: Math.min(total, (p + 1) * PAGE_SIZE) };
}
/** The page that holds a row index. */
export const pageOf = (index: number): number => Math.floor(Math.max(0, index) / PAGE_SIZE);

/** The Δh cell: null when no change is known; else the bin, the amount and the trend for text. */
export function dhCell(change: Change | undefined, quantity: 'H' | 'Q') {
  if (change == null) return null;
  const bin: DhBin = dhBin(change, quantity);
  return { bin, dh: change.dh, trend: change.trend };
}
