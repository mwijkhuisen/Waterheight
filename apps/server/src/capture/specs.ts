import { readFileSync } from 'node:fs';
import { Cron } from 'croner';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SOURCE_RE, SPEC_RE } from '../archive/manifest.ts';
import { ValiditySpec } from '../archive/validity.ts';
import { scanCsv } from '../http/guards.ts';
import type { Req, Row } from '../http/types.ts';

// CaptureSpecs (A§7.1): registry/capture.yaml, the station lists in
// registry/seed/*.csv, and each source's audience read (never written) from
// registry/sources.yaml. The registry sits next to apps/ in the repo layout,
// the same depth from src/ and dist/ (the P1b image keeps that layout).

export const REGISTRY_DIR = new URL('../../../../registry/', import.meta.url);

const Duration = z.string().regex(/^-?P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?)?$/);

/** ISO 8601 duration subset (days, hours, minutes; optional leading minus) in ms. */
export function durationMs(d: string): number {
  const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  const ms = ((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0)) * 60_000;
  return m[1] ? -ms : ms;
}

export const Spec = z.strictObject({
  id: z.string().regex(SPEC_RE).max(40),
  source: z.string().regex(SOURCE_RE),
  version: z.number().int().positive(),
  /** The first-enabled group: §0.1a streams and LU-3/LU-4 (unrefillable). */
  first: z.boolean().default(false),
  /** UTC cron with a staggered offset; null for a seed-only spec. */
  cron: z.string().nullable(),
  request: z.strictObject({
    method: z.enum(['GET', 'POST']).default('GET'),
    /** URL template: `{field}` takes a variant value, URL-encoded. The host is literal. */
    url: z.string().startsWith('https://'),
    /** Body template: `{field}` takes a variant value as is. */
    body: z.string().optional(),
    body_encoding: z.enum(['raw', 'form-query']).default('raw'),
    headers: z.record(z.string(), z.string()).default({}),
    /** The adapter builds the final request (window, body). */
    build: z.boolean().default(false),
    /** The adapter derives stage-2 requests from the document. */
    expand: z.boolean().default(false),
    max_expand: z.number().int().positive().max(500).default(60),
    /** Validity of the stage-2 documents (default: the spec's own). */
    expand_validity: ValiditySpec.optional(),
  }),
  variants: z
    .strictObject({
      seed: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      where: z.record(z.string(), z.string()).default({}),
      values: z.array(z.record(z.string(), z.string())).optional(),
      each: z.record(z.string(), z.array(z.string())).default({}),
      /** Fields that identify the variant (default: all), e.g. NL-1 location + quantity. */
      key: z.array(z.string()).optional(),
      /** Pause between two requests of a run (LU-2 is staggered). */
      space_ms: z.number().int().nonnegative().default(0),
    })
    .optional(),
  params: z.record(z.string(), z.string()).default({}),
  /** Gap-stretch window: from = max(now − max, min(now − default, last success − overlap)), at least `min` back. */
  window: z
    .strictObject({ default: Duration, max: Duration, overlap: Duration.default('PT0M'), min: Duration.optional() })
    .optional(),
  conditional: z.enum(['none', 'etag', 'last-modified', 'both']).default('none'),
  gate: z
    .strictObject({
      kind: z.enum(['hash', 'field', 'new-resource', 'lastmod-runstart']),
      /** `field`: dot paths tried in order (case variants); unreadable → the body is stored. */
      paths: z.array(z.string()).default([]),
    })
    .default({ kind: 'hash', paths: [] }),
  alert: z
    .strictObject({
      /** Dot paths whose joined value is watched; empty = the adapter's alertKey. */
      paths: z.array(z.string()).default([]),
      kind: z.string().regex(/^[a-z0-9_]+$/),
      /** true: the change pages (a /fail ping); false: daily report only. */
      page: z.boolean().default(false),
    })
    .optional(),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  timeout: z.enum(['normal', 'metadata']).default('normal'),
  retention: z.enum(['obs', 'forever']),
  validity: ValiditySpec,
  /** §0.1b day-0 harvest, run once off the scheduler. */
  seed: z
    .strictObject({
      kind: z.enum(['once', 'window', 'days', 'all-resources']),
      window: Duration.optional(),
      days: z.number().int().positive().max(31).optional(),
      pace_ms: z.number().int().nonnegative().default(1000),
      page_cap: z.number().int().positive().max(2000).default(50),
    })
    .optional(),
});
export type Spec = z.infer<typeof Spec>;

export const GROUP_SLUGS = [
  'cap-nl',
  'cap-de-fed',
  'cap-de6',
  'cap-de78',
  'cap-fr',
  'cap-lu',
  'cap-ch',
  'cap-bfg',
  'cap-owner',
] as const;

const CaptureFile = z.strictObject({
  version: z.literal(1),
  groups: z.record(z.enum(GROUP_SLUGS), z.array(z.string().regex(SOURCE_RE)).min(1)),
  hosts: z.record(z.string().regex(SOURCE_RE), z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1)),
  /** Per source: header name → file name under /run/secrets. */
  secret_headers: z.record(z.string().regex(SOURCE_RE), z.record(z.string(), z.string().regex(/^[a-z0-9_]+$/))),
  specs: z.array(Spec).min(1),
});

/** sources.yaml, read only for what capture needs; the registry test validates it fully. */
const SourcesFile = z.object({
  sources: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      audience: z.enum(['public', 'owner', 'off']),
      private_basis: z.object({ clause: z.string(), url: z.string(), retrieved: z.string() }).nullable(),
    }),
  ),
});

export type Audience = 'public' | 'owner';

export type LoadedSpec = Spec & {
  audience: Audience;
  cadence_s: number | null;
  group: (typeof GROUP_SLUGS)[number];
  rows: Row[];
};

export type Group = { slug: (typeof GROUP_SLUGS)[number]; sources: string[]; cadence_s: number; anchor: string };

export type Registry = {
  specs: LoadedSpec[];
  hosts: Map<string, string[]>;
  secretHeaders: Map<string, Record<string, string>>;
  groups: Group[];
  sources: Map<string, { audience: 'public' | 'owner' | 'off'; private_basis: unknown }>;
};

/** The shortest gap between two runs of a UTC cron (its cadence), in seconds. */
export function cadenceOf(cron: string): number {
  const job = new Cron(cron, { timezone: 'UTC', paused: true });
  const runs = job.nextRuns(64, new Date('2026-10-05T00:00:00Z'));
  job.stop();
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i += 1) {
    min = Math.min(min, ((runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime()) / 1000);
  }
  if (!Number.isFinite(min)) throw new Error(`cron ${cron} runs fewer than twice`);
  return min;
}

export function readSeed(dir: URL, name: string): Row[] {
  const bytes = readFileSync(new URL(`seed/${name}.csv`, dir));
  const { header, rows } = scanCsv(bytes, { delimiter: ',', commentPrefix: '#' });
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function expandRows(spec: Spec, dir: URL): Row[] {
  const v = spec.variants;
  if (v === undefined) return [{}];
  let rows: Row[] = v.values ?? (v.seed ? readSeed(dir, v.seed) : [{}]);
  rows = rows.filter((r) => Object.entries(v.where).every(([k, want]) => r[k] === want));
  for (const [field, values] of Object.entries(v.each)) {
    rows = rows.flatMap((r) => values.map((x) => ({ ...r, [field]: x })));
  }
  return rows;
}

/**
 * Loads and cross-checks the capture registry. Throws on any problem: a spec
 * for an `off` source, a host outside its source's allowlist, a host listed
 * for an `off` source, a source in no group or two groups, an unknown seed.
 */
export function loadRegistry(dir: URL = REGISTRY_DIR): Registry {
  const file = CaptureFile.parse(parseYaml(readFileSync(new URL('capture.yaml', dir), 'utf8')));
  const sourcesDoc = SourcesFile.parse(parseYaml(readFileSync(new URL('sources.yaml', dir), 'utf8')));
  const sources = new Map(
    sourcesDoc.sources.map((s) => [s.id, { audience: s.audience, private_basis: s.private_basis }]),
  );
  const problems: string[] = [];

  for (const [source, hosts] of Object.entries(file.hosts)) {
    const s = sources.get(source);
    if (s === undefined || s.audience === 'off') problems.push(`hosts: ${source} is not a captured source`);
    if (new Set(hosts).size !== hosts.length) problems.push(`hosts: duplicate host for ${source}`);
  }
  const groupOf = new Map<string, (typeof GROUP_SLUGS)[number]>();
  for (const slug of GROUP_SLUGS) {
    for (const source of file.groups[slug] ?? []) {
      if (groupOf.has(source)) problems.push(`groups: ${source} is in two groups`);
      groupOf.set(source, slug);
    }
  }

  const ids = new Set<string>();
  const specs: LoadedSpec[] = [];
  for (const spec of file.specs) {
    const at = `spec ${spec.id}`;
    if (ids.has(spec.id)) problems.push(`${at}: duplicate id`);
    ids.add(spec.id);
    const src = sources.get(spec.source);
    if (src === undefined) {
      problems.push(`${at}: unknown source ${spec.source}`);
      continue;
    }
    if (src.audience === 'off') {
      problems.push(`${at}: ${spec.source} is audience off and may have no spec`);
      continue;
    }
    if (src.audience === 'owner' && src.private_basis === null)
      problems.push(`${at}: owner source without private_basis`);
    const host = new URL(spec.request.url.replace(/\{!?[a-z_]+\}/g, 'x')).hostname;
    if (!file.hosts[spec.source]?.includes(host))
      problems.push(`${at}: host ${host} is not allowlisted for ${spec.source}`);
    const group = groupOf.get(spec.source);
    if (group === undefined) {
      problems.push(`${at}: ${spec.source} is in no healthchecks group`);
      continue;
    }
    if (spec.cron === null && spec.seed === undefined) problems.push(`${at}: neither scheduled nor seeded`);
    let cadence: number | null = null;
    try {
      cadence = spec.cron === null ? null : cadenceOf(spec.cron);
    } catch {
      problems.push(`${at}: bad cron ${spec.cron}`);
    }
    let rows: Row[] = [];
    try {
      rows = expandRows(spec, dir);
    } catch {
      problems.push(`${at}: cannot read seed ${spec.variants?.seed}`);
    }
    if (rows.length === 0) problems.push(`${at}: no variants`);
    specs.push({ ...spec, audience: src.audience, cadence_s: cadence, group, rows });
  }

  const groups: Group[] = [];
  for (const slug of GROUP_SLUGS) {
    const members = specs.filter((s) => s.group === slug && s.cadence_s !== null);
    if (members.length === 0) {
      problems.push(`group ${slug}: no scheduled spec`);
      continue;
    }
    const anchor = members.reduce((a, b) => ((b.cadence_s as number) < (a.cadence_s as number) ? b : a));
    groups.push({ slug, sources: file.groups[slug] ?? [], cadence_s: anchor.cadence_s as number, anchor: anchor.id });
  }
  if (problems.length > 0) throw new Error(`registry/capture.yaml:\n  ${problems.join('\n  ')}`);
  return {
    specs,
    hosts: new Map(Object.entries(file.hosts)),
    secretHeaders: new Map(Object.entries(file.secret_headers)),
    groups,
    sources,
  };
}

/**
 * `{field}` → the variant's value (URL-encoded in URLs, as is in bodies);
 * `{!field}` → as is, for query strings written in capture.yaml itself.
 */
export function render(template: string, row: Row, encode: boolean): string {
  return template.replace(/\{(!?)([a-z_]+)\}/g, (_, raw: string, k: string) => {
    const v = row[k];
    if (v === undefined) throw new Error(`template field ${k} missing`);
    return encode && raw === '' ? encodeURIComponent(v) : v;
  });
}

export function variantKey(row: Row, fields?: readonly string[]): string {
  const key = (fields ? fields.map((f) => row[f] ?? '') : Object.values(row)).join('/');
  return key === '' ? 'default' : key.slice(0, 200);
}

/** The request of one variant from the registry templates (before any adapter build). */
export function baseRequest(spec: Spec, row: Row): Req {
  const body = spec.request.body === undefined ? undefined : render(spec.request.body, row, false);
  return {
    url: render(spec.request.url, row, true),
    method: spec.request.method,
    headers: { ...spec.request.headers },
    ...(body === undefined
      ? {}
      : { body: spec.request.body_encoding === 'form-query' ? `query=${encodeURIComponent(body)}` : body }),
    variant: variantKey(row, spec.variants?.key),
  };
}

/**
 * The gap-stretched window: normally `default` back from now; after an outage
 * back to the last success minus the overlap; never further than `max`, and
 * never less than `min` back.
 */
export function windowFor(spec: Spec, now: Date, lastSuccess: string | undefined): { from: Date; to: Date } | null {
  const w = spec.window;
  if (w === undefined) return null;
  const t = now.getTime();
  let from = t - durationMs(w.default);
  if (lastSuccess !== undefined) from = Math.min(from, Date.parse(lastSuccess) - durationMs(w.overlap));
  if (w.min !== undefined) from = Math.min(from, t - durationMs(w.min));
  from = Math.max(from, t - durationMs(w.max));
  return { from: new Date(from), to: now };
}
