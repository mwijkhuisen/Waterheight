import {
  emptyNormalised,
  isFuture,
  levelOf,
  type Normalised,
  parseInstant,
  SchemaDrift,
  type TimeConvention,
  TimeError,
  toIso,
  type WarningRow,
} from '@rws/core';
import type { Collected, Geometry } from './parse.ts';

// CH-5 BAFU flood-danger sections → canonical warning areas (catalogue §2.7). Declared here, never inferred:
//  - one area per feature, `<kind>:<key>` (river, lake or hydro_region; unique per payload), name = `label`,
//    `label_raw` = `hydro_body`, `level_raw` = the integer as text, level = crosswalk CH-5 `section` (0 "Keine
//    Gefahrenstufe" is no_ref: null);
//  - a snapshot at `meta.produced_at` (ISO 8601 with the provider's true local offset); the area is valid from
//    its `valid_from` until `valid_until`, both with their offset;
//  - the geometry is converted from LV95 (EPSG:2056) to WGS84 [lon, lat], rounded to 6 decimals, so every stored
//    geometry is WGS84 like those of FR-5, DE-6 and LU-5;
//  - only the German payload is stored: the English one has the same sections (kinds, keys, levels, validity and
//    geometries; the label of a region and the water-body text are translated) and is parsed for drift only.

export const SOURCE = 'CH-5';
export const TIME: TimeConvention = { kind: 'iso-offset' };

export type Context = { fetchedAt: number; variant: string };

/**
 * LV95 (E, N metres) → WGS84 [lon, lat] degrees, with swisstopo's published approximate formulas, "Näherungslösungen
 * für die direkte Transformation CH1903/LV95 → WGS84" (swisstopo, Bundesamt für Landestopografie; the "Approximate
 * solutions for the direct transformation" formulas of its reference-frames documentation): accurate to about 1 m
 * in longitude and 0.5 m in latitude inside Switzerland. With y' = (E − 2,600,000)/10^6 and
 * x' = (N − 1,200,000)/10^6, in units of 10,000":
 *   λ' = 2.6779094 + 4.728982 y' + 0.791484 y' x' + 0.1306 y' x'² − 0.0436 y'³
 *   φ' = 16.9023892 + 3.238272 x' − 0.270978 y'² − 0.002528 x'² − 0.0447 y'² x' − 0.0140 x'³
 * and λ = λ'·100/36, φ = φ'·100/36 degrees. The origin (2,600,000, 1,200,000), the old Bern observatory, is
 * 7.438637°E 46.951081°N.
 */
export function lv95ToWgs84(e: number, n: number): [lon: number, lat: number] {
  const y = (e - 2_600_000) / 1_000_000;
  const x = (n - 1_200_000) / 1_000_000;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  const round = (v: number) => Math.round(((v * 100) / 36) * 1e6) / 1e6;
  return [round(lon), round(lat)];
}

const convert = (g: Geometry): string =>
  JSON.stringify({
    type: g.type,
    coordinates:
      g.type === 'MultiLineString'
        ? g.coordinates.map((line) => line.map(([e, n]) => lv95ToWgs84(e, n)))
        : g.coordinates.map((polygon) => polygon.map((ring) => ring.map(([e, n]) => lv95ToWgs84(e, n)))),
  });

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift('bad_time');
    throw err;
  }
}

export function normaliseWarnings(doc: Collected, ctx: Context): Normalised {
  const out = emptyNormalised();
  if (ctx.variant === 'en') return out;
  if (ctx.variant !== 'de') throw new SchemaDrift('bad_variant');
  const at = instant(doc.producedAt);
  if (isFuture(at, ctx.fetchedAt)) throw new SchemaDrift('future_time');
  const copies = new Map<string, number>();
  const keyOf = (s: Collected['sections'][number]) => `${s.properties.kind}:${s.properties.key}`;
  for (const s of doc.sections) copies.set(keyOf(s), (copies.get(keyOf(s)) ?? 0) + 1);
  const rows: WarningRow[] = [];
  // An area the payload lists but whose row is withheld stays as stored (review CR-5).
  const kept = new Set<string>();
  for (const s of doc.sections) {
    const p = s.properties;
    if ((copies.get(keyOf(s)) ?? 0) > 1) {
      // One area, one row: a key the payload states twice is withheld (RETAINED, alerted).
      count(out, 'conflict');
      kept.add(keyOf(s));
      continue;
    }
    const level = levelOf(SOURCE, 'section', String(p.level));
    if (level === undefined) {
      count(out, 'unmapped_class');
      kept.add(keyOf(s));
      continue;
    }
    rows.push({
      area_key: keyOf(s),
      name: p.label,
      geometry: convert(s.geometry),
      level,
      level_raw: String(p.level),
      label_raw: p.hydro_body,
      valid_from: toIso(instant(p.valid_from)),
      valid_to: p.valid_until === null ? null : toIso(instant(p.valid_until)),
      issued_at: null,
    });
  }
  out.warnings = { mode: 'snapshot', at: toIso(at), rows, ...(kept.size > 0 ? { kept: [...kept] } : {}) };
  return out;
}
