import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export interface NoticePackage {
  name: string;
  version: string;
  license: string | undefined;
  files: { name: string; text: string }[];
}

/** Top-level files of a package root that carry its licence terms. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const RULE = '='.repeat(72);

// Code-point order, never the locale's: the same inputs must give the same bytes.
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lf = (s: string) => (s.startsWith('\uFEFF') ? s.slice(1) : s).replace(/\r\n?/g, '\n').trimEnd();

/** The packages that give us nothing to ship: no licence file and no "license" field (the build fails on them). */
export function unlicensed(packages: readonly NoticePackage[]): string[] {
  return packages
    .filter((p) => p.files.length === 0 && p.license === undefined)
    .map((p) => `${p.name}@${p.version}`)
    .sort(byCode);
}

/** The notices file: the preamble, then per package (by name) its header and every licence file (by name). */
export function noticesText(packages: readonly NoticePackage[], preamble: string): string {
  const sections = [...packages]
    .sort((a, b) => byCode(a.name, b.name) || byCode(a.version, b.version))
    .map((p) => {
      const files = [...p.files].sort((a, b) => byCode(a.name, b.name));
      const body =
        files.length === 0
          ? ['No licence file was shipped in this package.']
          : files.flatMap((f) => [`--- ${f.name} ---`, lf(f.text), '']).slice(0, -1);
      return [RULE, `${p.name}@${p.version} — ${p.license ?? 'no license field'}`, RULE, '', ...body].join('\n');
    });
  return `${lf(preamble)}\n\n${sections.join('\n\n')}\n`;
}

const preamble = (mapCommit: string) =>
  [
    "Licence texts of the third-party npm packages in this site's JavaScript. Map data: © OpenStreetMap contributors · Protomaps.",
    `The licences of the map glyphs and sprites are in /assets/map/${mapCommit}/LICENSES.md.`,
    'Licentieteksten van de npm-pakketten van derden in de JavaScript van deze site. Kaartgegevens: © OpenStreetMap contributors · Protomaps.',
    `De licenties van de kaartlettertypen en sprites staan in /assets/map/${mapCommit}/LICENSES.md.`,
  ].join('\n');

interface PackageJson {
  name?: unknown;
  version?: unknown;
  license?: unknown;
}

/** The nearest package.json with a name above a module; a sub-folder's `{"type": "module"}` stub has none. */
function packageOf(file: string): { dir: string; json: PackageJson } | undefined {
  for (let dir = dirname(file); basename(dir) !== 'node_modules' && dir !== dirname(dir); dir = dirname(dir)) {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) continue;
    const json = JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
    if (typeof json.name === 'string') return { dir, json };
  }
  return undefined;
}

function licenseOf({ license }: PackageJson): string | undefined {
  if (typeof license === 'string') return license;
  // Old packages write {"type": "MIT", "url": …}.
  const type = (license as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * Emits third-party-notices.txt: the licence files of every npm package that has
 * a module in any chunk of the bundle (the lazy map chunks included). Our own
 * workspace packages are not under node_modules and are left out. The build
 * fails for a package that ships neither a licence file nor a "license" field.
 * Ceiling: Vite builds a `?worker&url` file in a bundle of its own that this
 * hook does not see; the MapLibre worker only imports maplibre-gl's own files.
 */
export function thirdPartyNotices(): Plugin {
  let mapAssets = '';
  return {
    name: 'rws-third-party-notices',
    configResolved(config) {
      mapAssets = join(config.publicDir, 'assets', 'map');
    },
    generateBundle(_, bundle) {
      const commits = existsSync(mapAssets)
        ? readdirSync(mapAssets, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [];
      if (commits.length !== 1)
        this.error(`${mapAssets}: expected one directory (the assets commit), found ${commits.length}`);

      const roots = new Map<string, PackageJson>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const file = id.split('?')[0] ?? id;
          if (file.startsWith('\0') || !file.includes('/node_modules/')) continue;
          const found = packageOf(file);
          if (found === undefined) this.error(`${file}: no package.json with a name above this module`);
          roots.set(found.dir, found.json);
        }
      }

      // pnpm can keep one name@version under several peer sets: the text is the same, list it once.
      const packages = new Map<string, NoticePackage>();
      for (const dir of [...roots.keys()].sort(byCode)) {
        const json = roots.get(dir) ?? {};
        const name = String(json.name);
        const version = typeof json.version === 'string' ? json.version : 'unknown';
        if (packages.has(`${name}@${version}`)) continue;
        const files = readdirSync(dir)
          .filter((f) => LICENCE_FILE.test(f) && statSync(join(dir, f)).isFile())
          .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
        packages.set(`${name}@${version}`, { name, version, license: licenseOf(json), files });
      }

      const missing = unlicensed([...packages.values()]);
      if (missing.length > 0) this.error(`no licence file and no "license" field: ${missing.join(', ')}`);
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-notices.txt',
        source: noticesText([...packages.values()], preamble(commits[0] ?? '')),
      });
    },
  };
}
