import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Table } from './parse.ts';

// LU-1 AGE → canonical rows (catalogue §2.6, §4.4, §8 C14, C15). Declared here, never inferred per row:
//  - series: the station's Name exactly as published (Unicode NFC), because `Number` is always empty; the
//    registry maps every Name explicitly (scripts/gen-lu1-stations.ts), so a crafted name can only miss;
//  - time: the labels are Europe/Luxembourg wall-clock times without an offset (`naive-local`; local time
//    with DST since 09/2026). They are resolved as one axis, never one by one: the columns are consecutive
//    15-minute steps, so one unambiguous label fixes every column's instant by its position, and every label
//    must then read exactly as its instant does on a Luxembourg clock. On 2026-10-25 the labels 02:00–02:45
//    occur twice: the first pass is +02:00, the second +01:00, by column order, also when a payload starts
//    or ends inside the repeated hour. A label that cannot exist (the spring gap), a missing, doubled or
//    shuffled column, or any other irregularity is drift (`time_axis`): never guessed;
//  - label offset (§2.6, C14): the value under label T belongs to T − offset (15 minutes in the 5-day file of
//    2026-09, 0 since the 7-day file of 2026-09-30). The offset is measured daily against the DE-1 Perl twin
//    (load/label-offset.ts) and passed in per UTC day; a day without a measurement takes the latest measured
//    day before it, else LABEL_OFFSET_DEFAULT_MIN;
//  - unit and factor from the registry row: cm (stage, LOCAL), and Esch-Sûre in m NN (level, NG95, ×100);
//    the row's Unit must be the series' native unit, else its values are withheld (`unit_mismatch`);
//  - an empty cell is a gap, never 0; a Name twice withholds both rows (`conflict`);
//  - a row with a value after the last label (Esch-Sure) cannot be placed: withheld as `row_width`;
//  - qc raw; our range bit; rows outside the loader's window (`since`), older than 45 days or more than
//    15 minutes ahead are dropped.

export const SOURCE = 'LU-1';
const ZONE = 'Europe/Luxembourg';
export const TIME: TimeConvention = {
  kind: 'naive-local',
  zone: ZONE,
  dst: { gap: 'reject', overlap: 'reject' },
};

/**
 * The offset a day without a measurement takes when no earlier day was measured. Catalogue §2.6 and C14 found
 * the labels 15 minutes late in the 5-day file of 2026-09 (the P1a recording of 2026-09-29 matches DE-1 Perl
 * at −15 min, 96/96). Since 2026-09-30 AGE serves a 7-day file (672 labels, no trailing field) whose labels are
 * on time (2026-09-29 matches at 0, 96/96); every archived production payload is of that format (P5b, measured
 * on the owner's export). The daily detector measures it from then on (load/label-offset.ts).
 */
export const LABEL_OFFSET_DEFAULT_MIN = 0;

/** The file's step: one label per 15 minutes. */
export const STEP_MS = 15 * 60_000;

const MAX_AGE_MS = 45 * 86_400_000;

/** The measured offset in minutes per UTC day (`YYYY-MM-DD`), as the loader passes it. */
export type LabelOffsets = { days: Readonly<Record<string, number>> };

export type Context = { registry: Registry; fetchedAt: number; since?: number; labelOffsets?: LabelOffsets };

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** How a Luxembourg clock shows an instant, in the file's label format. */
export function label(ms: number): string {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(ZONE);
  return `${pad(z.day)}.${pad(z.month)}.${z.year} ${pad(z.hour)}:${pad(z.minute)}`;
}

/** The instant (UTC ms) of every label column, by position from one unambiguous label; drift otherwise. */
export function timeAxis(labels: readonly string[]): number[] {
  let anchor = -1;
  let at = 0;
  for (let i = labels.length - 1; i >= 0 && anchor < 0; i -= 1) {
    try {
      at = parseInstant(TIME, labels[i] as string);
      anchor = i;
    } catch (err) {
      if (!(err instanceof TimeError)) throw err;
      // An ambiguous or non-existent label cannot anchor; any other failure is a broken label.
      if (err.code !== 'dst_overlap' && err.code !== 'dst_gap')
        throw new SchemaDrift(`time_${err.code}`, `labels.${i}`);
    }
  }
  if (anchor < 0) throw new SchemaDrift('time_axis');
  return labels.map((l, i) => {
    const ms = at + (i - anchor) * STEP_MS;
    if (label(ms) !== l) throw new SchemaDrift('time_axis', `labels.${i}`);
    return ms;
  });
}

/** The offset (minutes) for a UTC day: measured that day, else the latest measured day before it, else the default. */
export function offsetFor(day: string, offsets: LabelOffsets | undefined): number {
  const days = offsets?.days ?? {};
  if (Object.hasOwn(days, day)) return days[day] as number;
  let best: string | undefined;
  for (const d of Object.keys(days)) if (d < day && (best === undefined || d > best)) best = d;
  return best === undefined ? LABEL_OFFSET_DEFAULT_MIN : (days[best] as number);
}

export function normalise(t: Table, ctx: Context): Normalised {
  const out = emptyNormalised();
  const axis = timeAxis(t.labels).map((ms) => ms - offsetFor(toIso(ms).slice(0, 10), ctx.labelOffsets) * 60_000);
  const filled = (cells: readonly string[]) => cells.filter((c) => c !== '').length;
  const names = new Map<string, number>();
  for (const r of t.rows) {
    const k = r.name.normalize('NFC');
    names.set(k, (names.get(k) ?? 0) + 1);
  }
  const unknown = new Set<string>();
  for (const r of t.rows) {
    const key = r.name.normalize('NFC');
    const decl = ctx.registry.get(key);
    if (decl === undefined) {
      unknown.add(key);
      continue;
    }
    if ((names.get(key) as number) > 1) {
      count(out, 'conflict', filled(r.cells));
      continue;
    }
    if (r.unit !== decl.native_unit) {
      count(out, 'unit_mismatch', filled(r.cells));
      continue;
    }
    if (r.extra !== '') {
      count(out, 'row_width', filled(r.cells) + 1);
      continue;
    }
    r.cells.forEach((cell, i) => {
      if (cell === '') return;
      const ts = axis[i] as number;
      const drop = isFuture(ts, ctx.fetchedAt)
        ? 'future'
        : ts < ctx.fetchedAt - MAX_AGE_MS
          ? 'too_old'
          : ctx.since !== undefined && ts < ctx.since
            ? 'outside_window'
            : null;
      if (drop !== null) {
        count(out, drop);
        return;
      }
      const value = scale(decl.to_canonical, Number(cell));
      out.obs.push({ series: key, ts: toIso(ts), value, qc: QC.RAW | rangeBit(decl.value_kind ?? 'stage', value) });
    });
  }
  out.unknown = unknown.size;
  return out;
}
