// Bill of materials check (ARCHITECTURE §3; CLAUDE.md "Bill of materials").
// The BOM table in CLAUDE.md must match the pins that are really in use:
//   - npm rows (installed) <-> every direct dependency in the workspace
//     package.json files <-> the pnpm-lock.yaml importers, in both directions,
//     each pinned to an exact version; TypeScript must stay on major 6;
//   - node <-> .node-version; pnpm <-> packageManager and the lockfile's own pin;
//   - action, image and binary rows (installed) <-> the pins in the workflows,
//     the hook, scripts/*.sh and every file under deploy/ (bootstrap, Dockerfiles,
//     compose files), and every action, CI image or Dockerfile base has a row.
//   - supply chain: every locked package resolves by registry integrity, and
//     every minimumReleaseAgeExclude entry carries an unexpired "# expires" date.
// "planned" rows are skipped. Usage: node scripts/check-bom.ts [repo-root]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

type Row = { name: string; kind: string; version: string; status: string; pin: string };
const KINDS = ['npm', 'runtime', 'tool', 'action', 'image', 'binary'];
const EXACT = /^\d+\.\d+\.\d+$/;

export function readBom(claudeMd: string): Row[] {
  const start = claudeMd.indexOf('<!-- bom:start -->');
  const end = claudeMd.indexOf('<!-- bom:end -->');
  if (start < 0 || end < start) throw new Error('CLAUDE.md has no <!-- bom:start --> … <!-- bom:end --> block');
  const rows = claudeMd
    .slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Component '))
    .map((l) => l.split('|').map((c) => c.trim().replace(/`/g, '')));
  return rows.map(([, name = '', kind = '', version = '', status = '', pin = '']) => ({
    name,
    kind,
    version,
    status,
    pin,
  }));
}

function manifests(root: string): { path: string; json: Record<string, unknown> }[] {
  const out = [{ path: '.', json: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) }];
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const file = join(base, name, 'package.json');
      if (existsSync(file)) out.push({ path: `${group}/${name}`, json: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return out;
}

type LockDep = { specifier?: string; version?: string };
type Importer = Record<string, Record<string, LockDep> | undefined>;

function lockImporters(root: string): Map<string, Importer> {
  const importers = new Map<string, Importer>();
  for (const doc of parseAllDocuments(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))) {
    const json = doc.toJSON() as { importers?: Record<string, Importer> } | null;
    for (const [path, importer] of Object.entries(json?.importers ?? {})) {
      importers.set(path, { ...importers.get(path), ...importer });
    }
  }
  return importers;
}

function filesOf(root: string, dirs: string[]): string[] {
  const texts: string[] = [];
  for (const dir of dirs) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base)) {
      if (/\.(?:ya?ml|sh)$/.test(f)) texts.push(readFileSync(join(base, f), 'utf8'));
    }
  }
  return texts;
}

/** Every regular file under deploy/ (host scripts have no extension), with its path. */
function deployFiles(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push({ path: path.slice(root.length + 1), text: readFileSync(path, 'utf8') });
    }
  };
  walk(join(root, 'deploy'));
  return out;
}

/**
 * Supply-chain rules for the lockfile and the release-age override (risk R-008):
 * every locked package resolves from the registry by integrity (no tarball URL,
 * git repository or directory), and every minimumReleaseAgeExclude entry names
 * an expiry date ("# expires YYYY-MM-DD") that has not passed.
 */
export function checkSupplyChain(root: string, today = new Date().toISOString().slice(0, 10)): string[] {
  const problems: string[] = [];
  for (const doc of parseAllDocuments(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))) {
    const json = doc.toJSON() as { packages?: Record<string, { resolution?: Record<string, unknown> }> } | null;
    for (const [name, pkg] of Object.entries(json?.packages ?? {})) {
      const keys = Object.keys(pkg.resolution ?? {});
      if (keys.length !== 1 || keys[0] !== 'integrity') {
        problems.push(`pnpm-lock.yaml ${name}: resolves by ${keys.join(', ') || 'nothing'}, not by registry integrity`);
      }
    }
  }
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const excluded = (parse(workspace) as { minimumReleaseAgeExclude?: unknown } | null)?.minimumReleaseAgeExclude;
  if (excluded !== undefined) {
    if (!Array.isArray(excluded)) problems.push('pnpm-workspace.yaml: minimumReleaseAgeExclude must be a list');
    for (const entry of Array.isArray(excluded) ? excluded : []) {
      const line = workspace
        .split('\n')
        .find((l) =>
          new RegExp(`^\\s*-\\s*['"]?${String(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*#`).test(l),
        );
      const expires = /#.*\bexpires (\d{4}-\d{2}-\d{2})\b/.exec(line ?? '')?.[1];
      if (expires === undefined) {
        problems.push(`pnpm-workspace.yaml: minimumReleaseAgeExclude ${entry} needs a "# expires YYYY-MM-DD" comment`);
      } else if (expires < today) {
        problems.push(`pnpm-workspace.yaml: minimumReleaseAgeExclude ${entry} expired on ${expires}; remove it`);
      }
    }
  }
  return problems;
}

export function checkBom(root: string): string[] {
  const problems: string[] = [];
  const bom = readBom(readFileSync(join(root, 'CLAUDE.md'), 'utf8'));
  const names = new Set<string>();
  for (const r of bom) {
    if (!KINDS.includes(r.kind)) problems.push(`BOM row ${r.name}: unknown kind "${r.kind}"`);
    if (r.status !== 'installed' && r.status !== 'planned')
      problems.push(`BOM row ${r.name}: status must be installed or planned`);
    if (names.has(r.name)) problems.push(`BOM row ${r.name}: duplicate`);
    names.add(r.name);
  }
  const installed = bom.filter((r) => r.status === 'installed');
  const npmRows = new Map(installed.filter((r) => r.kind === 'npm').map((r) => [r.name, r]));

  // npm: package.json <-> BOM <-> lockfile.
  const importers = lockImporters(root);
  const used = new Set<string>();
  for (const { path, json } of manifests(root)) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = (json[field] ?? {}) as Record<string, string>;
      for (const [name, spec] of Object.entries(deps)) {
        if (spec.startsWith('workspace:')) continue;
        used.add(name);
        const where = `${path}/package.json ${name}@${spec}`;
        if (!EXACT.test(spec)) problems.push(`${where}: not an exact version`);
        const row = npmRows.get(name);
        if (row === undefined) problems.push(`${where}: no installed npm row in the CLAUDE.md bill of materials`);
        else if (row.version !== spec) problems.push(`${where}: the bill of materials says ${row.version}`);
        const locked = importers.get(path)?.[field]?.[name];
        if (locked?.specifier !== spec || !(locked.version === spec || locked.version?.startsWith(`${spec}(`))) {
          problems.push(
            `${where}: pnpm-lock.yaml has ${locked?.specifier ?? 'nothing'} -> ${locked?.version ?? 'nothing'}`,
          );
        }
      }
    }
  }
  for (const name of npmRows.keys()) {
    if (!used.has(name)) problems.push(`BOM row ${name}: installed, but no package.json depends on it`);
  }
  const typescript = npmRows.get('typescript');
  if (typescript === undefined || !typescript.version.startsWith('6.')) {
    problems.push('typescript must stay on major 6 (TS 7 is forbidden: no stable API, tooling caps TS below 6.1)');
  }

  // Runtime and package manager.
  const node = installed.find((r) => r.kind === 'runtime' && r.name === 'node');
  const nodeVersion = existsSync(join(root, '.node-version'))
    ? readFileSync(join(root, '.node-version'), 'utf8').trim()
    : '';
  if (node?.version !== nodeVersion)
    problems.push(`node: .node-version is ${nodeVersion || 'missing'}, the BOM says ${node?.version}`);
  const pnpm = installed.find((r) => r.kind === 'tool' && r.name === 'pnpm');
  const packageManager = String(manifests(root)[0]?.json.packageManager ?? '');
  if (pnpm === undefined || !packageManager.startsWith(`pnpm@${pnpm.version}+sha512.`)) {
    problems.push(`pnpm: packageManager is "${packageManager}", the BOM says ${pnpm?.version}`);
  }
  const lockedPnpm = importers.get('.')?.packageManagerDependencies?.pnpm?.version;
  if (pnpm !== undefined && lockedPnpm !== pnpm.version)
    problems.push(`pnpm: pnpm-lock.yaml pins ${lockedPnpm}, the BOM says ${pnpm.version}`);

  // Actions, images, binaries and the pinned tool downloads.
  const workflows = filesOf(root, ['.github/workflows']).join('\n');
  const deploy = deployFiles(root);
  const pinnedFiles = [...filesOf(root, ['.github/workflows', '.claude/hooks', 'scripts']), ...deploy.map((f) => f.text)];
  const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const r of installed.filter((r) => ['action', 'image', 'binary', 'runtime', 'tool'].includes(r.kind))) {
    if (r.pin === '' || r.pin === '–') {
      if (r.kind !== 'runtime' && r.kind !== 'tool')
        problems.push(`BOM row ${r.name}: installed ${r.kind} without a pin`);
      continue;
    }
    // The pin and the version must sit in the same file, the version as an assignment
    // (ZIZMOR_VERSION: v1.30.1 next to ZIZMOR_SHA256; NODE_VERSION=26.10.0; PG_MAJOR=18).
    // An image reference carries its tag in the pin itself.
    const assigned = new RegExp(`(?:VERSION|MAJOR)[=:]\\s*['"]?v?${re(r.version)}['"]?(?=\\s|$)`, 'm');
    const found =
      r.kind === 'action'
        ? new RegExp(`uses:\\s*${re(r.name)}(?:/[^@\\s]+)?@${re(r.pin)} # v${re(r.version)}$`, 'm').test(workflows)
        : r.kind === 'image'
          ? pinnedFiles.some((text) => text.includes(r.pin))
          : pinnedFiles.some((text) => text.includes(r.pin) && assigned.test(text));
    if (!found) {
      problems.push(
        `BOM row ${r.name}: pin ${r.pin} with version ${r.version} not found together in the workflows, hook or scripts`,
      );
    }
  }
  const actionRows = new Map(installed.filter((r) => r.kind === 'action').map((r) => [r.name, r.pin]));
  for (const [, repo = '', sha] of workflows.matchAll(/^\s*(?:-\s+)?uses:\s*([^@\s]+)@(\S+)/gm)) {
    const name = repo.split('/').slice(0, 2).join('/');
    if (actionRows.get(name) !== sha)
      problems.push(`workflow uses ${repo}@${sha}: no installed action row with that pin`);
  }
  const imageRows = new Set(installed.filter((r) => r.kind === 'image').map((r) => r.pin));
  for (const [, image = ''] of workflows.matchAll(/^\s*image:\s*(\S+)/gm)) {
    if (!imageRows.has(image)) problems.push(`workflow image ${image}: no installed image row with that pin`);
  }
  for (const { path, text } of deploy) {
    if (!/(?:^|\/)Dockerfile$/.test(path)) continue;
    for (const [, image = ''] of text.matchAll(/^FROM\s+(\S+)/gm)) {
      if (!imageRows.has(image)) problems.push(`${path}: base image ${image} has no installed image row with that pin`);
    }
  }
  return [...problems, ...checkSupplyChain(root)];
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const problems = checkBom(root);
  for (const p of problems) console.error(`check-bom: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log('check-bom: OK');
}
