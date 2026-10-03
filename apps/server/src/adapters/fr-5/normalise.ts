import { createHash } from 'node:crypto';
import {
  emptyNormalised,
  isFuture,
  levelOf,
  type Normalised,
  parseInstant,
  type ReferenceRow,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
  type WarningRow,
} from '@rws/core';
import type { Floods, Links, Vigilance } from './parse.ts';

// FR-5 Vigicrues → canonical rows (catalogue §2.5). Declared here, never inferred per row:
//  - vigilance: one warning area per river section (`CdEntCru`, type 8), level 1 vert … 4 rouge (`NivInfViCr`,
//    crosswalk FR-5 `section`). A snapshot: the map states every section, at `DtHrInfoVigiCru` (an ISO instant with
//    offset) or, for a capture that has none (the 2023 Wayback body was cut before it), at the fetch time. Only
//    the sections of our table (registry/vigicrues-sections.yaml) are kept: the loader hands their codes in, and
//    the rest of France is `out_of_scope`. The geometry is the feature's own WGS84 GeoJSON, as published. A
//    section's level reaches its stations through that table (P7b), not here;
//  - station.json: the historical floods (`CruesHistoriques`) of a station, as references of its FR-1 primary
//    stage series, `CRUE_<8 hex of sha256(LbUsuel)>`, ValHauteur m × 100 → cm, historical (never classifies);
//  - TronEntVigiCru and the territory documents store nothing: they feed the daily drift report of the table.

export const SOURCE = 'FR-5';
export const TIME: TimeConvention = { kind: 'iso-offset' };

export type VigilanceContext = {
  fetchedAt: number;
  /** The section codes of registry/vigicrues-sections.yaml. */
  sections: ReadonlySet<string>;
};

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

export function normaliseVigilance(v: Vigilance, ctx: VigilanceContext): Normalised {
  const out = emptyNormalised();
  const atMs = v.at === null ? ctx.fetchedAt : instant(v.at);
  // The map's own time is never ahead of the fetch (invariant 4); the fetch time is ours and always passes.
  if (isFuture(atMs, ctx.fetchedAt)) throw new SchemaDrift('future_time');
  const at = toIso(atMs);
  const copies = new Map<string, number>();
  for (const s of v.sections) copies.set(s.code, (copies.get(s.code) ?? 0) + 1);
  const rows: WarningRow[] = [];
  for (const s of v.sections) {
    if (!ctx.sections.has(s.code)) {
      count(out, 'out_of_scope');
      continue;
    }
    // One area, one row: a section the map lists twice is withheld (RETAINED, alerted), as a duplicate anywhere.
    if ((copies.get(s.code) ?? 0) > 1) {
      count(out, 'conflict');
      continue;
    }
    const level = levelOf(SOURCE, 'section', String(s.level));
    if (level === undefined) {
      count(out, 'unmapped_class');
      continue;
    }
    rows.push({
      area_key: s.code,
      name: s.name,
      geometry: s.geometry === null ? null : JSON.stringify(s.geometry),
      level,
      level_raw: String(s.level),
      label_raw: null,
      valid_from: at,
      valid_to: null,
      issued_at: null,
    });
  }
  out.warnings = { mode: 'snapshot', at, rows };
  return out;
}

/** `CRUE_` and the first 8 hex digits (upper case) of the SHA-256 of the flood's label as published. */
export const floodKind = (label: string): string =>
  `CRUE_${createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 8).toUpperCase()}`;

export function normaliseStation(f: Floods): Normalised {
  const out = emptyNormalised();
  out.references = [];
  out.refScope = [];
  // A document that does not state the list (absent or null) says nothing; [] states that there are none.
  if (f.floods === null) return out;
  const series = `${f.station}/H`;
  out.refScope.push({ target: 'FR-1', series });
  const copies = new Map<string, number>();
  for (const x of f.floods) copies.set(floodKind(x.label), (copies.get(floodKind(x.label)) ?? 0) + 1);
  for (const x of f.floods) {
    const kind = floodKind(x.label);
    if ((copies.get(kind) ?? 0) > 1) {
      // The same label twice: which height is meant is unknown, so neither is stored.
      count(out, 'conflict');
      continue;
    }
    if (x.heightM === null || x.heightM === 0) {
      count(out, 'no_value');
      continue;
    }
    const row: ReferenceRow = {
      series,
      target: 'FR-1',
      kind,
      value: scale(100, x.heightM),
      unit: 'cm',
      semantics: 'historical',
      convention: null,
      period: null,
      season_from_md: 101,
      season_to_md: 1231,
      priority: 0,
      basis_label: x.label,
      valid_from: null,
    };
    out.references.push(row);
  }
  return out;
}

// ---- the daily drift report of the section table ---------------------------------------------------------------------

/** Section code → its territory and the Vigicrues station codes the table has for it. */
export type SectionTable = ReadonlyMap<string, { territory: string; stations: readonly string[] }>;

export type Drift = {
  /** Section codes (territory document) or station codes (section document) the payload has and the table lacks. */
  unregistered: string[];
  /** The table's codes of that document that the payload no longer lists. */
  vanished: string[];
  changed: never[];
};

const LIMIT = 200;

/** A Tron or territory document against registry/vigicrues-sections.yaml. Our codes only, never a name. */
export function driftReport(links: Links, table: SectionTable): Drift {
  const listed = links.kind === 'section' ? links.stations : links.sections;
  const known =
    links.kind === 'section'
      ? (table.get(links.code)?.stations ?? [])
      : [...table].filter(([, s]) => s.territory === links.code).map(([section]) => section);
  const have = new Set(known);
  const got = new Set(listed);
  return {
    unregistered: [...got]
      .filter((c) => !have.has(c))
      .sort()
      .slice(0, LIMIT),
    vanished: [...have]
      .filter((c) => !got.has(c))
      .sort()
      .slice(0, LIMIT),
    changed: [],
  };
}

/** Tron and territory documents hold no rows: the parse is the check that the document is what we expect. */
export function normaliseLinks(_links: Links): Normalised {
  return emptyNormalised();
}
