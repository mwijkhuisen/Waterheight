/**
 * The data sources this application knows about, and the code namespace that
 * keeps them apart.
 *
 * The registry here is the source of truth, not the `sources` table: a source
 * is an adapter plus its configuration, and both live in code. The table exists
 * so location rows can carry a foreign key and so attribution can be served
 * from the database rather than hard-coded in the client; `syncSources` pushes
 * this registry into it at startup, which is why adding a source needs no
 * migration.
 */

/** Rijkswaterstaat's source id. Named once here; nothing else spells it out. */
export const RWS_SOURCE_ID = 'rws';

/**
 * The source a bare, unprefixed location code is assumed to belong to.
 *
 * Every code in the system was a Rijkswaterstaat code before sources existed,
 * so this is also what keeps links minted before that change resolving.
 */
export const DEFAULT_SOURCE_ID = RWS_SOURCE_ID;

/** Separates the source from the upstream's own code in `locations.code`. */
export const SOURCE_SEPARATOR = ':';

export interface SourceDescriptor {
  id: string;
  name: string;
  /**
   * ISO 3166-1 alpha-2 for the *publisher*, not for its stations: PEGELONLINE
   * is a German service that publishes gauges in Switzerland and the
   * Netherlands as well.
   */
  country: string;
  /** Shown in the map's attribution control. */
  attribution: string;
  licence: string;
  baseUrl: string;
  /**
   * Whether the upstream's codes are case-insensitive.
   *
   * Rijkswaterstaat's are, and are folded to lower case on the way in so a
   * hand-typed URL resolves whatever its casing. That is a property of this one
   * service, not of codes in general -- a KiWIS `station_no` like `01L05_404`
   * is not obviously safe to fold -- so each source states its own policy
   * instead of the namespace assuming one.
   */
  lowercaseCodes: boolean;
}

export const SOURCES: Readonly<Record<string, SourceDescriptor>> = {
  [RWS_SOURCE_ID]: {
    id: RWS_SOURCE_ID,
    name: 'Rijkswaterstaat',
    country: 'NL',
    attribution: 'Rijkswaterstaat',
    licence: 'Rijkswaterstaat open data — https://rijkswaterstaatdata.nl/waterdata/',
    baseUrl: 'https://ddapi20-waterwebservices.rijkswaterstaat.nl',
    lowercaseCodes: true,
  },
};

export function getSource(id: string): SourceDescriptor | null {
  return SOURCES[id] ?? null;
}

export function listSources(): SourceDescriptor[] {
  return Object.values(SOURCES);
}

/** Apply a source's own casing policy to one of its codes. */
export function normaliseSourceCode(sourceId: string, sourceCode: string): string {
  const trimmed = sourceCode.trim();
  return SOURCES[sourceId]?.lowercaseCodes ? trimmed.toLowerCase() : trimmed;
}

/**
 * Compose the primary key for a location: `<source>:<upstream code>`.
 *
 * No source's own codes contain a colon -- PEGELONLINE uses UUIDs, Hub'Eau
 * `B0220010`, KiWIS `01L05_404` -- so the separator stays unambiguous and
 * `parseLocationKey` is exact rather than a best guess.
 */
export function locationKey(sourceId: string, sourceCode: string): string {
  return `${sourceId}${SOURCE_SEPARATOR}${normaliseSourceCode(sourceId, sourceCode)}`;
}

export function parseLocationKey(
  key: string,
): { sourceId: string; sourceCode: string } | null {
  const at = key.indexOf(SOURCE_SEPARATOR);
  if (at <= 0 || at === key.length - 1) return null;
  return { sourceId: key.slice(0, at), sourceCode: key.slice(at + 1) };
}

/**
 * Resolve whatever a caller supplied into a location key.
 *
 * Accepts both the qualified form and a bare upstream code, which is read as
 * belonging to the default source. That second form is what keeps URLs, saved
 * queries and `--locations` arguments from before the source split working; it
 * is a compatibility affordance rather than the addressing scheme, so anything
 * this application mints uses the qualified form.
 */
export function resolveLocationKey(input: string): string {
  const parsed = parseLocationKey(input.trim());
  if (parsed && getSource(parsed.sourceId)) {
    return locationKey(parsed.sourceId, parsed.sourceCode);
  }
  return locationKey(DEFAULT_SOURCE_ID, input);
}
