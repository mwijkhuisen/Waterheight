import { SchemaDrift, scanCsv } from '@rws/core';

// DE-3 BfG 14-day probabilistic forecast (catalogue §2.2; owner audience): one latin1 text file per gauge,
// `https://vorhersage.bafg.de/14-Tage-Vorhersage/<Station>_Quantile_<PEGELONLINE number>.csv`:
//
//   # Probabilistische Wasserstandsvorhersage vom <yyyy-mm-dd> GMT+1
//   # Quelle: Bundesanstalt fuer Gewaesserkunde <address>
//   # Vorhersagetage <d> - <dd> Tagesmittelwerte
//   # Keine Veroeffentlichung von Werten > <n> cm (Wert '---')
//   # !!!! Zeitstempel Beginn des Zeitschritts !!!!
//   <station name>
//   Datum;5%;10%;20%;25%;30%;40%;50%;60%;70%;75%;80%;90%;95%
//   dd.mm.yyyy 00:00;<13 integers in cm, or --->        (one row per day, CRLF line ends)
//
// Exactly those five comment lines in that order (the digits vary: the issue date, the forecast days, each
// station's publication limit), then the station name (provider text: never read, only length-capped), then the
// header, then the rows. The header's `GMT+1` must be the offset the adapter declares (normalise.ts `TIME`): another
// one is drift, never a silently shifted day. A cell is an integer (negative levels occur) or `---`, which BfG
// writes where the level is above the station's publication limit; it is read as `null`, never as 0. Parsing is
// strict and the CSV is bounded by the §6.7 caps of `scanCsv` (100,000 rows, 1,000 columns, 1 KB a field; here at
// most MAX_ROWS rows); a failure is a SchemaDrift with a fixed code, never provider text.

/** The comment lines, in order. The captured digits only vary; the fixed offset is part of the first line. */
const COMMENTS: readonly RegExp[] = [
  /^# Probabilistische Wasserstandsvorhersage vom \d{4}-\d{2}-\d{2} GMT\+1$/,
  /^# Quelle: Bundesanstalt fuer Gewaesserkunde <[^<>\s;]{1,64}>$/,
  /^# Vorhersagetage \d{1,2} - \d{1,3} Tagesmittelwerte$/,
  /^# Keine Veroeffentlichung von Werten > \d{1,5} cm \(Wert '---'\)$/,
  /^# !{4} Zeitstempel Beginn des Zeitschritts !{4}$/,
];

/** The percentile columns, left to right. */
export const LEVELS = [5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95] as const;

/** The 14 days of a file, with room for a longer one; the caps of `scanCsv` are far above (100,000 rows). */
export const MAX_ROWS = 100;
/** The station line is a name of a few words (`Duisburg-Ruhrort `). */
const MAX_STATION = 100;
const LABEL = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/;
/** Integer centimetres; the generated fixtures may carry leading zeros, a real file has none. */
const VALUE = /^-?\d{1,5}$/;
export const NOT_PUBLISHED = '---';

export type Row = {
  /** The `Datum` cell, `dd.mm.yyyy hh:mm`, local to the file's declared offset (read in normalise). */
  label: string;
  /** One cell per column of LEVELS: centimetres, or null where the file says `---`. */
  cells: (number | null)[];
};
export type Table = { rows: Row[] };

export function parseTable(body: Uint8Array): Table {
  // latin1 never fails: a byte outside ASCII can only be in the station line, which is never read.
  const text = new TextDecoder('latin1').decode(body);
  let rest = text;
  const line = (at: number): string => {
    const nl = rest.indexOf('\n');
    if (nl < 0) throw new SchemaDrift('truncated', `lines.${at}`);
    const l = rest.slice(0, nl).replace(/\r$/, '');
    rest = rest.slice(nl + 1);
    return l;
  };
  for (const [i, re] of COMMENTS.entries()) if (!re.test(line(i))) throw new SchemaDrift('comment_line', `lines.${i}`);
  const station = line(COMMENTS.length);
  if (station.startsWith('#') || station.trim() === '' || station.length > MAX_STATION || station.includes(';'))
    throw new SchemaDrift('station_line', `lines.${COMMENTS.length}`);
  const { header, rows } = scanCsv(rest.trimEnd(), { delimiter: ';', maxRows: MAX_ROWS, extraField: false });
  if (header[0] !== 'Datum' || header.length !== LEVELS.length + 1 || LEVELS.some((p, i) => header[i + 1] !== `${p}%`))
    throw new SchemaDrift('csv_header');
  return {
    rows: rows.map((r, i) => {
      const at = `rows.${i}`;
      const [label, ...cells] = r as [string, ...string[]];
      if (!LABEL.test(label)) throw new SchemaDrift('time_bad_format', at);
      return {
        label,
        cells: cells.map((c) => {
          if (c === NOT_PUBLISHED) return null;
          if (!VALUE.test(c)) throw new SchemaDrift('bad_value', at);
          // `-0` is 0.
          return Number(c) || 0;
        }),
      };
    }),
  };
}
