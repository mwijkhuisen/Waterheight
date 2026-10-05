import type { FramesFile } from '@rws/contracts';
import { sql } from 'kysely';
import { valueSources } from '../../api/answer.ts';
import { iso } from '../../api/util.ts';
import { attributionFor } from '../../attribution.ts';
import { VIEWS } from '../../db/audience.ts';
import type { RenderCtx } from '../cycle.ts';
import { historyExcluded } from '../plan.ts';
import { readFacts } from './series.ts';

// P9a: frames (A§8 Q5): the hourly rollup's last value per series and hour of [from, to), for the playback. One row
// per display series with at least one value in the span (ids increasing), null where an hour has none; no dates in
// the attribution, so an ended day's file stays a function of (day, version).

const HOUR_MS = 3_600_000;

export async function renderFrames(c: RenderCtx, from: number, to: number): Promise<FramesFile> {
  const hours = Math.max(0, Math.round((to - from) / HOUR_MS));
  const facts = await readFacts(c.db, c.family);
  const { rows } = await sql<{ series_id: number; bucket: Date; vlast: number; qc_or: number }>`
    SELECT series_id, bucket, vlast, qc_or FROM ${sql.table(VIEWS[c.family].obs1h)}
    WHERE bucket >= ${new Date(from)}::timestamptz AND bucket < ${new Date(to)}::timestamptz`.execute(c.db);
  const bySeries = new Map<number, (number | null)[]>();
  // The qc bits of the kept hours per series: a filled hour names its fill source too (P9b, as the API does).
  const qcOf = new Map<number, number>();
  for (const r of rows) {
    const f = facts.get(r.series_id);
    const h = Math.round((r.bucket.getTime() - from) / HOUR_MS);
    if (f === undefined || historyExcluded(f, 'other') || h < 0 || h >= hours) continue;
    let row = bySeries.get(r.series_id);
    if (row === undefined) {
      row = new Array<number | null>(hours).fill(null);
      bySeries.set(r.series_id, row);
    }
    row[h] = r.vlast;
    qcOf.set(r.series_id, (qcOf.get(r.series_id) ?? 0) | r.qc_or);
  }
  const ids = [...bySeries.keys()].sort((a, b) => a - b);
  return {
    schemaVersion: 1,
    from: iso(new Date(from)),
    to: iso(new Date(to)),
    stepSeconds: 3600,
    series: ids,
    vlast: ids.map((id) => bySeries.get(id) as (number | null)[]),
    attribution: attributionFor(
      c.attribution,
      new Set(ids.flatMap((id) => valueSources((facts.get(id) as { source: string }).source, qcOf.get(id) ?? 0))),
    ),
  };
}
