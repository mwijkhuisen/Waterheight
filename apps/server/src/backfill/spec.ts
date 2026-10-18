import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SPEC_RE } from '../archive/manifest.ts';
import { durationMs, REGISTRY_DIR } from '../capture/specs.ts';
import { DATA_EPOCH, DATA_FLOOR } from '../load/dirty.ts';
import { PROVIDERS, type Provider } from './provider.ts';

// registry/backfill.yaml (P14a, plan §3.2): the history jobs of the backfill runner. Like capture.yaml it is the
// only place a fetch target comes from (invariant 1): every host of a spec must be in that source's capture.yaml
// `hosts`, so the runner's Client gets the same allowlist as live capture. Series are never listed here: a spec's
// units (the jobs) are resolved by its source's provider against registry/stations/ (P14b: providers/<id>.ts).

const HHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HOST = z.string().regex(/^[a-z0-9.-]+$/);
const https = z.string().startsWith('https://');

export const HostLimits = z.strictObject({
  /** At least this long between the starts of ANY two requests to the host (probes included). */
  min_interval_ms: z.number().int().min(1000),
  /** Over any sliding hour. */
  max_per_hour: z.number().int().positive().max(3600),
  /** Off-peak UTC window [from, to); `from > to` wraps midnight. */
  window_utc: z.strictObject({ from: HHMM, to: HHMM }).refine((w) => w.from !== w.to, 'window_utc: from is not to'),
});
export type HostLimits = z.infer<typeof HostLimits>;

/** The NL-1 spec (P14a), unchanged but for the literal source that the union discriminates by. */
export const Nl1BackfillSpec = z.strictObject({
  id: z.string().regex(SPEC_RE).max(40),
  source: z.literal('NL-1'),
  version: z.number().int().positive(),
  url: https,
  check_url: https,
  select: z.strictObject({
    first_release: z.literal(true),
    quantities: z.array(z.enum(['WATHTE', 'Q'])).min(1),
    role: z.literal('primary'),
  }),
  /** ISO duration in days (the cap arithmetic is a test: P40D of 10-minute values is 57 % of the list cap). */
  chunk: z.string().regex(/^P[1-9]\d{0,2}D$/),
  floor: DAY,
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  retention: z.literal('backfill'),
});
export type Nl1BackfillSpec = z.infer<typeof Nl1BackfillSpec>;

/** P14b: the §6.7 defaults a spec may exceed only with `caps.justification` (a spec test holds it). */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Above this, no spec: a body is held in memory whole. */
export const MAX_BYTES_CEILING = 128 * 1024 * 1024;

/** P14b: a spec's own caps above the §6.7 defaults (ZIP total 200 MiB, ratio 50:1, CSV 100,000 rows). */
export const Caps = z.strictObject({
  zip_members: z.number().int().positive().optional(),
  zip_total: z.number().int().positive().optional(),
  zip_ratio: z.number().int().positive().optional(),
  csv_rows: z.number().int().positive().optional(),
  /** Why the defaults do not hold: what was measured on which recording. */
  justification: z.string().min(20).max(500),
});
export type Caps = z.infer<typeof Caps>;

/** P14b: the fields of every non-NL-1 spec (`target`: the source whose series the rows go to). */
const archive = {
  id: z.string().regex(SPEC_RE).max(40),
  version: z.number().int().positive(),
  url: https,
  chunk: z.string().regex(/^P[1-9]\d{0,3}D$/),
  floor: DAY,
  max_bytes: z.number().int().positive().max(MAX_BYTES_CEILING),
  caps: Caps.optional(),
  retention: z.literal('backfill'),
};
const capsNeeded = (s: { max_bytes: number; caps?: Caps | undefined }) =>
  s.max_bytes <= DEFAULT_MAX_BYTES || s.caps !== undefined;
const CAPS_MSG = 'max_bytes above 25 MiB needs caps with a justification';

/** P14b: the NRW decade ZIPs of hydro/w, step-held onto the DE-7 W series of the tier-1 gauges. */
export const De8BackfillSpec = z
  .strictObject({
    ...archive,
    source: z.literal('DE-8'),
    target: z.literal('DE-7'),
    select: z.strictObject({ first_release: z.literal(true) }),
    /**
     * The catchments that hold a selected gauge, each with the decades the recorded index lists (a missing or empty
     * decade is not fetched) and those gauges (DE-7 station_no).
     */
    datasets: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,80}$/),
          decades: z.array(z.number().int().min(1900).max(2020).multipleOf(10)).min(1),
          stations: z.array(z.string().regex(/^\d{1,15}$/)).min(1),
        }),
      )
      .min(1),
  })
  .refine(capsNeeded, CAPS_MSG);
export type De8BackfillSpec = z.infer<typeof De8BackfillSpec>;

/** P14b: Hub'Eau obs_elab daily aggregates into the FR-1 aggregate twin series. */
export const Fr2BackfillSpec = z
  .strictObject({
    ...archive,
    source: z.literal('FR-2'),
    target: z.literal('FR-1'),
    select: z.strictObject({ aggregates: z.array(z.enum(['QmnJ', 'HIXnJ'])).min(1) }),
  })
  .refine(capsNeeded, CAPS_MSG);
export type Fr2BackfillSpec = z.infer<typeof Fr2BackfillSpec>;

/** P14b: data.bs.ch, grid-aligned points into the CH-1 series of the same gauge. */
export const Ch9BackfillSpec = z
  .strictObject({
    ...archive,
    source: z.literal('CH-9'),
    target: z.literal('CH-1'),
    datasets: z.array(z.strictObject({ id: z.string().regex(/^\d{6}$/), station: z.string().regex(/^\d{4}$/) })).min(1),
  })
  .refine(capsNeeded, CAPS_MSG);
export type Ch9BackfillSpec = z.infer<typeof Ch9BackfillSpec>;

/** P14b: one spec of registry/backfill.yaml, by source. */
export const BackfillSpec = z.discriminatedUnion('source', [
  Nl1BackfillSpec,
  De8BackfillSpec,
  Fr2BackfillSpec,
  Ch9BackfillSpec,
]);
export type BackfillSpec = z.infer<typeof BackfillSpec>;
/** The same union, under the name the providers take it by. */
export type BackfillSpecAny = BackfillSpec;

const BackfillFile = z.strictObject({
  version: z.literal(1),
  hosts: z.record(HOST, HostLimits),
  specs: z.array(BackfillSpec).min(1),
});

/**
 * P14b: one job's unit, what a provider plans and asks by. The runner reads only `series_key` (the job's key: a series
 * key for NL-1 and FR-2, a dataset and decade for DE-8, a dataset for CH-9), `step_ms` and `range`; `range` (DE-8:
 * the decade) narrows the job's range, and `values` is the dry-run's value count over `range` (else over the job)
 * where duration / step is not it.
 */
export type Unit = {
  series_key: string;
  /** Native step in ms (the registry's `native_step`, else 10 minutes): the dry-run's value count. */
  step_ms: number;
  range?: { from: Date; to: Date };
  values?: number;
  /**
   * P14b: the dry-run's values the provider states and rows we store per `step_ms` where they are not one each (CH-9:
   * two values a 5-minute record, of which only the 10-minute grid is stored).
   */
  per_step?: { values: number; rows: number };
};

/** One resolved NL-1 series of a spec: what the request body and the probe are built from. */
export type Series = Unit & {
  /** The registry `provider_key`: `<code>/<Grootheid>/<Hoedanigheid>/<method>`. */
  series_key: string;
  code: string;
  quantity: 'H' | 'Q';
  hoedanigheid: string;
  /** The series' live method (`other:F007`): the probe asks for it. */
  method: string;
};

/** P14b: a DE-8 decade file of one dataset (catchment); `series_key` is `<dataset>/<decade>`. */
export type De8Unit = Unit & { dataset: string; decade: number; file: string };
/** P14b: one FR-1 aggregate twin series (`<code>/QmnJ` or `<code>/HIXnJ`). */
export type Fr2Unit = Unit & { code: string; grandeur: 'QmnJ' | 'HIXnJ' };
/** P14b: one data.bs.ch dataset and the CH-1 gauge it feeds; `series_key` is the dataset id. */
export type Ch9Unit = Unit & { dataset: string; station: string };

type Loaded<S, U extends Unit> = S & {
  /** Host of `url`, and the limits that apply. */
  host: string;
  limits: HostLimits;
  chunk_ms: number;
  /** The jobs' units (the name is P14a's: for NL-1 they are series). */
  series: U[];
  /** P14b: the source whose series the rows go to (none for NL-1: its own). */
  target?: string;
};
export type LoadedBackfillSpec =
  | Loaded<Nl1BackfillSpec, Series>
  | Loaded<De8BackfillSpec, De8Unit>
  | Loaded<Fr2BackfillSpec, Fr2Unit>
  | Loaded<Ch9BackfillSpec, Ch9Unit>;
/** `skipped`: specs left out because their source's provider is not built yet (`no provider for <source>`). */
export type LoadedBackfill = { specs: LoadedBackfillSpec[]; hosts: Record<string, HostLimits>; skipped?: string[] };

/**
 * P14b: the end a spec's history may reach (ms). NL-1's own series meet their live rows at DATA_EPOCH; a spec with a
 * `target` stops at DATA_FLOOR, the start of the target's display window, so no backfilled row lands inside it.
 */
export const ceilingMs = (spec: { target?: string | undefined }): number =>
  Date.parse(spec.target === undefined ? DATA_EPOCH : DATA_FLOOR);

/** sources.yaml, read for the audience gate only (the registry test validates it fully). */
const SourcesFile = z.looseObject({
  sources: z.array(
    z.looseObject({ id: z.string(), audience: z.enum(['public', 'owner', 'off']), history_export: z.boolean() }),
  ),
});

/**
 * Reads and cross-checks registry/backfill.yaml. `captureHosts` is capture.yaml's `hosts` (Registry.hosts). Throws
 * on any problem: a host or URL outside its source's allowlist, a spec host without limits, an unknown source, a
 * source or target that is not `public` or whose `history_export` channel is off (review S8; the owner channel has
 * no backfill), a floor not before the ceiling, max_bytes above the default without caps, or a registry fault its
 * provider's `units` finds. A spec whose provider is not built (PROVIDERS has no entry) is left out and named in
 * `skipped`, so that the other specs, the CLI and the tests keep working while a provider is being written.
 */
export function loadBackfill(
  captureHosts: ReadonlyMap<string, readonly string[]>,
  dir: URL = REGISTRY_DIR,
  providers: Readonly<Record<string, Provider>> = PROVIDERS,
): LoadedBackfill {
  const file = BackfillFile.parse(parseYaml(readFileSync(new URL('backfill.yaml', dir), 'utf8')));
  const sources = new Map(
    SourcesFile.parse(parseYaml(readFileSync(new URL('sources.yaml', dir), 'utf8'))).sources.map((s) => [s.id, s]),
  );
  const problems: string[] = [];
  const skipped: string[] = [];
  const ids = new Set<string>();
  const specs: LoadedBackfillSpec[] = [];
  for (const spec of file.specs) {
    const at = `backfill spec ${spec.id}`;
    if (ids.has(spec.id)) problems.push(`${at}: duplicate id`);
    ids.add(spec.id);
    const allowed = captureHosts.get(spec.source);
    if (allowed === undefined) problems.push(`${at}: ${spec.source} has no hosts in capture.yaml`);
    const host = new URL(spec.url).hostname;
    for (const u of spec.source === 'NL-1' ? [spec.url, spec.check_url] : [spec.url]) {
      const h = new URL(u).hostname;
      if (h !== host) problems.push(`${at}: url and check_url are on different hosts`);
      if (!allowed?.includes(h)) problems.push(`${at}: host ${h} is not allowlisted for ${spec.source}`);
    }
    const limits = file.hosts[host];
    if (limits === undefined) problems.push(`${at}: no limits for host ${host}`);
    const floor = Date.parse(`${spec.floor}T00:00:00Z`);
    const target = spec.source === 'NL-1' ? undefined : spec.target;
    if (Number.isNaN(floor)) problems.push(`${at}: bad floor`);
    else if (floor >= ceilingMs({ target })) problems.push(`${at}: floor is not before the ceiling`);
    const src = sources.get(spec.source);
    if (src?.audience !== 'public') problems.push(`${at}: ${spec.source} is not a public source`);
    if (src?.history_export !== true) problems.push(`${at}: ${spec.source} has history_export off`);
    if (target !== undefined) {
      const t = sources.get(target);
      if (t?.audience !== 'public') problems.push(`${at}: target ${target} is not a public source`);
      if (t?.history_export !== true) problems.push(`${at}: target ${target} has history_export off`);
    }
    // The schema refines this too; kept here so that a member without the refine cannot slip past.
    if (spec.source !== 'NL-1' && !capsNeeded(spec)) problems.push(`${at}: ${CAPS_MSG}`);
    if (limits === undefined || src?.audience !== 'public') continue;
    const provider = providers[spec.source];
    if (provider === undefined) {
      skipped.push(`${at}: no provider for ${spec.source}`);
      continue;
    }
    let units: ReturnType<Provider['units']>;
    try {
      units = provider.units(spec, dir);
    } catch (err) {
      problems.push(`${at}: ${err instanceof Error ? err.message : 'units failed'}`);
      continue;
    }
    // The units come from the provider of the spec's own source, so they are that member's unit type.
    specs.push({
      ...spec,
      host,
      limits,
      chunk_ms: durationMs(spec.chunk),
      series: units,
      ...(target === undefined ? {} : { target }),
    } as LoadedBackfillSpec);
  }
  for (const host of Object.keys(file.hosts)) {
    if (![...captureHosts.values()].some((h) => h.includes(host)))
      problems.push(`backfill hosts: ${host} is in no capture.yaml hosts list`);
  }
  if (problems.length > 0) throw new Error(`registry/backfill.yaml:\n  ${problems.join('\n  ')}`);
  return { specs, hosts: file.hosts, ...(skipped.length === 0 ? {} : { skipped }) };
}
