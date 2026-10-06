// UI text lives in apps/web/messages (A§3, PHASES P10), checked in CI:
//   - nl.json and en.json define the same keys, each a non-empty string;
//   - no .tsx file under apps/web/src (the compiled paraglide folder aside) holds a hard-coded UI string:
//     JSX text, a string literal as a JSX child, or a string literal in an accessible-name attribute;
//   - no .ts or .tsx file there (generated `*.gen.ts` aside) sets a UI-text property (`name`, `text`, `title`,
//     `subtext`, `label`: an ECharts axis or series name, a MapLibre or chart label) to a string literal (P10a review
//     round 1: the chart and popup builders are .ts).
//     Only text with a letter counts: punctuation, digits and symbols such as ( ) : · – are fine.
//   - (P10b) the pages' prose under apps/web/src/features/pages/content/{nl,en}/ is exempt from that scan, but both
//     folders hold the same non-empty files, which import only `react` and ../../parts/* and set no HTML string.
// Output is the path, the line and the kind only, never the text.
// Usage: node scripts/check-i18n.ts [repo-root]   (exit 1 on a problem)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';
import { keyDrift, loadMessages } from '../apps/web/i18n-html.ts';
import { labelKey, slug } from './gen-web-labels.ts';

const LOCALES = ['nl', 'en'] as const;
/** Attributes whose value a visitor reads or hears; className, data-* and the like are not UI text. */
const TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-valuetext',
  'aria-description',
  'aria-roledescription',
  'aria-placeholder',
  'title',
  'alt',
  'placeholder',
  'label',
]);

/** Object properties whose string value a visitor reads (ECharts `name`, `text`, `subtext`, `title`, `label`). */
const TEXT_PROPERTIES = new Set(['name', 'text', 'title', 'subtext', 'label']);

const LETTER = /\p{L}/u;
/** Blanked to the same length, so `&nbsp;` is no word and the offsets stay true. */
const entitiesBlanked = (s: string) => s.replace(/&#?\w+;/g, (e) => ' '.repeat(e.length));

/** The string literals an expression can render as they are: through parentheses, `?:`, `&&`, `||` and `??`. */
function literals(node: ts.Expression): ts.StringLiteralLike[] {
  if (ts.isStringLiteralLike(node)) return [node];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    )
      return [...literals(node.left), ...literals(node.right)];
  }
  return [];
}

/** `<path>:<line>: <what>` for every hard-coded UI string in one .tsx source. */
export function findHardcoded(path: string, source: string): string[] {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const report = (pos: number, what: string) =>
    found.push(`${path}:${file.getLineAndCharacterOfPosition(pos).line + 1}: ${what}`);
  const text = (node: ts.StringLiteralLike, what: string) => {
    if (LETTER.test(node.text)) report(node.getStart(file), what);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const at = entitiesBlanked(node.text).search(LETTER);
      if (at >= 0) report(node.pos + at, 'hard-coded JSX text');
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const literal of literals(node.expression)) text(literal, 'hard-coded string as a JSX child');
    } else if (ts.isJsxAttribute(node) && node.initializer && TEXT_ATTRIBUTES.has(node.name.getText(file))) {
      const name = node.name.getText(file);
      const value = node.initializer;
      const candidates = ts.isJsxExpression(value) ? (value.expression ? literals(value.expression) : []) : [value];
      for (const literal of candidates)
        if (ts.isStringLiteralLike(literal)) text(literal, `hard-coded ${name} attribute`);
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      TEXT_PROPERTIES.has(node.name.text)
    ) {
      for (const literal of literals(node.initializer)) text(literal, `hard-coded ${node.name.text} property`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The pages' prose (P10b): one JSX file per page and language, outside the message files. */
export const CONTENT_DIR = 'apps/web/src/features/pages/content';
const isContent = (path: string) => path.startsWith(`${CONTENT_DIR}/`);

/** Repo-relative POSIX paths of the .ts and .tsx files the rule covers (generated files and page prose aside), sorted. */
function tsxFiles(root: string): string[] {
  const src = join(root, 'apps/web/src');
  if (!existsSync(src)) return [];
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(
      (name) =>
        (name.endsWith('.tsx') || (name.endsWith('.ts') && !name.endsWith('.gen.ts') && !name.endsWith('.d.ts'))) &&
        !name.split(sep).some((part) => part === 'paraglide' || part === 'node_modules'),
    )
    .map((name) => relative(root, join(src, name)).split(sep).join('/'))
    .filter((path) => !isContent(path))
    .sort();
}

/** What a page's prose may import: React, and the parts that render its data. */
const CONTENT_IMPORT = /^(react|\.\.\/\.\.\/parts\/[A-Za-z0-9_-]+\.tsx?)$/;

/**
 * The page prose rule (P10b): content/nl and content/en hold the same file names, each a non-empty .tsx; a file
 * imports only `react` and ../../parts/*, loads nothing at run time, and never sets HTML from a string.
 */
export function contentProblems(root: string): string[] {
  const dir = join(root, CONTENT_DIR);
  if (!existsSync(dir)) return [];
  const problems: string[] = [];
  const names = new Map(
    LOCALES.map((loc) => [loc, existsSync(join(dir, loc)) ? readdirSync(join(dir, loc)).sort() : []] as const),
  );
  for (const loc of LOCALES) {
    for (const other of LOCALES)
      for (const name of names.get(other) ?? [])
        if (!(names.get(loc) ?? []).includes(name)) problems.push(`${CONTENT_DIR}/${loc}/${name} is missing`);
    for (const name of names.get(loc) ?? []) {
      const path = `${CONTENT_DIR}/${loc}/${name}`;
      if (!name.endsWith('.tsx')) {
        problems.push(`${path}: page prose is a .tsx file`);
        continue;
      }
      const source = readFileSync(join(root, path), 'utf8');
      if (source.trim() === '') problems.push(`${path}: empty`);
      if (/dangerouslySetInnerHTML|innerHTML|outerHTML/.test(source)) problems.push(`${path}: sets HTML from a string`);
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        const spec =
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined;
        if (spec !== undefined && !CONTENT_IMPORT.test(spec)) problems.push(`${path}: imports ${spec}`);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          problems.push(`${path}: a dynamic import`);
        if (ts.isImportEqualsDeclaration(node)) problems.push(`${path}: an import =`);
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  return problems;
}

/**
 * The catalogue rule (P10a): every label of registry/labels and every river has a non-empty nl and en text, a public
 * source's in both message files under its generated key, an owner source's in features/owner/labels.gen.ts.
 */
function catalogueProblems(root: string, messages: Map<string, Record<string, unknown>>): string[] {
  const dir = join(root, 'registry/labels');
  if (!existsSync(dir)) return [];
  const problems: string[] = [];
  const read = (p: string) => parse(readFileSync(join(root, p), 'utf8')) as Record<string, unknown>;
  const audience = new Map(
    (read('registry/sources.yaml').sources as { id: string; audience: string }[]).map((s) => [s.id, s.audience]),
  );
  const ownerPath = join(root, 'apps/web/src/features/owner/labels.gen.ts');
  const ownerSource = existsSync(ownerPath) ? readFileSync(ownerPath, 'utf8') : '';
  const need = (key: string, what: string, texts: Record<string, unknown>, owner: boolean) => {
    for (const loc of LOCALES) {
      if (typeof texts[loc] !== 'string' || texts[loc].trim() === '') {
        problems.push(`${what} has no ${loc} text in the registry`);
      } else if (owner) {
        if (!new RegExp(`\\b${key}\\b`).test(ownerSource))
          problems.push(`${what} ("${key}") is missing in labels.gen.ts`);
      } else {
        const have = messages.get(loc)?.[key];
        if (typeof have !== 'string' || have.trim() === '')
          problems.push(`${what} ("${key}") is missing in ${loc}.json`);
      }
    }
  };
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
    const doc = read(`registry/labels/${f}`) as { source: string; labels: Record<string, unknown>[] };
    for (const l of doc.labels) {
      const label = { source: doc.source, scale: String(l.scale), code: String(l.code) };
      need(
        labelKey(label),
        `label ${label.source} ${label.scale} ${label.code}`,
        l,
        audience.get(doc.source) === 'owner',
      );
    }
  }
  const rivers = existsSync(join(root, 'registry/rivers.yaml'))
    ? (read('registry/rivers.yaml').rivers as Record<string, unknown>[])
    : [];
  for (const r of rivers)
    need(`river_${slug(String(r.id))}`, `river ${String(r.id)}`, { nl: r.name_nl, en: r.name_en }, false);
  return problems;
}

function scan(root: string) {
  const messages = loadMessages(join(root, 'apps/web/messages'), LOCALES);
  const problems = keyDrift(messages);
  for (const [locale, m] of messages) {
    for (const [key, value] of Object.entries(m)) {
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`message "${key}" in ${locale}.json is not a non-empty string`);
      }
    }
  }
  problems.push(...catalogueProblems(root, messages));
  problems.push(...contentProblems(root));
  const files = tsxFiles(root);
  for (const path of files) problems.push(...findHardcoded(path, readFileSync(join(root, path), 'utf8')));
  return { problems: problems.sort(), files: files.length, messages: Object.keys(messages.get('nl') ?? {}).length };
}

/** Every problem found under a repository root, sorted; empty when the tree is clean. */
export const checkI18n = (root: string): string[] => scan(root).problems;

if (import.meta.main) {
  const { problems, files, messages } = scan(resolve(process.argv[2] ?? join(import.meta.dirname, '..')));
  for (const p of problems) console.error(`check-i18n: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`check-i18n: OK (${files} .ts and .tsx files, ${messages} messages)`);
}
