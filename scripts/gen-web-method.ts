// P10b: the Method page's crosswalk table (apps/web/src/features/pages/method.gen.ts), generated from
// packages/core/src/crosswalk.ts. Only rows a public view may show go in: a row of `audience: public`, not `gated`,
// of a source that registry/sources.yaml lists as public. The owner and permission sources' rows, their flags and
// their agencies stay out of the public bundle (the root of @rws/core is banned in the web anyway). A reference
// role carries no `flag` and no `convention`; AGENCY keeps the sources that have a row in the file. The any-source
// DOY roles (P14f, source `'*'`: our own climatology of a series, under that series' audience) go in too; `'*'` has
// no agency, the page names it with the message method_agency_own.
// P19b (D32): also the water boards without data on the map: the §2.8 IDs and Rivers cells of the catalogue (nothing
// else of it: no contacts, e-mails or terms), registry/sources.yaml (the board is `audience: "off"`), providers.yaml
// (its name), registry/uncovered.yaml (curated rivers and 1-2 gauges) and registry/stations/*.yaml (each gauge a public,
// open, primary row of a public source). `uncoveredBoards` is pure and throws on any mismatch; no source id is emitted.
// They go in their own file, uncovered.gen.ts: station/thresholds.ts imports method.gen.ts into the initial bundle,
// and the board list belongs to the lazy Method chunk only.
// Usage: node scripts/gen-web-method.ts [--check] [repo-root]   (--check diffs both files and exits 1)
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { AGENCY, CROSSWALK, REFERENCE_ROLES } from '../packages/core/src/crosswalk.ts';

export const METHOD_FILE = 'apps/web/src/features/pages/method.gen.ts';
export const UNCOVERED_FILE = 'apps/web/src/features/pages/uncovered.gen.ts';

function biomeFormat(root: string, path: string, source: string): string {
  const r = spawnSync(join(root, 'node_modules/.bin/biome'), ['format', `--stdin-file-path=${path}`], {
    input: source,
    encoding: 'utf8',
    cwd: root,
  });
  if (r.status !== 0) throw new Error(`gen-web-method: biome format failed for ${path}`);
  return r.stdout;
}

export type UncoveredBoard = {
  board: string;
  rivers: { nl: string[]; en: string[] };
  gauges: { id: string; name: string }[];
};

const readYaml = <T>(root: string, path: string): T => parse(readFileSync(join(root, path), 'utf8')) as T;
const BAD_NAME = /UNVERIFIED|\bR\d+\b|[()]/;

/** The §2.8 table of the catalogue: [source id, Rivers cell] per row (only these two columns are read). */
function boardRows(root: string): [string, string][] {
  const text = readFileSync(join(root, 'docs/sources/SOURCE-CATALOGUE.md'), 'utf8');
  const start = text.indexOf('\n### 2.8 ');
  if (start < 0) throw new Error('gen-web-method: catalogue section 2.8 not found');
  const rows: [string, string][] = [];
  for (const line of text
    .slice(start + 1)
    .split('\n')
    .slice(1)) {
    if (/^#{1,3} /.test(line)) break;
    const id = /^\|\s*(NL-\d+)(?:\s*\(C\d+\))?\s*\|/.exec(line)?.[1];
    if (id !== undefined) rows.push([id, line.split('|')[5] ?? '']);
  }
  return rows;
}

export function uncoveredBoards(root: string): UncoveredBoard[] {
  const sources = readYaml<{ sources: { id: string; provider: string; audience: string }[] }>(
    root,
    'registry/sources.yaml',
  ).sources;
  const providers = new Map(
    readYaml<{ providers: { id: string; name: string }[] }>(root, 'registry/providers.yaml').providers.map((p) => [
      p.id,
      p.name,
    ]),
  );
  const entries = readYaml<{ boards: { source: string; rivers: { nl: string[]; en: string[] }; gauges: string[] }[] }>(
    root,
    'registry/uncovered.yaml',
  ).boards;
  const stations = new Map<string, { name: string }>();
  const publicSources = new Set(sources.filter((s) => s.audience === 'public').map((s) => s.id));
  for (const f of readdirSync(join(root, 'registry/stations'))
    .filter((n) => n.endsWith('.yaml'))
    .sort()) {
    const rows = readYaml<{
      stations: { id: string; name: string; source: string; audience: string; licence_gate: string; role: string }[];
    }>(root, `registry/stations/${f}`).stations;
    for (const r of rows)
      if (
        r.audience === 'public' &&
        r.licence_gate === 'open' &&
        r.role === 'primary' &&
        publicSources.has(r.source) &&
        !stations.has(r.id)
      )
        stations.set(r.id, { name: r.name });
  }
  const off: UncoveredBoard[] = [];
  const offIds = new Set<string>();
  for (const [id, cell] of boardRows(root)) {
    const src = sources.find((s) => s.id === id);
    if (src === undefined) throw new Error(`gen-web-method: ${id} (catalogue 2.8) is not in registry/sources.yaml`);
    if (src.audience !== 'off') continue;
    offIds.add(id);
    const e = entries.find((x) => x.source === id);
    if (e === undefined) throw new Error(`gen-web-method: off board ${id} has no entry in registry/uncovered.yaml`);
    const board = providers.get(src.provider);
    if (board === undefined) throw new Error(`gen-web-method: ${id} has no provider name`);
    if (e.rivers.nl.length !== e.rivers.en.length || e.rivers.en.length === 0)
      throw new Error(`gen-web-method: ${id}: rivers nl and en differ in length (or are empty)`);
    for (const n of [...e.rivers.nl, ...e.rivers.en])
      if (BAD_NAME.test(n)) throw new Error(`gen-web-method: ${id}: river name "${n}" holds a marker or a bracket`);
    for (const n of e.rivers.en)
      if (!cell.toLowerCase().includes(n.toLowerCase()))
        throw new Error(`gen-web-method: ${id}: river "${n}" is not in the catalogue Rivers cell`);
    const gauges = [...new Set(e.gauges)].map((g) => {
      const s = stations.get(g);
      if (s === undefined) throw new Error(`gen-web-method: ${id}: gauge ${g} is not a public, open, primary station`);
      return { id: g, name: s.name };
    });
    if (gauges.length === 0) throw new Error(`gen-web-method: ${id} names no gauge`);
    off.push({ board, rivers: e.rivers, gauges });
  }
  for (const e of entries)
    if (!offIds.has(e.source)) throw new Error(`gen-web-method: uncovered.yaml entry ${e.source} is not an off board`);
  return off;
}

export function generate(root: string): string {
  const reg = parse(readFileSync(join(root, 'registry/sources.yaml'), 'utf8')) as {
    sources: { id: string; audience: string }[];
  };
  const isPublic = new Set(reg.sources.filter((s) => s.audience === 'public').map((s) => s.id));
  const shown = (r: { source: string; audience: string; gated?: true }) =>
    r.audience === 'public' && r.gated !== true && (isPublic.has(r.source) || r.source === '*');
  const classes = CROSSWALK.filter(shown).map((r) => ({
    source: r.source,
    scale: r.scale,
    code: r.code,
    level: r.level,
    basis: r.basis,
    group: r.group,
    noFlood: r.noFlood === true,
  }));
  const references = REFERENCE_ROLES.filter(shown).map((r) => ({
    source: r.source,
    kind: r.kind,
    op: r.op,
    level: r.level,
    basis: r.basis,
    group: r.group,
    form: r.form,
    short: r.short,
  }));
  const inFile = new Set([...classes, ...references].map((r) => r.source));
  const agencies = Object.fromEntries(Object.entries(AGENCY).filter(([source]) => inFile.has(source)));
  const lit = (v: unknown) => JSON.stringify(v, null, 2);
  return biomeFormat(
    root,
    'method.gen.ts',
    `// GENERATED by scripts/gen-web-method.ts from packages/core/src/crosswalk.ts and registry/sources.yaml. Do not edit.
// The public, ungated rows only: the Method page's class crosswalk and reference roles (catalogue §4.9, ADR-0009).

export type MethodClass = {
  source: string;
  scale: string;
  code: string;
  level: 'low' | 'normal' | 'elevated' | 'high' | 'extreme' | 'no_ref';
  basis: 'stage' | 'discharge' | 'area';
  group: 'operational' | 'statistical' | 'provider_class' | 'area';
  /** "No flood" (LHP 0, BAFU 1, Vigicrues green, LU-Alert information): only "not elevated". */
  noFlood: boolean;
};

export type MethodReference = {
  /** '*': our own day-of-year climatology, of any source (the series' own). */
  source: string;
  kind: string;
  /** A value at or above, at or below, or below the reference reaches the level; null: shown, never classifies. */
  op: '>=' | '<=' | '<' | null;
  level: 'low' | 'normal' | 'elevated' | 'high' | 'extreme' | null;
  basis: 'stage' | 'discharge' | 'area';
  group: 'operational' | 'statistical' | null;
  form: 'scale' | 'stats' | 'percentile' | 'doy' | null;
  short: string;
};

export const METHOD_CLASSES: readonly MethodClass[] = ${lit(classes)};

export const METHOD_REFERENCES: readonly MethodReference[] = ${lit(references)};

/** The agency named in a basis label, for the sources above. */
export const METHOD_AGENCIES: Readonly<Record<string, string>> = ${lit(agencies)};
`,
  );
}

/** uncovered.gen.ts: the board list of the Method page (D32), for the lazy Method chunk only. */
export function generateUncovered(root: string): string {
  return biomeFormat(
    root,
    'uncovered.gen.ts',
    `// GENERATED by scripts/gen-web-method.ts from catalogue §2.8 and registry/{sources,providers,uncovered}.yaml and
// registry/stations/*.yaml. Do not edit. Public stations only; no source id.

export type UncoveredBoard = {
  /** The board's name. No source id: the page never names one. */
  board: string;
  rivers: { nl: string[]; en: string[] };
  /** Public gauges on or near its waters; a link to the map. */
  gauges: { id: string; name: string }[];
};

/** The Dutch water boards with no data on the map (catalogue 2.8, registry/uncovered.yaml): D32. */
export const UNCOVERED_BOARDS: readonly UncoveredBoard[] = ${JSON.stringify(uncoveredBoards(root), null, 2)};
`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(import.meta.dirname, '..'));
  for (const [file, gen] of [
    [METHOD_FILE, generate],
    [UNCOVERED_FILE, generateUncovered],
  ] as const) {
    const content = gen(root);
    let have = '';
    try {
      have = readFileSync(join(root, file), 'utf8');
    } catch {}
    if (have !== content) {
      if (check) {
        console.error(`gen-web-method: ${file} is out of date (run: node scripts/gen-web-method.ts)`);
        process.exit(1);
      }
      writeFileSync(join(root, file), content);
    }
    console.log(`gen-web-method: ${check ? 'OK' : 'written'} (${file})`);
  }
}
