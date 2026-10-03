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
//  - `wl_1..wl_4` are the lower bounds of BAFU danger levels 2–5 (P7a): references WL2..WL5 on the CH-1 PRIMARY
//    series of the same station (`target: 'CH-1'`): discharge (m³/s, l/s ÷ 1000) for a river, the level (m ü.M.
//    → cm) for a `masl` station, converted by the unit the value is published in (m³/s ×1, l/s ×0.001, m ü.M. ×100).
//    A unit that does not fit the target is `unit_mismatch`; a station with thresholds whose CH-1 series the
//    registry lacks is `no_target` (counted, review CR-7); every target series of a station in the payload is in
//    `refScope`. `threshold_customer` is not stored.

export const SOURCE = 'CH-2';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const MAX_AGE_MS = 45 * 86_400_000;

export type Context = {
  registry: Registry;
  fetchedAt: number;
  /** P7a: the registries of `SpecLoader.refTarget` (CH-1) by source. */
  refRegistries?: ReadonlyMap<string, Registry>;
};

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

type Unit = { native_unit: string; value_kind: 'stage' | 'level' | null };

/** A unit string → its number and unit, or null for a gap. Throws SchemaDrift on anything else. */
function split(raw: string): { n: number; unit: string; kind: Unit } | null {
  if (raw === '' || raw === '-') return null;
  const m = VALUE.exec(raw);
  if (m === null) throw new SchemaDrift('bad_value');
  return { n: Number(m[1]), unit: m[2] as string, kind: UNIT.get(m[2] as string) as Unit };
}

/** A unit string → the number, or null for a gap. Throws SchemaDrift on anything else. */
export function unitValue(raw: string, expect: Unit): number | null {
  const v = split(raw);
  if (v === null) return null;
  if (v.kind.native_unit !== expect.native_unit || v.kind.value_kind !== expect.value_kind) {
    throw new SchemaDrift('unit_mismatch');
  }
  return v.n;
}

/** A threshold's published unit → the factor to cm or m³/s (never the target series' own factor). */
const WL_FACTOR: ReadonlyMap<string, number> = new Map([
  ['m³/s', 1],
  ['l/s', 0.001],
  ['m ü.M.', 100],
]);

/** wl_1..wl_4 → WL2..WL5 (the lower bounds of BAFU danger levels 2–5). */
const WL = ['wl_1', 'wl_2', 'wl_3', 'wl_4'] as const;

function thresholds(p: Properties, ctx: Context, out: Normalised): void {
  const ch1 = ctx.refRegistries?.get('CH-1');
  if (ch1 === undefined) return;
  // A `masl` station states its thresholds as a level, the others as a discharge.
  const target = ch1.get(`${p.key}/${p.metric === 'masl' ? 'W' : 'Q'}`);
  if (target === undefined) {
    if (WL.some((name) => split(p[name] ?? '') !== null)) count(out, 'no_target');
    return;
  }
  out.refScope?.push({ target: 'CH-1', series: target.key });
  WL.forEach((name, i) => {
    const v = split(p[name] ?? '');
    if (v === null) return;
    const fits =
      target.quantity === 'Q'
        ? v.unit === 'm³/s' || v.unit === 'l/s'
        : target.value_kind === 'level' && v.unit === 'm ü.M.';
    if (!fits) {
      count(out, 'unit_mismatch');
      return;
    }
    const canonical = scale(WL_FACTOR.get(v.unit) as number, v.n);
    out.references?.push({
      series: target.key,
      target: 'CH-1',
      kind: `WL${i + 2}`,
      value: canonical,
      unit: target.quantity === 'Q' ? 'm³/s' : 'cm',
      semantics: 'operational',
      convention: null,
      period: null,
      season_from_md: 101,
      season_to_md: 1231,
      priority: 0,
      basis_label: `BAFU Gefahrenstufe ${i + 2}, untere Grenze`,
      valid_from: null,
    });
  });
}

export function normaliseFeatures(features: readonly Properties[], ctx: Context): Normalised {
  const out = emptyNormalised();
  out.references = [];
  out.refScope = [];
  const seen = new Set<string>();
  for (const p of [...features].sort((a, b) => Number(a.key) - Number(b.key))) {
    if (seen.has(p.key)) throw new SchemaDrift('duplicate_key');
    seen.add(p.key);
    thresholds(p, ctx, out);
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
  if (out.references?.length === 0) delete out.references;
  if (out.refScope?.length === 0) delete out.refScope;
  return out;
}
