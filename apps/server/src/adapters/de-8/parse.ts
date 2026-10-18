import { parseInstant, SchemaDrift, scanCsv, type TimeConvention, TimeError } from '@rws/core';

// DE-8 opengeodata.nrw.de (DL-DE Zero; catalogue §2.3), two station files of the DE-7 gauges:
//  - `de-8-stations`: hygon `OpenHygon-Pegel-Stationen_EPSG4326.txt`, UTF-8, CRLF, `;`, WGS84 lat/lon,
//    254 stations (2026-09-29). It has no gauge zero.
//  - `de-8-hydro`: hydro `Hydrologische-Stationen-NRW_EPSG25832_CSV.zip`, one member, ISO-8859-1, LF, `;`,
//    281 stations (member dated 2024-06-12) with `Nullpunkt` (the gauge zero, PNP, in m on DHHN2016: Stah
//    29.938) and `Betreiber` (the operator). Its coordinates are EPSG:25832 and are not read (the hygon file
//    has WGS84). The loader inflates the ZIP under the §6.7 guard and passes the member's bytes.
// Strict: the headers are pinned, numbers are checked; provider strings (names, operators) are data.

export const STATIONS_HEADER =
  'station_latitude;station_longitude;station_name;station_no;catchment_no;catchment_name;LANUV_Info_1;LANUV_Info_2;LANUV_Info_3;LANUV_MNW;LANUV_MW;LANUV_MHW;station_carteasting;station_cartnorthing;CATCHMENT_SIZE;DIST_TO_CONFL';
export const HYDRO_MEMBER = 'Hydrologische-Stationen-NRW_EPSG25832.csv';
export const HYDRO_HEADER =
  'station_name;station_id;Meldepegel;Datenpfleger;Mittelwert;Zweck;Betreiber;KOORDX;KOORDYY;UTMZone;Errichtung;GewS;EZG;Nullpunkt;Kommune;Kreis;Name';

/** 254 and 281 rows today. */
export const MAX_ROWS = 2_000;

const STATION = /^\d{6,13}$/;
const COORD = /^-?\d{1,3}\.\d{1,16}$/;
/** m on DHHN2016, up to four decimals (29.938; 340.587). */
const ZERO = /^-?\d{1,4}(?:\.\d{1,4})?$/;
/**
 * A plausible NRW gauge zero in m NHN; a value outside it is drift of the payload, because the first zero stored
 * for a series is never overwritten by another payload (load/store.ts). The file of 2024-06-12 spans 0 … 546.221 m
 * (six stations at 0, none of them a DE-7 gauge), plus one `9999.9` (Rehringhausen, not a DE-7 gauge): that is
 * the file's missing marker and reads as no zero, like `NA` and an empty cell.
 */
export const ZERO_RANGE_M = { min: -10, max: 1000 } as const;
const MISSING: ReadonlySet<string> = new Set(['', 'NA', '9999.9']);
const MAX_TEXT = 200;

export type Station = { no: string; name: string; lat: number; lon: number };
export type HydroRow = { id: string; name: string; operator: string; zero: number | null };

const header = (h: string[], want: string) => {
  if (h.join(';') !== want) throw new SchemaDrift('csv_header');
};
const text = (s: string, at: string) => {
  if (s.length > MAX_TEXT) throw new SchemaDrift('text', at);
  return s;
};

export function parseStations(body: Uint8Array): Station[] {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  const { header: h, rows } = scanCsv(decoded.replace(/^﻿/, ''), {
    delimiter: ';',
    maxRows: MAX_ROWS,
    extraField: false,
  });
  header(h, STATIONS_HEADER);
  return rows.map((r, i) => {
    const at = `rows.${i}`;
    const [lat, lon, name, no] = r as [string, string, string, string];
    if (!STATION.test(no)) throw new SchemaDrift('station_no', at);
    if (!COORD.test(lat) || !COORD.test(lon)) throw new SchemaDrift('position', at);
    return { no, name: text(name, at), lat: Number(lat), lon: Number(lon) };
  });
}

/** The hydro member's bytes, ISO-8859-1 (Node's `latin1` is ISO-8859-1, every byte is a character). */
export function parseHydro(member: Uint8Array): HydroRow[] {
  const decoded = Buffer.from(member.buffer, member.byteOffset, member.byteLength).toString('latin1');
  const { header: h, rows } = scanCsv(decoded, { delimiter: ';', maxRows: MAX_ROWS, extraField: false });
  header(h, HYDRO_HEADER);
  const out: HydroRow[] = [];
  rows.forEach((r, i) => {
    const at = `rows.${i}`;
    const [name, id] = r as [string, string];
    // A catchment without a station is a row of `NA` with the catchment's name last (Emscher, 2024-06-12).
    if (id === 'NA') return;
    if (!STATION.test(id)) throw new SchemaDrift('station_no', at);
    const zero = r[13] as string;
    const value = MISSING.has(zero) ? null : Number(zero);
    if (value !== null && (!ZERO.test(zero) || value < ZERO_RANGE_M.min || value > ZERO_RANGE_M.max)) {
      throw new SchemaDrift('bad_value', at);
    }
    out.push({ id, name: text(name, at), operator: text(r[6] as string, at), zero: value });
  });
  return out;
}

// ---------------------------------------------------------------- P14b: the decade ZIPs of hydro/w (backfill)
//
// `<Catchment>-NRW-W_<decade>-<decade+9>_EPSG25832_CSV.zip` (opengeodata.nrw.de, DL-DE Zero; catalogue §2.3): one
// member per station, UTF-8, LF, `;`, no BOM (Rur 2020-2029: 27 members, 292 MB inflated; IBV 1950-1959: 5):
//
//   station_name;station_no;dateTime;value[cm]
//   Stah;2829100000100;2020-01-01T00:00:00+01:00;106
//
// The stamps are a fixed +01:00 all year, sorted, with no duplicate, and a change-driven logger writes them in the
// 1950s (gaps up to a day) and a 15-minute grid in the 2020s. `NA` is a gap. A member is far too large to hold as
// text, so parsing is a pure line sink like DE-7's: the loader inflates under the ZIP guard (load/wire/de-8-backfill.ts)
// and feeds it the lines. Every failure is a SchemaDrift with a fixed code and the line number, never provider text.

/** The convention of the decade files (A§7.4): ISO 8601 at a fixed +01:00 all year, any other offset is drift. */
export const TIME: TimeConvention = { kind: 'fixed-offset', offset: '+01:00' };

export const BACKFILL_HEADER = 'station_name;station_no;dateTime;value[cm]';
/** `<station_no>_<name>_<from>-<to>_Wasserstand_cm.csv`: the names of the 32 recorded W members (Q members end `_Abfluss_m3s.csv`). */
export const MEMBER_RE = /^(\d{13})_[^/\\]{1,80}_(\d{4})-(\d{4})_Wasserstand_cm\.csv$/;
/**
 * The caps of this spec above the §6.7 defaults (the same numbers as `caps` of registry/backfill.yaml, which a test holds
 * equal): Rur 2020-2029 has 27 members and 292,475,414 inflated bytes (the default total is 200 MiB), and a member
 * holds at most 221,283 lines (Stah), a tenth of the row cap.
 */
export const BACKFILL_ZIP = { members: 200, total: 640 * 1024 * 1024 } as const;
export const BACKFILL_MAX_ROWS = 2_000_000;
/** A line is about 50 bytes; lineSplitter's cap (load/wire/de-8-backfill.ts). */
export const BACKFILL_MAX_LINE = 1024;

const BF_STATION = /^\d{13}$/;
const BF_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+01:00$/;
const BF_VALUE = /^-?\d{1,5}(?:\.\d{1,6})?$/;

/** One member's rows as columns, strictly increasing in time; `value` is NaN for `NA`. */
export type Held = { ts: number[]; value: number[] };

export type BackfillSink = {
  line: (text: string) => void;
  /** The rows kept (empty for a counting sink) and the data rows seen. */
  end: () => Held & { rows: number };
};

/**
 * A strict reader of one member's lines. `station` is the 13 digits of the member's name, which every row must repeat.
 * `keep: false` (a station nobody selects) checks the header and counts the rows, nothing more: those members are
 * most of a decade file (26 of 27 in Rur 2020-2029) and a row of one is never stored.
 */
export function backfillSink(station: string, { keep }: { keep: boolean }): BackfillSink {
  const out: Held = { ts: [], value: [] };
  let rows = 0;
  let n = 0;
  let header = false;
  let last = Number.NEGATIVE_INFINITY;
  const drift = (code: string): never => {
    throw new SchemaDrift(code, `line.${n}`);
  };
  return {
    line(text: string) {
      n += 1;
      if (text.length > BACKFILL_MAX_LINE) drift('line_length');
      if (!header) {
        if (text !== BACKFILL_HEADER) drift('csv_header');
        header = true;
        return;
      }
      if (rows >= BACKFILL_MAX_ROWS) drift('csv_rows');
      rows += 1;
      if (!keep) return;
      const cells = text.split(';');
      if (cells.length !== 4) drift('csv_width');
      const [, no, at, v] = cells as [string, string, string, string];
      if (!BF_STATION.test(no) || no !== station) drift('station_no');
      if (!BF_TIME.test(at)) drift('time_bad_format');
      if (v !== 'NA' && !BF_VALUE.test(v)) drift('bad_value');
      let ms: number;
      try {
        ms = parseInstant(TIME, at);
      } catch (err) {
        if (err instanceof TimeError) return drift(`time_${err.code}`);
        throw err;
      }
      if (ms <= last) drift('time_order');
      last = ms;
      out.ts.push(ms);
      out.value.push(v === 'NA' ? Number.NaN : Number(v));
    },
    end() {
      if (!header) throw new SchemaDrift('csv_empty');
      return { ...out, rows };
    },
  };
}

/** The 13 digits of a member's name, or null for a name that is not a W member. */
export const memberStation = (name: string): string | null => MEMBER_RE.exec(name)?.[1] ?? null;
