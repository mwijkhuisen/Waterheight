import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClassCoverage, ForecastCoverage } from '@rws/contracts';
import { z } from 'zod';
import { forecastCoverage } from '../../api/forecast.ts';
import { Detail, latestTwinChecks, loaderRow, ownerCounts, sourceRows } from '../../api/health.ts';
import { classCoverage } from '../../api/states.ts';
import { iso, snapshot } from '../../api/util.ts';
import { attributionFor } from '../../attribution.ts';
import { CaptureStatus } from '../../capture/status.ts';
import { errorCode } from '../../db/pool.ts';
import type { PublisherStatus, RenderCtx } from '../cycle.ts';
import { commitOf, datesOf } from './series.ts';
import { statesNow } from './snapshot.ts';
import { familySourcesOf } from './sources.ts';

// P9a (A§11.3): status.json, which absorbs /status/capture.json and /status/ops.json. Coarse on purpose: states, times
// and counts; no URL, host, version, address or error text ever leaves (the capture and ops files are mapped field by
// field, never copied). A part that fails to read is null and does not fail the file; the logs of the publisher carry
// the fixed codes, this module (which has no logger) only degrades.

const INPUT_MAX_BYTES = 1024 * 1024;

/**
 * A status input file, read defensively: opened with O_NOFOLLOW (a symlink is refused), a regular file, at most
 * 1 MiB, JSON. Anything else (missing, unreadable, too large, not JSON) is null.
 */
export async function readInput(dir: string | undefined, name: string): Promise<unknown> {
  if (dir === undefined) return null;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile() || st.size > INPUT_MAX_BYTES) return null;
    return JSON.parse(await fh.readFile('utf8'));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

const Ops = z.object({
  last_backup: z.iso.datetime().nullable(),
  drill: z.object({ at: z.iso.datetime() }).nullable(),
  disk_pct: z.number().min(0).max(100).nullable(),
});

const opsOf = (raw: unknown) => {
  const p = Ops.safeParse(raw);
  return p.success
    ? { lastBackup: p.data.last_backup, drill: p.data.drill?.at ?? null, diskPct: p.data.disk_pct }
    : null;
};

/** capture.json mapped to the coarse shape; only specs of the family's own sources (a stray id is dropped). */
function captureOf(raw: unknown, allowed: ReadonlySet<string>, ownerSpecs: boolean) {
  const p = CaptureStatus.safeParse(raw);
  if (!p.success) return null;
  return {
    generatedAt: p.data.generated_at,
    specs: p.data.specs
      .filter((s) => allowed.has(s.source))
      .map((s) => ({
        source: s.source,
        spec: s.spec,
        cadenceS: s.cadence_s,
        lastSuccess: s.last_success,
        bytesToday: s.bytes_today,
      })),
    ownerSpecs: ownerSpecs ? (p.data.owner_specs ?? null) : null,
  };
}

/** A coverage read that fails gives null and a logged fixed code, never a failed status file. */
const orNull = async <T>(read: () => Promise<T>, log?: RenderCtx['log']): Promise<T | null> => {
  try {
    return await read();
  } catch (err) {
    log?.error({ code: errorCode(err), step: 'status' }, 'status part unavailable');
    return null;
  }
};

/**
 * #218: the loader's last commit, the source dates and the classification are the cycle's own reads, made when
 * latest.json was rendered (the same instant latest.json and meta.latestFrom describe); the source, twin and loader
 * rows are read here, at the end of the cycle.
 */
export async function status(c: RenderCtx, p: PublisherStatus): Promise<unknown> {
  const now = new Date(c.now);
  const isPublic = c.family === 'public';

  const read = await snapshot(c.db, async (tx) => ({
    rows: await sourceRows(tx, c.family),
    twins: await latestTwinChecks(tx, c.family, now),
    // The public family only (the owner role cannot read these views).
    owner: isPublic ? await ownerCounts(tx) : null,
    loader: isPublic ? await loaderRow(tx) : undefined,
  }));
  const commit = await commitOf(c);
  const known = new Set((await familySourcesOf(c)).map((s) => s.id));
  const dates = await datesOf(c);

  const sources = read.rows.map((r) => {
    const d = Detail.safeParse(r.detail);
    const detail = d.success ? d.data : {};
    return {
      id: r.source_id,
      status: r.status,
      lastFetchOk: iso(r.last_fetch_ok),
      newestTs: iso(r.newest_ts),
      lagP95S: r.lag_p95_s,
      coverage: detail.coverage?.ratio ?? null,
      forecast:
        detail.forecast === undefined
          ? null
          : {
              issuedAt: detail.forecast.issued_at,
              runAgeS: detail.forecast.run_age_s,
              series: detail.forecast.series,
              current: detail.forecast.current,
              late: detail.forecast.late,
            },
    };
  });
  const lags = sources.flatMap((s) => (s.lagP95S === null ? [] : [s.lagP95S]));
  const capture = captureOf(await readInput(c.inputs, 'capture.json'), known, isPublic);
  const body = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sources,
    twins: { ok: read.twins.filter((x) => x.ok).length, failing: read.twins.filter((x) => !x.ok).length },
    ops: opsOf(await readInput(c.inputs, 'ops.json')),
    loader: {
      lastCommit: iso(commit),
      lagP95S: lags.length === 0 ? null : Math.max(...lags),
      backlogAgeS: read.loader?.backlog_age_s ?? null,
    },
    publisher: p,
    capture,
    attribution: attributionFor(
      c.attribution,
      [...sources.map((s) => s.id), ...(capture?.specs.map((s) => s.source) ?? [])],
      dates,
    ),
  };
  if (isPublic) {
    return {
      ...body,
      classification: await orNull(async () => classCoverage(await statesNow(c)), c.log),
      forecastCoverage: await orNull(() => forecastCoverage(c.db, 'public', c.now), c.log),
      ownerSources: read.owner ?? { healthy: 0, total: 0 },
    };
  }
  // The owner role cannot read the public-only views, so the "public" half of the owner file is the owner read
  // restricted to the public series (and the stations that have one), and forecastCoverage's public split.
  const states = await orNull(() => statesNow(c), c.log);
  const pub = (s: NonNullable<typeof states>): ClassCoverage => {
    const series = s.series.filter((x) => s.publicSeries.has(x.series));
    const stations = new Set(series.map((x) => x.station));
    return classCoverage({ ...s, series, stations: s.stations.filter((x) => stations.has(x.id)) });
  };
  const ownerForecast: ForecastCoverage | null = await orNull(() => forecastCoverage(c.db, 'owner', c.now), c.log);
  const publicForecast = await orNull(() => forecastCoverage(c.db, 'owner', c.now, { publicSplit: true }), c.log);
  return {
    ...body,
    classification: { public: states && pub(states), owner: states && classCoverage(states) },
    forecastCoverage: { public: publicForecast, owner: ownerForecast },
  };
}
