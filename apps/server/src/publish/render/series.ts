import type { ForecastLatest, ForecastRun, StationRecent } from '@rws/contracts';
import { MAX_POINTS, pickRun } from '@rws/contracts';
import { type Kysely, sql } from 'kysely';
import { valueSources } from '../../api/answer.ts';
import { readForecastLatest } from '../../api/forecast-latest.ts';
import { iso } from '../../api/util.ts';
import { attributionFor } from '../../attribution.ts';
import { type ChannelAudience, VIEWS } from '../../db/audience.ts';
import type { DB } from '../../db/generated.ts';
import type { RenderCtx } from '../cycle.ts';
import { type HistoryFacts, historyExcluded } from '../plan.ts';

// P9a (§4.4): the series facts every renderer shares (the family's active display series with the channel facts that
// decide which file may carry one, §9 C5) and series/{station}/recent.json.

export type SeriesFacts = HistoryFacts & { id: number; station: string; source: string; lic_api: boolean };

/** The family's active series by id, with the history facts of the series view (effective, appended by M2). */
export async function readFacts(db: Kysely<DB>, family: ChannelAudience): Promise<Map<number, SeriesFacts>> {
  const { rows } = await sql<SeriesFacts>`
    SELECT id, station_id AS station, source_id AS source, lic_api, lic_history_export,
           EXTRACT(EPOCH FROM history_window)::float8 AS history_window_s,
           EXTRACT(EPOCH FROM staleness_limit)::float8 AS staleness_s
    FROM ${sql.table(VIEWS[family].series)} WHERE active ORDER BY id`.execute(db);
  return new Map(rows.map((r) => [r.id, r]));
}

export { historyExcluded };

const WEEK_MS = 7 * 86_400_000;

// One forecast read per (database, family, cycle clock): a 1,000-station sweep reads it once.
let memo: { db: Kysely<DB>; family: ChannelAudience; now: number; read: Promise<ForecastLatest> } | undefined;
export function forecastOnce(c: RenderCtx): Promise<ForecastLatest> {
  if (memo?.db === c.db && memo.family === c.family && memo.now === c.now) return memo.read;
  const read = readForecastLatest(c.db, c.family, c.now);
  memo = { db: c.db, family: c.family, now: c.now, read };
  read.catch(() => {
    if (memo?.read === read) memo = undefined;
  });
  return read;
}

type ObsRow = { ts: Date; value: number; qc: number };
type RefRow = {
  series_id: number;
  source_id: string;
  kind: string;
  value: number;
  unit: string;
  priority: number;
  basis_label: string | null;
};

/** series/{id}/recent.json: seven days of raw observations, the run forecast/latest.json shows, the references now. */
export async function renderStation(c: RenderCtx, id: string): Promise<StationRecent> {
  const v = VIEWS[c.family];
  const facts = [...(await readFacts(c.db, c.family)).values()].filter(
    (f) => f.station === id && !historyExcluded(f, 'other'),
  );
  const ids = facts.map((f) => f.id);
  const from = c.now - WEEK_MS;
  const forecast = await forecastOnce(c);
  const refs =
    ids.length === 0
      ? []
      : (
          await sql<RefRow>`
            SELECT series_id, source_id, kind, value, unit, priority, basis_label
            FROM ${sql.table(v.reference)}
            WHERE series_id = ANY(${ids}::int[]) AND valid @> ${new Date(c.now)}::timestamptz
            ORDER BY series_id, priority, source_id, kind`.execute(c.db)
        ).rows;
  const series: StationRecent['series'] = [];
  for (const f of facts) {
    // The newest points when the cap bites, in time order.
    const { rows } = await sql<ObsRow>`
      SELECT ts, value, qc FROM ${sql.table(v.obs)}
      WHERE series_id = ${f.id} AND ts >= ${new Date(from)}::timestamptz AND ts <= ${new Date(c.now)}::timestamptz
      ORDER BY ts DESC LIMIT ${MAX_POINTS}`.execute(c.db);
    rows.reverse();
    const run: ForecastRun | undefined = pickRun(
      forecast.runs.filter((r) => r.series === f.id),
      () => true,
    );
    series.push({
      id: f.id,
      source: f.source,
      ts: rows.map((r) => iso(r.ts)),
      value: rows.map((r) => r.value),
      qc: rows.map((r) => r.qc),
      run: run ?? null,
      references: refs
        .filter((r) => r.series_id === f.id)
        .slice(0, 100)
        .map((r) => ({
          source: r.source_id,
          kind: r.kind,
          value: r.value,
          unit: r.unit,
          priority: r.priority,
          label: r.basis_label === null || r.basis_label === '' ? null : r.basis_label,
        })),
    });
  }
  const sources = new Set(
    series.flatMap((s) => [
      ...valueSources(
        s.source,
        s.qc.reduce((or, q) => or | q, 0),
      ),
      ...(s.run ? [s.run.source] : []),
      ...s.references.map((r) => r.source),
    ]),
  );
  return {
    schemaVersion: 1,
    station: id,
    from: iso(new Date(from)),
    to: iso(new Date(c.now)),
    series,
    attribution: attributionFor(c.attribution, sources),
  };
}
