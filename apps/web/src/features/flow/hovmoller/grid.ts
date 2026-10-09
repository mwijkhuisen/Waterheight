import type { ApiStation } from '@rws/contracts';
import { changesAt } from '../../../lib/data/change.ts';
import type { FrameStore } from '../../../lib/data/frames.ts';
import { ceilHour, DAY_MS, floorHour, HOUR_MS } from '../../../lib/time/time.ts';
import { type DhBin, dhBin } from '../../legend/palette.ts';
import type { Column } from './path.ts';

// P11c (issue #26): the rows and cells of the Hovmöller panel. Rows are whole UTC hours of the playback range, one
// 7-day page at a time; a cell is the map's own 24-hour change of the column's station at that hour (D-2), from the
// hourly frames (P11b). No value, a value past its staleness limit or no value 24 h before: a grey cell, never carried
// forward or interpolated. Pure.

/** The first and the last row hour (whole UTC hours, both included). */
export interface HourSpan {
  from: number;
  to: number;
}

/** null: no change known (grey). `quantity` is the series the change is of (H: cm, Q: m³/s). */
export interface Cell {
  bin: DhBin | null;
  change: number | null;
  quantity: 'H' | 'Q' | null;
}

const PAGE_MS = 168 * HOUR_MS;
/** The frames lead of a window: the bucket t − 1 h plus the Δ hour t − 24 h (playback's LEAD_MS). */
const LEAD_MS = 25 * HOUR_MS;

/**
 * The 7-day page of rows that holds `t`, pages aligned to `range.end` (playRange) and clamped to it; the newest page
 * when `t` is outside the range (live, or a forecast t). null when the range holds no hour.
 */
export function hovRows(t: number | undefined, range: { start: number; end: number }): HourSpan | null {
  const start = ceilHour(range.start);
  const end = floorHour(range.end);
  if (end < start) return null;
  const at = t === undefined ? end : floorHour(t);
  // At most two pages (playRange is ≤ 14 days): a range that starts on a whole hour 14 days back leaves its first
  // hour off both, and a `t` there shows the older page without a marker.
  const page = at < start || at > end ? 0 : Math.min(1, Math.floor((end - at) / PAGE_MS));
  return { from: Math.max(start, end - (page + 1) * PAGE_MS + HOUR_MS), to: end - page * PAGE_MS };
}

/** The row hours, ascending. */
export function hoursOf(rows: HourSpan): number[] {
  const out: number[] = [];
  for (let h = rows.from; h <= rows.to; h += HOUR_MS) out.push(h);
  return out;
}

/** The frames window for `rows` (useFrames, [from, to)): 25 h of lead (the bucket t − 1 h, the Δ hour t − 24 h). */
export function hovFetch(rows: HourSpan, displayStart: number): { from: number; to: number } {
  return { from: Math.max(ceilHour(displayStart), rows.from - LEAD_MS), to: rows.to };
}

const GREY: Cell = { bin: null, change: null, quantity: null };

/** Cells by [row][column]: rows as `hours`, columns as `columns`. */
export function buildGrid(
  columns: readonly Column[],
  stations: readonly ApiStation[],
  hours: readonly number[],
  frames: Pick<FrameStore, 'valuesAt'>,
): Cell[][] {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const sts = columns.map((c) => byId.get(c.id));
  // Only the series of the path's stations are ever read from a snapshot.
  const quantity = new Map<number, 'H' | 'Q'>();
  for (const st of sts) for (const s of st?.series ?? []) quantity.set(s.id, s.quantity);
  // Each hour is asked once: one row's h − 24 h is another row's h.
  const memo = new Map<number, { series: number; value: number }[]>();
  const valuesOf = (h: number) => {
    let hit = memo.get(h);
    if (hit === undefined) {
      const all = frames.valuesAt(h);
      hit = [];
      for (const id of quantity.keys()) {
        const v = all.get(id);
        if (v !== undefined) hit.push(v);
      }
      memo.set(h, hit);
    }
    return hit;
  };
  return hours.map((h) => {
    const changes = changesAt(quantity, valuesOf(h), valuesOf(h - DAY_MS));
    return sts.map((st): Cell => {
      if (st === undefined) return GREY;
      // The map's own rule (lib/stationStates.ts, trendSeries): the first H series with a change, else the Q series.
      const series =
        st.series.find((s) => s.quantity === 'H' && changes.get(s.id)) ?? st.series.find((s) => s.quantity === 'Q');
      const change = series === undefined ? null : (changes.get(series.id) ?? null);
      if (series === undefined || change === null) return GREY;
      return { bin: dhBin(change, series.quantity), change: change.dh, quantity: series.quantity };
    });
  });
}
