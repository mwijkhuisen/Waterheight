import { DAY_MS, floorBucket, type LatestFile, type StaticStations } from '@rws/contracts';
import { sql } from 'kysely';
import { lastCommit } from '../../api/health.ts';
import { iso, snapshot } from '../../api/util.ts';
import { attributionFor, sourceDates } from '../../attribution.ts';
import { OBS_AT, VIEWS } from '../../db/audience.ts';
import type { RenderCtx } from '../cycle.ts';
import { historyExcluded } from '../plan.ts';
import { readFacts } from './series.ts';
import { columns, readValues, sourcesOf } from './snapshot.ts';
import { seriesHash } from './stations.ts';

// P9a: latest.json, the current bucket in stations.json's series order (§9 C3: `current: true`), with the hash of that
// order and Δh over 24 h and over 1 h from Q1 at those instants. KG-233: the series of stations.json without a value
// at t are `lapsed`, each with the age of its newest value (the family's obs_latest view, so only what it may show).

const HOUR_MS = 3_600_000;
/** Δh in the series' unit to a millimetre, so float4 noise (100.3 − 99.9) does not reach the file. */
const delta = (a: number, b: number) => Math.round((a - b) * 1000) / 1000;

export async function renderLatest(
  c: RenderCtx,
  stations: StaticStations,
): Promise<{ body: LatestFile; latestFrom: string | null }> {
  const t = floorBucket(c.now);
  // Before the states read: whatever the render sees was loaded no later than this commit.
  const commit = await lastCommit(c.db, c.family, new Date(c.now));
  const [facts, all] = await Promise.all([readFacts(c.db, c.family), readValues(c, t, true)]);
  const byId = new Map(all.map((v) => [v.series, v]));
  const values = stations.stations.flatMap((st) =>
    st.series.flatMap((s) => {
      const v = byId.get(s.id);
      const f = facts.get(s.id);
      return v === undefined || f === undefined || historyExcluded(f, 'latest') ? [] : [v];
    }),
  );
  const q1 = (tx: Parameters<Parameters<typeof snapshot>[1]>[0], at: number) =>
    sql<{ series_id: number; value: number }>`
      SELECT series_id, value FROM ${sql.id(OBS_AT[c.family])}(${iso(new Date(at))}::timestamptz)`
      .execute(tx)
      .then((r) => new Map(r.rows.map((x) => [x.series_id, x.value])));
  const have = new Set(values.map((v) => v.series));
  const lapsed = stations.stations.flatMap((st) =>
    st.series.flatMap((s) => {
      const f = facts.get(s.id);
      return f === undefined || have.has(s.id) || historyExcluded(f, 'latest') ? [] : [s.id];
    }),
  );
  const [day, hour, newest] = await snapshot(
    c.db,
    async (tx) =>
      [
        await q1(tx, t - DAY_MS),
        await q1(tx, t - HOUR_MS),
        lapsed.length === 0
          ? new Map<number, Date>()
          : await sql<{ series_id: number; ts: Date }>`
              SELECT series_id, ts FROM ${sql.table(VIEWS[c.family].obsLatest)} WHERE series_id = ANY(${lapsed}::int[])`
              .execute(tx)
              .then((r) => new Map(r.rows.map((x) => [x.series_id, x.ts]))),
      ] as const,
  );
  // A series without history_export has no value older than its window to subtract.
  const dh = (v: (typeof values)[number], before: Map<number, number>, lag: number) => {
    const f = facts.get(v.series);
    const old = before.get(v.series);
    if (old === undefined || f === undefined) return null;
    if (!f.lic_history_export && (f.history_window_s === null || f.history_window_s < lag / 1000)) return null;
    return delta(v.value, old);
  };
  const cols = columns(iso(new Date(t)), values);
  const dates = await sourceDates(c.db, c.family, c.attribution);
  return {
    body: {
      schemaVersion: 1,
      ...cols,
      generatedAt: iso(new Date(c.now)),
      seriesHash: seriesHash(stations.stations.flatMap((st) => st.series.map((s) => s.id))),
      dh24: values.map((v) => dh(v, day, DAY_MS)),
      dh1: values.map((v) => dh(v, hour, HOUR_MS)),
      lapsed,
      // ponytail: obs_latest can hold a point after t (t is the floored bucket), then the age is 0, not negative.
      lapsedAge: lapsed.map((id) => {
        const ts = newest.get(id);
        return ts === undefined ? null : Math.max(0, Math.floor((t - ts.getTime()) / 1000));
      }),
      attribution: attributionFor(
        c.attribution,
        new Set([...sourcesOf(cols, facts), ...lapsed.flatMap((id) => facts.get(id)?.source ?? [])]),
        dates,
      ),
    },
    latestFrom: commit === null ? null : iso(commit),
  };
}
