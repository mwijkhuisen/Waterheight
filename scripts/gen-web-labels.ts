// P10a: the web label catalogue, generated from registry/labels/*.yaml, registry/rivers.yaml and the audience of
// registry/sources.yaml. Public sources' labels and the rivers become messages (`lbl_<source>_<scale>_<code>`,
// `river_<id>`) in apps/web/messages/{nl,en}.json (a sorted block at the end; every other key keeps its place);
// owner-audience labels go only to apps/web/src/features/owner/labels.gen.ts (the owner chunk, never the public
// bundle); lib/labels/labels-index.gen.ts maps (source, scale, code) to the keys.
// Usage: node scripts/gen-web-labels.ts [--check] [repo-root]   (--check diffs and exits 1)
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { AREA_SCALE, CLASS_SCALE } from '../packages/core/src/crosswalk.ts';

type Label = { source: string; scale: string; code: string; nl: string; en: string; color?: string };
type River = { id: string; name_nl: string; name_en: string };

/** Keys of the reserved prefixes that are hand-written (the generator never touches them). */
const HAND_WRITTEN = new Set(['river_chip', 'river_clear']);
const isGenerated = (key: string) => (key.startsWith('lbl_') || key.startsWith('river_')) && !HAND_WRITTEN.has(key);

export const slug = (s: string): string => {
  const t = s === '*' ? 'any' : `${s.startsWith('-') ? `m${s.slice(1)}` : s}`;
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
};
export const labelKey = (l: Pick<Label, 'source' | 'scale' | 'code'>) =>
  `lbl_${slug(l.source)}_${slug(l.scale)}_${slug(l.code)}`;

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`gen-web-labels: empty text: ${what}`);
  if (/[{}]/.test(v)) throw new Error(`gen-web-labels: braces in text (a Paraglide placeholder): ${what}`);
  return v;
};

function readInputs(root: string) {
  const sources = parse(readFileSync(join(root, 'registry/sources.yaml'), 'utf8')) as {
    sources: { id: string; audience: string }[];
  };
  const audience = new Map(sources.sources.map((s) => [s.id, s.audience]));
  const labels: Label[] = [];
  const dir = join(root, 'registry/labels');
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.yaml'))
    .sort()) {
    const doc = parse(readFileSync(join(dir, f), 'utf8')) as { source: string; labels: Record<string, unknown>[] };
    if (!audience.has(doc.source)) throw new Error(`gen-web-labels: ${f}: unknown source ${doc.source}`);
    for (const l of doc.labels) {
      const code = String(l.code);
      const at = `${doc.source} ${String(l.scale)} ${code}`;
      labels.push({
        source: doc.source,
        scale: String(l.scale),
        code,
        nl: text(l.nl, `${at} nl`),
        en: text(l.en, `${at} en`),
        ...(typeof l.color === 'string' ? { color: l.color } : {}),
      });
    }
  }
  const rv = parse(readFileSync(join(root, 'registry/rivers.yaml'), 'utf8')) as { rivers: Record<string, unknown>[] };
  const rivers: River[] = rv.rivers.map((r) => ({
    id: String(r.id),
    name_nl: text(r.name_nl, `river ${String(r.id)} name_nl`),
    name_en: text(r.name_en, `river ${String(r.id)} name_en`),
  }));
  return { audience, labels, rivers };
}

const lit = (v: string) => JSON.stringify(v);
const frozenMap = (entries: [string, string][], raw = false) =>
  `Object.freeze(Object.assign(Object.create(null), {\n${entries.map(([k, v]) => `${lit(k)}: ${raw ? v : lit(v)},`).join('\n')}\n}))`;

function biomeFormat(root: string, path: string, source: string): string {
  const r = spawnSync(join(root, 'node_modules/.bin/biome'), ['format', `--stdin-file-path=${path}`], {
    input: source,
    encoding: 'utf8',
    cwd: root,
  });
  if (r.status !== 0) throw new Error(`gen-web-labels: biome format failed for ${path}`);
  return r.stdout;
}

/** Every generated file: repo-relative path → content. */
export function generate(root: string): Map<string, string> {
  const { audience, labels, rivers } = readInputs(root);
  const pub: Label[] = [];
  const own: Label[] = [];
  for (const l of labels)
    (audience.get(l.source) === 'public' ? pub : audience.get(l.source) === 'owner' ? own : []).push(l);

  const keys = new Map<string, string>();
  const claim = (key: string, what: string) => {
    if (keys.has(key) || HAND_WRITTEN.has(key))
      throw new Error(`gen-web-labels: key collision ${key}: ${what} and ${keys.get(key)}`);
    keys.set(key, what);
  };
  const messages = { nl: {} as Record<string, string>, en: {} as Record<string, string> };
  const ownerMsgs = { nl: {} as Record<string, string>, en: {} as Record<string, string> };
  const publicIndex: [string, string][] = [];
  const ownerIndex: [string, string][] = [];
  for (const l of [...pub, ...own]) {
    const key = labelKey(l);
    claim(key, `${l.source} ${l.scale} ${l.code}`);
    const isOwner = audience.get(l.source) === 'owner';
    const target = isOwner ? ownerMsgs : messages;
    target.nl[key] = l.nl;
    target.en[key] = l.en;
    (isOwner ? ownerIndex : publicIndex).push([`${l.source}\n${l.scale}\n${l.code}`, key]);
  }
  const riverIndex: [string, string][] = [];
  for (const r of rivers) {
    const key = `river_${slug(r.id)}`;
    claim(key, `river ${r.id}`);
    messages.nl[key] = r.name_nl;
    messages.en[key] = r.name_en;
    riverIndex.push([r.id, key]);
  }
  const colours: [string, string][] = pub.flatMap((l) =>
    l.color && l.source === 'DE-6' ? [[`${l.scale}\n${l.code}`, l.color] as [string, string]] : [],
  );

  const out = new Map<string, string>();
  for (const loc of ['nl', 'en'] as const) {
    const path = `apps/web/messages/${loc}.json`;
    const kept = Object.entries(JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>).filter(
      ([k]) => !isGenerated(k),
    );
    const block = Object.entries(messages[loc]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    out.set(path, `${JSON.stringify(Object.fromEntries([...kept, ...block]), null, 2)}\n`);
  }
  const sorted = (e: [string, string][]) => [...e].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const scaleMap = (m: Readonly<Record<string, string>>) => sorted(Object.entries(m));
  const header =
    '// GENERATED by scripts/gen-web-labels.ts from registry/labels, registry/rivers.yaml and registry/sources.yaml. Do not edit.\n';
  const ownerEntries = (loc: 'nl' | 'en') => frozenMap(sorted(Object.entries(ownerMsgs[loc])));
  out.set(
    'apps/web/src/features/owner/labels.gen.ts',
    biomeFormat(
      root,
      'labels.gen.ts',
      `${header}import type { OwnerLabels } from '../../lib/labels/labels.ts';\n\nexport const OWNER_LABELS: OwnerLabels = Object.freeze({\n// (source, scale, code) → key, here and not in the public index: the owner sources' ids stay out of the public bundle.\nkeys: ${frozenMap(sorted(ownerIndex))},\nnl: ${ownerEntries('nl')},\nen: ${ownerEntries('en')},\n});\n`,
    ),
  );
  out.set(
    'apps/web/src/lib/labels/labels-index.gen.ts',
    biomeFormat(
      root,
      'labels-index.gen.ts',
      `${header}import {\n${[...publicIndex, ...riverIndex]
        .map(([, k]) => k)
        .sort()
        .map((k) => `${k},`)
        .join(
          '\n',
        )}\n} from '../../paraglide/messages.js';\n\ntype Message = (inputs: object, options: { locale: 'nl' | 'en' }) => string;\n// Keys are \`<source>\\n<scale>\\n<code>\` (public labels, message functions imported by name so the bundle holds only these), or a river id (the owner index lives in the owner chunk).\nexport const PUBLIC_LABELS: Readonly<Record<string, Message>> = ${frozenMap(sorted(publicIndex), true)};\nexport const RIVER_LABELS: Readonly<Record<string, Message>> = ${frozenMap(sorted(riverIndex), true)};\n/** Copies of CLASS_SCALE and AREA_SCALE of packages/core/src/crosswalk.ts. */\nexport const CLASS_SCALE: Readonly<Record<string, string>> = ${frozenMap(scaleMap(CLASS_SCALE))};\nexport const AREA_SCALE: Readonly<Record<string, string>> = ${frozenMap(scaleMap(AREA_SCALE))};\n/** The LHP legend colours of DE-6, keyed \`<scale>\\n<code>\`. */\nexport const LHP_COLOURS: Readonly<Record<string, string>> = ${frozenMap(sorted(colours))};\n`,
    ),
  );
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? join(import.meta.dirname, '..'));
  const files = generate(root);
  let drift = 0;
  for (const [path, content] of files) {
    let have = '';
    try {
      have = readFileSync(join(root, path), 'utf8');
    } catch {}
    if (have === content) continue;
    if (check) {
      console.error(`gen-web-labels: ${path} is out of date (run: node scripts/gen-web-labels.ts)`);
      drift++;
    } else writeFileSync(join(root, path), content);
  }
  if (drift > 0) process.exit(1);
  console.log(`gen-web-labels: ${check ? 'OK' : 'written'} (${files.size} files)`);
}
