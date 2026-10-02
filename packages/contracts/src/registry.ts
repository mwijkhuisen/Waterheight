import { z } from 'zod';
import { BASELINE } from './baseline.ts';

// Registry schemas (A§6; catalogue §0.7, §0.8; ADR-0007, ADR-0017). Every
// object is strict: an unknown or misspelt key is an error, never ignored.

/** Who may see a source's data: the public site, the owner view only, or nobody (not captured). */
export const AUDIENCES = ['public', 'owner', 'off'] as const;
export const Audience = z.enum(AUDIENCES);
export type Audience = z.infer<typeof Audience>;

/** Licence channels (catalogue §0.7); they apply inside each audience. */
export const CHANNELS = ['display', 'api', 'bulk_export', 'history_export'] as const;
export type Channel = (typeof CHANNELS)[number];
export type Channels = Record<Channel, boolean>;

/** Our classification of the §1b licence cell; it drives the channel defaults. */
export const LICENCE_KINDS = [
  'cc0',
  'dl-de-zero-2.0',
  'etalab-2.0',
  'cc-by',
  'cc-by-sa-4.0',
  'modellicentie-1.0',
  'ch-open-use',
  'bfg-terms',
  'provider-terms',
  'unlicensed',
] as const;
export const LicenceKind = z.enum(LICENCE_KINDS);
export type LicenceKind = z.infer<typeof LicenceKind>;
/** Open licences: all four channels on by default, with attribution (§0.7). */
export const OPEN_LICENCE_KINDS: readonly LicenceKind[] = [
  'cc0',
  'dl-de-zero-2.0',
  'etalab-2.0',
  'cc-by',
  'modellicentie-1.0',
  'ch-open-use',
];

export const SourceId = z.string().regex(/^(?:(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?|CANARY-[A-Z]+)$/);
export const ProviderId = z.string().regex(/^[a-z][a-z0-9-]*$/);
const Lang = z.enum(['nl', 'en', 'de', 'fr']);
const IsoDate = z.iso.date();
const HttpsUrl = z.url({ protocol: /^https$/, hostname: z.regexes.domain });

export const Provider = z.strictObject({
  id: ProviderId,
  name: z.string().min(1),
  country: z.string().min(1),
  contact: z.string().min(1).nullable(),
  terms_url: HttpsUrl.nullable(),
});
export type Provider = z.infer<typeof Provider>;

/** Why an owner-audience source may be shown to the owner: its catalogue §0.8 row. */
export const PrivateBasis = z.strictObject({
  clause: z.string().trim().min(1),
  url: HttpsUrl,
  retrieved: IsoDate,
});
export type PrivateBasis = z.infer<typeof PrivateBasis>;

/**
 * A series override inside a source: it may only narrow the source's audience
 * (public > owner > off) and channels, never widen them.
 */
export const SeriesOverride = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  canary: z.literal(true).optional(),
  audience: Audience.optional(),
  display: z.boolean().optional(),
  api: z.boolean().optional(),
  bulk_export: z.boolean().optional(),
  history_export: z.boolean().optional(),
  reason: z.string().min(1),
});
export type SeriesOverride = z.infer<typeof SeriesOverride>;

const AttributionVariant = z.strictObject({ lang: Lang.nullable(), text: z.string().min(1) });

export const Source = z.strictObject({
  id: SourceId,
  provider: ProviderId,
  /** §1a "Provider – service", markdown stripped. */
  name: z.string().min(1),
  /** §1a "Country / region". */
  country: z.string().min(1),
  canary: z.literal(true).optional(),
  /** §1b licence cell, markdown stripped; null where the catalogue has none. */
  licence_text: z.string().min(1).nullable(),
  licence_kind: LicenceKind.nullable(),
  audience: Audience,
  capture_enabled: z.boolean(),
  /** Used only under a written permission (registry/permissions/<ID>.md). */
  permission_required: z.boolean(),
  private_basis: PrivateBasis.nullable(),
  display: z.boolean(),
  api: z.boolean(),
  bulk_export: z.boolean(),
  history_export: z.boolean(),
  /**
   * The provider's own public history window (ISO 8601 duration, e.g. "P31D"). Older values need
   * history_export, so a source without it must declare the window it may still serve.
   */
  history_window: z.iso.duration().optional(),
  /** Exact text from §1b, markdown stripped and untranslated; null where §1b gives none. */
  attribution_text: z.string().min(1).nullable(),
  attribution_lang: Lang.nullable(),
  /** The link target §1b names for the credit, else null. */
  attribution_url: HttpsUrl.nullable(),
  /** false where §1b marks the credit "Suggested" or "Courtesy" (or the licence only recommends it). */
  attribution_required: z.boolean(),
  /** Other exact texts §1b gives (other languages, alternatives). */
  attribution_variants: z.array(AttributionVariant),
  needs_last_updated: z.boolean(),
  needs_retrieval_date: z.boolean(),
  /** false where §1b forbids the provider's logo; null where it says nothing. */
  logo_allowed: z.boolean().nullable(),
  series: z.array(SeriesOverride),
});
export type Source = z.infer<typeof Source>;

export const ProvidersFile = z.strictObject({ providers: z.array(Provider).min(1) });
export const SourcesFile = z.strictObject({ sources: z.array(Source).min(1) });

const RANK: Record<Audience, number> = { public: 2, owner: 1, off: 0 };

/** True when `narrow` is the same as or narrower than `wide` (public > owner > off). */
export function audienceWithin(narrow: Audience, wide: Audience): boolean {
  return RANK[narrow] <= RANK[wide];
}

/** The §0.7 channel defaults for a source (ADR-0017 for the owner audience). */
export function defaultChannels(source: Pick<Source, 'audience' | 'permission_required' | 'licence_kind'>): Channels {
  if (source.audience === 'owner') return { display: true, api: true, bulk_export: false, history_export: true };
  if (source.permission_required) return { display: true, api: false, bulk_export: false, history_export: false };
  const open = source.licence_kind !== null && OPEN_LICENCE_KINDS.includes(source.licence_kind);
  return { display: open, api: open, bulk_export: open, history_export: open };
}

/**
 * A permission record: the YAML front matter of registry/permissions/<ID>.md
 * (P13 adds them as grants arrive). It states what the provider granted; the
 * registry may use no more. The original e-mail stays in the owner's archive,
 * never in this public repository, and no person is named.
 */
export const PermissionRecord = z.strictObject({
  source: SourceId,
  /** The granting organisation, e.g. "LfU Rheinland-Pfalz". */
  granted_by: z.string().min(1),
  granted_on: IsoDate,
  /** Where the original lives, e.g. "e-mail of 2026-10-07, owner's mail archive". */
  evidence: z.string().min(1),
  /** The widest audience the permission allows. */
  audience: Audience,
  display: z.boolean(),
  api: z.boolean(),
  bulk_export: z.boolean(),
  history_export: z.boolean(),
});
export type PermissionRecord = z.infer<typeof PermissionRecord>;

/**
 * A withholding record (P5b): registry/permissions/<ID>.md that names series of a public source withheld in
 * both audiences (`off`), and why: third-party gauges inside a provider's open file whose licence may not
 * cover them (LU-1: the LfU RLP gauges, until C4 or C11). It narrows, never grants: the station rows carry
 * `audience: off`, and the sync checks that each named series has it.
 */
export const WithholdingRecord = z.strictObject({
  source: SourceId,
  /** Provider keys of the source's series (registry/stations/<source>.yaml), as published. */
  withheld: z.array(z.string().min(1).max(120)).min(1).max(50),
  audience: z.literal('off'),
  /** The catalogue clauses and the owner actions (C-numbers) that would lift it; no person is named. */
  basis: z.string().min(1).max(2000),
  recorded_on: IsoDate,
});
export type WithholdingRecord = z.infer<typeof WithholdingRecord>;

export type RegistryOptions = {
  /**
   * The parsed front matter of every registry/permissions/<ID>.md, keyed by the
   * file's ID (a file without valid front matter maps to null and fails).
   */
  permissionRecords: ReadonlyMap<string, unknown>;
  /** Today as YYYY-MM-DD: a record may not be dated in the future. */
  today: string;
};

/**
 * Cross-row rules that a schema alone cannot express. Returns every problem
 * found; an empty list means the registry is valid. It fails closed: a source
 * it cannot parse is a problem, never a default.
 */
export function validateRegistry(
  providersInput: unknown,
  sourcesInput: unknown,
  options: RegistryOptions,
): { problems: string[]; providers: Provider[]; sources: Source[]; withholdings: WithholdingRecord[] } {
  const problems: string[] = [];
  const providersParsed = ProvidersFile.safeParse(providersInput);
  const sourcesParsed = SourcesFile.safeParse(sourcesInput);
  if (!providersParsed.success) problems.push(`providers.yaml: ${z.prettifyError(providersParsed.error)}`);
  if (!sourcesParsed.success) problems.push(`sources.yaml: ${z.prettifyError(sourcesParsed.error)}`);
  if (!providersParsed.success || !sourcesParsed.success)
    return { problems, providers: [], sources: [], withholdings: [] };

  const providers = providersParsed.data.providers;
  const sources = sourcesParsed.data.sources;
  const providerIds = new Set<string>();
  for (const p of providers) {
    if (providerIds.has(p.id)) problems.push(`provider ${p.id}: duplicate`);
    providerIds.add(p.id);
  }

  // Permission records: valid front matter, named after their source, not dated in the future.
  const records = new Map<string, PermissionRecord>();
  const withholdings: WithholdingRecord[] = [];
  for (const [id, raw] of options.permissionRecords) {
    const withheld = WithholdingRecord.safeParse(raw);
    if (withheld.success) {
      if (withheld.data.source !== id) {
        problems.push(`registry/permissions/${id}.md: source is ${withheld.data.source}, expected ${id}`);
      } else if (withheld.data.recorded_on > options.today) {
        problems.push(`registry/permissions/${id}.md: recorded_on ${withheld.data.recorded_on} is in the future`);
      } else withholdings.push(withheld.data);
      continue;
    }
    const parsed = PermissionRecord.safeParse(raw);
    if (!parsed.success) {
      problems.push(`registry/permissions/${id}.md: not a valid permission record: ${z.prettifyError(parsed.error)}`);
    } else if (parsed.data.source !== id) {
      problems.push(`registry/permissions/${id}.md: source is ${parsed.data.source}, expected ${id}`);
    } else if (parsed.data.granted_on > options.today) {
      problems.push(`registry/permissions/${id}.md: granted_on ${parsed.data.granted_on} is in the future`);
    } else {
      records.set(id, parsed.data);
    }
  }
  for (const id of options.permissionRecords.keys()) {
    if (!sources.some((s) => s.id === id)) problems.push(`registry/permissions/${id}.md: no such source`);
  }

  const seen = new Set<string>();
  for (const s of sources) {
    const at = `source ${s.id}`;
    if (seen.has(s.id)) problems.push(`${at}: duplicate`);
    seen.add(s.id);
    if (!providerIds.has(s.provider)) problems.push(`${at}: unknown provider ${s.provider}`);
    if ((s.canary === true) !== s.id.startsWith('CANARY-'))
      problems.push(`${at}: canary flag and CANARY- id must agree`);

    // The reviewed baseline: licence kind always, audience unless a record grants it.
    const baseline = BASELINE[s.id];
    const record = records.get(s.id);
    if (baseline === undefined) {
      problems.push(`${at}: not in the approved baseline (packages/contracts/src/baseline.ts)`);
    } else {
      if (s.licence_kind !== baseline.licence_kind) {
        problems.push(`${at}: licence_kind ${s.licence_kind} differs from the baseline ${baseline.licence_kind}`);
      }
      if (s.audience !== baseline.audience && record === undefined) {
        problems.push(
          `${at}: audience ${s.audience} differs from ${baseline.audience} without registry/permissions/${s.id}.md`,
        );
      }
    }
    if (record !== undefined && !audienceWithin(s.audience, record.audience)) {
      problems.push(`${at}: audience ${s.audience} exceeds the ${record.audience} its permission record grants`);
    }

    // Audience (invariants 8 and 11; ADR-0017).
    if (s.capture_enabled !== (s.audience !== 'off'))
      problems.push(`${at}: capture_enabled must equal audience != off`);
    if (s.audience === 'owner' && s.private_basis === null)
      problems.push(`${at}: owner audience needs a private_basis`);
    if (s.audience !== 'owner' && s.private_basis !== null)
      problems.push(`${at}: private_basis is only for the owner audience`);

    // Channels (§0.7): the default for the source, or what its record grants. Owner sources never export in bulk.
    if (s.audience === 'owner' && s.bulk_export) problems.push(`${at}: an owner source must have bulk_export off`);
    const defaults = defaultChannels(s);
    for (const c of CHANNELS) {
      if (s[c] === defaults[c]) continue;
      if (record === undefined) {
        problems.push(`${at}: ${c} differs from the §0.7 default without registry/permissions/${s.id}.md`);
      } else if (s[c] && !record[c]) {
        problems.push(`${at}: ${c} is on, but its permission record does not grant it`);
      }
    }
    if (s.audience !== 'off' && !s.history_export && s.history_window === undefined) {
      problems.push(`${at}: history_export is off, so the source must declare its provider's history_window`);
    }
    if (s.permission_required && record === undefined && (s.api || s.bulk_export || s.history_export)) {
      problems.push(
        `${at}: permission-based source has api/bulk_export/history_export on without registry/permissions/${s.id}.md`,
      );
    }

    // Series may only narrow (invariant 8).
    const keys = new Set<string>();
    for (const o of s.series) {
      const where = `${at} series ${o.key}`;
      if (keys.has(o.key)) problems.push(`${where}: duplicate`);
      keys.add(o.key);
      if (o.audience !== undefined && !audienceWithin(o.audience, s.audience)) {
        problems.push(`${where}: widens audience ${s.audience} to ${o.audience}`);
      }
      for (const c of CHANNELS) {
        if (o[c] === true && !s[c]) problems.push(`${where}: widens channel ${c}`);
      }
      if (o.canary === true && o.audience !== 'off')
        problems.push(`${where}: the withheld canary must be audience off`);
    }
  }
  return { problems, providers, sources, withholdings };
}
