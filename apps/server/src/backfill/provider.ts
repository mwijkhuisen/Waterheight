import type { ValiditySpec } from '../archive/validity.ts';
import type { Req } from '../http/types.ts';
import type { Chunk } from './plan.ts';
import { provider as ch9Provider } from './providers/ch-9.ts';
import { provider as de8Provider } from './providers/de-8.ts';
import { provider as fr2Provider } from './providers/fr-2.ts';
import { provider as nl1Provider } from './providers/nl-1.ts';
import type { BackfillSpecAny, LoadedBackfillSpec, Unit } from './spec.ts';

export { PROVIDER_VALUE_CAP } from './providers/nl-1.ts';
/** P14b: any spec of registry/backfill.yaml (the union of the four members). */
export type { BackfillSpecAny } from './spec.ts';

// What the runner needs of a source (P14a): the units of a spec, the chunk request, the probe request and the probe
// answer, and the truncation check of a response. One file per source in providers/; a source adds a row to
// PROVIDERS. Requests are built only from the registry row and the spec (invariant 1). A provider file imports only
// types from spec.ts (spec.ts imports PROVIDERS), and values of this file only inside its functions.

/** `drift`: the parser's own fixed code (never provider text), for the run's job line. */
export type Inspect =
  | { ok: true; values: number }
  | { ok: false; code: 'truncated' }
  | { ok: false; code: 'schema_drift'; drift: string };

export { driftCode } from './drift.ts';

/**
 * P14b: the dry-run constants of a provider (project.ts), measured on its real fixtures (a test pins them ±25 %).
 * `zstd_ratio` 1 for a body that does not compress (a ZIP).
 */
export type DryRun = { bytes_per_value: number; zstd_ratio: number; db_bytes_per_row: number };

// The unit methods take the provider's own unit type (Series, De8Unit, …): method parameters are bivariant, and the
// runner pairs a unit only with the provider of its own spec's source.
export type Provider = {
  /** P14b: the jobs' units of a spec, from the registry only (NL-1: resolveSeries). Throws on a registry fault. */
  units(spec: BackfillSpecAny, dir: URL): Unit[];
  chunkRequest(spec: LoadedBackfillSpec, unit: Unit, chunk: Chunk, now: Date): Req;
  /** The yearly probe (NL-1). P14b: without one, a job starts at its range's start with data_from NULL. */
  checkRequest?(spec: LoadedBackfillSpec, unit: Unit, from: Date, to: Date): Req;
  parseCheck?(body: Uint8Array): boolean;
  /** Parses a response and refuses one that may be cut short by the provider's cap. */
  inspect(body: Uint8Array): Inspect | Promise<Inspect>;
  validity: ValiditySpec;
  /** P14b: the statuses that carry data (default [200, 204]; FR-2 adds 206, a page with a `next`). 204 is no data. */
  okStatus?: readonly number[];
  /** P14b: a truncated answer halves the chunk (default true); DE-8 false: a file is a file, `too_large` fails. */
  halvable?: boolean;
  /** P14b: one response serves every chunk that asks the same request (DE-8: the slices of a decade file). */
  reuse?: boolean;
  dryRun?: DryRun;
  /** P14b: the manifest line carries the request's variant, because the payload does not name its series (CH-9). */
  lineVariant?: boolean;
};

/**
 * A provider file exports null until it is built: its source is then not in this map, and loadBackfill leaves its
 * specs out (`LoadedBackfill.skipped`: `no provider for <source>`) instead of failing the whole file.
 */
export const PROVIDERS: Readonly<Record<string, Provider>> = {
  'NL-1': nl1Provider,
  ...(de8Provider === null ? {} : { 'DE-8': de8Provider }),
  ...(fr2Provider === null ? {} : { 'FR-2': fr2Provider }),
  ...(ch9Provider === null ? {} : { 'CH-9': ch9Provider }),
};
