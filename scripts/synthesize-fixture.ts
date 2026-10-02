// Synthetic fixtures for owner-audience specs (invariants 9 and 11). The repository is public, so a committed
// fixture of an owner source keeps the real structure and nothing else: every value is generated.
//
//   pnpm fixtures:synth --spec <owner spec id> [--keep <n>] [--force]
//     P1 form: reads the git-ignored .smoke/<spec>.raw (smoke-capture.ts) and writes
//     apps/server/src/adapters/<id>/fixtures/<spec>.synthetic.raw (an existing one only with --force).
//   pnpm fixtures:synth --from <export dir> --spec <spec id> [--variant <v>] [--pick latest|oldest]
//                       --name <suffix> [--keep <n>] [--force]
//     Export form: <export dir> (outside the repository; written by the owner's VPS script) is flat, one pair per
//     payload: <spec>-<n>.raw (the decoded body) and <spec>-<n>.line.json (its manifest line: source, spec, variant,
//     sha256, key, status, fetched_at). Picks the spec's payload by fetched_at.start, checks its sha256, and writes
//     <spec>-<suffix>.synthetic.raw and .synthetic.meta.json into the adapter's fixtures folder.
//
// Policy (deterministic, seeded; one table per source in VERBATIM):
//   kept     keys (names of letters only: any other key is refused), structure, array lengths up to --keep (a KiWIS
//            table: its header row of returnfield names plus --keep rows; a first row of anything else is no
//            header), booleans, nulls, the numbers -1 and 0, 9999.0 (number or string), KiWIS quality codes of SPW's
//            table, empty strings, and the identifiers and codes the registry itself publishes (VERBATIM, by key or
//            table column, each with its one format): a string or an integer under a kept key or column that is not
//            in its format is refused; an object or array under it is generated like any other;
//   shifted  every ISO timestamp by one constant whole number of days (1,000 to 2,000), offset suffix and fraction
//            format kept, so the time grid, the order and the offsets stay as they were;
//   random   every other number (magnitude, integer or decimal kept), the digits of a string that is a number with
//            at most a unit ("999.99 m NN"), and every other string becomes synthetic-<n>; in a text file every
//            comment line and the station line are generated whole, the first line with cells must be the `Datum`
//            header (kept), every data cell that is a number gets new digits (the `Datum` column new dates), and any
//            other non-empty cell is refused.
// Both forms end with the leak scan (P5c review SR-2): a leaf of the source outside the kept places, a string of at
// least four characters anywhere in the output outside them, or a number (or numeric string) of at least two
// significant digits other than -1, 0 and 9999 at its own place, is refused, and so are output bytes equal to the
// source's.
// It prints only paths and byte counts, never content.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { extractDataToJson } from '../apps/server/src/http/guards.ts';

const root = join(import.meta.dirname, '..');
const ADAPTERS = join(root, 'apps/server/src/adapters');

/** A refusal with its exit code: 64 is usage (or a source that is not owner audience), 1 anything the data forbids. */
export class Refusal extends Error {
  code: 1 | 64;
  constructor(code: 1 | 64, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The one format each kept value holds (P5c review R2-SR-3), measured on the owner export of 2026-10-02 (99
 * payloads): a string or an integer under a kept key or table column stays only when it matches, and any other
 * string or integer there is refused. Only ids, counts and the UTC offset take digits alone; a code takes digits
 * only where its real form has them (a `ts_path` station segment, `15m.Cmd.P`, `HQ100`, `h24`, `Lambert 72`).
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const COUNT = /^\d{1,7}$/;
const PARAMETER = /^[A-Za-z]{1,8}(?:_[A-Za-z]{1,8}){0,2}$/;
const UNIT = /^(?:m|cm|mm|m³\/s|m3\/s|cumec|l\/s)$/;
const COLUMNS = /^Timestamp,Value(?:,Quality Code)?$/;
const TS_PATH = /^\w{1,40}\/\w{1,40}\/\w{1,40}\/\d{0,2}[A-Za-z][\w-]{0,39}(?:\.[A-Za-z][\w-]{0,39}){0,6}$/;
/** An AGE page id or file name: letters, `-` and `/` (`Name-/-Name`), no digits. */
const AGE_NAME = /^\p{L}[\p{L}_/-]{0,99}$/u;

/** Identifiers and enumerations the registry itself publishes, by JSON key or KiWIS table column, with their format. */
export const VERBATIM: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'BE-3': {
    ts_id: /^\d{1,12}$/,
    station_no: ID,
    site_no: ID,
    stationparameter_no: PARAMETER,
    ts_unitsymbol: UNIT,
    ts_path: TS_PATH,
    ts_name: /^\d{1,2}[a-z]?-[A-Za-z]{1,20}(?: [a-z]{1,20})?(?:\.[A-Za-z]{1,20}){0,4}$/,
    ts_shortname: /^[A-Za-z]{1,20}(?:[.-][A-Za-z]{1,20}){0,6}$/,
    columns: COLUMNS,
    rows: COUNT,
    station_gauge_datum_unit: /^(?:[A-Z]{3}|---)$/,
    station_georefsystem: /^Lambert (?:72|2008)$/,
    station_timezone: /^\(UTC[+-]\d{2}:\d{2}\)(?: [A-Za-z]{1,20},?){1,8}$/,
    station_utcoffset: /^[+-]?(?:0|60|120)$/,
  },
  'LU-2': { ts_path: TS_PATH, ts_unitsymbol: UNIT, parametertype_name: PARAMETER, columns: COLUMNS, rows: COUNT },
  'LU-3': {},
  // Not `label`: AGE writes the vigilance level into it ("Cote de vigilance <colour> <n> cm"), a threshold value (P5c
  // review CR-1). Not `operator`, `serviceStatus` or `forecastsCalcul`: free text, which no parser needs as published
  // (R2-SR-3).
  'LU-4': {
    id: AGE_NAME,
    jsonFile: /^(?:\/[a-z]{1,40}){0,8}\/?\p{L}[\p{L}_-]{0,99}\.json$/u,
    forecastsLimit: /^h\d{1,3}$/,
    forecastsFileName: AGE_NAME,
    stationPath: /^https:\/\/[a-z.]{1,60}(?:\/[a-z]{1,40}){0,8}\.html$/,
    legend: /^HQ\d{1,4}$/,
  },
  'DE-2': {},
  'DE-3': {},
};

/** A KiWIS `Quality Code` cell keeps only a code of SPW's `getQualityCodes` (catalogue §2.4) or -1 "missing". */
const QUALITY_CODE = /^(?:-1|0|40|80|120|16[0-5]|200|205|210|253)$/;
/** A KiWIS table's header cell: a returnfield name, never a number, a time or a value (P5c review R2-SR-2). */
export const HEADER_CELL = /^[A-Za-z][A-Za-z0-9_ ]{0,63}$/;
/**
 * An object key: words of letters, `_` and `-` with single inner spaces, no digit (P5c review R2-SR-4); any other key
 * is refused unless it is in KEYS_ALLOWED (the empty name of one LU-4 `logosHeaderPath` entry).
 */
export const KEY = /^[A-Za-z_-]{1,64}(?: [A-Za-z_-]{1,64}){0,7}$/;
export const KEYS_ALLOWED: ReadonlySet<string> = new Set(['']);

const ISO = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
/** The units a number may carry in a generated string or text cell (`999.99 m NN.`, `99,99 km`); other words are not. */
const UNITS = String.raw`(?:cm|mm|m|km|km²|m NN|m NHN|m³/s|m3/s|l/s|%)\.?`;
const NUMBER_TEXT = new RegExp(String.raw`^[-+]?\d+(?:[.,]\d+)*(?: ${UNITS})?$`);
const KEPT_NUMBERS = new Set([-1, 0, 9999]);
const DAY_MS = 86_400_000;
/** A value with a unit ("999 cm", "9,9 m³/s"), not a code that holds digits ("15m.Cmd", "PT15M"): never kept. */
export const VALUE_WITH_UNIT =
  /(?<![\p{L}\d.,/_])\d+(?:[.,]\d+)?\s*(?:cm|mm|m|m³\/s|m3\/s|l\/s|%)(?![\p{L}\d]|\.[\p{L}\d])/iu;

type Ctx = { rnd: () => number; days: number; names: number; keep: number; verbatim: ReadonlyMap<string, RegExp> };

const seedOf = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest().readUInt32BE(0);

function newCtx(source: string, keep: number, body: Uint8Array): Ctx {
  // Values are seeded by the payload itself: the same input gives the same bytes, and two payloads of one shape
  // (the five percentile files of an LU-3 run) do not come out as the same document. The date shift is one constant
  // per source, so payloads that share their times (one run's five files, one hour's two layers) still share them.
  let seed = (20300101 ^ seedOf(body)) >>> 0;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const days = 1000 + (seedOf(`days:${source}`) % 1001);
  return { rnd, days, names: 0, keep, verbatim: new Map(Object.entries(VERBATIM[source] ?? {})) };
}

const significant = (n: number) =>
  String(Math.abs(n)).replace(/e.*$/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;

/**
 * The leak scan's key of the leaf at `path`, or null for one it does not compare. A string of at least four characters
 * is compared wherever it appears; a number (or a numeric string) of at least two significant digits other than the
 * kept -1, 0 and 9999 only at its own place, because a number drawn in the band of the original lands on another value
 * of the source by chance (in 9 of the 99 payloads of the first owner export), which is no leak.
 */
function leafKey(v: unknown, path: string): string | null {
  const t = typeof v === 'string' ? v.trim() : null;
  const n = typeof v === 'number' ? v : t !== null && NUMBER.test(t) ? Number(t) : null;
  if (n !== null) return KEPT_NUMBERS.has(n) || significant(n) < 2 ? null : `n${JSON.stringify(path)}${n}`;
  return t !== null && t.length >= 4 ? `s${t}` : null;
}

function fakeNumber(c: Ctx, n: number): number {
  if (KEPT_NUMBERS.has(n)) return n;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(n)));
  const draw = () => {
    const v = (0.1 + c.rnd() * 0.9) * mag * 10 * Math.sign(n);
    return Number.isInteger(n) ? Math.round(v) : Math.round(v * 1000) / 1000;
  };
  // Never the published value, even by chance (a small value has few draws): redraw, then step one unit away.
  for (let i = 0; i < 8; i += 1) {
    const v = draw();
    if (v !== n) return v;
  }
  return Number.isInteger(n) ? n + 1 : Math.round((n + 0.001) * 1000) / 1000;
}

/** The digits of a numeric text replaced, never giving back the text itself. */
function fakeDigits(c: Ctx, s: string): string {
  for (let i = 0; i < 8; i += 1) {
    const v = s.replace(/\d/g, () => String(Math.floor(c.rnd() * 10)));
    if (v !== s) return v;
  }
  return s.replace(/\d/, (d) => String((Number(d) + 1) % 10));
}

/** The date moves by the document's constant; the time of day and the offset suffix stay as written. */
function shiftTime(c: Ctx, s: string, m: RegExpExecArray): string {
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const iso = new Date(d.getTime() + c.days * DAY_MS).toISOString();
  if (iso.length !== 24) return fakeName(c); // beyond year 9999: no ISO form to keep
  return `${iso.slice(0, 10)}${s.slice(10)}`;
}

function fakeName(c: Ctx): string {
  c.names += 1;
  return `synthetic-${c.names}`;
}

function fakeString(c: Ctx, s: string): string {
  if (s === '') return s;
  const time = ISO.exec(s);
  if (time !== null) return shiftTime(c, s, time);
  if (NUMBER.test(s) && Number(s) === 9999) return s;
  if (NUMBER_TEXT.test(s)) return fakeDigits(c, s);
  return fakeName(c);
}

/** A coordinate (by its key or column): generated inside the basin (49.4–51.6 N, 2.5–6.5 E), never the real one. */
const COORDINATE = /(?:^|_)(lat|latitude|lon|longitude)$/i;
function fakeCoordinate(c: Ctx, key: string, v: unknown): unknown {
  const n = typeof v === 'number' ? v : typeof v === 'string' && NUMBER.test(v) ? Number(v) : null;
  if (n === null) return scramble(c, v);
  const lat = /lat/i.test(key);
  const out = Math.round(((lat ? 49.4 : 2.5) + c.rnd() * (lat ? 2.2 : 4)) * 1e6) / 1e6;
  const fake = out === n ? Math.round((out + 1e-6) * 1e6) / 1e6 : out;
  return typeof v === 'string' ? String(fake) : fake;
}

/** The format of a kept table column (a `Quality Code` column of any source too), or undefined. */
const columnFormat = (c: Ctx, col: unknown) =>
  typeof col !== 'string'
    ? undefined
    : col.trim().toLowerCase() === 'quality code'
      ? QUALITY_CODE
      : c.verbatim.get(col);

/**
 * Whether the value under a kept key or column (`format`) stays: a string or an integer in its one format (P5c review
 * R2-SR-3). Any other string or integer there is refused; an empty string, null, a decimal, an object or an array
 * is generated like any other value (P5c review SR-2).
 */
function keeps(format: RegExp | undefined, x: unknown): boolean {
  if (format === undefined || x === '' || !(typeof x === 'string' || Number.isInteger(x))) return false;
  if (format.test(String(x)) && !VALUE_WITH_UNIT.test(String(x))) return true;
  throw new Refusal(1, 'a kept key or column holds a value outside its format');
}

/** An object key as it is, or a refusal: a key is copied, so it may hold no digit and no other text (R2-SR-4). */
function checkedKey(k: string): string {
  if (KEY.test(k) || KEYS_ALLOWED.has(k)) return k;
  throw new Refusal(1, 'an object key is not a name of letters');
}

/**
 * A KiWIS table: a header row of returnfield names, then rows (the header is kept besides the --keep rows). An array
 * whose first row holds anything else (numbers, times, values) is no table and is generated whole (R2-SR-2).
 */
const isTable = (v: unknown[]): v is [string[], ...unknown[]] =>
  v.length > 1 &&
  Array.isArray(v[0]) &&
  v[0].length > 0 &&
  v[0].every((x) => typeof x === 'string' && HEADER_CELL.test(x));
/** A KiWIS getTimeseriesValues item (or an AGE JSON): `data` rows follow the comma list of `columns`. */
const dataColumns = (o: Record<string, unknown>) =>
  typeof o.columns === 'string' && Array.isArray(o.data) ? o.columns.split(',') : null;

/** Rows of cells: a cell of a kept column stays, the others are scrambled. */
const scrambleRows = (c: Ctx, rows: unknown[], cols: unknown[]) =>
  rows.map((r) =>
    Array.isArray(r)
      ? r.map((x, i) => {
          const col = cols[i];
          if (keeps(columnFormat(c, col), x)) return x;
          return typeof col === 'string' && COORDINATE.test(col) ? fakeCoordinate(c, col, x) : scramble(c, x);
        })
      : scramble(c, r),
  );

function scramble(c: Ctx, v: unknown): unknown {
  if (Array.isArray(v)) {
    if (isTable(v)) return [v[0], ...scrambleRows(c, v.slice(1, c.keep + 1), v[0])];
    return v.slice(0, c.keep).map((x) => scramble(c, x));
  }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cols = dataColumns(o);
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) => [
        checkedKey(k),
        keeps(c.verbatim.get(k), x)
          ? x
          : COORDINATE.test(k)
            ? fakeCoordinate(c, k, x)
            : cols !== null && k === 'data'
              ? scrambleRows(c, (x as unknown[]).slice(0, c.keep), cols)
              : scramble(c, x),
      ]),
    );
  }
  if (typeof v === 'number') return fakeNumber(c, v);
  if (typeof v === 'string') return fakeString(c, v);
  return v;
}

/** Every leaf the policy does not keep (kept keys and columns, a table's header of names, quality codes), by leafKey. */
function leaves(c: Ctx, v: unknown, path = '', acc = new Set<string>()): Set<string> {
  const rows = (rs: unknown[], cols: unknown[], at: string, from: number) => {
    for (const [n, r] of rs.entries()) {
      if (!Array.isArray(r)) leaves(c, r, `${at}/${n + from}`, acc);
      else
        for (const [i, x] of r.entries())
          if (!keeps(columnFormat(c, cols[i]), x)) leaves(c, x, `${at}/${n + from}/${i}`, acc);
    }
  };
  if (Array.isArray(v)) {
    if (isTable(v)) rows(v.slice(1), v[0], path, 1);
    else for (const [i, x] of v.entries()) leaves(c, x, `${path}/${i}`, acc);
  } else if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cols = dataColumns(o);
    for (const [k, x] of Object.entries(o)) {
      if (keeps(c.verbatim.get(k), x)) continue;
      if (cols !== null && k === 'data') rows(x as unknown[], cols, `${path}/data`, 0);
      else leaves(c, x, `${path}/${k}`, acc);
    }
  } else {
    const k = leafKey(v, path);
    if (k !== null) acc.add(k);
  }
  return acc;
}

/**
 * The header of a BfG text file (catalogue §2.2, DE-3: `Datum;5%;10%;…;95%`): the date column, then percentiles or
 * names. It is kept, and only as the first line that holds cells (P5c review R2-SR-5).
 */
const TEXT_HEADER = /^Datum(?:;(?:\d{1,2}%|[A-Z][A-Za-z]{0,31}))+$/;
/** A data cell that is a number, with at most an allowed unit after it (`1.234,5`, `1e3`, `12 cm`). */
const TEXT_NUMBER = new RegExp(String.raw`^\s*[-+]?\d+(?:[.,]\d+)*(?:e[-+]?\d+)?(?: ?${UNITS})?\s*$`, 'i');
const CR = (line: string) => (line.endsWith('\r') ? '\r' : '');

/** The cells of a text file's lines, by leafKey (the `Datum` header aside: it is kept by rule). */
function textLeaves(text: string): Set<string> {
  const acc = new Set<string>();
  for (const [l, line] of text.split('\n').entries())
    if (!TEXT_HEADER.test(line.replace(/\r$/, '')))
      for (const [i, cell] of line.split(';').entries()) {
        const k = leafKey(cell, `/${l}/${i}`);
        if (k !== null) acc.add(k);
      }
  return acc;
}

/**
 * Text files (BfG CSV; P5c review R2-SR-5): a comment line is generated whole; a line without cells (the station
 * line) is generated; the first line with cells must be the `Datum` header and is kept; in the data lines after it
 * every cell that is a number (with at most an allowed unit) gets new digits, the dates of the `Datum` column come
 * from a clock, an empty cell stays, and any other cell (a second header among them) is refused, never kept.
 */
function scrambleText(c: Ctx, text: string): string {
  let clock = Date.parse('2030-01-01T00:00:00Z');
  let header = false;
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#')) return `# ${fakeName(c)}${CR(line)}`;
      if (line.trim() === '') return line;
      if (!line.includes(';')) return `${fakeString(c, line.trim())}${CR(line)}`;
      if (!header) {
        if (!TEXT_HEADER.test(line.replace(/\r$/, '')))
          throw new Refusal(1, 'the first line of cells is not the Datum header');
        header = true;
        return line;
      }
      return line
        .split(';')
        .map((cell, i) => {
          if (i === 0 && /^\d{2}\.\d{2}\.\d{4}/.test(cell)) {
            clock += DAY_MS;
            const d = new Date(clock);
            return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} 00:00`;
          }
          if (TEXT_NUMBER.test(cell)) return fakeDigits(c, cell);
          if (cell.trim() === '') return cell;
          throw new Refusal(1, 'a text cell is neither a number, a date nor empty');
        })
        .join(';');
    })
    .join('\n');
}

/** The output of one format and its leak scan: whether a leaf key of the source is a leaf key of the output. */
function generate(c: Ctx, format: string, body: Uint8Array): { out: Buffer; leaked: boolean } {
  const scan = (src: Set<string>, fake: Set<string>) => [...fake].some((k) => src.has(k));
  switch (format) {
    case 'json': {
      const doc = JSON.parse(Buffer.from(body).toString('utf8'));
      const fake = scramble(c, doc);
      return { out: Buffer.from(JSON.stringify(fake)), leaked: scan(leaves(c, doc), leaves(c, fake)) };
    }
    case 'html-attr': {
      const doc = extractDataToJson(body);
      const fake = scramble(c, doc);
      const attr = JSON.stringify(fake).replace(/&/g, '&amp;').replace(/"/g, '&#34;');
      return {
        out: Buffer.from(
          `<!DOCTYPE html>\n<html lang="fr"><head><title>synthetic</title></head><body>\n<cmp-dashboard-station class="synthetic" data-to-json="${attr}"></cmp-dashboard-station>\n</body></html>\n`,
        ),
        leaked: scan(leaves(c, doc), leaves(c, fake)),
      };
    }
    case 'html': {
      // A fixed page and a count of links: nothing of the payload reaches it.
      const links = (
        Buffer.from(body)
          .toString('utf8')
          .match(/href="\.\/[^"]*\.csv"/g) ?? []
      ).map((_, i) => `<a href="./synthetic-${i}.csv">synthetic-${i}.csv</a>`);
      return {
        out: Buffer.from(
          `<!DOCTYPE html>\n<html><head><title>synthetic</title></head><body>\n${links.join('\n')}\n</body></html>\n`,
        ),
        leaked: false,
      };
    }
    case 'text': {
      const text = Buffer.from(body).toString('latin1');
      const fake = scrambleText(c, text);
      return { out: Buffer.from(fake), leaked: scan(textLeaves(text), textLeaves(fake)) };
    }
  }
  throw new Refusal(64, `format ${format} not supported`);
}

/**
 * The synthetic body of one payload, by the spec's validity format (json, html-attr, html or text): pure and
 * deterministic, so the same input gives the same bytes. Throws a `Refusal` with a fixed text, never the payload's.
 */
export function synthesize(
  source: string,
  format: string,
  body: Uint8Array,
  opts: { keep?: number | undefined } = {},
): Buffer {
  const c = newCtx(source, opts.keep ?? 40, body);
  let r: { out: Buffer; leaked: boolean };
  try {
    r = generate(c, format, body);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(1, `the payload does not read as ${format}`);
  }
  if (r.leaked) throw new Refusal(1, 'a value of the source reappears in the output outside the kept keys');
  if (sha256(r.out) === sha256(body))
    throw new Refusal(1, 'the synthetic bytes equal the source: nothing was generated');
  return r.out;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function ownerSpec(id: string) {
  const spec = loadRegistry().specs.find((s) => s.id === id);
  if (spec === undefined || spec.audience !== 'owner') throw new Refusal(64, 'give an owner-audience --spec');
  return spec;
}

/** Writes the pair (raw, meta) into <outRoot>/<source>/fixtures/; returns the two paths and their byte counts. */
function writePair(
  outRoot: string,
  source: string,
  base: string,
  raw: Uint8Array,
  meta: Record<string, unknown>,
  force: boolean,
) {
  const dir = join(outRoot, source.toLowerCase(), 'fixtures');
  const files = [
    { path: join(dir, `${base}.synthetic.raw`), data: raw },
    { path: join(dir, `${base}.synthetic.meta.json`), data: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`) },
  ];
  if (!force && files.some((f) => existsSync(f.path))) throw new Refusal(1, 'the output exists: --force overwrites it');
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(f.path, f.data);
  return files.map((f) => ({ path: f.path, bytes: f.data.length }));
}

/** The P1 form: .smoke/<spec>.raw to <spec>.synthetic.raw (an existing one only with --force). */
export function synthesizeSmoke(o: {
  spec: string;
  keep?: number | undefined;
  force?: boolean | undefined;
  smokeDir?: string;
  outRoot?: string;
}) {
  const spec = ownerSpec(o.spec);
  const file = join(o.smokeDir ?? join(root, '.smoke'), `${o.spec}.raw`);
  if (!existsSync(file)) throw new Refusal(1, 'there is no recorded payload of that spec in .smoke');
  const raw = readFileSync(file);
  const out = synthesize(spec.source, spec.validity.format, raw, { keep: o.keep });
  return writePair(
    o.outRoot ?? ADAPTERS,
    spec.source,
    o.spec,
    out,
    {
      spec: o.spec,
      source: spec.source,
      synthetic: true,
      derived_from: 'the structure of a live payload recorded 2026-09-29 (owner audience: not committed)',
      values: 'every value, name, id and timestamp generated (scripts/synthesize-fixture.ts)',
      status: 200,
    },
    o.force ?? false,
  );
}

type Line = {
  source: string;
  spec: string;
  variant: string | null | undefined;
  sha256: string;
  key: string;
  status: number;
  startMs: number;
  file: string;
};

/** One manifest line of the export, or null when it is not a line of `spec`; a line of `spec` that is malformed refuses. */
function readLine(file: string, text: string, spec: string): Line | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (j === null || typeof j !== 'object' || j.spec !== spec) return null;
  const start = (j.fetched_at as { start?: unknown } | null | undefined)?.start;
  const ok =
    typeof j.source === 'string' &&
    (j.variant === undefined || j.variant === null || typeof j.variant === 'string') &&
    typeof j.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(j.sha256) &&
    typeof j.key === 'string' &&
    Number.isInteger(j.status) &&
    typeof start === 'string' &&
    Number.isFinite(Date.parse(start));
  if (!ok) throw new Refusal(1, `a manifest line of ${spec} is malformed`);
  return { ...(j as Omit<Line, 'startMs' | 'file'>), startMs: Date.parse(start as string), file };
}

export type ExportOptions = {
  from: string;
  spec: string;
  variant?: string | undefined;
  pick?: 'latest' | 'oldest' | undefined;
  name: string;
  keep?: number | undefined;
  force?: boolean | undefined;
  outRoot?: string;
};

/** The export form: one archived payload of an owner spec to a synthetic fixture. */
export function synthesizeFromExport(o: ExportOptions) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(o.name)) throw new Refusal(64, '--name must be lowercase words joined by -');
  const spec = ownerSpec(o.spec);
  let names: string[];
  try {
    names = readdirSync(o.from).filter((f) => f.endsWith('.line.json'));
  } catch {
    throw new Refusal(64, '--from is not a readable directory');
  }
  const lines = names
    .flatMap((f) => readLine(f, readFileSync(join(o.from, f), 'utf8'), o.spec) ?? [])
    .filter((l) => (o.variant === undefined || l.variant === o.variant) && existsSync(join(o.from, rawName(l.file))));
  if (lines.length === 0) throw new Refusal(1, 'the export has no payload of that spec (and variant)');
  lines.sort((a, b) => a.startMs - b.startMs || (a.file < b.file ? -1 : 1));
  const line = (o.pick ?? 'latest') === 'latest' ? (lines.at(-1) as Line) : (lines[0] as Line);
  if (line.source !== spec.source) throw new Refusal(1, 'the manifest line names another source than the spec');
  const raw = readFileSync(join(o.from, rawName(line.file)));
  if (sha256(raw) !== line.sha256) throw new Refusal(1, 'the payload does not match the sha256 of its manifest line');
  const out = synthesize(spec.source, spec.validity.format, raw, { keep: o.keep });
  return writePair(
    o.outRoot ?? ADAPTERS,
    spec.source,
    `${o.spec}-${o.name}`,
    out,
    {
      spec: o.spec,
      source: spec.source,
      synthetic: true,
      derived_from: 'an archived payload (owner audience: not committed)',
      values:
        'every number, name and string generated, timestamps shifted by one constant whole number of days; keys, ' +
        'structure, identifiers, nulls, -1, 0, 9999.0 and quality codes kept (scripts/synthesize-fixture.ts)',
      status: line.status,
      variant: line.variant ?? undefined,
      archive_key: line.key,
      source_sha256: line.sha256,
    },
    o.force ?? false,
  );
}

const rawName = (lineFile: string) => lineFile.replace(/\.line\.json$/, '.raw');

function main(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      spec: { type: 'string' },
      keep: { type: 'string' },
      from: { type: 'string' },
      variant: { type: 'string' },
      pick: { type: 'string' },
      name: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const keep = v.keep === undefined ? undefined : Number(v.keep);
  if (v.spec === undefined || (keep !== undefined && !(Number.isInteger(keep) && keep >= 1)))
    throw new Refusal(64, 'usage: --spec <id> [--keep <n>] [--force] | --from <dir> --spec <id> --name <suffix> [...]');
  if (v.pick !== undefined && v.pick !== 'latest' && v.pick !== 'oldest') throw new Refusal(64, '--pick latest|oldest');
  if (v.from === undefined) {
    if ([v.variant, v.pick, v.name].some((x) => x !== undefined)) throw new Refusal(64, 'those flags need --from');
    return synthesizeSmoke({ spec: v.spec, keep, force: v.force });
  }
  if (v.name === undefined) throw new Refusal(64, '--name <suffix> is required with --from');
  return synthesizeFromExport({
    from: v.from,
    spec: v.spec,
    variant: v.variant,
    pick: v.pick,
    name: v.name,
    keep,
    force: v.force,
  });
}

if (import.meta.main) {
  try {
    for (const f of main(process.argv.slice(2))) console.log(`${f.path} ${f.bytes} B`);
  } catch (e) {
    // A fixed text only: never the payload's content, never a stack.
    const usage = (e as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS');
    const refusal =
      e instanceof Refusal
        ? e
        : usage === true
          ? new Refusal(64, 'usage: see the header of scripts/synthesize-fixture.ts')
          : new Refusal(1, 'failed (no details are printed)');
    console.error(`synthesize-fixture: ${refusal.message}`);
    process.exit(refusal.code);
  }
}
