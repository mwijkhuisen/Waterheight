// Turns payloads the owner exported from the production raw archive (Action D2;
// the read-only export command is in the P5a PR) into adapter fixtures:
//
//   node scripts/import-fixtures.ts [--p5b|--p7a|--p8a|--p8b] <export dir>
//
// (`--p5b`: the P5b export and its rules, `IMPORTS_P5B`; `--p7a`: `IMPORTS_P7A`; `--p8a`: the NL-1 forecast captures
// of `IMPORTS_P8A`, whole bodies; `--p8b`: the CH-4 and FR-4 forecasts of `IMPORTS_P8B`, whole bodies; without a
// flag the P5a list.)
//
// The export holds `<name>.raw` (the archived body) and `<name>.line.json` (its
// manifest line). Each payload listed below is copied to
// apps/server/src/adapters/<source>/fixtures/<fixture>.raw with a .meta.json
// that records where it came from: the archive key, the manifest's fetch time,
// status and request URL (secret parameters are already redacted in the
// manifest; FR and CH send none), and the sha256 of the exported body. A body
// is trimmed only by the rules written here (`TRIM`), never by hand: an FR-1
// page keeps its first or its last n rows of `data` (results come newest first,
// so the last rows of a page are the ones next to its following page), an FR-3
// series and each trace of a CH-3 plot keep their last n points (the newest);
// every other field stays as archived. Public sources only: an owner-audience payload never
// becomes a fixture (invariant 11).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');

type Doc = Record<string, unknown>;
type Import = {
  name: string;
  source: 'FR-1' | 'FR-3' | 'CH-1' | 'CH-3' | 'NL-1';
  fixture: string;
  keep?: number;
  /** FR-1 only: keep the last n rows instead of the first. */
  last?: true;
};

/** The trim rule of each source: cuts the document to `n` in place and says what it kept. */
export const TRIM: Readonly<Record<Import['source'], (doc: Doc, n: number, last: boolean) => string>> = {
  'FR-1': (doc, n, last) => {
    doc.data = last ? (doc.data as unknown[]).slice(-n) : (doc.data as unknown[]).slice(0, n);
    return `${last ? 'last' : 'first'} ${n} rows of data`;
  },
  'FR-3': (doc, n) => {
    const serie = doc.Serie as Doc;
    serie.ObssHydro = (serie.ObssHydro as unknown[]).slice(-n);
    return `last ${n} points of Serie.ObssHydro`;
  },
  'CH-1': () => {
    throw new Error('CH-1 bodies are imported whole');
  },
  'NL-1': () => {
    throw new Error('NL-1 bodies are imported whole');
  },
  'CH-3': (doc, n) => {
    for (const trace of (doc.plot as Doc).data as Doc[]) {
      trace.x = (trace.x as unknown[]).slice(-n);
      trace.y = (trace.y as unknown[]).slice(-n);
    }
    return `last ${n} points of every trace`;
  },
};

// ---------------------------------------------------------------- P5b: the text and ZIP rules (scripts/trim-fixtures.ts
// uses them too)

/**
 * LU-1 rows kept: a tier-1 gauge, the Perl twin, a row with gaps, Esch-Sûre (m, a value after the last label). No
 * withheld row (review L3 of P5b): the RLP gauges' values stay out of the trims, and the `off` path is tested on a
 * synthetic row; the P1a recording `lu-1-csv.raw` holds them as recorded, the only fixture that does.
 */
export const LU1_ROWS: readonly string[] = ['Diekirch', 'Perl', 'SN_Remich', 'Bissen', 'Esch-Sure'];
export const LU1_LABELS = 96;
/** DE-7 blocks kept: Stah (15 min), Goch, Gronau, a 5-minute station, the placeholder block, the 10-digit number. */
export const DE7_BLOCKS: readonly string[] = [
  '2829100000100',
  '2869500000200',
  '9286455000200',
  '2847500000100',
  '1234512345',
  '2768898001',
];
/** The pegeldaten.zip seed holds two months: Stah and the placeholder block only. */
export const DE7_SEED_BLOCKS: readonly string[] = ['2829100000100', '1234512345'];
/** LU-6 features kept, by the AGE number of their fiche: both Kautenbach (14, 104), both Niederfeulen (27, 77), Wasserbillig, Gemünd, Esch-Sûre. */
export const LU6_CODES: readonly string[] = ['14', '104', '27', '77', '0029151', '2626030300', '40', '11'];

/** Splits a text body into lines and its line end (CRLF or LF), keeping both. */
export function lines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const all = text.split(eol);
  if (all.at(-1) === '') all.pop();
  return { lines: all, eol };
}
export const join_ = (l: readonly string[], eol: string) => `${l.join(eol)}${eol}`;

export type ZipEntry = { name: string; time: number; date: number; data: Buffer };

/** The members of one of our own recorded ZIPs (no zip64, deflate or stored): read, never trusted beyond that. */
export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    if (data.length !== size) throw new Error(`${name}: size`);
    out.push({ name, time, date, data });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** A ZIP of the given members, deflated, with their recorded names and DOS times: the same input, the same bytes. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const deflated = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(e.time, 10);
    head.writeUInt16LE(e.date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(head, name, deflated);
    central.push(cd, name);
    offset += head.length + name.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

/** A DE-7 member with only the whole blocks of `keep` (their data lines and terminator lines), in recorded order. */
export function de7Blocks(text: string, keep: readonly string[]): string {
  const { lines: all, eol } = lines(text);
  return join_([all[0] as string, ...all.slice(1).filter((l) => keep.includes(l.split(';')[0] as string))], eol);
}

/** An LU-1 CSV with only the rows named in `names` and the last `n` labels, every row's trailing field kept. */
export function lu1Cut(text: string, names: readonly string[] | null, n: number): string {
  const { lines: all, eol } = lines(text);
  const fields = (l: string) => l.split('","');
  const header = fields(all[0] as string);
  const labels = header.length - 3;
  const pick = (f: string[], extra: boolean) => {
    const head = f.slice(0, 3);
    const cells = f.slice(3 + labels - n, 3 + labels);
    return [...head, ...cells, ...(extra ? f.slice(3 + labels) : [])];
  };
  const head = pick(header, false).join('","');
  const rows = all.slice(1).filter((l) => names?.includes(l.slice(1, l.indexOf('"', 1))));
  return join_([head, ...rows.map((l) => pick(fields(l), true).join('","'))], eol);
}

/** The exported payloads that P5a uses, and the fixture each becomes. */
export const IMPORTS: readonly Import[] = [
  // The first two pages of one FR-1 seed walk (both HTTP 206 with a `next`): the end of page 1 and the start of
  // page 2, which meet at 2026-09-01T08:30Z (page 1's cursor is its last row).
  { name: 'fr-1-page1', source: 'FR-1', fixture: 'fr-1-obs-page1', keep: 400, last: true },
  { name: 'fr-1-page2', source: 'FR-1', fixture: 'fr-1-obs-page2', keep: 400 },
  // The empty last page of a seed day walk (`count` is the walk's total, `data` empty, no `next`).
  { name: 'fr-1-empty', source: 'FR-1', fixture: 'fr-1-obs-empty' },
  // About two days of 5-minute values each (the whole series is ~72 days, 0.2–0.3 MB).
  { name: 'fr-3-uckange-q', source: 'FR-3', fixture: 'fr-3-obs-uckange-q', keep: 600 },
  { name: 'fr-3-lauterbourg-h', source: 'FR-3', fixture: 'fr-3-obs-lauterbourg-h', keep: 600 },
  // Strasbourg Q: a station Vigicrues lists without discharge (an empty series; it failed capture validity).
  { name: 'fr-3-invalid', source: 'FR-3', fixture: 'fr-3-obs-empty' },
  { name: 'ch-1-lake', source: 'CH-1', fixture: 'ch-1-lindas-lake' },
  // A river query that answered with the header alone (it failed capture validity).
  { name: 'ch-1-invalid', source: 'CH-1', fixture: 'ch-1-lindas-empty' },
  { name: 'ch-3-2289', source: 'CH-3', fixture: 'ch-3-40d-2289', keep: 600 },
  { name: 'ch-3-2473', source: 'CH-3', fixture: 'ch-3-40d-2473', keep: 600 },
];

type Line = {
  spec: string;
  variant: string;
  seed?: true;
  request: { url: string } | null;
  fetched_at: { start: string };
  status: number | null;
  key: string;
  sha256: string;
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The body as the fixture holds it, and the trim it took (false: the archived bytes unchanged). */
export function cut(
  source: Import['source'],
  raw: Buffer,
  keep?: number,
  last = false,
): { body: Buffer; trimmed: string | false } {
  if (keep === undefined) return { body: raw, trimmed: false };
  const doc = JSON.parse(raw.toString('utf8')) as Doc;
  const trimmed = TRIM[source](doc, keep, last);
  return { body: Buffer.from(JSON.stringify(doc)), trimmed };
}

/**
 * P5b (Action D2, export of 2026-10-02): the payloads P5b imports and the rule that cuts each. LU-1: the seed
 * (the first capture, 2026-09-30, in the 672-label format AGE serves since that day) with the rows of
 * `LU1_ROWS` and its last two days of labels; DE-1: the Perl W seed (31 days, 2,976 points) cut to its last 300
 * points, which overlap that LU-1 seed (the label-offset detector's fixture); DE-7: one production messwerte.zip
 * with the whole blocks of `DE7_BLOCKS`, and the pegeldaten.zip seed (two months) with those of
 * `DE7_SEED_BLOCKS` only (Stah and the placeholder: a readable golden), in every member (pegel_stationen.txt:
 * its rows of those stations), re-zipped.
 */
export const IMPORTS_P5B: readonly {
  name: string;
  source: 'DE-1' | 'DE-7' | 'LU-1';
  fixture: string;
  rule: 'lu1-rows' | 'de1-last' | 'de7-blocks' | 'de7-seed-blocks';
  n?: number;
}[] = [
  { name: 'lu-1-seed', source: 'LU-1', fixture: 'lu-1-csv-seed', rule: 'lu1-rows', n: 192 },
  { name: 'de-1-series-c263ea53-seed', source: 'DE-1', fixture: 'de-1-series-perl-w-seed', rule: 'de1-last', n: 300 },
  { name: 'de-7-messwerte-005000-1', source: 'DE-7', fixture: 'de-7-messwerte-archive', rule: 'de7-blocks' },
  { name: 'de-7-pegeldaten-seed', source: 'DE-7', fixture: 'de-7-pegeldaten-blocks', rule: 'de7-seed-blocks' },
];

/** The body a P5b rule keeps, and what it says it kept. */
export function cutP5b(
  rule: (typeof IMPORTS_P5B)[number]['rule'],
  raw: Buffer,
  n = 0,
): { body: Buffer; trimmed: string } {
  if (rule === 'lu1-rows') {
    return {
      body: Buffer.from(lu1Cut(raw.toString('utf8'), LU1_ROWS, n)),
      trimmed: `rows ${LU1_ROWS.join(', ')} and the last ${n} labels, each row's trailing field kept`,
    };
  }
  if (rule === 'de1-last') {
    return {
      body: Buffer.from(JSON.stringify((JSON.parse(raw.toString('utf8')) as unknown[]).slice(-n))),
      trimmed: `last ${n} measurements`,
    };
  }
  const blocks = rule === 'de7-seed-blocks' ? DE7_SEED_BLOCKS : DE7_BLOCKS;
  const members = unzip(raw).map((m) => {
    const text = m.data.toString('latin1');
    const kept =
      m.name === 'pegel_stationen.txt'
        ? (() => {
            const { lines: all, eol } = lines(text);
            return join_(
              [all[0] as string, ...all.slice(1).filter((l) => DE7_BLOCKS.includes(l.split(';')[3] as string))],
              eol,
            );
          })()
        : de7Blocks(text, blocks);
    return { ...m, data: Buffer.from(kept, 'latin1') };
  });
  return {
    body: zip(members),
    trimmed: `in every member the whole blocks (pegel_stationen.txt: the rows) of ${blocks.join(', ')}, re-zipped with the recorded member names and times`,
  };
}

/**
 * P7a (Action D2, export of 2026-10-03, `p7a-export.sh`): the class, warning and reference payloads P7a imports.
 * LU-5: every `[AGE]` CAP message since 2025-06 (the flood alerts of 2025-09-08/09, 2025-09-23..25 and
 * 2026-02-13/14, their Updates and Cancels, and the 2026-02-02 TEST with `<status>Actual</status>`), whole. FR-5:
 * one InfoVigiCru cut to the sections of territories 2, 3 and 29 (`fr5-territories`), two more TronEntVigiCru
 * documents (Rhin courant libre, Sambre) and three station.json pages with CruesHistoriques (Charleville-Mézières,
 * Stenay, Chooz). CH-5: the newest de and en warning maps. DE-6: the first stations payload that had a class of 1 or
 * more (one BW gauge at 3, 2026-10-02).
 */
export const IMPORTS_P7A: readonly {
  name: string;
  source: 'LU-5' | 'FR-5' | 'CH-5' | 'DE-6';
  fixture: string;
  rule: 'whole' | 'fr5-territories';
}[] = [
  { name: 'lu-5-age-24', source: 'LU-5', fixture: 'lu-5-cap-20250908-125233-alert-lvl3', rule: 'whole' },
  { name: 'lu-5-age-23', source: 'LU-5', fixture: 'lu-5-cap-20250908-174407-cancel', rule: 'whole' },
  { name: 'lu-5-age-22', source: 'LU-5', fixture: 'lu-5-cap-20250908-174421-alert-lvl2', rule: 'whole' },
  { name: 'lu-5-age-21', source: 'LU-5', fixture: 'lu-5-cap-20250908-182128-update-lvl3', rule: 'whole' },
  { name: 'lu-5-age-20', source: 'LU-5', fixture: 'lu-5-cap-20250908-183232-update-lvl2', rule: 'whole' },
  { name: 'lu-5-age-19', source: 'LU-5', fixture: 'lu-5-cap-20250908-231502-alert-lvl1', rule: 'whole' },
  { name: 'lu-5-age-18', source: 'LU-5', fixture: 'lu-5-cap-20250908-231507-alert-lvl2', rule: 'whole' },
  { name: 'lu-5-age-17', source: 'LU-5', fixture: 'lu-5-cap-20250908-231529-cancel', rule: 'whole' },
  { name: 'lu-5-age-16', source: 'LU-5', fixture: 'lu-5-cap-20250908-231531-cancel', rule: 'whole' },
  { name: 'lu-5-age-15', source: 'LU-5', fixture: 'lu-5-cap-20250909-080450-cancel', rule: 'whole' },
  { name: 'lu-5-age-14', source: 'LU-5', fixture: 'lu-5-cap-20250909-080458-update-lvl1', rule: 'whole' },
  { name: 'lu-5-age-13', source: 'LU-5', fixture: 'lu-5-cap-20250909-080509-alert-lvl4', rule: 'whole' },
  { name: 'lu-5-age-12', source: 'LU-5', fixture: 'lu-5-cap-20250909-135714-alert-lvl2', rule: 'whole' },
  { name: 'lu-5-age-11', source: 'LU-5', fixture: 'lu-5-cap-20250909-155418-alert-lvl4', rule: 'whole' },
  { name: 'lu-5-age-10', source: 'LU-5', fixture: 'lu-5-cap-20250923-154904-alert-lvl3', rule: 'whole' },
  { name: 'lu-5-age-9', source: 'LU-5', fixture: 'lu-5-cap-20250924-094817-alert-lvl2', rule: 'whole' },
  { name: 'lu-5-age-8', source: 'LU-5', fixture: 'lu-5-cap-20250924-094922-update-lvl3', rule: 'whole' },
  { name: 'lu-5-age-7', source: 'LU-5', fixture: 'lu-5-cap-20250924-140001-update-lvl2', rule: 'whole' },
  { name: 'lu-5-age-6', source: 'LU-5', fixture: 'lu-5-cap-20250925-074208-alert-lvl4', rule: 'whole' },
  { name: 'lu-5-age-5', source: 'LU-5', fixture: 'lu-5-cap-20260202-095833-alert-test', rule: 'whole' },
  { name: 'lu-5-age-4', source: 'LU-5', fixture: 'lu-5-cap-20260213-095631-alert-lvl3', rule: 'whole' },
  { name: 'lu-5-age-3', source: 'LU-5', fixture: 'lu-5-cap-20260213-160002-update-lvl3', rule: 'whole' },
  { name: 'lu-5-age-2', source: 'LU-5', fixture: 'lu-5-cap-20260214-080016-update-lvl3', rule: 'whole' },
  { name: 'lu-5-age-1', source: 'LU-5', fixture: 'lu-5-cap-20260214-081825-alert-lvl4', rule: 'whole' },
  { name: 'fr-5-vigilance-last', source: 'FR-5', fixture: 'fr-5-vigilance-archive', rule: 'fr5-territories' },
  { name: 'fr-5-sections-28', source: 'FR-5', fixture: 'fr-5-tron-sa16', rule: 'whole' },
  { name: 'fr-5-sections-37', source: 'FR-5', fixture: 'fr-5-tron-ap1', rule: 'whole' },
  { name: 'fr-5-stations-4', source: 'FR-5', fixture: 'fr-5-stations-charleville', rule: 'whole' },
  { name: 'fr-5-stations-6', source: 'FR-5', fixture: 'fr-5-stations-stenay', rule: 'whole' },
  { name: 'fr-5-stations-1', source: 'FR-5', fixture: 'fr-5-stations-chooz', rule: 'whole' },
  { name: 'ch-5-de-last', source: 'CH-5', fixture: 'ch-5-warn-de-archive', rule: 'whole' },
  { name: 'ch-5-en-last', source: 'CH-5', fixture: 'ch-5-warn-en-archive', rule: 'whole' },
  { name: 'de-6-stations-flood', source: 'DE-6', fixture: 'de-6-stations-class3', rule: 'whole' },
];

/**
 * P8a (Action D2, export of 2026-10-03, `p8a-export.sh`): the NL-1 forecast captures P8a imports, every body whole
 * (a forecast capture is a run without its leading values, so a cut would break the tail relation the loader merges
 * by). Lobith Q (spec `nl-1-fc-1h`): the captures of 2026-10-01T04:25Z and 05:25Z (the last two of the run ending
 * 2026-10-02T05:00Z: the second is the tail of the first) and of 06:25Z and 07:25Z (the first two of the next run, which
 * differs from the old one on its whole overlap). Driel beneden H (spec `nl-1-fc-3h-0`): 2026-10-01T03:45Z (last of
 * the old run), 06:45Z (first of the new one) and 09:45Z (its tail). Alblasserdam H (`nl-1-fc-3h-0`, 2026-10-01T00:45Z):
 * 288 values, every one quality code 99 (the all-gap list), a location the registry does not hold.
 */
export const IMPORTS_P8A: readonly { name: string; source: 'NL-1'; fixture: string }[] = [
  {
    name: 'nl-1-fc-lobith.bovenrijn.tolkamer-Q-0017',
    source: 'NL-1',
    fixture: 'nl-1-fc-1h-lobith-q-20261001t0425z',
  },
  {
    name: 'nl-1-fc-lobith.bovenrijn.tolkamer-Q-0018',
    source: 'NL-1',
    fixture: 'nl-1-fc-1h-lobith-q-20261001t0525z',
  },
  {
    name: 'nl-1-fc-lobith.bovenrijn.tolkamer-Q-0019',
    source: 'NL-1',
    fixture: 'nl-1-fc-1h-lobith-q-20261001t0625z',
  },
  {
    name: 'nl-1-fc-lobith.bovenrijn.tolkamer-Q-0020',
    source: 'NL-1',
    fixture: 'nl-1-fc-1h-lobith-q-20261001t0725z',
  },
  { name: 'nl-1-fc-driel.beneden-H-0006', source: 'NL-1', fixture: 'nl-1-fc-3h-0-driel-beneden-h-20261001t0345z' },
  { name: 'nl-1-fc-driel.beneden-H-0007', source: 'NL-1', fixture: 'nl-1-fc-3h-0-driel-beneden-h-20261001t0645z' },
  { name: 'nl-1-fc-driel.beneden-H-0008', source: 'NL-1', fixture: 'nl-1-fc-3h-0-driel-beneden-h-20261001t0945z' },
  { name: 'nl-1-fc-novalue', source: 'NL-1', fixture: 'nl-1-fc-3h-0-alblasserdam-h-novalue' },
];

/**
 * P8b (Action D2, export of 2026-10-04): whole archived forecast bodies. CH-4 Rheinfelden (2091, Q): the last capture
 * of the run starting 2026-09-30T11:00+02:00 and the first of the next one (15:00+02:00); 2602 (2026-10-04): a run
 * whose measured trace has 17 points instead of 25. FR-4 (captured 2026-09-30, before #39 limited the stations to the
 * NL-bound basins: none is NL-bound, KG-176): L800001020 H and Q (hourly, 40 values) and Y210002001 H (one value).
 */
export const IMPORTS_P8B: readonly { name: string; source: 'CH-4' | 'FR-4'; fixture: string }[] = [
  { name: 'ch-4-2091-0004', source: 'CH-4', fixture: 'ch-4-forecast-2091-20260930t1535z' },
  { name: 'ch-4-2091-0005', source: 'CH-4', fixture: 'ch-4-forecast-2091-20260930t1635z' },
  { name: 'ch-4-newest-0039', source: 'CH-4', fixture: 'ch-4-forecast-2602-20261004t0535z' },
  { name: 'fr-4-station-0373', source: 'FR-4', fixture: 'fr-4-station-l800001020-h-20260930t1620z' },
  { name: 'fr-4-station-0409', source: 'FR-4', fixture: 'fr-4-station-l800001020-q-20260930t1620z' },
  { name: 'fr-4-station-0009', source: 'FR-4', fixture: 'fr-4-station-y210002001-h-20260930t1220z' },
];

/** The FR-5 territories whose sections reach the rivers into the Netherlands (catalogue §2.5). */
export const FR5_TERRITORIES = ['2', '3', '29'] as const;

/** The body a P7a rule keeps, and what it says it kept (false: the archived bytes unchanged). */
export function cutP7a(
  rule: (typeof IMPORTS_P7A)[number]['rule'],
  raw: Buffer,
): { body: Buffer; trimmed: string | false } {
  if (rule === 'whole') return { body: raw, trimmed: false };
  // InfoVigiCru: the features whose parent territory (`cdensup_1`, `CdEnSup_1` in the old casing) is one of ours.
  const doc = JSON.parse(raw.toString('utf8')) as { features: { properties: Record<string, unknown> }[] };
  doc.features = doc.features.filter((f) =>
    (FR5_TERRITORIES as readonly unknown[]).includes(f.properties.cdensup_1 ?? f.properties.CdEnSup_1),
  );
  return {
    body: Buffer.from(JSON.stringify(doc)),
    trimmed: `the features whose cdensup_1 (the parent territory) is ${FR5_TERRITORIES.join(', ')}, all other keys kept`,
  };
}

function main(dir: string, mode: 'p5a' | 'p5b' | 'p7a' | 'p8a' | 'p8b'): void {
  type Entry = {
    name: string;
    source: string;
    fixture: string;
    keep?: number;
    last?: boolean;
    rule?: string;
    n?: number;
  };
  const list: readonly Entry[] =
    mode === 'p5b'
      ? IMPORTS_P5B
      : mode === 'p7a'
        ? IMPORTS_P7A
        : mode === 'p8a'
          ? IMPORTS_P8A
          : mode === 'p8b'
            ? IMPORTS_P8B
            : IMPORTS;
  for (const { name, source, fixture, keep, last, rule, n } of list) {
    const raw = readFileSync(join(dir, `${name}.raw`));
    const line = JSON.parse(readFileSync(join(dir, `${name}.line.json`), 'utf8')) as Line;
    if (sha256(raw) !== line.sha256) throw new Error(`${name}: the body is not the archived object (sha256)`);
    const { body, trimmed } =
      mode === 'p7a'
        ? cutP7a(rule as (typeof IMPORTS_P7A)[number]['rule'], raw)
        : rule === undefined
          ? cut(source as Import['source'], raw, keep, last === true)
          : cutP5b(rule as (typeof IMPORTS_P5B)[number]['rule'], raw, n);
    const meta = {
      spec: line.spec,
      variant: line.variant,
      source,
      synthetic: false,
      from: 'archive',
      archive_key: line.key,
      recorded_at: line.fetched_at.start.replace(/\.\d{3}Z$/, 'Z'),
      ...(line.seed === true ? { seed: true } : {}),
      status: line.status,
      url: line.request?.url ?? null,
      bytes: raw.length,
      source_sha256: line.sha256,
      trimmed,
    };
    const out = join(root, 'apps/server/src/adapters', source.toLowerCase(), 'fixtures');
    writeFileSync(join(out, `${fixture}.raw`), body);
    writeFileSync(join(out, `${fixture}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${fixture}: ${body.length} B${trimmed === false ? '' : ` (${trimmed})`} ← ${line.key}`);
  }
}

if (import.meta.main) {
  const flag = process.argv[2];
  const mode =
    flag === '--p5b' ? 'p5b' : flag === '--p7a' ? 'p7a' : flag === '--p8a' ? 'p8a' : flag === '--p8b' ? 'p8b' : 'p5a';
  const dir = process.argv[mode === 'p5a' ? 2 : 3];
  if (dir === undefined) {
    console.error('usage: node scripts/import-fixtures.ts [--p5b|--p7a|--p8a|--p8b] <export dir>');
    process.exitCode = 64;
  } else main(dir, mode);
}
