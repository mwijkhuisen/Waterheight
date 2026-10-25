import type { StateBasis } from '@rws/contracts';
import { useQuery } from '@tanstack/react-query';
import type { Locale } from '../../paraglide/runtime.js';
import { useAudience } from '../data/api.ts';
import { type OwnerLabels, own } from './labels.ts';
import { AREA_SCALE, CLASS_SCALE, PUBLIC_LABELS } from './labels-public.gen.ts';

// O4 (#220): the basis lookups over PUBLIC_LABELS, imported only by the lazy station panel's sections, so the entry chunk
// holds none of the provider-class messages. See labels.ts for the lookup rules.

/** The text of (source, scale, code): the public catalogue, else (owner sources) the owner labels. */
function labelFor(
  source: string,
  scale: string,
  code: string,
  locale: Locale,
  owner?: OwnerLabels,
): string | undefined {
  const id = `${source}\n${scale}\n${code}`;
  const message = own(PUBLIC_LABELS, id);
  if (message !== undefined) return message({}, { locale });
  const ownerKey = owner === undefined ? undefined : own(owner.keys, id);
  return ownerKey === undefined || owner === undefined ? undefined : own(owner[locale as 'nl' | 'en'] ?? {}, ownerKey);
}

/** The row of a code, else the source's `*` row. */
const exactOrAny = (source: string, scale: string, code: string, locale: Locale, owner?: OwnerLabels) =>
  labelFor(source, scale, code, locale, owner) ?? labelFor(source, scale, '*', locale, owner);

/**
 * Our NL/EN text for a state basis (V2): a gauge class by CLASS_SCALE with its `XX:` prefix stripped (exact code,
 * else the `*` row), NL-4 by (`stem`, ref), an area by AREA_SCALE and the area feature's `levelRaw`, a single-part
 * operational or statistical ref by (`reference`, kind). Undefined when there is none (raw only).
 */
export function basisLabel(
  basis: Pick<StateBasis, 'source' | 'kind' | 'ref'>,
  locale: Locale,
  ctx: { areaLevelRaw?: string | null | undefined; owner?: OwnerLabels | undefined } = {},
): string | undefined {
  const { source, kind, ref } = basis;
  switch (kind) {
    case 'provider_class': {
      if (source === 'NL-4') return labelFor(source, 'stem', ref, locale, ctx.owner);
      const scale = own(CLASS_SCALE, source);
      return scale === undefined
        ? undefined
        : exactOrAny(source, scale, ref.replace(/^[A-Z]{2}:/, ''), locale, ctx.owner);
    }
    case 'area': {
      const scale = own(AREA_SCALE, source);
      return scale === undefined || ctx.areaLevelRaw == null
        ? undefined
        : labelFor(source, scale, ctx.areaLevelRaw, locale, ctx.owner);
    }
    case 'operational':
    case 'statistical':
      // A multi-part ref (`MNW/MHW`, `A + B`) has no single text.
      return /[/+\s]/.test(ref) ? undefined : labelFor(source, 'reference', ref, locale, ctx.owner);
    default:
      return undefined;
  }
}

/** Our text for a recent.json reference (source, `reference`, kind; FR-5 `CRUE_*` → `CRUE`); undefined when none. */
export function referenceLabel(source: string, kind: string, locale: Locale, owner?: OwnerLabels): string | undefined {
  return labelFor(source, 'reference', source === 'FR-5' && kind.startsWith('CRUE_') ? 'CRUE' : kind, locale, owner);
}

/** The owner labels once the owner chunk has loaded (owner site only); undefined on the public site. */
export function useOwnerLabels(): OwnerLabels | undefined {
  const audience = useAudience();
  return useQuery({
    queryKey: ['owner-labels', audience],
    queryFn: async () => (await import('../../features/owner/labels.gen.ts')).OWNER_LABELS,
    enabled: audience === 'owner',
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data;
}
