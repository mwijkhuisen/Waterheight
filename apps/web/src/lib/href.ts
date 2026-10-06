/** A link target from data only when it is an https URL (invariant 3); else undefined and the caller shows text. */
export function httpsHref(u: string | null): string | undefined {
  if (u === null) return undefined;
  try {
    return new URL(u).protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}
