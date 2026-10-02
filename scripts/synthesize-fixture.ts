// Synthetic fixtures for owner-audience specs (invariants 9 and 11). The repository is public, so a committed
// fixture of an owner source keeps the real structure and nothing else: every value is generated.
//
//   pnpm fixtures:synth --spec <owner spec id> [--keep <n>]
//     P1 form: reads the git-ignored .smoke/<spec>.raw (smoke-capture.ts) and writes
//     apps/server/src/adapters/<id>/fixtures/<spec>.synthetic.raw.
//   pnpm fixtures:synth --from <export dir> --spec <spec id> [--variant <v>] [--pick latest|oldest]
//                       --name <suffix> [--keep <n>] [--force]
//     Export form: <export dir> (outside the repository; written by the owner's VPS script) is flat, one pair per
//     payload: <spec>-<n>.raw (the decoded body) and <spec>-<n>.line.json (its manifest line: source, spec, variant,
//     sha256, key, status, fetched_at). Picks the spec's payload by fetched_at.start, checks its sha256, and writes
//     <spec>-<suffix>.synthetic.raw and .synthetic.meta.json into the adapter's fixtures folder.
//
// Policy (deterministic, seeded; one table per source in VERBATIM):
//   kept     keys, structure, array lengths up to --keep (a KiWIS table: its header row plus --keep rows),
//            booleans, nulls, the numbers -1 and 0, 9999.0 (number or string), KiWIS quality codes, empty strings,
//            and the identifiers and enumerations the registry itself publishes (VERBATIM, by key or table column);
//   shifted  every ISO timestamp by one constant whole number of days (1,000 to 2,000), offset suffix and fraction
//            format kept, so the time grid, the order and the offsets stay as they were;
//   random   every other number (magnitude, integer or decimal kept), the digits of a string that is a number with
//            optional unit text ("185.41 m NN"), and every other string becomes synthetic-<n>.
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

/** Identifiers and enumerations the registry itself publishes, by JSON key or KiWIS table column name. */
export const VERBATIM: Readonly<Record<string, readonly string[]>> = {
  'BE-3': [
    ...'ts_id station_no site_no stationparameter_no stationparameter_name parametertype_name ts_unitsymbol ts_path'.split(
      ' ',
    ),
    ...'ts_name ts_shortname columns rows timezone ts_spacing station_gauge_datum_unit station_georefsystem'.split(' '),
    ...'station_timezone station_utcoffset'.split(' '),
  ],
  'LU-2': ['ts_path', 'ts_unitsymbol', 'parametertype_name', 'columns', 'rows'],
  'LU-3': [],
  // Not `label`: AGE writes the vigilance level into it ("Cote de vigilance <colour> <n> cm"), a threshold value (P5c
  // review CR-1). Every key here is an identifier or a code, never a text that can carry a measured or set value.
  'LU-4':
    'id jsonFile forecastsLimit forecastsFileName forecastsCalcul stationPath legend operator serviceStatus'.split(' '),
  'DE-2': [],
  'DE-3': [],
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const NUMBER_TEXT = /^[-+]?\d+(?:[.,]\d+)*(?: \D{1,20})?$/;
const KEPT_NUMBERS = new Set([-1, 0, 9999]);
const DAY_MS = 86_400_000;

type Ctx = { rnd: () => number; days: number; names: number; keep: number; verbatim: ReadonlySet<string> };

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
  return { rnd, days, names: 0, keep, verbatim: new Set(VERBATIM[source] ?? []) };
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

const keptColumn = (c: Ctx, col: unknown) =>
  typeof col === 'string' && (c.verbatim.has(col) || col.trim().toLowerCase() === 'quality code');

/** Rows of cells: a cell of a kept column stays, the others are scrambled. */
const scrambleRows = (c: Ctx, rows: unknown[], cols: unknown[]) =>
  rows.map((r) =>
    Array.isArray(r)
      ? r.map((x, i) => {
          const col = cols[i];
          if (keptColumn(c, col)) return x;
          return typeof col === 'string' && COORDINATE.test(col) ? fakeCoordinate(c, col, x) : scramble(c, x);
        })
      : scramble(c, r),
  );

function scramble(c: Ctx, v: unknown): unknown {
  if (Array.isArray(v)) {
    // A KiWIS table: a header row of strings, then rows (the header is kept besides the --keep rows).
    const header = v.length > 1 && Array.isArray(v[0]) && v[0].length > 0 && v[0].every((x) => typeof x === 'string');
    if (header) return [v[0], ...scrambleRows(c, v.slice(1, c.keep + 1), v[0])];
    return v.slice(0, c.keep).map((x) => scramble(c, x));
  }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // A KiWIS getTimeseriesValues item (or an AGE JSON): `data` rows follow the comma list of `columns`.
    const cols = typeof o.columns === 'string' && Array.isArray(o.data) ? o.columns.split(',') : null;
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) => [
        k,
        c.verbatim.has(k)
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

/** Text files (BfG CSV): comment lines keep their words with dates and numbers replaced; data cells are generated. */
function scrambleText(c: Ctx, text: string): string {
  let clock = Date.parse('2030-01-01T00:00:00Z');
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#'))
        return line.replace(/\d{4}-\d{2}-\d{2}/g, '2030-01-01').replace(/\d+/g, (d) => '9'.repeat(d.length));
      if (/^Datum;/.test(line) || line.trim() === '') return line;
      if (!line.includes(';')) return `${fakeString(c, line.trim())}\r`.replace(/\r\r$/, '\r');
      return line
        .split(';')
        .map((cell, i) => {
          if (i === 0 && /^\d{2}\.\d{2}\.\d{4}/.test(cell)) {
            clock += DAY_MS;
            const d = new Date(clock);
            return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} 00:00`;
          }
          return /^-?\d+(?:\.\d+)?\r?$/.test(cell)
            ? String(fakeNumber(c, Number(cell.trim()))) + (cell.endsWith('\r') ? '\r' : '')
            : cell;
        })
        .join(';');
    })
    .join('\n');
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
  try {
    switch (format) {
      case 'json':
        return Buffer.from(JSON.stringify(scramble(c, JSON.parse(Buffer.from(body).toString('utf8')))));
      case 'html-attr': {
        const attr = JSON.stringify(scramble(c, extractDataToJson(body)))
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&#34;');
        return Buffer.from(
          `<!DOCTYPE html>\n<html lang="fr"><head><title>synthetic</title></head><body>\n<cmp-dashboard-station class="synthetic" data-to-json="${attr}"></cmp-dashboard-station>\n</body></html>\n`,
        );
      }
      case 'html': {
        const links = (
          Buffer.from(body)
            .toString('utf8')
            .match(/href="\.\/[^"]*\.csv"/g) ?? []
        ).map((_, i) => `<a href="./synthetic-${i}.csv">synthetic-${i}.csv</a>`);
        return Buffer.from(
          `<!DOCTYPE html>\n<html><head><title>synthetic</title></head><body>\n${links.join('\n')}\n</body></html>\n`,
        );
      }
      case 'text':
        return Buffer.from(scrambleText(c, Buffer.from(body).toString('latin1')));
    }
  } catch {
    throw new Refusal(1, `the payload does not read as ${format}`);
  }
  throw new Refusal(64, `format ${format} not supported`);
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

/** The P1 form: .smoke/<spec>.raw to <spec>.synthetic.raw. */
export function synthesizeSmoke(o: { spec: string; keep?: number | undefined; smokeDir?: string; outRoot?: string }) {
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
    true,
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
  if (sha256(out) === line.sha256) throw new Refusal(1, 'the synthetic bytes equal the source: nothing was generated');
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
    throw new Refusal(64, 'usage: --spec <id> [--keep <n>] | --from <dir> --spec <id> --name <suffix> [...]');
  if (v.pick !== undefined && v.pick !== 'latest' && v.pick !== 'oldest') throw new Refusal(64, '--pick latest|oldest');
  if (v.from === undefined) {
    if ([v.variant, v.pick, v.name, v.force].some((x) => x !== undefined))
      throw new Refusal(64, 'those flags need --from');
    return synthesizeSmoke({ spec: v.spec, keep });
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
