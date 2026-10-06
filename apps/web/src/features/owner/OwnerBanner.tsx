import type { WebSource } from '../../lib/data/contracts.ts';
import type { Locale } from '../../paraglide/runtime.js';

// STUB (lead, P10a): S3 builds the owner banner (plan T12, C14): a persistent, non-dismissible `role="region"` with
// the one-line text, and a <details> listing each owner-audience source (canary already dropped by the loader) with
// its clause as a text node, an https-only link and the retrieval date.

export interface OwnerBannerProps {
  locale: Locale;
  /** sources.json entries of owner audience (useSources, filtered); undefined while it loads. */
  sources: readonly WebSource[] | undefined;
}

export function OwnerBanner(_: OwnerBannerProps) {
  return null;
}
