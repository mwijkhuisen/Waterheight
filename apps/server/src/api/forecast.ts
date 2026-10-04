import { readFileSync } from 'node:fs';
import { ForecastCoverage, type ForecastReach, ForecastReaches, SourcesFile } from '@rws/contracts';
import { de2Superseded, isCurrent } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { parse } from 'yaml';
import { REGISTRY_DIR } from '../capture/specs.ts';
import { type ChannelAudience, FAMILY_AUDIENCES, FORECAST_AT, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { coded, iso, snapshot, validated } from './util.ts';

// The forecast coverage of ONE audience family at "now" (P8a; catalogue §0.5): the first-release stations, how many
// of them have a current forecast run in the family, per country and per reach row of registry/forecast-reaches.yaml.
// The public family goes into /api/v1/health/sources (`forecast_coverage`); the owner family is computed and tested
// only (P9a serves it). The family is a constant at each call site, never request input; every view and function
// name comes from db/audience.ts, so a public report cannot read an owner run, and it names only the sources whose
// audience the family can see (invariant 11: no DE-2, DE-3 or LU-3 in the public report).

/** DE-1 Duisburg-Ruhrort (`RUHRORT_W` of core is its W series): its stage decides whether DE-2 owes a weekend run. */
export const RUHRORT_STATION = 'de.wsv.2770010';
const DE2 = 'DE-2';

/**
 * Ruhrort's latest stage (cm) in the family's views at `at`, inside the series' staleness window; null when there is
 * none (a weekend or holiday is then not a DE-2 due day). Shared by the coverage and forecast/latest.json.
 */
export async function ruhrortCm(tx: Kysely<DB>, family: ChannelAudience, at: string): Promise<number | null> {
  const V = VIEWS[family];
  const { rows } = await sql<{ value: number }>`
    SELECT l.value FROM ${sql.table(V.series)} s JOIN ${sql.table(V.obsLatest)} l ON l.series_id = s.id
    WHERE s.station_id = ${RUHRORT_STATION} AND s.source_id = 'DE-1' AND s.quantity = 'H' AND s.active
      AND l.ts <= ${at}::timestamptz AND l.ts > ${at}::timestamptz - s.staleness_limit
    LIMIT 1`.execute(tx);
  return rows[0]?.value ?? null;
}

const yaml = (name: string): unknown =>
  // Aliases off: a reviewed table has no use for them, and they are the YAML expansion attack.
  parse(readFileSync(new URL(name, REGISTRY_DIR), 'utf8'), { maxAliasCount: 0 });

/** registry/forecast-reaches.yaml, read once. */
let reachesFile: ForecastReaches | undefined;
export const forecastReaches = (): ForecastReaches =>
  (reachesFile ??= ForecastReaches.parse(yaml('forecast-reaches.yaml')));

/**
 * The sources a family can see: audience within the family's and the display channel on (the forecast views and
 * functions apply the same two tests to a run's own source), from registry/sources.yaml, read once.
 */
let sourcesFile: ReturnType<typeof SourcesFile.parse> | undefined;
export function visibleSources(family: ChannelAudience): ReadonlySet<string> {
  sourcesFile ??= SourcesFile.parse(yaml('sources.yaml'));
  const audiences: readonly string[] = FAMILY_AUDIENCES[family];
  return new Set(sourcesFile.sources.filter((s) => audiences.includes(s.audience) && s.display).map((s) => s.id));
}

/**
 * Fail closed (review SEC-2): every run a family's read returned must be of a source the family can see. The views
 * and the Q2 function already filter by the run's own source, and neither the coverage nor the forecast/latest.json
 * contract can tell an owner source from a public one, so this is the check at the boundary: a run of any other
 * source throws the fixed code `owner_source` (the public coverage is then null, the document is not written).
 */
export function assertVisible(sources: Iterable<string>, visible: ReadonlySet<string>): void {
  for (const s of sources) if (!visible.has(s)) throw coded('owner_source');
}

/** What a reach row asks of a station: its country, its river (river_id) and the operator's km (km_official). */
export type ReachStation = { country: string; river: string | null; km: number | null };

const hits = (m: ForecastReach['match'][number], s: ReachStation): boolean =>
  (m.countries === undefined || (m.countries as readonly string[]).includes(s.country)) &&
  (m.rivers === undefined || (s.river !== null && m.rivers.includes(s.river))) &&
  (m.km_min === undefined || (s.km !== null && s.km >= m.km_min)) &&
  (m.km_max === undefined || (s.km !== null && s.km < m.km_max));

/** The index of the first row of `reaches` that takes the station, or -1 (the station is in `other`). */
export const reachOf = (reaches: readonly ForecastReach[], s: ReachStation): number =>
  reaches.findIndex((r) => r.match.some((m) => hits(m, s)));

type StationRow = { id: string; country: string; river_id: string | null; km_official: number | null };
type SeriesRow = { id: number; station_id: string; audience: string };
type RunRow = { series_id: number; source_id: string; issued: Date; last_valid: Date };

export type CoverageDeps = {
  /** The reach matrix; the registry's by default. */
  reaches?: ForecastReaches;
  /** The sources the family can see; sources.yaml's by default. */
  visible?: ReadonlySet<string>;
  /**
   * P9a: the public share of an owner read (the owner status file, whose role cannot read the public family): only
   * public series and runs of the sources the public family can see count, and each reach lists only those.
   */
  publicSplit?: boolean;
};

/**
 * The coverage report of one family at `now` (UTC ms). The denominator is the first-release stations (tier 1 with a
 * public primary series, the registry's `first_release`), the same in every family. A station
 * is covered when one of its series has a current run in the family: `FORECAST_AT(now, now)` (A§8 Q2: the latest
 * run known now, only if it still reaches now) and, for a DE-2 run, only while its schedule has not superseded it
 * (core `de2Superseded`, Ruhrort's latest stage from the family's observation views; an unknown stage is silence).
 * A reach lists the declared sources the family can see; with none it is `no_official_forecast`.
 */
export async function forecastCoverage(
  db: Kysely<DB>,
  family: ChannelAudience,
  now: number,
  deps: CoverageDeps = {},
): Promise<ForecastCoverage> {
  const V = VIEWS[family];
  const reaches = (deps.reaches ?? forecastReaches()).reaches;
  const visible = deps.visible ?? visibleSources(family);
  const counted = deps.publicSplit === true ? visibleSources('public') : visible;
  const at = new Date(now).toISOString();
  const read = await snapshot(db, async (tx) => {
    const stations = (
      await sql<StationRow>`
        SELECT id, country, river_id, km_official FROM ${sql.table(V.station)} WHERE tier = 1 ORDER BY id`.execute(tx)
    ).rows;
    const series = (
      await sql<SeriesRow>`
        SELECT id, station_id, audience::text AS audience FROM ${sql.table(V.series)} WHERE active ORDER BY id`.execute(
        tx,
      )
    ).rows;
    const runs = (
      await sql<RunRow>`
        SELECT series_id, source_id, COALESCE(issued_at, fetched_at) AS issued, last_valid
        FROM ${sql.id(FORECAST_AT[family])}(${at}::timestamptz, ${at}::timestamptz)`.execute(tx)
    ).rows;
    assertVisible(
      runs.map((r) => r.source_id),
      visible,
    );
    // Only a DE-2 run needs it (the weekend rule): the public family never reads it.
    const ruhrort = runs.some((r) => r.source_id === DE2) ? await ruhrortCm(tx, family, at) : null;
    return { stations, series, runs, ruhrort };
  });

  const current = new Set<number>();
  for (const r of read.runs) {
    if (!counted.has(r.source_id)) continue;
    const run = { source: r.source_id, lastValid: r.last_valid.getTime(), issued: r.issued.getTime() };
    const superseded =
      r.source_id === DE2 ? (x: typeof run, n: number) => de2Superseded(x, n, read.ruhrort) : undefined;
    if (isCurrent(run, now, now, superseded)) current.add(r.series_id);
  }
  const seriesOf = new Map<string, SeriesRow[]>();
  for (const s of read.series)
    if (deps.publicSplit !== true || s.audience === 'public')
      seriesOf.set(s.station_id, [...(seriesOf.get(s.station_id) ?? []), s]);

  const tally = () => ({ stations: 0, covered: 0 });
  const total = tally();
  const other = tally();
  const byReach = reaches.map(tally);
  const byCountry = new Map<string, ReturnType<typeof tally>>();
  for (const st of read.stations) {
    const list = seriesOf.get(st.id) ?? [];
    // First release: a public primary series (the owner family also lists owner-only stations; they are not counted).
    if (!list.some((s) => s.audience === 'public')) continue;
    const covered = list.some((s) => current.has(s.id)) ? 1 : 0;
    const row = reachOf(reaches, { country: st.country, river: st.river_id, km: st.km_official });
    const country = byCountry.get(st.country) ?? tally();
    byCountry.set(st.country, country);
    for (const k of [total, country, row < 0 ? other : (byReach[row] as ReturnType<typeof tally>)]) {
      k.stations += 1;
      k.covered += covered;
    }
  }
  return validated(ForecastCoverage, {
    t: iso(new Date(now)),
    total,
    countries: [...byCountry].sort(([a], [b]) => (a < b ? -1 : 1)).map(([country, c]) => ({ country, ...c })),
    reaches: reaches.map((r, i) => {
      const sources = r.sources.filter((id) => counted.has(id));
      return {
        id: r.id,
        names: r.names,
        ...(byReach[i] as ReturnType<typeof tally>),
        sources,
        no_official_forecast: sources.length === 0,
        after_permission: r.after_permission,
        none_publishes: r.none_publishes,
      };
    }),
    other,
  });
}
