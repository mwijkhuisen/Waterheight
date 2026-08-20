/**
 * The five-minute latest poll.
 *
 * Everything else in this service fetches on demand: a chart asks for a window
 * that is not covered locally and the request path goes and gets it. That is
 * fine for history, which does not change, and wrong for live readings --
 * "what is the water doing now" would mean an upstream call per visitor, at
 * Rijkswaterstaat's rate limit rather than ours. This job inverts that. It
 * pulls the newest reading for every live series on a fixed cadence, so the
 * store is already current when someone asks and the only traffic upstream is
 * the poll's own.
 *
 * Two passes, because two different questions are being asked.
 *
 * The **poll** asks for series we already know, and asks narrowly.
 * OphalenLaatsteWaarnemingen answers a (compartiment, grootheid) pair with
 * every series a location ever ran for that quantity -- readings from 1900
 * included, each carrying a full AquoMetadata block. Adding the parameter,
 * instrument and determination method of the series we are actually after cut
 * one measured request from 4,622 series and 7.6 MB to 83 series and 137 KiB,
 * with all 44 live readings intact (18 locations, `CONCTTE`, 2026-08-20).
 * Locations that share a filter are batched into one call.
 *
 * The **discovery** pass asks about pairs the WFS layer says are publishing but
 * which no live series of ours covers: a store that has never ingested
 * anything, a station back from maintenance, a swapped instrument. Those
 * cannot be narrowed -- the metadata that would narrow them is exactly what is
 * missing -- so they go one at a time through OphalenWaarnemingen over a short
 * window, which returns only series with data in it and so answers in a couple
 * of KiB. A bounded number per cycle, oldest first, so a cold system warms up
 * over a few hours instead of opening with thousands of unfiltered calls.
 *
 * Continuous aggregates are deliberately left alone: the refresh policies
 * cover the last 3 days hourly and 30 days daily, which is exactly where this
 * job writes. Backfilled history needs an explicit refresh; live data does not.
 */

import { config } from '../config.js';
import {
  listPairsToDiscover,
  markPairsPolled,
  touchFreshness,
  type FreshnessTouch,
  type QuantityPair,
} from '../db/locations.js';
import { appendObservations, type PointForSeries } from '../db/observations.js';
import { withTransaction } from '../db/pool.js';
import {
  advanceCoverage,
  listPollTargets,
  upsertSeries,
  type PollTarget,
} from '../db/series.js';
import { RWS_SOURCE_ID } from '../sources/registry.js';
import {
  RwsError,
  fetchLatest,
  fetchObservations,
  type LatestFilter,
} from '../sources/rws/client.js';
import {
  normaliseLatest,
  normaliseObservations,
  type NormalisedPoint,
  type SeriesIdentity,
} from '../sources/rws/normalise.js';
import { recordRefresh } from './locations.js';

/** One upstream call: the filters it carries, and the locations it asks for. */
export interface LatestBatch {
  filters: LatestFilter[];
  locationCodes: string[];
}

export interface PollLatestOptions {
  /**
   * Which source to poll. Rijkswaterstaat is the only one with a latest
   * endpoint today; a second source polls with its own adapter rather than
   * having this one widened, because nothing about the batching survives a
   * change of protocol.
   */
  sourceId?: string;
  /**
   * How far back a reading still counts as live. Doubles as the cut-off for
   * which series are polled and which returned readings are stored, so a
   * long-dead stream is neither asked about nor written.
   */
  maxAgeMs?: number;
  /** Locations one filter may be asked for in a single call. */
  batchSize?: number;
  /** Ceiling on the location x filter cross product one call may ask for. */
  maxCombinations?: number;
  /** Upstream calls in flight; the client's own gate caps this too. */
  concurrency?: number;
  /** Pairs probed for an unknown series per cycle. */
  discoveryLimit?: number;
  /** Window a discovery probe asks for. */
  discoveryWindowMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface PollLatestResult {
  /** Live series the poll asked about. */
  targets: number;
  /** Upstream calls made, across both passes. */
  requests: number;
  /** Series that received a point. */
  seriesWritten: number;
  pointsWritten: number;
  /** Points that were new rather than a rewrite of one already stored. */
  pointsInserted: number;
  /** Readings ignored as older than the freshness window. */
  stale: number;
  /** Readings we already had, so nothing was written. */
  unchanged: number;
  discovery: { probed: number; withData: number; seriesFound: number };
  failures: number;
  durationMs: number;
}

function filterKey(filter: LatestFilter): string {
  return [
    filter.compartiment,
    filter.grootheid,
    filter.procesType ?? 'meting',
    filter.parameter ?? '',
    filter.meetapparaat ?? '',
    filter.waardebepalingMethode ?? '',
  ].join('|');
}

/**
 * Group live series into upstream calls.
 *
 * Series that differ only in something unfilterable (two sampling heights at
 * one station) collapse onto the same filter, a filter wanted at more
 * locations than `batchSize` is split, and what is left is packed several
 * filters to a call.
 *
 * The packing is where the cost of a cycle is decided. The service answers the
 * cross product of the location and filter lists it is given, so a call asking
 * eight filters of 200 locations does the work of eight calls and returns a
 * little more than their sum -- the extra being live series at locations our
 * own metadata had not associated with that filter, which is data we want
 * anyway. Measured over 1,744 live series on 2026-08-20: one filter per call
 * was 140 calls and 4.5 MiB, four per call 35 calls and 5.1 MiB, sixteen per
 * call 9 calls and 6.7 MiB, all three finding the same live series. Fewer
 * calls for slightly more bytes is the right trade against a service that asks
 * clients to identify themselves for future rate limiting, so `maxCombinations`
 * caps the cross product rather than the call count and packing fills up to it.
 */
export function planBatches(
  targets: PollTarget[],
  batchSize: number,
  maxCombinations: number,
): LatestBatch[] {
  const size = Math.max(1, batchSize);
  const cap = Math.max(size, maxCombinations);
  const groups = new Map<string, { filter: LatestFilter; codes: Set<string> }>();

  for (const target of targets) {
    const filter: LatestFilter = {
      compartiment: target.compartiment,
      grootheid: target.grootheid,
      procesType: target.procesType,
      parameter: target.parameter,
      meetapparaat: target.meetapparaat,
      waardebepalingMethode: target.waardebepalingMethode,
    };
    const key = filterKey(filter);
    const group = groups.get(key);
    if (group) group.codes.add(target.locationCode);
    else groups.set(key, { filter, codes: new Set([target.locationCode]) });
  }

  // Insertion order follows the query's ordering, so filters for the same
  // quantity are adjacent and pack into calls with overlapping locations.
  const chunks: { filter: LatestFilter; codes: string[] }[] = [];
  for (const { filter, codes } of groups.values()) {
    const all = [...codes];
    for (let i = 0; i < all.length; i += size) {
      chunks.push({ filter, codes: all.slice(i, i + size) });
    }
  }

  const batches: LatestBatch[] = [];
  let current: { filters: LatestFilter[]; codes: Set<string> } | null = null;

  for (const chunk of chunks) {
    if (current) {
      const union = new Set([...current.codes, ...chunk.codes]);
      if ((current.filters.length + 1) * union.size <= cap) {
        current.filters.push(chunk.filter);
        current.codes = union;
        continue;
      }
      batches.push({ filters: current.filters, locationCodes: [...current.codes] });
    }
    current = { filters: [chunk.filter], codes: new Set(chunk.codes) };
  }
  if (current) batches.push({ filters: current.filters, locationCodes: [...current.codes] });

  return batches;
}

/** A series and the points to write to it, before either has an id. */
interface Writable {
  identity: SeriesIdentity;
  points: NormalisedPoint[];
}

interface WriteSummary {
  seriesWritten: number;
  pointsWritten: number;
  pointsInserted: number;
}

/**
 * Store what a pass fetched.
 *
 * Series known to be live are resolved from the map the plan was built from,
 * which saves an upsert round trip each; anything else -- a stream we have
 * never seen, or one that has been quiet longer than the freshness window --
 * is created on the spot.
 */
async function store(
  entries: Writable[],
  known: Map<string, PollTarget>,
): Promise<WriteSummary> {
  if (entries.length === 0) return { seriesWritten: 0, pointsWritten: 0, pointsInserted: 0 };

  return withTransaction(async (client) => {
    const rows: PointForSeries[] = [];
    const touched = new Set<number>();

    for (const entry of entries) {
      const seriesId = known.get(entry.identity.naturalKey)?.id
        ?? await upsertSeries(client, entry.identity);
      touched.add(seriesId);
      for (const point of entry.points) rows.push({ seriesId, point });
    }

    const result = await appendObservations(client, rows);
    await advanceCoverage(client, result.spans);

    return {
      seriesWritten: touched.size,
      pointsWritten: result.written,
      pointsInserted: result.inserted,
    };
  });
}

function toTouch(identity: SeriesIdentity, point: NormalisedPoint): FreshnessTouch {
  return {
    locationCode: identity.locationCode,
    compartiment: identity.compartiment,
    grootheid: identity.grootheid,
    observedAt: point.t,
    value: point.value,
  };
}

/** Run `work` over `items`, `concurrency` at a time, in the queue's own idiom. */
async function lanes<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => lane()),
  );
}

export async function pollLatest(options: PollLatestOptions = {}): Promise<PollLatestResult> {
  const log = options.log ?? console.log;
  const started = Date.now();
  const sourceId = options.sourceId ?? RWS_SOURCE_ID;
  const maxAgeMs = options.maxAgeMs ?? config.latestPoll.maxAgeMs;
  const batchSize = options.batchSize ?? config.latestPoll.batchSize;
  const maxCombinations = options.maxCombinations ?? config.latestPoll.maxCombinations;
  const concurrency = options.concurrency ?? config.sources.rws.http.maxConcurrency;
  const discoveryLimit = options.discoveryLimit ?? config.latestPoll.discoveryLimit;
  const discoveryWindowMs = options.discoveryWindowMs ?? config.latestPoll.discoveryWindowMs;

  const cutoff = new Date(started - maxAgeMs);
  const cutoffIso = cutoff.toISOString();

  const targets = await listPollTargets(sourceId, cutoff);
  const known = new Map(targets.map((t) => [t.naturalKey, t]));
  const batches = planBatches(targets, batchSize, maxCombinations);

  const result: PollLatestResult = {
    targets: targets.length,
    requests: 0,
    seriesWritten: 0,
    pointsWritten: 0,
    pointsInserted: 0,
    stale: 0,
    unchanged: 0,
    discovery: { probed: 0, withData: 0, seriesFound: 0 },
    failures: 0,
    durationMs: 0,
  };

  const touches: FreshnessTouch[] = [];
  // A series can answer two calls at once: a filter that names a parameter and
  // one that leaves it open both match it, and packing can put them in
  // different calls. The write would be an idempotent overwrite either way,
  // but counting it twice would overstate what the cycle did.
  const written = new Set<string>();

  const record = (summary: WriteSummary): void => {
    result.seriesWritten += summary.seriesWritten;
    result.pointsWritten += summary.pointsWritten;
    result.pointsInserted += summary.pointsInserted;
  };

  const fail = (what: string, err: unknown): void => {
    result.failures += 1;
    const message = err instanceof RwsError
      ? `${err.message}${err.status ? ` (status ${err.status})` : ''}`
      : (err as Error).message;
    // One bad batch must not lose the rest of the cycle: the next one is five
    // minutes away and will ask again.
    log(`[latest] ${what} failed: ${message}`);
  };

  log(
    `[latest] ${targets.length} live series in ${batches.length} request(s), ` +
    `readings older than ${cutoffIso} ignored`,
  );

  await lanes(batches, concurrency, async (batch) => {
    if (options.signal?.aborted) return;
    result.requests += 1;
    try {
      const response = await fetchLatest(batch.locationCodes, batch.filters, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.data) return;

      const entries: Writable[] = [];
      for (const { identity, point } of normaliseLatest(response.data)) {
        // Dead streams come back alongside live ones and must not be stored:
        // a reading from 1953 would otherwise create a series whose history
        // starts there and whose charts are empty everywhere in between.
        if (point.t < cutoffIso) { result.stale += 1; continue; }

        const lastObserved = known.get(identity.naturalKey)?.lastObservedAt;
        if (lastObserved && point.t <= lastObserved) { result.unchanged += 1; continue; }
        if (written.has(identity.naturalKey)) continue;

        written.add(identity.naturalKey);
        entries.push({ identity, points: [point] });
        touches.push(toTouch(identity, point));
      }

      record(await store(entries, known));
    } catch (err) {
      const first = batch.filters[0]!;
      fail(
        `${first.compartiment}/${first.grootheid} batch` +
        (batch.filters.length > 1 ? ` (+${batch.filters.length - 1} more)` : ''),
        err,
      );
    }
  });

  // Discovery runs after the poll proper, so a slow or failing probe can never
  // delay the readings the map is waiting on.
  const pairs = options.signal?.aborted
    ? []
    : await listPairsToDiscover(
      sourceId,
      new Date(started - config.activeWindowDays * 86_400_000),
      cutoff,
      discoveryLimit,
    );

  if (pairs.length > 0) {
    const to = new Date();
    const from = new Date(to.getTime() - discoveryWindowMs);
    log(`[latest] probing ${pairs.length} pair(s) with no live series`);

    await lanes(pairs, concurrency, async (pair: QuantityPair) => {
      if (options.signal?.aborted) return;
      result.requests += 1;
      result.discovery.probed += 1;
      try {
        const response = await fetchObservations({
          locationCode: pair.locationCode,
          compartiment: pair.compartiment,
          grootheid: pair.grootheid,
          from,
          to,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.data) return;

        const series = normaliseObservations(response.data)
          .filter((s) => s.points.length > 0);
        if (series.length === 0) return;

        result.discovery.withData += 1;
        result.discovery.seriesFound += series.length;

        for (const s of series) {
          const newest = s.points[s.points.length - 1]!;
          touches.push(toTouch(s.identity, newest));
        }

        record(await store(series.map((s) => ({ identity: s.identity, points: s.points })), known));
      } catch (err) {
        fail(`discovery ${pair.locationCode}/${pair.grootheid}`, err);
      }
    });

    // Marked whether or not they answered: a pair that never has anything to
    // say would otherwise sit at the head of the rotation for ever.
    await markPairsPolled(pairs);
  }

  // Last, and once: the map reads freshness from these columns, so a poll that
  // wrote observations but left them alone would be invisible outside charts.
  await touchFreshness(touches);

  result.durationMs = Date.now() - started;

  log(
    `[latest] ${result.pointsInserted} new reading(s) across ${result.seriesWritten} series ` +
    `in ${result.requests} request(s), ${result.unchanged} unchanged, ` +
    `${result.discovery.seriesFound} discovered, ${result.failures} failure(s) ` +
    `(${(result.durationMs / 1000).toFixed(1)} s)`,
  );

  await recordRefresh(sourceId, 'latest', {
    targets: result.targets,
    requests: result.requests,
    seriesWritten: result.seriesWritten,
    pointsInserted: result.pointsInserted,
    unchanged: result.unchanged,
    stale: result.stale,
    discovery: result.discovery,
    failures: result.failures,
    durationMs: result.durationMs,
  // A cycle that failed every request is not a successful refresh, and
  // /api/health should say so rather than reporting a fresh cache.
  }, result.failures === 0 || result.requests > result.failures);

  return result;
}
