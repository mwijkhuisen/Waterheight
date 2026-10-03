import { readRegistry } from '../../../apps/server/src/load/registry-sync.ts';
import type { Audience, Station } from '../../../packages/contracts/src/index.ts';

// The registry stations the P6b placement reads (one entry per station id; a
// station's H and Q rows share id, coordinates and water body). Read through
// readRegistry, so the placement sees exactly the rows the sync stores.

export type StationInput = {
  id: string;
  /** The source of the station's first row (rows of one id share a source). */
  source: string;
  /** The widest audience among its rows. */
  audience: Audience;
  /**
   * Shown on the public site: a primary row of audience public whose source
   * has the display channel (the rule of the public station view, A§6). Only
   * these stations cut reaches or appear in a public output.
   */
  public: boolean;
  lon: number | null;
  lat: number | null;
  /** The water body as the operator publishes it (null where none is published). */
  water_name: string | null;
  /** DE-1 only: the generator's river slug and the PEGELONLINE km. */
  river_hint: string | null;
  km: { system: string; value: number } | null;
};

const RANK: Record<Audience, number> = { off: 0, owner: 1, public: 2 };

/** Groups validated rows by station id, in id order. */
export function stationInputs(rows: readonly Station[], display: ReadonlyMap<string, boolean>): StationInput[] {
  const byId = new Map<string, Station[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  return [...byId.keys()].sort().map((id) => {
    const group = byId.get(id) ?? [];
    const first = group[0] as Station;
    const audience = group.reduce<Audience>((a, r) => (RANK[r.audience] > RANK[a] ? r.audience : a), 'off');
    return {
      id,
      source: first.source,
      audience,
      public: group.some((r) => r.role === 'primary' && r.audience === 'public' && display.get(r.source) === true),
      lon: first.lon,
      lat: first.lat,
      water_name: first.water_name,
      river_hint: first.river,
      km: first.km,
    };
  });
}

/** Every registry station, validated by readRegistry (which fails closed). */
export function readStations(dir?: URL): StationInput[] {
  const registry = dir === undefined ? readRegistry() : readRegistry(dir);
  return stationInputs(registry.stations, new Map(registry.sources.map((s) => [s.id, s.display])));
}
