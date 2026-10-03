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
import type { CapAlert, CapInfo } from './parse.ts';

// LU-5 LU-Alert CAP → warning rows (catalogue §2.6, §4.9). One payload is one message ('message' mode):
//  - only AGE's flood alerts: sender `[AGE]` and an eventCode FLOOD (the valueName is `LU-Alert` in 2025 and
//    `LU_Alert` since 2026); the other senders (ALVA food recalls, …) are dropped, never stored;
//  - a TEST is known by its `cb-eu-level` parameter (`TEST`) or a headline that starts with TEST, in any info
//    block, never by `<status>` alone: the real TEST of 2026-02-02 says `Actual`. It stores nothing, not even a
//    cancel; a message whose `<status>` is not `Actual` (Exercise, System, Test, Draft) is no real alert either
//    (`not_actual`, the same way);
//  - a warning area is the `areaDesc` as published ("Sud du Luxembourg", "Nord du Luxembourg", "Moselle"); its
//    three language blocks (fr-FR, de, en-US) share it, so one row per area carries the texts of all of them.
//    The level is the parameter `cb-eu-level` and is inverted: ALERT_LVL_1 is red (the crosswalk maps it); the
//    label is the French block's `…:name` parameter (else its headline); validity is the later of the block's
//    `effective` and the message's `sent` (an Update keeps the original's `effective`) to `expires`;
//  - the geometry is the area's CAP polygons ("lat,lon lat,lon …", closed) as GeoJSON [lon, lat]; a pair that is
//    not a coordinate, a ring under 4 points or a ring that is not closed is `bad_polygon` drift, never repaired;
//  - an Update and a Cancel name the messages they replace in `<references>` (`sender,identifier,sent` triples
//    separated by spaces): their identifiers are `cancels`; a Cancel has no info and so no rows;
//  - a `sent` more than 15 minutes after the fetch is dropped (`future`), invariant 4.

export const SOURCE = 'LU-5';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const SENDER = '[AGE]';
const SCALE = 'zone';
const MAX_REFERENCES = 50;
const BASE_LANGUAGE = 'fr-FR';

export type Context = { fetchedAt: number };

const instant = (raw: string): number => {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift('bad_time');
    throw err;
  }
};

/** The value of the profile parameter whose name ends `:<name>` (or is `<name>`). */
const param = (info: CapInfo, name: string) =>
  info.parameter.find((p) => p.valueName === name || p.valueName.endsWith(`:${name}`))?.value;

const isFlood = (info: CapInfo) => info.eventCode.some((c) => /^LU[-_]Alert$/.test(c.valueName) && c.value === 'FLOOD');
const isTest = (info: CapInfo) => param(info, 'cb-eu-level') === 'TEST' || (info.headline ?? '').startsWith('TEST');

const POINT = /^(-?\d{1,3}(?:\.\d{1,20})?),(-?\d{1,3}(?:\.\d{1,20})?)$/;

/** One CAP polygon ("lat,lon lat,lon …") as a GeoJSON ring of [lon, lat], closed as published. */
function ring(raw: string): [number, number][] {
  const out: [number, number][] = [];
  for (const pair of raw.trim().split(/\s+/)) {
    const m = POINT.exec(pair);
    const lat = Number(m?.[1]);
    const lon = Number(m?.[2]);
    if (m === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new SchemaDrift('bad_polygon');
    out.push([lon, lat]);
  }
  const [first, last] = [out[0], out.at(-1)];
  if (out.length < 4 || first === undefined || last === undefined || first[0] !== last[0] || first[1] !== last[1])
    throw new SchemaDrift('bad_polygon');
  return out;
}

function geometry(polygons: string[]): string | null {
  const rings = polygons.map(ring);
  if (rings.length === 0) return null;
  return JSON.stringify(
    rings.length === 1
      ? { type: 'Polygon', coordinates: rings }
      : { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) },
  );
}

/** The identifiers of a `<references>` text. */
function references(raw: string | undefined): string[] {
  const triples = (raw ?? '').trim().split(/\s+/).filter(Boolean);
  if (triples.length > MAX_REFERENCES) throw new SchemaDrift('references_too_many');
  const ids = triples.map((t) => {
    const parts = t.split(',');
    if (parts.length !== 3 || !parts[1]) throw new SchemaDrift('bad_references');
    return parts[1];
  });
  return [...new Set(ids)];
}

export function normalise(alert: CapAlert, ctx: Context): Normalised {
  const out = emptyNormalised();
  const sent = instant(alert.sent);
  const sentIso = toIso(sent);
  const empty = (code: string): Normalised => {
    out.dropped[code] = 1;
    out.warnings = { mode: 'message', sent: sentIso, rows: [], cancels: [] };
    return out;
  };
  if (alert.sender !== SENDER) return empty('other_sender');
  if (alert.info.length > 0 && !alert.info.every(isFlood)) return empty('not_flood');
  if (alert.info.some(isTest)) return empty('test');
  if (alert.status !== 'Actual') return empty('not_actual');
  if (isFuture(sent, ctx.fetchedAt)) return empty('future');

  const cancels = alert.msgType === 'Alert' ? [] : references(alert.references);
  const rows: WarningRow[] = [];
  if (alert.msgType !== 'Cancel') {
    // Per area, the blocks that state it: the French one is the base for the label, validity and geometry.
    const areas = new Map<string, CapInfo[]>();
    for (const info of alert.info)
      for (const a of info.area) areas.set(a.areaDesc, [...(areas.get(a.areaDesc) ?? []), info]);
    for (const [key, blocks] of areas) {
      const base = blocks.find((b) => b.language === BASE_LANGUAGE) ?? (blocks[0] as CapInfo);
      const raw = param(base, 'cb-eu-level') ?? null;
      const level = raw === null ? undefined : levelOf(SOURCE, SCALE, raw);
      const levelRaws = new Set(blocks.map((b) => param(b, 'cb-eu-level')));
      const languages = blocks.map((b) => b.language);
      if (levelRaws.size > 1 || new Set(languages).size < languages.length) {
        out.dropped.conflict = (out.dropped.conflict ?? 0) + 1;
        continue;
      }
      if (level === undefined) {
        out.dropped.unmapped_class = (out.dropped.unmapped_class ?? 0) + 1;
        continue;
      }
      const texts: NonNullable<WarningRow['texts']> = {};
      for (const b of blocks) {
        const t: Record<string, string> = {};
        if (b.headline !== undefined) t.headline = b.headline;
        if (b.description !== undefined) t.description = b.description;
        if (b.instruction !== undefined) t.instruction = b.instruction;
        texts[b.language] = t;
      }
      rows.push({
        area_key: key,
        name: key,
        geometry: geometry(base.area.filter((a) => a.areaDesc === key).flatMap((a) => a.polygon)),
        level,
        level_raw: raw,
        label_raw: param(base, 'name') ?? base.headline ?? null,
        texts,
        // Never before the message itself: an Update keeps the original alert's `effective`, and its level holds only
        // from when it was sent (the original's row holds until then).
        valid_from: toIso(base.effective === undefined ? sent : Math.max(sent, instant(base.effective))),
        valid_to: base.expires === undefined ? null : toIso(instant(base.expires)),
        issued_at: sentIso,
        ref: alert.identifier,
      });
    }
  }
  out.warnings = { mode: 'message', sent: sentIso, rows, cancels };
  return out;
}
