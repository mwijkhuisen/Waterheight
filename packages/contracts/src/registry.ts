import { z } from 'zod';

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

export type RegistryOptions = {
  /** Source IDs with a registry/permissions/<ID>.md record. */
  permissionRecords: ReadonlySet<string>;
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
): { problems: string[]; providers: Provider[]; sources: Source[] } {
  const problems: string[] = [];
  const providersParsed = ProvidersFile.safeParse(providersInput);
  const sourcesParsed = SourcesFile.safeParse(sourcesInput);
  if (!providersParsed.success) problems.push(`providers.yaml: ${z.prettifyError(providersParsed.error)}`);
  if (!sourcesParsed.success) problems.push(`sources.yaml: ${z.prettifyError(sourcesParsed.error)}`);
  if (!providersParsed.success || !sourcesParsed.success) return { problems, providers: [], sources: [] };

  const providers = providersParsed.data.providers;
  const sources = sourcesParsed.data.sources;
  const providerIds = new Set<string>();
  for (const p of providers) {
    if (providerIds.has(p.id)) problems.push(`provider ${p.id}: duplicate`);
    providerIds.add(p.id);
  }

  const seen = new Set<string>();
  for (const s of sources) {
    const at = `source ${s.id}`;
    if (seen.has(s.id)) problems.push(`${at}: duplicate`);
    seen.add(s.id);
    if (!providerIds.has(s.provider)) problems.push(`${at}: unknown provider ${s.provider}`);
    if ((s.canary === true) !== s.id.startsWith('CANARY-'))
      problems.push(`${at}: canary flag and CANARY- id must agree`);

    // Audience (invariants 8 and 11; ADR-0017).
    if (s.capture_enabled !== (s.audience !== 'off'))
      problems.push(`${at}: capture_enabled must equal audience != off`);
    if (s.audience === 'owner' && s.private_basis === null)
      problems.push(`${at}: owner audience needs a private_basis`);
    if (s.audience !== 'owner' && s.private_basis !== null)
      problems.push(`${at}: private_basis is only for the owner audience`);

    // Channels (§0.7). Owner sources never export in bulk.
    if (s.audience === 'owner' && s.bulk_export) problems.push(`${at}: an owner source must have bulk_export off`);
    const record = options.permissionRecords.has(s.id);
    if (s.permission_required && !record && (s.api || s.bulk_export || s.history_export)) {
      problems.push(
        `${at}: permission-based source has api/bulk_export/history_export on without registry/permissions/${s.id}.md`,
      );
    }
    const defaults = defaultChannels(s);
    const changed = CHANNELS.filter((c) => s[c] !== defaults[c]);
    if (changed.length > 0 && !record) {
      problems.push(
        `${at}: ${changed.join(', ')} differ(s) from the §0.7 default without registry/permissions/${s.id}.md`,
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
  return { problems, providers, sources };
}
