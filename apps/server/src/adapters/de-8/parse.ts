import { SchemaDrift, scanCsv } from '@rws/core';

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
    if (zero !== '' && zero !== 'NA' && !ZERO.test(zero)) throw new SchemaDrift('bad_value', at);
    out.push({
      id,
      name: text(name, at),
      operator: text(r[6] as string, at),
      zero: zero === '' || zero === 'NA' ? null : Number(zero),
    });
  });
  return out;
}
