import { QC } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { offsetFor } from '../adapters/lu-1/normalise.ts';
import type { DB } from '../db/generated.ts';
import { type Point, scoreShifts } from './align.ts';
import { lock, readMeta, writeMeta } from './store.ts';

// The LU-1 label offset (A§7.4 step 8; catalogue §2.6, §8 C14): AGE's CSV labelled a value 15 minutes after its
// time until its format change of 2026-09-30, and on time since. The offset is measured per UTC day against the
// public DE-1 Perl twin and stored in app_meta;
// the LU-1 normaliser shifts each day's labels by that day's offset (adapters/lu-1/normalise.ts `offsetFor`).

/**
 * What the detector found for one UTC day: an offset, or (review CR-4 of P5b) a day that decided nothing, kept so
 * that health shows the detector ran. An undecided day never reaches the normaliser: it carries the offset of the
 * latest decided day before it forward.
 */
export type OffsetDay =
  | { decided: true; minutes: number; n_aligned: number; share: number }
  | { decided: false; n_aligned: number };
export type OffsetState = { days: Record<string, OffsetDay> };

export const offsetKey = (source: string): string => `label_offset:${source}`;

/** The decided days of a state, in minutes per UTC day (only these are offsets). */
const decidedMinutes = (state: OffsetState | null | undefined): Record<string, number> =>
  Object.fromEntries(Object.entries(state?.days ?? {}).flatMap(([day, d]) => (d.decided ? [[day, d.minutes]] : [])));

/** The measured offsets of a source, in minutes per decided UTC day, as the normaliser takes them. */
export async function labelOffsetsOf(
  db: Kysely<DB>,
  source: string,
): Promise<{ days: Readonly<Record<string, number>> }> {
  return { days: decidedMinutes(await readMeta<OffsetState>(db, offsetKey(source))) };
}

// ---------------------------------------------------------------- the detector

/**
 * The pair the detector compares: the LU-1 Perl series (a twin, stored with the offset applied at load time)
 * and the public DE-1 Perl W series (PEGELONLINE; LU-1 Perl is byte-identical to it, catalogue §2.6). Owner
 * data never corrects a public value: LU-2 is not used (A§7.4 step 8). test/registry-precedence.test.ts holds
 * this pair to registry/twins.yaml.
 */
export const OFFSET_PAIR = {
  source: 'LU-1',
  key: 'Perl',
  against: { source: 'DE-1', key: 'c263ea53-ca4d-41f5-b3f5-6178fec302aa/W' },
} as const;

/** The shifts compared (minutes): the offset is expected to move by a whole step, if at all. */
export const OFFSET_SHIFTS = [-15, 0, 15] as const;
/** The file's step: an instant votes only where DE-1 moved since the step before and moves by the step after. */
const STEP_MS = 15 * 60_000;
/**
 * At least this many informative instants at the winning shift (review CR-4: Perl is an impounded reach whose
 * level stands still for hours; a flat stretch agrees at every shift, so it no longer votes). The real days of
 * the fixtures have 34 (2026-09-28, the P1a file) and 25 (2026-09-29, the seed) of their 96 instants.
 */
export const MIN_ALIGNED = 16;
/** The winning shift's share of equal values. */
export const MIN_SHARE = 0.9;
/** Every other shift's share is at least this much lower (a flat river matches every shift: no decision). */
export const MARGIN = 0.2;
/**
 * The largest offset believed (review L1): the AGE file was 15 minutes late or on time. A measurement further out
 * (each night adds its residual to the offset carried forward, so a skewed feed could walk it) decides nothing.
 */
export const MAX_OFFSET_MIN = 15;
/** Equal values: both feeds publish the same cm with one decimal (stored as `real`). */
const TOLERANCE_CM = 0.05;
/** Days kept in app_meta (the latest decided day is always kept: it is the offset carried forward). */
const KEEP_DAYS = 60;

/**
 * The LU-1 points that can tell the shifts apart: DE-1 states their instant and both instants a step away, and its
 * value differs from both (review CR-4). A stored point 15 minutes late then meets DE-1 only at shift −15, an
 * on-time one only at 0, while a flat stretch, which would agree at every shift and dilute the vote, is left out.
 */
function informative(lu: readonly Point[], de: readonly Point[]): Point[] {
  const at = new Map(de.map((p) => [p.ts, p.value]));
  const moved = (v: number, w: number | undefined) => w !== undefined && Math.abs(v - w) > TOLERANCE_CM + 1e-6;
  return lu.filter((p) => {
    const v = at.get(p.ts);
    return v !== undefined && moved(v, at.get(p.ts - STEP_MS)) && moved(v, at.get(p.ts + STEP_MS));
  });
}

/**
 * The residual of one day (pure): how far the stored LU-1 points are from DE-1 in minutes (the offset applied at
 * load time was short by `residual`), or null when the day does not decide it; with the informative instants at
 * the best shift and their share of equal values.
 */
export function detectResidual(
  lu: readonly Point[],
  de: readonly Point[],
): { residual: number | null; n_aligned: number; share: number } {
  const scores = scoreShifts(informative(lu, de), de, OFFSET_SHIFTS, { tolerance: TOLERANCE_CM });
  const best = scores.reduce((b, s) => (s.share > b.share ? s : b));
  const clear = scores.every((s) => s === best || s.n === 0 || s.share <= best.share - MARGIN);
  const share = Math.round(best.share * 1000) / 1000;
  if (best.n < MIN_ALIGNED || best.share < MIN_SHARE || !clear) return { residual: null, n_aligned: best.n, share };
  // Stored LU-1 points sit at true time + residual, so they meet DE-1 at shift −residual.
  return { residual: best.shift === 0 ? 0 : -best.shift, n_aligned: best.n, share };
}

const DAY_MS = 86_400_000;

/**
 * The nightly measurement (A§7.4 step 8) of the last complete UTC day before `now`, once: its loads applied
 * the offset carried forward from the days decided before it, and the day's offset is that plus the
 * residual. (A day is never measured again: after a replay its rows carry the measured offset, which would
 * read as a residual of the old one.) A different offset than the loads applied is alerted (`label_offset_changed`):
 * the next LU-1 payloads and a replay of the payloads that state the day (docs/runbooks/label-offset.md) move
 * the values, each move an obs_revision, never silently. A day that does not decide it (DE-1 Perl missing,
 * stale, coarser than 15 minutes, a flat river, or an offset beyond ±MAX_OFFSET_MIN) is alerted
 * (`label_offset_unknown`, once a night), stored as undecided and keeps the offset carried forward. Writes LU-1's
 * `detail.label_offset` for public health: the latest measured day, whether it decided, and the offset of the
 * latest day that did.
 */
export async function detectLabelOffsets(
  db: Kysely<DB>,
  now: Date,
  alert: (code: string, fields: Record<string, string | number>) => void,
): Promise<void> {
  const { source, key, against } = OFFSET_PAIR;
  const ids = await sql<{ source_id: string; id: number }>`
    SELECT source_id, id FROM series
    WHERE active AND ((source_id = ${source} AND provider_key = ${key})
                   OR (source_id = ${against.source} AND provider_key = ${against.key}))`.execute(db);
  const lu = ids.rows.find((r) => r.source_id === source)?.id;
  const de = ids.rows.find((r) => r.source_id === against.source)?.id;
  if (lu === undefined || de === undefined) return;
  const state: OffsetState = (await readMeta<OffsetState>(db, offsetKey(source))) ?? { days: {} };
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
  const day = new Date(from).toISOString().slice(0, 10);
  if (Object.hasOwn(state.days, day)) return;
  const applied = offsetFor(day, { days: decidedMinutes(state) });
  const pad = 30 * 60_000;
  const { rows } = await sql<{ series_id: number; ts: Date; value: number }>`
    SELECT series_id, ts, value FROM obs
    WHERE ((series_id = ${lu} AND ts >= ${new Date(from)}::timestamptz AND ts < ${new Date(from + DAY_MS)}::timestamptz)
        OR (series_id = ${de} AND ts >= ${new Date(from - pad)}::timestamptz
            AND ts < ${new Date(from + DAY_MS + pad)}::timestamptz))
      AND (qc & ${QC.BACKFILLED}::int2) = 0`.execute(db);
  const points = (id: number) =>
    rows.filter((r) => r.series_id === id).map((r) => ({ ts: r.ts.getTime(), value: r.value }));
  const found = detectResidual(points(lu), points(de));
  const measured = found.residual === null ? null : applied + found.residual;
  if (measured === null || Math.abs(measured) > MAX_OFFSET_MIN) {
    alert('label_offset_unknown', measured === null ? { source, day } : { source, day, measured });
    state.days[day] = { decided: false, n_aligned: found.n_aligned };
  } else {
    if (measured !== applied) alert('label_offset_changed', { source, day, from: applied, to: measured });
    state.days[day] = { decided: true, minutes: measured, n_aligned: found.n_aligned, share: found.share };
  }
  const days = Object.keys(state.days).sort();
  const kept = days.filter((d) => state.days[d]?.decided).at(-1);
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) if (d !== kept) delete state.days[d];
  await writeMeta(db, offsetKey(source), state);
  const newest = days.at(-1) as string;
  const latest = state.days[newest] as OffsetDay;
  const offset = kept === undefined ? undefined : (state.days[kept] as Extract<OffsetDay, { decided: true }>);
  await db.transaction().execute(async (tx) => {
    await lock(tx);
    await sql`
      UPDATE source_health SET detail = detail || ${JSON.stringify({
        label_offset: {
          day: newest,
          decided: latest.decided,
          n_aligned: latest.n_aligned,
          share: latest.decided ? latest.share : null,
          minutes: offset?.minutes ?? null,
          decided_day: kept ?? null,
        },
      })}::jsonb
      WHERE source_id = ${source}`.execute(tx);
  });
}
