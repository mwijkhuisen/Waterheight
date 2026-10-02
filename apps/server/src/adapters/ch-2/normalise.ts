import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Properties } from './parse.ts';

// CH-2 hydrodaten → canonical rows of the CH-2 twin series (catalogue §2.7).
// CH-2 is never primary and nothing depends on it: if BAFU objects in C13, it
// moves to the owner audience (or stops) by one registry change. Declared here,
// never inferred per row:
//  - series: `<key>/W` and `<key>/Q`, the key being the CH-1 station id;
//  - values: `sensor_waterlevel_last_value` and `sensor_discharge_last_value`,
//    a number and its unit, parsed by one anchored, bounded pattern (no
//    backtracking): "462.48 m ü.M.", "0.16 m", "0.005 m³/s", "24 l/s". The
//    unit must be the one the registry declares for the series (`m ü.M.` a
//    level in m, `m` a relative stage in m, `m³/s` or `l/s`); any other unit
//    quarantines the payload (`unit_mismatch`), as does a value that is not a
//    plain decimal number. An empty value or "-" is a gap;
//  - time: ISO 8601 with the provider's true local offset;
//  - factor from the registry row (`l/s` ×0.001), qc "raw";
//  - `wl_1..wl_4` and `threshold_customer` are thresholds (P7), not read here.

export const SOURCE = 'CH-2';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const MAX_AGE_MS = 45 * 86_400_000;

export type Context = { registry: Registry; fetchedAt: number };

/** A decimal number, a space and one of the four units: nothing else, no exponent, sign or separator but a minus. */
const VALUE = /^(-?\d{1,9}(?:\.\d{1,9})?) (m³\/s|l\/s|m ü\.M\.|m)$/;

const UNIT: ReadonlyMap<string, { native_unit: string; value_kind: 'stage' | 'level' | null }> = new Map([
  ['m³/s', { native_unit: 'm³/s', value_kind: null }],
  ['l/s', { native_unit: 'l/s', value_kind: null }],
  ['m ü.M.', { native_unit: 'm', value_kind: 'level' }],
  ['m', { native_unit: 'm', value_kind: 'stage' }],
]);

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

/** A unit string → the number, or null for a gap. Throws SchemaDrift on anything else. */
export function unitValue(
  raw: string,
  expect: { native_unit: string; value_kind: 'stage' | 'level' | null },
): number | null {
  if (raw === '' || raw === '-') return null;
  const m = VALUE.exec(raw);
  if (m === null) throw new SchemaDrift('bad_value');
  const unit = UNIT.get(m[2] as string);
  if (unit === undefined || unit.native_unit !== expect.native_unit || unit.value_kind !== expect.value_kind) {
    throw new SchemaDrift('unit_mismatch');
  }
  return Number(m[1]);
}

export function normaliseFeatures(features: readonly Properties[], ctx: Context): Normalised {
  const out = emptyNormalised();
  const seen = new Set<string>();
  for (const p of [...features].sort((a, b) => Number(a.key) - Number(b.key))) {
    if (seen.has(p.key)) throw new SchemaDrift('duplicate_key');
    seen.add(p.key);
    for (const [quantity, raw, at] of [
      ['W', p.sensor_waterlevel_last_value, p.sensor_waterlevel_measured_at],
      ['Q', p.sensor_discharge_last_value, p.sensor_discharge_measured_at],
    ] as const) {
      if (raw === undefined || raw === null) continue;
      const decl = ctx.registry.get(`${p.key}/${quantity}`);
      if (decl === undefined) {
        out.unknown += 1;
        continue;
      }
      const value = unitValue(raw, { native_unit: decl.native_unit, value_kind: decl.value_kind });
      if (value === null || at === undefined) {
        count(out, 'gap');
        continue;
      }
      let ts: number;
      try {
        ts = parseInstant(TIME, at);
      } catch (err) {
        if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
        throw err;
      }
      if (isFuture(ts, ctx.fetchedAt)) count(out, 'future');
      else if (ts < ctx.fetchedAt - MAX_AGE_MS) count(out, 'too_old');
      else {
        const canonical = scale(decl.to_canonical, value);
        const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'level');
        out.obs.push({ series: decl.key, ts: toIso(ts), value: canonical, qc: QC.RAW | rangeBit(kind, canonical) });
      }
    }
  }
  return out;
}
