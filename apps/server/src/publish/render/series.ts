import type { ForecastLatest, ForecastRun, StationRecent } from '@rws/contracts';
import { MAX_POINTS, pickRun } from '@rws/contracts';
import { type Kysely, sql } from 'kysely';
import { valueSources } from '../../api/answer.ts';
import { readForecastLatest } from '../../api/forecast-latest.ts';
import { lastCommit } from '../../api/health.ts';
import { iso } from '../../api/util.ts';
import { attributionFor, sourceDates } from '../../attribution.ts';
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

// #218: the reads the renderers of one cycle share are read once a cycle (a 1,000-station sweep and 144 buckets of a
// settled day read the facts once). The memo hangs on the cycle's RenderCtx, which cycle.ts builds once a cycle and
// never changes, so it carries the db, the family and the clock: a public render never sees an owner read, nothing
// outlives the cycle (a test context at a fixed clock is a new cycle too), and a read that fails is not kept.
const memos = new WeakMap<RenderCtx, Map<string, Promise<unknown>>>();
export function once<T>(c: RenderCtx, key: string, read: () => Promise<T>): Promise<T> {
  const m = memos.get(c) ?? new Map<string, Promise<unknown>>();
  memos.set(c, m);
  const hit = m.get(key);
  if (hit !== undefined) return hit as Promise<T>;
  const p = read();
  m.set(key, p);
  p.catch(() => {
    if (m.get(key) === p) m.delete(key);
  });
  return p;
}

/** readFacts, once a cycle. */
export const factsOf = (c: RenderCtx): Promise<Map<number, SeriesFacts>> =>
  once(c, 'facts', () => readFacts(c.db, c.family));

/** The facts of every station's series that a file other than latest.json may carry, in id order, grouped once. */
export const stationFacts = (c: RenderCtx): Promise<Map<string, SeriesFacts[]>> =>
  once(c, 'stationFacts', async () => {
    const out = new Map<string, SeriesFacts[]>();
    for (const f of (await factsOf(c)).values()) {
      if (historyExcluded(f, 'other')) continue;
      const list = out.get(f.station) ?? [];
      list.push(f);
      out.set(f.station, list);
    }
    return out;
  });

/** The family's forecast document at the cycle's clock, once a cycle (forecast/latest.json and the station files). */
export const forecastOnce = (c: RenderCtx): Promise<ForecastLatest> =>
  once(c, 'forecast', () => readForecastLatest(c.db, c.family, c.now));

/** The dated licences' dates (attribution.ts `sourceDates`), once a cycle. */
export const datesOf = (c: RenderCtx) => once(c, 'dates', () => sourceDates(c.db, c.family, c.attribution));

/**
 * The newest loaded_at of the family's batches, once a cycle. latest.json reads it before its states (so
 * meta.latestFrom never claims more than the read saw); status.json shows the same instant.
 */
export const commitOf = (c: RenderCtx) => once(c, 'commit', () => lastCommit(c.db, c.family, new Date(c.now)));

type ObsRow = { ts: Date; value: number; qc: number };
type RefRow = {
  series_id: number;
  source_id: string;
  kind: string;
  value: number;
  unit: string;
  priority: number;
  basis_label: string | null;
  season_from_md: number;
  season_to_md: number;
};

/**
 * series/{id}/recent.json: seven days of raw observations, the run forecast/latest.json shows, the references now.
 * P14f: not our day-of-year rows (730 a series would crowd out the slice of 100); a band on the chart is a follow-up.
 */
export async function renderStation(c: RenderCtx, id: string): Promise<StationRecent> {
  const v = VIEWS[c.family];
  const facts = (await stationFacts(c)).get(id) ?? [];
  const ids = facts.map((f) => f.id);
  const from = c.now - WEEK_MS;
  const forecast = await forecastOnce(c);
  const refs =
    ids.length === 0
      ? []
      : (
          await sql<RefRow>`
            SELECT series_id, source_id, kind, value, unit, priority, basis_label, season_from_md, season_to_md
            FROM ${sql.table(v.reference)}
            WHERE series_id = ANY(${ids}::int[]) AND valid @> ${new Date(c.now)}::timestamptz
              AND kind NOT IN ('P10_DOY', 'P90_DOY')
            ORDER BY series_id, priority, source_id, kind, season_from_md, season_to_md`.execute(c.db)
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
          // Every season valid now (#99): the web picks the one that holds at its t.
          ...(r.season_from_md === 101 && r.season_to_md === 1231
            ? {}
            : { season: { from: r.season_from_md, to: r.season_to_md } }),
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
