import type { DOY_KINDS, DoySet } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';
import { type DirtyKind, dirtyEntriesOf, markDirty } from '../load/dirty.ts';
import type { Tx } from '../load/store.ts';
import type { Candidate } from './read.ts';

// The writes of the climatology command (P14f, plan section 3.4): the series' P10_DOY and P90_DOY rows in
// reference_value, one transaction per series under the loader lock (the caller takes it), then the dirty log. A key
// whose stored value, period and label equal the new ones is left alone, so a re-run that changes nothing writes
// nothing; a changed key closes its open range and opens another from the run's start (past days never change, so
// settled files stay consistent); a key the new set no longer has is closed.

export type Wanted = { kind: (typeof DOY_KINDS)[number]; md: number; value: number };
export type Stored = { kind: string; md: number; value: number; lo: Date; period: string; label: string | null };
export type Counts = { new: number; changed: number; unchanged: number; closed: number };
export type Plan = { insert: Wanted[]; close: { kind: string; md: number }[]; counts: Counts };

const periodOf = (set: DoySet) => `[${set.period[0]}-01-01,${set.period[1] + 1}-01-01)`;

/** The rows a set stores: P10 and P90 per day key (P50 is computed and not stored until a chart band needs it). */
export const wantedOf = (set: DoySet | null): Wanted[] =>
  set === null
    ? []
    : set.rows.flatMap((r) => [
        { kind: 'P10_DOY' as const, md: r.md, value: r.p10 },
        { kind: 'P90_DOY' as const, md: r.md, value: r.p90 },
      ]);

/** The series' open DOY rows (the caller holds the loader lock when it is about to write). */
export async function readStored(db: Kysely<DB>, series: number): Promise<Stored[]> {
  const { rows } = await sql<Stored>`
    SELECT kind, season_from_md AS md, value, lower(valid) AS lo, period::text AS period, basis_label AS label
    FROM reference_value
    WHERE series_id = ${series} AND kind IN ('P10_DOY', 'P90_DOY') AND upper_inf(valid)
      AND season_from_md = season_to_md`.execute(db);
  return rows;
}

/** Pure: what to close, what to insert and the counts. A float4 column: values compare as `Math.fround`. */
export function planOf(set: DoySet | null, stored: readonly Stored[]): Plan {
  const have = new Map(stored.map((s) => [`${s.kind}|${s.md}`, s]));
  const plan: Plan = { insert: [], close: [], counts: { new: 0, changed: 0, unchanged: 0, closed: 0 } };
  const period = set === null ? '' : periodOf(set);
  const label = set?.basisLabel ?? null;
  for (const w of wantedOf(set)) {
    const s = have.get(`${w.kind}|${w.md}`);
    have.delete(`${w.kind}|${w.md}`);
    if (s === undefined) {
      plan.counts.new += 1;
    } else if (Math.fround(s.value) === Math.fround(w.value) && s.period === period && s.label === label) {
      plan.counts.unchanged += 1;
      continue;
    } else {
      plan.counts.changed += 1;
      plan.close.push({ kind: s.kind, md: s.md });
    }
    plan.insert.push(w);
  }
  for (const s of have.values()) {
    plan.counts.closed += 1;
    plan.close.push({ kind: s.kind, md: s.md });
  }
  return plan;
}

const NO_TOUCHES: Record<DirtyKind, never[]> = {
  obs: [],
  forecast: [],
  reference: [],
  class: [],
  warning: [],
  gauge_zero: [],
};

/**
 * Applies a plan for one series inside the caller's transaction (which holds the loader lock): closes, inserts
 * (`WHERE NOT EXISTS`: the key is a temporal one, so there is no ON CONFLICT target) and marks the series' station
 * dirty from `at` on. `at` is the run's start, or one millisecond after the newest open range it closes.
 */
export async function applyPlan(
  tx: Tx,
  c: Candidate,
  set: DoySet | null,
  stored: readonly Stored[],
  plan: Plan,
  runStart: Date,
): Promise<void> {
  if (plan.close.length === 0 && plan.insert.length === 0) return;
  const newestLo = stored.reduce((m, s) => Math.max(m, s.lo.getTime()), Number.NEGATIVE_INFINITY);
  const at = new Date(Math.max(runStart.getTime(), newestLo + 1));
  if (plan.close.length > 0) {
    await sql`
      UPDATE reference_value r SET valid = tstzrange(lower(r.valid), ${at}::timestamptz), seen_at = ${at}::timestamptz
      FROM unnest(${plan.close.map((k) => k.kind)}::text[], ${plan.close.map((k) => k.md)}::int[]) AS k(kind, md)
      WHERE r.series_id = ${c.id} AND r.source_id = ${c.source} AND r.kind = k.kind AND r.season_from_md = k.md
        AND r.season_to_md = k.md AND r.priority = 0 AND upper_inf(r.valid)`.execute(tx);
  }
  if (plan.insert.length > 0 && set !== null) {
    await sql`
      INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, percentile_convention, period,
                                   season_from_md, season_to_md, priority, basis_label, valid, batch_id, seen_at)
      SELECT ${c.id}, ${c.source}, k.kind, k.v::real, ${c.unit}, 'statistical', 'non_exceedance',
             daterange(${`${set.period[0]}-01-01`}::date, ${`${set.period[1] + 1}-01-01`}::date, '[)'),
             k.md, k.md, 0, ${set.basisLabel}, tstzrange(${at}::timestamptz, NULL), NULL, ${at}::timestamptz
      FROM unnest(${plan.insert.map((w) => w.kind)}::text[], ${plan.insert.map((w) => w.md)}::int[],
                  ${plan.insert.map((w) => w.value)}::float8[]) AS k(kind, md, v)
      WHERE NOT EXISTS (
        SELECT 1 FROM reference_value x
        WHERE x.series_id = ${c.id} AND x.source_id = ${c.source} AND x.kind = k.kind AND x.season_from_md = k.md
          AND x.season_to_md = k.md AND x.priority = 0 AND x.valid && tstzrange(${at}::timestamptz, NULL))`.execute(tx);
  }
  // The series' states change from `at` on (the publishers render the station again; no settled day is bumped).
  await markDirty(
    tx,
    at,
    dirtyEntriesOf(
      c.audience,
      { ...NO_TOUCHES, reference: [{ series: c.id, from: at.getTime() }] },
      new Map([[c.id, { station: c.station, audience: c.audience }]]),
      new Map(),
    ),
  );
}
