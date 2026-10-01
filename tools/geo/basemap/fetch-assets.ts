// Writes the self-hosted glyphs and sprites of the basemap (P3, ADR-0016): the fonts of
// registry/basemap.yaml `assets.fonts`, the flavour's sprites and the font licence, taken
// unmodified from ONE download of the pinned protomaps/basemaps-assets commit, to
// apps/web/public/assets/map/<first 7 of commit>/ with LICENSES.md and SHA256SUMS
// (`sha256sum` format, sorted by path, every file but itself). Nothing else of the archive is
// extracted. The one request goes to assets.archive_url (invariant 1), without redirects.
//
//   node tools/geo/basemap/fetch-assets.ts            # (re)writes the tree, removing what is no longer listed
//   node tools/geo/basemap/fetch-assets.ts --verify   # changes nothing; exit 1 unless the pinned commit gives
//                                                     # the committed tree and assets.sums_sha256 is the hash of its SHA256SUMS
//
// In the source repository the 252 Devanagari ranges are symbolic links to the same range of
// `Noto Sans Regular`; they are written as regular files with the same bytes (a link in the
// served tree would be followed by the web server). Any other link or entry type is refused.
// Archive text is data: messages name only our own paths.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { type BasemapFile, basemapAssetsPath } from '../../../packages/contracts/src/basemap.ts';
import { ROOT, readBasemap } from './build-style.ts';

const USER_AGENT = 'rivierstanden-geo (+https://github.com/mwijkhuisen/Waterheight)';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
/** The 256 glyph ranges of a font: `0-255.pbf` … `65280-65535.pbf`. */
const RANGES = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}.pbf`);

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT },
  });
  if (res.status !== 200 || res.body === null) throw new Error(`the archive download answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ARCHIVE_BYTES) throw new Error('the archive is too large');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) throw new Error('the archive is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tar(args: string[]): string {
  const r = spawnSync('tar', args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`tar failed (${r.status ?? r.signal})`);
  return r.stdout;
}

function readRegular(path: string, rel: string): Buffer {
  const st = lstatSync(path);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error(`${rel}: not a regular file of a sane size`);
  return readFileSync(path);
}

/** The files to publish, by path relative to the assets directory, from the pinned archive. */
async function collect(b: BasemapFile): Promise<Map<string, Buffer>> {
  const { commit, fonts } = b.assets;
  const top = `basemaps-assets-${commit}`;
  const sprites = ['', '@2x'].flatMap((s) => ['json', 'png'].map((e) => `sprites/v4/${b.style.flavour}${s}.${e}`));
  const licence = b.assets.licences.fonts.file;
  if (!/^fonts\/[A-Za-z0-9._-]+$/.test(licence)) throw new Error('assets.licences.fonts.file: not a file of fonts/');
  const fontFiles = fonts.flatMap((font) => RANGES.map((r) => `fonts/${font}/${r}`));
  const wanted = [licence, ...sprites, ...fontFiles];

  const dir = mkdtempSync(join(tmpdir(), 'rws-assets-'));
  try {
    const archive = join(dir, 'assets.tar.gz');
    const bytes = await download(b.assets.archive_url);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('the archive is not gzip');
    writeFileSync(archive, bytes);

    // What the archive holds, before anything is extracted: every wanted file, and exactly 256 ranges per font.
    const listed = new Set(tar(['-tzf', archive]).split('\n'));
    for (const rel of wanted) if (!listed.has(`${top}/${rel}`)) throw new Error(`${rel}: not in the archive`);
    for (const font of fonts) {
      const prefix = `${top}/fonts/${font}/`;
      const n = [...listed].filter((name) => name.startsWith(prefix) && name.endsWith('.pbf')).length;
      if (n !== RANGES.length) throw new Error(`fonts/${font}: ${n} range files instead of ${RANGES.length}`);
    }

    // Only the wanted members: a link or directory the archive adds is never created.
    const out = join(dir, 'out');
    mkdirSync(out);
    tar(['-xzf', archive, '-C', out, '--no-same-owner', '--no-same-permissions', ...wanted.map((r) => `${top}/${r}`)]);

    const files = new Map<string, Buffer>();
    for (const rel of wanted) {
      const path = join(out, top, rel);
      if (!lstatSync(path).isSymbolicLink()) {
        files.set(rel, readRegular(path, rel));
        continue;
      }
      // `../<another listed font>/<the same range>`, and there a regular file.
      const m = /^\.\.\/([A-Za-z0-9 ]+)\/([0-9]+-[0-9]+\.pbf)$/.exec(readlinkSync(path));
      const font = m?.[1];
      if (font === undefined || !fonts.includes(font) || m?.[2] !== basename(rel) || !rel.startsWith('fonts/'))
        throw new Error(`${rel}: a link that is not to another listed font`);
      files.set(rel, readRegular(join(out, top, 'fonts', font, basename(rel)), rel));
    }
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function licencesText(b: BasemapFile): string {
  const { repo, commit, fonts, licences } = b.assets;
  return `${[
    '# Licences of the map assets',
    '',
    `Fonts and sprites of ${repo} at commit ${commit}, copied by tools/geo/basemap/fetch-assets.ts from that one`,
    'commit. Every file here is byte for byte the file of that name in the commit (the Devanagari ranges that the',
    'commit links to the Noto Sans Regular ranges are copies of those files), and is listed with its sha256 in',
    'SHA256SUMS.',
    '',
    '## Fonts (fonts/)',
    '',
    `Glyph ranges of ${fonts.join(', ')}.`,
    `Licence: SIL Open Font License 1.1 (${licences.fonts.spdx}), see ${licences.fonts.file}.`,
    '',
    `## Sprites (sprites/v4/${b.style.flavour}*.json and *.png)`,
    '',
    `Licence: MIT (${licences.sprites.spdx}), ${licences.sprites.note}.`,
    'Copyright (c) 2017 Mapzen',
    licences.sprites.url,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated',
    'documentation files (the "Software"), to deal in the Software without restriction, including without limitation',
    'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,',
    'and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions',
    'of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED',
    'TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL',
    'THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF',
    'CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER',
    'DEALINGS IN THE SOFTWARE.',
  ].join('\n')}\n`;
}

/** `sha256sum` format, sorted by path in byte order, every file but SHA256SUMS itself. */
function sumsText(files: Map<string, Buffer>): string {
  const byPath = ([a]: [string, Buffer], [b]: [string, Buffer]) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  return [...files]
    .sort(byPath)
    .map(([path, data]) => `${sha256(data)}  ${path}\n`)
    .join('');
}

/** How the committed tree differs from the expected one (paths only). */
function differences(dir: string, expected: Map<string, Buffer>): string[] {
  const found = new Map<string, Buffer | null>();
  if (existsSync(dir)) {
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const path = join(e.parentPath, e.name);
      if (e.isDirectory()) continue;
      found.set(relative(dir, path), e.isFile() ? readFileSync(path) : null);
    }
  }
  const out: string[] = [];
  for (const [rel, data] of expected) {
    const have = found.get(rel);
    if (have === undefined) out.push(`missing: ${rel}`);
    else if (have === null) out.push(`not a regular file: ${rel}`);
    else if (!have.equals(data)) out.push(`changed: ${rel}`);
  }
  for (const rel of found.keys()) if (!expected.has(rel)) out.push(`not listed: ${rel}`);
  return out;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--verify')) {
    console.error('usage: node tools/geo/basemap/fetch-assets.ts [--verify]');
    return 64;
  }
  const verify = args.length > 0;
  const b = readBasemap();
  const dir = join(ROOT, 'apps/web/public', basemapAssetsPath(b));
  const files = await collect(b);
  files.set('LICENSES.md', Buffer.from(licencesText(b)));
  const sums = sumsText(files);
  files.set('SHA256SUMS', Buffer.from(sums));
  const sumsHash = sha256(sums);
  const bytes = [...files.values()].reduce((n, d) => n + d.length, 0);
  console.log(`${files.size} files (SHA256SUMS included), ${bytes} bytes, SHA256SUMS sha256 ${sumsHash}`);

  const registryMatches = b.assets.sums_sha256 === sumsHash;
  if (verify) {
    const diff = differences(dir, files);
    for (const line of diff.slice(0, 20)) console.error(`fetch-assets: ${line}`);
    if (diff.length > 20) console.error(`fetch-assets: and ${diff.length - 20} more`);
    if (!registryMatches) console.error('fetch-assets: registry/basemap.yaml assets.sums_sha256 is not that hash');
    if (diff.length > 0 || !registryMatches) return 1;
    console.log('verified: the committed tree is the pinned commit, and the registry names its SHA256SUMS');
    return 0;
  }
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, data] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
  if (!registryMatches) console.log('put that hash into registry/basemap.yaml assets.sums_sha256');
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main().catch((err: unknown) => {
    console.error(`fetch-assets: ${err instanceof Error ? err.message : 'failed'}`);
    return 1;
  });
}
