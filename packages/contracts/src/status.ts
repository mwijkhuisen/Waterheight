import { z } from 'zod';
import { HealthSourceId } from './api.ts';
import { ForecastCoverage } from './forecast.ts';
import { ClassCoverage, SourceStatus } from './health.ts';
import { AttributionEntry, DAY_RE } from './static.ts';
import { OwnerAttributionEntry, OwnerSourceId } from './static-owner.ts';

// Server only (P9a): /data/v1/status.json (A§11.3), which absorbs /status/capture.json and /status/ops.json. Coarse:
// states, times and counts, never a URL with parameters, a host, a version, an address or an error text. The public
// file names public sources only; owner sources are the two counts `ownerSources` and capture's `ownerSpecs`
// (invariant 11). The owner file (A§9.3) has the owner family's sources and both families' coverage.

const iso = z.iso.datetime();
const count = z.number().int().nonnegative();
const seconds = z.number().nonnegative();

const sourceRow = (source: z.ZodString) =>
  z.strictObject({
    id: source,
    status: SourceStatus,
    lastFetchOk: iso.nullable(),
    newestTs: iso.nullable(),
    lagP95S: seconds.nullable(),
    /** Q7 since the seed: the share of expected tier-1 buckets that hold a value; null when not computed. */
    coverage: z.number().min(0).max(1).nullable(),
    forecast: z
      .strictObject({ issuedAt: iso, runAgeS: count, series: count, current: count, late: z.iso.date().nullable() })
      .nullable(),
  });

const captureOf = (source: z.ZodString) =>
  z.strictObject({
    generatedAt: iso,
    specs: z
      .array(
        z.strictObject({
          source,
          spec: z
            .string()
            .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
            .max(80),
          cadenceS: count,
          lastSuccess: iso.nullable(),
          bytesToday: count,
        }),
      )
      .max(200),
    /** The owner specs as two counts (public file only). */
    ownerSpecs: z.strictObject({ fresh: count, total: count }).nullable(),
  });

const common = {
  schemaVersion: z.literal(1),
  generatedAt: iso,
  twins: z.strictObject({ ok: count, failing: count }),
  /** /status/ops.json: the last backup, the last restore drill and the disk use; null before the first. */
  ops: z
    .strictObject({ lastBackup: iso.nullable(), drill: iso.nullable(), diskPct: z.number().min(0).max(100).nullable() })
    .nullable(),
  loader: z.strictObject({
    /** The newest loaded_at of the family's batches. */
    lastCommit: iso.nullable(),
    lagP95S: seconds.nullable(),
    backlogAgeS: seconds.nullable(),
  }),
  publisher: z.strictObject({
    cycleAt: iso,
    cycleSeconds: seconds,
    /** The last settled day rendered whole (public), with how long its 144 snapshots and frames took. */
    lastDayRender: z
      .strictObject({ day: z.string().regex(DAY_RE), version: z.number().int().min(1), seconds, at: iso })
      .nullable(),
    /** Settled days whose current version has no complete render yet. */
    pendingDays: count,
    /** The bytes under settled/ and frames/ (plain files; the compressed siblings are extra). */
    settledBytes: count,
  }),
};

/** The public status.json. */
export const StatusFile = z.strictObject({
  ...common,
  sources: z.array(sourceRow(HealthSourceId)).max(200),
  classification: ClassCoverage.nullable(),
  forecastCoverage: ForecastCoverage.nullable(),
  ownerSources: z.strictObject({ healthy: count, total: count }),
  capture: captureOf(HealthSourceId).nullable(),
  attribution: z.array(AttributionEntry).max(500),
});
export type StatusFile = z.infer<typeof StatusFile>;

/** The owner's status.json: the owner family's sources, twins and capture, and the coverage of both families. */
export const OwnerStatusFile = z.strictObject({
  ...common,
  sources: z.array(sourceRow(OwnerSourceId)).max(200),
  classification: z.strictObject({ public: ClassCoverage.nullable(), owner: ClassCoverage.nullable() }),
  forecastCoverage: z.strictObject({ public: ForecastCoverage.nullable(), owner: ForecastCoverage.nullable() }),
  capture: captureOf(OwnerSourceId).nullable(),
  attribution: z.array(OwnerAttributionEntry).max(500),
});
export type OwnerStatusFile = z.infer<typeof OwnerStatusFile>;
