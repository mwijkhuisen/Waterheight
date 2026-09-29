import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Inflate } from 'fflate';

// Per-format input guards (A§12.2; catalogue §6.7). The capture validity
// assertions use them too, so a payload is only ever read through a guard.
// Failures carry a fixed reason code, never provider text.

export class GuardFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`guard: ${reason}`);
    this.reason = reason;
  }
}

const fail = (reason: string): never => {
  throw new GuardFailure(reason);
};

export type Encoding = 'utf-8' | 'latin1';
export const decode = (bytes: Uint8Array, encoding: Encoding = 'utf-8') => new TextDecoder(encoding).decode(bytes);

// ---------------------------------------------------------------- JSON

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    return fail('json');
  }
}

// ---------------------------------------------------------------- CSV

export const CSV_MAX_ROWS = 100_000;
export const CSV_MAX_COLUMNS = 1000;
export const CSV_MAX_FIELD = 1024;

export type CsvOptions = {
  delimiter: string;
  encoding?: Encoding;
  /** Lines starting with this prefix before the header are skipped (BfG `#` notes). */
  commentPrefix?: string;
  maxRows?: number;
};

/**
 * A quote-aware CSV scan with the §6.7 caps: ≤ 100,000 data rows, ≤ 1,000
 * columns, fields ≤ 1 KB, and every row as wide as the header (a truncated
 * last row fails). Returns the header and the data rows.
 */
export function scanCsv(bytes: Uint8Array, opts: CsvOptions): { header: string[]; rows: string[][] } {
  let text = decode(bytes, opts.encoding);
  if (opts.commentPrefix !== undefined) {
    while (text.startsWith(opts.commentPrefix)) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
  }
  const maxRows = opts.maxRows ?? CSV_MAX_ROWS;
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    if (field.length > CSV_MAX_FIELD) fail('csv_field');
    row.push(field);
    field = '';
    if (row.length > CSV_MAX_COLUMNS) fail('csv_columns');
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
    if (records.length > maxRows + 1) fail('csv_rows');
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      if (field.length > CSV_MAX_FIELD) fail('csv_field');
    } else if (c === '"' && field === '') quoted = true;
    else if (c === opts.delimiter) endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') {
      field += c;
      if (field.length > CSV_MAX_FIELD) fail('csv_field');
    }
    i += 1;
  }
  if (quoted) fail('csv_quote');
  if (field !== '' || row.length > 0) endRow();
  const [header, ...rows] = records;
  if (header === undefined) return fail('csv_empty');
  for (const r of rows) if (r.length !== header.length) fail('csv_width');
  return { header, rows };
}

/** Splits streamed bytes into lines (bounded length) for ZIP members too large to hold. */
export function lineSplitter(onLine: (line: string) => void, encoding: Encoding = 'utf-8', maxLine = 64 * 1024) {
  const decoder = new TextDecoder(encoding);
  let rest = '';
  const feed = (text: string) => {
    rest += text;
    let nl = rest.indexOf('\n');
    while (nl >= 0) {
      onLine(rest.slice(0, nl).replace(/\r$/, ''));
      rest = rest.slice(nl + 1);
      nl = rest.indexOf('\n');
    }
    if (rest.length > maxLine) fail('line_length');
  };
  return {
    push: (chunk: Uint8Array) => feed(decoder.decode(chunk, { stream: true })),
    end: () => {
      feed(decoder.decode());
      if (rest !== '') onLine(rest.replace(/\r$/, ''));
      rest = '';
    },
  };
}

// ---------------------------------------------------------------- ZIP

export const ZIP_MAX_MEMBERS = 10;
export const ZIP_MAX_TOTAL = 200 * 1024 * 1024;
export const ZIP_MAX_RATIO = 50;
const PUSH = 4096;

export type ZipOptions = {
  /** Allowed member names; the default refuses any `/`. */
  names: (name: string) => boolean;
  maxMembers?: number;
  /** Receives each member's inflated bytes; nothing is ever written to disk. */
  onMember?: (name: string) => { data: (chunk: Uint8Array) => void; end: () => void } | undefined;
};

export type ZipMember = { name: string; size: number; compressed: number };

/** Names no member may have, whatever the spec allows. */
const UNSAFE_NAME = /(^[/\\])|\\|(^|\/)\.\.(\/|$)|\0|^[A-Za-z]:/;

/**
 * ZIP guard: reads the end record and the central directory first, checks
 * member count, names, sizes and ratios there, then inflates each member in
 * small pushes and counts the real output against the declared size, the
 * 200 MB total and 50:1 (a lying central directory fails), and checks CRC-32.
 */
export async function checkZip(buf: Buffer, opts: ZipOptions): Promise<ZipMember[]> {
  const maxMembers = opts.maxMembers ?? ZIP_MAX_MEMBERS;
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 65_535); p -= 1) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return fail('zip_eocd');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) fail('zip64');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('zip64');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) fail('zip_multidisk');
  if (count > maxMembers) fail('zip_members');
  if (cdOffset + cdSize > eocd) fail('zip_eocd');

  type Entry = ZipMember & { method: number; crc: number; local: number; start: number; raw: Buffer };
  const entries: Entry[] = [];
  let p = cdOffset;
  let total = 0;
  let compressedTotal = 0;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) fail('zip_cd');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    const name = raw.toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) fail('zip_cd');
    if (flags & 0x1) fail('zip_encrypted');
    if (method !== 0 && method !== 8) fail('zip_method');
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) fail('zip64');
    if (UNSAFE_NAME.test(name) || !opts.names(name)) fail('zip_name');
    if (entries.some((e) => e.name === name)) fail('zip_name');
    if (size > (compressed === 0 ? 0 : compressed * ZIP_MAX_RATIO)) fail('zip_ratio');
    total += size;
    compressedTotal += compressed;
    entries.push({ name, size, compressed, method, crc, local, start: 0, raw });
  }
  if (total > ZIP_MAX_TOTAL) fail('zip_total');
  if (total > compressedTotal * ZIP_MAX_RATIO) fail('zip_ratio');

  // Local headers must match the central directory, and member data must not overlap.
  for (const e of entries) {
    if (e.local + 30 > cdOffset || buf.readUInt32LE(e.local) !== 0x04034b50) fail('zip_local');
    const nameLen = buf.readUInt16LE(e.local + 26);
    const extraLen = buf.readUInt16LE(e.local + 28);
    if (!buf.subarray(e.local + 30, e.local + 30 + nameLen).equals(e.raw)) fail('zip_local');
    e.start = e.local + 30 + nameLen + extraLen;
    if (e.start + e.compressed > cdOffset) fail('zip_local');
  }
  const sorted = [...entries].sort((a, b) => a.local - b.local);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] as Entry;
    if ((sorted[i] as Entry).local < prev.start + prev.compressed) fail('zip_overlap');
  }

  let inflatedTotal = 0;
  for (const e of entries) {
    const data = buf.subarray(e.start, e.start + e.compressed);
    const sink = opts.onMember?.(e.name);
    let out = 0;
    let crc = 0;
    const take = (chunk: Uint8Array) => {
      out += chunk.length;
      inflatedTotal += chunk.length;
      if (out > e.size) fail('zip_size');
      if (inflatedTotal > ZIP_MAX_TOTAL) fail('zip_total');
      crc = crc32(chunk, crc);
      sink?.data(chunk);
    };
    if (e.method === 0) {
      for (let i = 0; i < data.length; i += PUSH) take(data.subarray(i, i + PUSH));
    } else {
      const inflate = new Inflate((chunk) => take(chunk));
      let pushes = 0;
      do {
        const from = pushes * PUSH;
        try {
          inflate.push(data.subarray(from, from + PUSH), from + PUSH >= data.length);
        } catch (err) {
          if (err instanceof GuardFailure) throw err;
          fail('zip_inflate');
        }
        pushes += 1;
        // Yield now and then: a 128 MB member must not stall the heartbeat or the scheduler.
        if (pushes % 256 === 0) await yieldToLoop();
      } while (pushes * PUSH < data.length);
    }
    if (out !== e.size) fail('zip_size');
    if (crc >>> 0 !== e.crc >>> 0) fail('zip_crc');
    sink?.end();
  }
  return entries.map(({ name, size, compressed }) => ({ name, size, compressed }));
}

/** A flat member name: no directory part at all (DE-7 ZIPs). */
export const flatNames =
  (allowed: readonly string[]) =>
  (name: string): boolean =>
    !name.includes('/') && allowed.includes(name);

/** OOXML member names (XLSX): a fixed set of top folders, safe path segments only. */
export const ooxmlNames = (name: string): boolean =>
  /^(?:\[Content_Types\]\.xml|(?:_rels|docProps|xl|customXml)(?:\/[A-Za-z0-9_.[\] -]+)+)$/.test(name) &&
  !name.split('/').some((s) => s === '' || s === '.' || s === '..');

// ---------------------------------------------------------------- XML

export const XML_MAX_BYTES = 1024 * 1024;

/** DTDs and entities off: any DOCTYPE or ENTITY declaration is refused before parsing. */
export function checkXmlText(text: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('xml_dtd');
  if (XMLValidator.validate(text) !== true) fail('xml_invalid');
}

export function parseXml(bytes: Uint8Array, maxBytes = XML_MAX_BYTES): unknown {
  if (bytes.length > maxBytes) fail('xml_size');
  const text = decode(bytes);
  checkXmlText(text);
  return new XMLParser({ processEntities: false, htmlEntities: false, ignoreAttributes: true }).parse(text);
}

/** XLSX: the ZIP rules with OOXML names, plus the XML rule on every .xml/.rels member. */
export async function checkXlsx(buf: Buffer, maxMembers: number): Promise<string[]> {
  const texts = new Map<string, Buffer[]>();
  const members = await checkZip(buf, {
    names: ooxmlNames,
    maxMembers,
    onMember: (name) => {
      if (!/\.(?:xml|rels)$/.test(name)) return undefined;
      const parts: Buffer[] = [];
      texts.set(name, parts);
      return { data: (c) => parts.push(Buffer.from(c)), end: () => {} };
    },
  });
  for (const parts of texts.values()) checkXmlText(Buffer.concat(parts).toString('utf8'));
  return members.map((m) => m.name);
}

// ---------------------------------------------------------------- HTML (LU-4)

const ATTR_MAX = 256 * 1024;
const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'" };

/**
 * Reads only the `data-to-json` attribute of the first `<cmp-dashboard-station`
 * tag with a bounded scan and parses it as JSON. Nothing else of the page is
 * parsed, and no script ever runs.
 */
export function extractDataToJson(bytes: Uint8Array): unknown {
  const html = decode(bytes);
  const tag = /<cmp-dashboard-station[\s>]/.exec(html);
  if (tag === null) return fail('html_tag');
  const attr = html.indexOf('data-to-json=', tag.index);
  if (attr < 0 || attr - tag.index > 4096 || html.slice(tag.index, attr).includes('>')) return fail('html_attr');
  const quote = html[attr + 13];
  if (quote !== '"' && quote !== "'") return fail('html_attr');
  const start = attr + 14;
  const end = html.indexOf(quote, start);
  if (end < 0 || end - start > ATTR_MAX) return fail('html_attr');
  const raw = html.slice(start, end).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(Number.parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
    return ENTITIES[k] ?? m;
  });
  try {
    return JSON.parse(raw);
  } catch {
    return fail('html_json');
  }
}
