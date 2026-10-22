import type { State, StateBasis } from '@rws/contracts';

// A lake's state and spread (P18b, D27, owner decision O-4): pure, over the reaches file's water body and the
// snapshot. The state is the reference gauge's own (its H series), never an average and never another gauge's,
// however high or badly classed that one is: wind piles the water up on one shore and lowers it on the other. The
// spread between the body's NAP gauges is information only, never a state.

/** A reaches-file water body (the fields used; the web parses the file leniently). */
export type LakeBody = { reference_station_id: string | null; stations: readonly string[] };

/** A station's primary series at T: the caller passes the H series where the station has one. */
export type LakeGauge = {
  quantity: 'H' | 'Q';
  datum: string | null;
  value: number | null;
  state: State;
  basis: StateBasis | null;
};

export type LakeView = {
  /** The D27 reference gauge's station id, or null (no placed gauge, or a sea or estuary). */
  reference: string | null;
  /** The reference's state and basis at T; null when there is no reference or it has no H value at T. */
  state: State | null;
  basis: StateBasis | null;
  /** max − min in cm over the body's H gauges in NAP with a value at T (n ≥ 2), else null. Never a state. */
  spread: { cm: number; n: number } | null;
};

const level = (g: LakeGauge | undefined) => (g !== undefined && g.quantity === 'H' && g.value !== null ? g : undefined);

export function lakeView(body: LakeBody, byStation: ReadonlyMap<string, LakeGauge>): LakeView {
  const ref = body.reference_station_id === null ? undefined : level(byStation.get(body.reference_station_id));
  const nap = body.stations.flatMap((s) => {
    const g = level(byStation.get(s));
    return g?.datum === 'NAP' ? [g.value as number] : [];
  });
  return {
    reference: body.reference_station_id,
    state: ref?.state ?? null,
    basis: ref === undefined ? null : ref.basis,
    spread: nap.length < 2 ? null : { cm: Math.round((Math.max(...nap) - Math.min(...nap)) * 10) / 10, n: nap.length },
  };
}
