import { SchemaDrift, scanCsv } from '@rws/core';

// CH-1 BAFU LINDAS (catalogue §2.7): the SPARQL CSV of the fixed query in
// registry/capture.yaml (never built from data), one per cube (`river`,
// `lake`). The header must be the query's own variables; every field is
// checked against a strict pattern before it is used. Provider strings are
// data.

export const HEADER = ['id', 'name', 'water', 'time', 'q', 'w', 't', 'dl', 'wkt'] as const;

/** Rows of one cube: about 205 river and 34 lake observations; some stations come twice. */
export const MAX_ROWS = 2000;

/** `https://cube.link/Undefined`: the station has no danger levels (never level 0). */
export const UNDEFINED_LEVEL = 'https://cube.link/Undefined';

export type Observation = {
  id: string;
  time: string;
  /** Discharge, m³/s (the cube's shape: unit:M3-PER-SEC); null when the station has none. */
  q: number | null;
  /** Water level, m (LN02, or relative at a few small stations); null when the station has none. */
  w: number | null;
  /** BAFU danger level 1–5, null when undefined. Parsed for its shape only: classes are P7. */
  dangerLevel: number | null;
};

const ID = /^\d{1,6}$/;
const NUMBER = /^-?\d{1,7}(?:\.\d{1,9})?(?:[eE][+-]?\d{1,3})?$/;
const LEVEL = /^[1-5]$/;
const IRI = /^https:\/\/[^\s"<>]{1,500}$/;
const WKT = /^POINT\(-?\d{1,3}(?:\.\d{1,20})? -?\d{1,2}(?:\.\d{1,20})?\)$/;

function number(raw: string, at: string): number | null {
  if (raw === '') return null;
  if (!NUMBER.test(raw)) throw new SchemaDrift('bad_number', at);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new SchemaDrift('bad_number', at);
  return n;
}

export function parseCube(body: Uint8Array): Observation[] {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  const { header, rows } = scanCsv(text, { delimiter: ',', maxRows: MAX_ROWS, extraField: false });
  if (header.length !== HEADER.length || HEADER.some((h, i) => header[i] !== h)) throw new SchemaDrift('csv_header');
  return rows.map((r, i) => {
    const [id, name, water, time, q, w, t, dl, wkt] = r as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const at = `rows.${i}`;
    if (!ID.test(id)) throw new SchemaDrift('bad_id', at);
    if (name === '' || name.length > 200) throw new SchemaDrift('bad_name', at);
    if (water !== '' && !IRI.test(water)) throw new SchemaDrift('bad_water', at);
    if (wkt !== '' && !WKT.test(wkt)) throw new SchemaDrift('bad_wkt', at);
    number(t, `${at}.t`);
    if (dl !== '' && dl !== UNDEFINED_LEVEL && !LEVEL.test(dl)) throw new SchemaDrift('bad_danger_level', at);
    return {
      id,
      time,
      q: number(q, `${at}.q`),
      w: number(w, `${at}.w`),
      dangerLevel: LEVEL.test(dl) ? Number(dl) : null,
    };
  });
}
