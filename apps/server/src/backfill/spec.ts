import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SOURCE_RE, SPEC_RE } from '../archive/manifest.ts';
import { durationMs, REGISTRY_DIR } from '../capture/specs.ts';

// registry/backfill.yaml (P14a, plan §3.2): the history jobs of the backfill runner. Like capture.yaml it is the
// only place a fetch target comes from (invariant 1): every host of a spec must be in that source's capture.yaml
// `hosts`, so the runner's Client gets the same allowlist as live capture. Series are never listed here: the
// selection resolves against registry/stations/<source>.yaml.

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

export const BackfillSpec = z.strictObject({
  id: z.string().regex(SPEC_RE).max(40),
  source: z.string().regex(SOURCE_RE),
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
export type BackfillSpec = z.infer<typeof BackfillSpec>;

const BackfillFile = z.strictObject({
  version: z.literal(1),
  hosts: z.record(HOST, HostLimits),
  specs: z.array(BackfillSpec).min(1),
});

/** One resolved series of a spec: what the request body and the probe are built from. */
export type Series = {
  /** The registry `provider_key`: `<code>/<Grootheid>/<Hoedanigheid>/<method>`. */
  series_key: string;
  code: string;
  quantity: 'H' | 'Q';
  hoedanigheid: string;
  /** The series' live method (`other:F007`): the probe asks for it. */
  method: string;
  /** Native step in ms (the registry's `native_step`, else 10 minutes): the dry-run's value count. */
  step_ms: number;
};

export type LoadedBackfillSpec = BackfillSpec & {
  /** Host of `url`, and the limits that apply. */
  host: string;
  limits: HostLimits;
  chunk_ms: number;
  series: Series[];
};
export type LoadedBackfill = { specs: LoadedBackfillSpec[]; hosts: Record<string, HostLimits> };

const StationRow = z.looseObject({
  provider_code: z.string(),
  provider_key: z.string(),
  quantity: z.enum(['H', 'Q']),
  role: z.string(),
  first_release: z.boolean(),
  audience: z.string(),
  native_step: z.string().optional(),
});
const StationsFile = z.looseObject({ stations: z.array(StationRow) });

const QUANTITY = { WATHTE: 'H', Q: 'Q' } as const;

/**
 * The series a spec selects: its source's station rows with `first_release`, the asked quantity, `role: primary`
 * (never the TAW twin) and an audience other than `off`. A row whose key is not `<code>/<Grootheid>/<Hoedanigheid>/
 * <method>` is a registry fault.
 */
export function resolveSeries(spec: BackfillSpec, dir: URL = REGISTRY_DIR): Series[] {
  const file = StationsFile.parse(
    parseYaml(readFileSync(new URL(`stations/${spec.source.toLowerCase()}.yaml`, dir), 'utf8')),
  );
  const wanted = new Set(spec.select.quantities.map((q) => QUANTITY[q]));
  const out: Series[] = [];
  for (const r of file.stations) {
    if (!r.first_release || r.role !== spec.select.role || r.audience === 'off' || !wanted.has(r.quantity)) continue;
    const [code, grootheid, hoedanigheid, method, ...rest] = r.provider_key.split('/');
    if (
      rest.length > 0 ||
      code !== r.provider_code ||
      grootheid !== (r.quantity === 'H' ? 'WATHTE' : 'Q') ||
      !hoedanigheid ||
      !method
    )
      throw new Error(`registry/stations: ${r.provider_key} is not a series key of ${r.provider_code}`);
    if (hoedanigheid === 'TAW') continue;
    out.push({
      series_key: r.provider_key,
      code,
      quantity: r.quantity,
      hoedanigheid,
      method,
      step_ms: r.native_step === undefined ? 600_000 : durationMs(r.native_step),
    });
  }
  return out;
}

/**
 * Reads and cross-checks registry/backfill.yaml. `captureHosts` is capture.yaml's `hosts` (Registry.hosts). Throws
 * on any problem: a host or URL outside its source's allowlist, a spec host without limits, an unknown source.
 */
export function loadBackfill(
  captureHosts: ReadonlyMap<string, readonly string[]>,
  dir: URL = REGISTRY_DIR,
): LoadedBackfill {
  const file = BackfillFile.parse(parseYaml(readFileSync(new URL('backfill.yaml', dir), 'utf8')));
  const problems: string[] = [];
  const ids = new Set<string>();
  const specs: LoadedBackfillSpec[] = [];
  for (const spec of file.specs) {
    const at = `backfill spec ${spec.id}`;
    if (ids.has(spec.id)) problems.push(`${at}: duplicate id`);
    ids.add(spec.id);
    const allowed = captureHosts.get(spec.source);
    if (allowed === undefined) problems.push(`${at}: ${spec.source} has no hosts in capture.yaml`);
    const host = new URL(spec.url).hostname;
    for (const u of [spec.url, spec.check_url]) {
      const h = new URL(u).hostname;
      if (h !== host) problems.push(`${at}: url and check_url are on different hosts`);
      if (!allowed?.includes(h)) problems.push(`${at}: host ${h} is not allowlisted for ${spec.source}`);
    }
    const limits = file.hosts[host];
    if (limits === undefined) problems.push(`${at}: no limits for host ${host}`);
    if (Number.isNaN(Date.parse(`${spec.floor}T00:00:00Z`))) problems.push(`${at}: bad floor`);
    if (limits === undefined) continue;
    specs.push({ ...spec, host, limits, chunk_ms: durationMs(spec.chunk), series: resolveSeries(spec, dir) });
  }
  for (const host of Object.keys(file.hosts)) {
    if (![...captureHosts.values()].some((h) => h.includes(host)))
      problems.push(`backfill hosts: ${host} is in no capture.yaml hosts list`);
  }
  if (problems.length > 0) throw new Error(`registry/backfill.yaml:\n  ${problems.join('\n  ')}`);
  return { specs, hosts: file.hosts };
}
