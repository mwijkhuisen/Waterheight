// Import boundaries (ARCHITECTURE §5), checked in CI:
//   - apps/web never imports apps/server;
//   - packages/* never import apps/*;
//   - apps/server/src/adapters/<id> imports only packages/core, types from
//     apps/server/src/http, its own folder and adapters/_shared/<its provider>
//     (provider from registry/sources.yaml); npm packages and node: builtins
//     are outside this rule;
//   - the view names pub_* and own_* (in any case) appear only in
//     apps/server/src/db/audience.ts: no other TypeScript file under apps/,
//     packages/, scripts/ or test/ (fixture directories included, except this
//     checker's own test trees), and no .sql file under apps/ or packages/
//     (db/migrations is where they are created).
// Usage: node scripts/check-boundaries.ts [repo-root]   (exit 1 on a violation)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';

type Import = { spec: string; typeOnly: boolean };

const AUDIENCE_MODULE = 'apps/server/src/db/audience.ts';
/** SQL folds unquoted names to lower case: an upper-case spelling names the same view. */
const VIEW_NAME = /\b(?:pub|own)_[a-z][a-z0-9_]*\b/i;
/** The deliberately wrong trees this checker is tested on (test/check-boundaries.test.ts): data, not code. */
const CHECKER_FIXTURES = 'scripts/fixtures/boundaries';

const isTypeScript = (name: string) => /\.(?:ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts');

function walk(dir: string, out: string[] = [], wanted: (name: string) => boolean = isTypeScript): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out, wanted);
    else if (wanted(name)) out.push(path);
  }
  return out;
}

/** Every module reference in a file: static, re-export, dynamic import(), require() and import types. */
export function importsOf(file: string, text: string): Import[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Import[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // Only `import type …` is erased. Under verbatimModuleSyntax, `import { type X }`
      // still emits `import {} from '…'`: a runtime import that runs the module.
      found.push({ spec: node.moduleSpecifier.text, typeOnly: node.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) found.push({ spec: expr.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isImport || isRequire) && arg !== undefined) {
        // A computed specifier cannot be checked: treat it as a violation target.
        found.push({ spec: ts.isStringLiteralLike(arg) ? arg.text : '<computed>', typeOnly: false });
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal))
        found.push({ spec: arg.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function workspacePackages(root: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const manifest = join(base, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (pkg.name) names.set(pkg.name, `${group}/${name}`);
    }
  }
  return names;
}

function adapterProviders(root: string): Map<string, string> {
  const file = join(root, 'registry/sources.yaml');
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  const doc = parse(readFileSync(file, 'utf8')) as { sources?: { id: string; provider: string }[] };
  for (const s of doc.sources ?? []) map.set(s.id.toLowerCase(), s.provider);
  return map;
}

/** Repo-relative POSIX path an import points to, or null for npm packages and builtins. */
function target(root: string, fromFile: string, spec: string, packages: Map<string, string>): string | null {
  if (spec === '<computed>') return '<computed>';
  if (spec.startsWith('.') || spec.startsWith('/')) {
    return relative(root, resolve(dirname(fromFile), spec))
      .split(sep)
      .join('/');
  }
  for (const [name, dir] of packages) {
    if (spec === name || spec.startsWith(`${name}/`)) return dir + spec.slice(name.length);
  }
  return null;
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

export function checkBoundaries(root: string): string[] {
  const problems: string[] = [];
  const packages = workspacePackages(root);
  const providers = adapterProviders(root);
  const files = [...walk(join(root, 'apps')), ...walk(join(root, 'packages'))];
  const isSql = (name: string) => name.endsWith('.sql');
  const fixtureTrees = join(root, CHECKER_FIXTURES) + sep;
  const viewNameFiles = [
    ...files,
    ...walk(join(root, 'scripts')).filter((f) => !f.startsWith(fixtureTrees)),
    ...walk(join(root, 'test')),
    ...walk(join(root, 'apps'), [], isSql),
    ...walk(join(root, 'packages'), [], isSql),
  ];
  for (const file of viewNameFiles) {
    const from = relative(root, file).split(sep).join('/');
    if (from === AUDIENCE_MODULE) continue;
    const view = VIEW_NAME.exec(readFileSync(file, 'utf8'))?.[0];
    if (view) problems.push(`${from}: view name ${view} outside ${AUDIENCE_MODULE}`);
  }

  for (const file of files) {
    const from = relative(root, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');

    const adapter = /^apps\/server\/src\/adapters\/([^/]+)(?:\/([^/]+))?\//.exec(from);
    let own: string | null = null;
    let sharedAllowed: string | null = null;
    if (adapter) {
      const [, folder = '', sub = ''] = adapter;
      if (folder === '_shared') {
        own = `apps/server/src/adapters/_shared/${sub}`;
        sharedAllowed = own;
      } else {
        own = `apps/server/src/adapters/${folder}`;
        const provider = providers.get(folder);
        if (provider === undefined) problems.push(`${from}: adapter folder ${folder} is not a registry source ID`);
        else sharedAllowed = `apps/server/src/adapters/_shared/${provider}`;
      }
    }

    for (const { spec, typeOnly } of importsOf(file, text)) {
      const to = target(root, file, spec, packages);
      if (to === null) continue;
      const bad = (why: string) => problems.push(`${from}: imports ${spec} (${why})`);
      if (to === '<computed>') {
        bad('computed module specifier');
        continue;
      }
      if (under(from, 'apps/web') && under(to, 'apps/server')) bad('apps/web must not import apps/server');
      if (under(from, 'packages') && under(to, 'apps')) bad('packages must not import apps');
      if (own !== null) {
        const allowed =
          under(to, 'packages/core') ||
          under(to, own) ||
          (sharedAllowed !== null && under(to, sharedAllowed)) ||
          (typeOnly && under(to, 'apps/server/src/http'));
        if (!allowed) {
          bad('an adapter imports only packages/core, http types, its own folder and _shared/<its provider>');
        }
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const problems = checkBoundaries(root);
  for (const p of problems) console.error(`check-boundaries: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log('check-boundaries: OK');
}
