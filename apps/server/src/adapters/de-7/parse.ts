import { SchemaDrift } from '@rws/core';

// DE-7 LANUK NRW (catalogue §2.3): `messwerte.txt` in `messwerte.zip` (7 days) and `pegel_messwerte.txt`
// in `pegeldaten.zip` (2 months), the same format:
//
//   station_no;time;value(cm)
//   2847500000100;2026-09-22T14:45:00.000+01:00;36.80
//   2847500000100;                     <- every station block ends with its number and an empty field
//
// A member is far too large to hold as rows (pegel_messwerte.txt: 108 MB, about 2.13 million lines), so
// parsing is a pure line sink: the loader inflates the member under the ZIP guard of §6.7 and feeds it the
// lines (an adapter may not import the guards, load/adapters.ts does), and the sink keeps compact columns.
// Every line is checked strictly here; times stay text until normalise reads them under their declared
// convention. Failures are SchemaDrift with a fixed code and the line number, never provider text.

export const HEADER = 'station_no;time;value(cm)';

/** Lines per member, measured: messwerte.txt 238,931 (2026-09-29), pegel_messwerte.txt 2,127,026 (2026-09-23). */
export const MAX_ROWS = { 'messwerte.txt': 400_000, 'pegel_messwerte.txt': 3_000_000 } as const;
export type Member = keyof typeof MAX_ROWS;

/** The longest line is about 50 bytes. */
export const MAX_LINE = 128;

/** The station number: 13 digits for LANUK's own, shorter ones occur (`2768898001` and the placeholders). */
const STATION = /^\d{6,13}$/;
/** The time's shape; normalise reads it under the fixed +01:00 convention (any other offset is drift there). */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?[+-]\d{2}:\d{2}$/;
/** cm above the gauge zero, two decimals (−10.7 … 193.4 in the 2026-09-29 file); `NA` is the provider's gap. */
const VALUE = /^-?\d{1,5}(?:\.\d{1,3})?$/;

/** The rows of one member as columns: a row is (station index, time index, value; NaN = `NA`). */
export type Readings = {
  /** Station numbers in first-seen order. */
  stations: string[];
  /** Distinct time strings (a time is shared by every station of that step). */
  times: string[];
  station: number[];
  time: number[];
  value: number[];
  /** Block terminator lines (`<station_no>;`), skipped. */
  terminators: number;
};

export type LineSink = { line: (text: string) => void; end: () => Readings };

/**
 * A strict reader of one member's lines. `ascii`: the member is declared ASCII (messwerte.txt), so any other
 * character is drift; pegel_messwerte.txt is UTF-8 (the loader decodes it with a fatal decoder).
 */
export function lineSink(member: Member, { ascii }: { ascii: boolean }): LineSink {
  const max = MAX_ROWS[member];
  const out: Readings = { stations: [], times: [], station: [], time: [], value: [], terminators: 0 };
  const stationIx = new Map<string, number>();
  const timeIx = new Map<string, number>();
  let n = 0;
  let header = false;
  const drift = (code: string): never => {
    throw new SchemaDrift(code, `line.${n}`);
  };
  return {
    line(text: string) {
      n += 1;
      if (text.length > MAX_LINE) drift('line_length');
      if (ascii && /[\u0080-\uffff]/.test(text)) drift('encoding');
      if (!header) {
        if (text.replace(/^﻿/, '') !== HEADER) drift('csv_header');
        header = true;
        return;
      }
      const cells = text.split(';');
      if (cells.length === 2 && cells[1] === '') {
        if (!STATION.test(cells[0] as string)) drift('station_no');
        out.terminators += 1;
        return;
      }
      if (cells.length !== 3) drift('csv_width');
      const [no, ts, v] = cells as [string, string, string];
      if (!STATION.test(no)) drift('station_no');
      if (!TIME.test(ts)) drift('time_bad_format');
      if (v !== 'NA' && !VALUE.test(v)) drift('bad_value');
      if (out.station.length >= max) drift('csv_rows');
      let s = stationIx.get(no);
      if (s === undefined) {
        s = out.stations.push(no) - 1;
        stationIx.set(no, s);
      }
      let t = timeIx.get(ts);
      if (t === undefined) {
        t = out.times.push(ts) - 1;
        timeIx.set(ts, t);
      }
      out.station.push(s);
      out.time.push(t);
      out.value.push(v === 'NA' ? Number.NaN : Number(v));
    },
    end() {
      if (!header) throw new SchemaDrift('csv_empty');
      return out;
    },
  };
}

/** A whole decoded member at once (tests and fixtures; the loader streams). `\r\n` or `\n` line ends. */
export function parseText(text: string, member: Member, opts: { ascii: boolean }): Readings {
  const sink = lineSink(member, opts);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const l of lines) sink.line(l.replace(/\r$/, ''));
  return sink.end();
}
