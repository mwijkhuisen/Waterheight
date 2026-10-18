import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  type SeriesDecl,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Ch9Record } from './parse.ts';

// CH-9 data.bs.ch → canonical rows of the CH-1 series of the same gauge (P14b backfill, plan §3.8).
// Declared here, never inferred per row:
//  - datasets (the manifest variant): 100089 is Basel Rheinhalle, station 2289 (W and Q); 100236 is Münchenstein on the
//    Birs, station 2106 (W only: its Q is on average 2.6 % above CH-1's at the same instants, max 5.6 %, so it fails the
//    1 % twin bound and is counted `q_not_twin`, never stored). Series keys are CH-1's: `<station>/W`, `<station>/Q`;
//  - time: ISO 8601 with its own offset (`+00:00`); only points on the 10-minute grid load (the 5-minute points in
//    between are `off_grid`), and a stamp before 2020-06-01, outside the line's chunk or more than 15 minutes after the
//    fetch is dropped;
//  - W is `pegel` in m ü. M. (LN02) times the series' factor (registry m → cm), Q is `abfluss` in m³/s; where a record
//    also states `pegelhoehe` (cm = pegel × 100 − 24000), a disagreement over 1 cm drops its W and Q as `inconsistent`;
//  - qc: raw, always (data.bs.ch states no validation); the temperature is not stored.
// The ledger identity: `provider_values` is 2 per record (its W and Q slots), each ends as an observation or in
// exactly one `dropped` code.

export const SOURCE = 'CH-9';
export const TIME: TimeConvention = { kind: 'iso-offset' };

/** The first stamp read (the Rhine's history starts 2020-06-22, the Birs's 2022-10-29). */
export const FLOOR = '2020-06-01T00:00:00Z';
const FLOOR_MS = Date.parse(FLOOR);
const GRID_MS = 600_000;
/** pegelhoehe is cm above 240 m ü. M. */
const PEGELHOEHE_ZERO_CM = 24_000;
/** CH-1's floor: no Swiss water level is below 150 m ü. M. (a lower `pegel` is not a level of LN02). */
const LEVEL_FLOOR_M = 150;
const TOLERANCE_CM = 1;

/** dataset → CH-1 station; `q`: whether its discharge is loaded. */
export const DATASETS: Readonly<Record<string, { station: string; q: boolean }>> = {
  '100089': { station: '2289', q: true },
  '100236': { station: '2106', q: false },
};

export type Context = {
  /** The registry of CH-1 (the target). */
  registry: Registry;
  fetchedAt: number;
  /** The manifest variant: the dataset id. */
  dataset: string;
  /** The line's chunk [from, to) in UTC ms. */
  backfill?: { from: number; to: number } | undefined;
};
export type Result = Normalised & { provider_values: number; unknown_values: number };

const UNIT = { H: 'm', Q: 'm³/s' } as const;

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

export function normaliseRecords(records: readonly Ch9Record[], ctx: Context): Result {
  const info = Object.hasOwn(DATASETS, ctx.dataset) ? DATASETS[ctx.dataset] : undefined;
  if (info === undefined) throw new SchemaDrift('unknown_variant');
  const out: Result = { ...emptyNormalised(), provider_values: 2 * records.length, unknown_values: 0 };
  const count = (code: string, n = 1) => {
    out.dropped[code] = (out.dropped[code] ?? 0) + n;
  };
  const lo = Math.max(FLOOR_MS, ctx.backfill?.from ?? Number.NEGATIVE_INFINITY);
  const hi = ctx.backfill?.to ?? Number.POSITIVE_INFINITY;
  const w = ctx.registry.get(`${info.station}/W`);
  const q = ctx.registry.get(`${info.station}/Q`);

  const one = (decl: SeriesDecl | undefined, raw: number | null, quantity: 'H' | 'Q', ts: number) => {
    if (raw === null) count('gap');
    else if (decl === undefined) {
      out.unknown_values += 1;
      out.unknown += 1;
    } else if (decl.native_unit !== UNIT[quantity]) count('unit_mismatch');
    // The CH-1 level rules (review C2): an exact 0 is "no value", and no Swiss level is below 150 m ü. M.
    else if (quantity === 'H' && raw === 0) count('sentinel');
    else if (quantity === 'H' && raw < LEVEL_FLOOR_M) count('datum_mismatch');
    else {
      const value = scale(decl.to_canonical, raw);
      out.obs.push({
        series: decl.key,
        ts: toIso(ts),
        value,
        qc: QC.RAW | rangeBit(quantity === 'Q' ? 'Q' : 'level', value),
      });
    }
  };

  for (const r of records) {
    const ts = instant(r.timestamp);
    // The slots that can still load: W, and Q where it is a twin.
    if (!info.q) count('q_not_twin');
    const slots = info.q ? 2 : 1;
    if (ts % GRID_MS !== 0) count('off_grid', slots);
    else if (ts < lo || ts >= hi) count('outside_backfill', slots);
    else if (isFuture(ts, ctx.fetchedAt)) count('future', slots);
    else if (
      typeof r.pegelhoehe === 'number' &&
      typeof r.pegel === 'number' &&
      Math.abs(r.pegel * 100 - PEGELHOEHE_ZERO_CM - r.pegelhoehe) > TOLERANCE_CM
    )
      count('inconsistent', slots);
    else {
      one(w, r.pegel, 'H', ts);
      if (info.q) one(q, r.abfluss, 'Q', ts);
    }
  }
  return out;
}
