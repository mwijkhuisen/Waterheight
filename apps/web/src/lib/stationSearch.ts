// The station search (P10e D6): a pure matcher over the station list. A query is matched case- and
// diacritics-insensitively against the name and the water name; every word of it must occur. Names that start with
// the query come first, then those that contain it, then the ones that match only through the water.

export const SEARCH_LIMIT = 20;

export interface Searchable {
  id: string;
  name: string;
  waterName: string | null;
}

/** Lower case with the combining marks of the decomposed form removed: "Lobíth" and "lobith" are the same. */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** At most `limit` stations for `query`, best first; the list's own order breaks ties. No query, no matches. */
export function matchStations<T extends Searchable>(
  stations: readonly T[],
  query: string,
  limit: number = SEARCH_LIMIT,
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const ranked: { station: T; rank: number; at: number }[] = [];
  stations.forEach((station, at) => {
    const name = fold(station.name);
    const both = `${name} ${fold(station.waterName ?? '')}`;
    if (!words.every((w) => both.includes(w))) return;
    const inName = words.every((w) => name.includes(w));
    ranked.push({ station, rank: inName ? (name.startsWith(words[0] ?? '') ? 0 : 1) : 2, at });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, limit)
    .map((r) => r.station);
}
