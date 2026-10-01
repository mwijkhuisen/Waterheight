import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, chmod, link, mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TilesManifest, tileFileNames } from '@rws/core';
import { afterEach, describe, expect, it } from 'vitest';
import { nextManifest, runPromote } from '../../src/basemap/promote.ts';
import {
  BASEMAP_HEADER,
  cleanSandboxes,
  LOBITH,
  LOBITH_SUM,
  PLANET,
  PLANET_HEADER,
  PLANET_SUM,
  place,
  promoteDeps,
  type Sandbox,
  sandbox,
  stage,
  testBasemap,
} from './helpers.ts';

afterEach(cleanSandboxes);

const names = (dir: string) => readdir(dir).then((n) => n.sort());
const manifest = (sb: Sandbox): TilesManifest => JSON.parse(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8'));
const mode = (path: string) => statSync(path).mode & 0o777;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const failsWith = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });
const promote = (sb: Sandbox, dryRun = false, over = {}) => runPromote(promoteDeps(sb, over).deps, { dryRun });

/** Nothing of the failed promote may have reached the served directory. */
async function untouched(sb: Sandbox, expected: string[] = ['.staging']) {
  expect(await names(sb.tiles)).toEqual(expected);
}

describe('promote: the happy path', () => {
  it('moves the files into the served directory (0644), writes the manifest, empties staging', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    const { deps, codes } = promoteDeps(sb);
    await runPromote(deps, { dryRun: false });

    const files = tileFileNames(entry.build);
    expect(await names(sb.tiles)).toEqual(['.staging', files.basemap, 'manifest.json', files.planet].sort());
    for (const name of [files.basemap, files.planet, 'manifest.json']) expect(mode(join(sb.tiles, name))).toBe(0o644);
    expect(sha(join(sb.tiles, files.basemap))).toBe(LOBITH_SUM.sha256);
    expect(sha(join(sb.tiles, files.planet))).toBe(PLANET_SUM.sha256);
    expect(manifest(sb)).toEqual({ schema_version: 1, current: entry, previous: null });
    expect(await names(sb.staging)).toEqual([]);
    expect(codes()).toContain('promoted');
    // No temporary file is left behind.
    expect((await names(sb.tiles)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('the next build becomes current and the old current becomes previous; retention deletes only stale tile files', async () => {
    const sb = await sandbox();
    await stage(sb, '20260929');
    await promote(sb);
    await stage(sb, '20260930');
    await promote(sb);
    expect(manifest(sb).current.build).toBe('20260930');
    expect(manifest(sb).previous?.build).toBe('20260929');

    // Things that must survive retention: other files, a directory and a link with a tile name.
    place(sb.tiles, 'rivers-nl.pmtiles');
    await writeFile(join(sb.tiles, 'notes.txt'), 'x');
    await mkdir(join(sb.tiles, 'basemap-20250101.pmtiles'));
    const outside = join(sb.root, 'outside.pmtiles');
    await writeFile(outside, 'outside');
    await symlink(outside, join(sb.tiles, 'basemap-20250202.pmtiles'));
    place(sb.tiles, 'planet-z6-20250303.pmtiles'); // a stale one: goes

    await stage(sb, '20261001');
    await promote(sb);
    expect(manifest(sb).current.build).toBe('20261001');
    expect(manifest(sb).previous?.build).toBe('20260930');
    expect(await names(sb.tiles)).toEqual(
      [
        '.staging',
        'basemap-20250101.pmtiles',
        'basemap-20260930.pmtiles',
        'basemap-20261001.pmtiles',
        'manifest.json',
        'notes.txt',
        'planet-z6-20260930.pmtiles',
        'planet-z6-20261001.pmtiles',
        'rivers-nl.pmtiles',
      ].sort(),
    );
    expect(readFileSync(outside, 'utf8')).toBe('outside'); // the link was removed, never followed
    expect(await names(sb.staging)).toEqual([]);
  });

  it('with nothing staged it does nothing, again and again', async () => {
    const sb = await sandbox();
    await stage(sb);
    await promote(sb);
    const before = readFileSync(join(sb.tiles, 'manifest.json'), 'utf8');
    for (let i = 0; i < 2; i += 1) {
      const { deps, codes, out } = promoteDeps(sb);
      await runPromote(deps, { dryRun: false });
      expect(codes()).toEqual(['nothing_staged']);
      expect(out).toEqual(['nothing staged']);
    }
    expect(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8')).toBe(before);
    // Also when there is no staging directory at all.
    await rm(sb.staging, { recursive: true });
    await promote(sb);
  });

  it('a dry run validates and prints the plan, and changes nothing', async () => {
    const sb = await sandbox();
    await stage(sb, '20260930');
    await promote(sb);
    await stage(sb);
    place(sb.tiles, 'basemap-20250303.pmtiles');
    const manifestBefore = readFileSync(join(sb.tiles, 'manifest.json'), 'utf8');
    const stagingBefore = await names(sb.staging);
    const tilesBefore = await names(sb.tiles);
    const { deps, out } = promoteDeps(sb);
    await runPromote(deps, { dryRun: true });
    expect(await names(sb.tiles)).toEqual(tilesBefore);
    expect(await names(sb.staging)).toEqual(stagingBefore);
    expect(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8')).toBe(manifestBefore);
    const text = out.join('\n');
    expect(text).toContain('would promote build 20261001');
    expect(text).toContain('move basemap-20261001.pmtiles');
    expect(text).toContain('manifest: current 20261001, previous 20260930');
    expect(text).toContain('would delete basemap-20250303.pmtiles');
    // A dry run still refuses what a real run would refuse.
    await writeFile(join(sb.staging, 'basemap-20261001.pmtiles'), 'garbage');
    await failsWith(runPromote(promoteDeps(sb).deps, { dryRun: true }), 'sha_mismatch');
  });
});

describe('promote: what it refuses', () => {
  it('a staged file that is a symlink', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    const target = join(sb.root, 'real.pmtiles');
    await rename(join(sb.staging, entry.basemap.file), target);
    await symlink(target, join(sb.staging, entry.basemap.file));
    await failsWith(promote(sb), 'not_regular_file');
    await untouched(sb);
  });

  it('a staged file with a second hard link', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await link(join(sb.staging, entry.planet.file), join(sb.root, 'second-name'));
    await failsWith(promote(sb), 'not_regular_file');
    await untouched(sb);
  });

  it('a staged FIFO, without hanging', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await rm(join(sb.staging, entry.basemap.file));
    execFileSync('mkfifo', [join(sb.staging, entry.basemap.file)]);
    await failsWith(promote(sb), 'not_regular_file');
    await untouched(sb);
  });

  it('a staged directory', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await rm(join(sb.staging, entry.basemap.file));
    await mkdir(join(sb.staging, entry.basemap.file));
    await failsWith(promote(sb), 'not_regular_file');
    await untouched(sb);
  });

  it('a staging directory that is a link', async () => {
    const sb = await sandbox();
    await stage(sb);
    const real = join(sb.root, 'elsewhere');
    await rename(sb.staging, real);
    await symlink(real, sb.staging);
    await failsWith(promote(sb), 'staging_dir');
    await untouched(sb);
  });

  it('a result that names bytes the file does not have', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    const bad = (patch: object) =>
      writeFile(join(sb.staging, 'result.json'), JSON.stringify({ schema_version: 1, ...entry, ...patch }));
    await bad({ basemap: { ...entry.basemap, sha256: 'a'.repeat(64) } });
    await failsWith(promote(sb), 'sha_mismatch');
    await bad({ planet: { ...entry.planet, bytes: entry.planet.bytes + 1 } });
    await failsWith(promote(sb), 'sha_mismatch');
    await untouched(sb);
  });

  it('a staged file that was changed after fetch', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await appendFile(join(sb.staging, entry.basemap.file), 'x');
    await failsWith(promote(sb), 'sha_mismatch');
    await untouched(sb);
  });

  it('a file that is larger than its extract may be', async () => {
    const sb = await sandbox();
    await stage(sb);
    await failsWith(promote(sb, false, { basemap: testBasemap({ planetMax: 1000 }) }), 'file_too_large');
    await untouched(sb);
  });

  it('says which file it refused', async () => {
    const sb = await sandbox({ planetHeader: { ...PLANET_HEADER, maxzoom: 6 } });
    await stage(sb);
    const { deps, lines } = promoteDeps(sb);
    await failsWith(runPromote(deps, { dryRun: false }), 'header_zoom');
    expect(lines).toEqual([{ level: 'error', code: 'file_refused', kind: 'planet', reason: 'header_zoom' }]);
  });

  it('a file that changes under the check', async () => {
    const sb = await sandbox({ tamperOnVerify: true });
    await stage(sb);
    await failsWith(promote(sb), 'file_changed');
    await untouched(sb);
  });

  it('a file that changes after its own check, while the other one is checked', async () => {
    const sb = await sandbox({ tamperPeer: true });
    await stage(sb);
    await failsWith(promote(sb), 'file_changed');
    await untouched(sb);
  });

  it.each([
    ['verify fails', { verifyExit: 1 }, 'verify_failed'],
    ['not vector tiles', { basemapHeader: { ...BASEMAP_HEADER, tile_type: 'png' } }, 'header_type'],
    ['another minzoom', { basemapHeader: { ...BASEMAP_HEADER, minzoom: 1 } }, 'header_zoom'],
    ['a lower maxzoom', { basemapHeader: { ...BASEMAP_HEADER, maxzoom: 13 } }, 'header_zoom'],
    ['planet at another maxzoom', { planetHeader: { ...PLANET_HEADER, maxzoom: 6 } }, 'header_zoom'],
    [
      'bounds west of the bbox',
      { basemapHeader: { ...BASEMAP_HEADER, bounds: [5.5, 51.82, 6.16, 51.88] } },
      'header_bounds',
    ],
    [
      'bounds north of the bbox',
      { basemapHeader: { ...BASEMAP_HEADER, bounds: [6.04, 51.82, 6.16, 52.5] } },
      'header_bounds',
    ],
    ['empty bounds', { basemapHeader: { ...BASEMAP_HEADER, bounds: [6.1, 51.85, 6.1, 51.85] } }, 'header_bounds'],
    ['a planet that is a region', { planetHeader: { ...PLANET_HEADER, bounds: [-10, -10, 10, 10] } }, 'header_bounds'],
    [
      'a planet that stops short in the east',
      { planetHeader: { ...PLANET_HEADER, bounds: [-180, -85, 100, 85] } },
      'header_bounds',
    ],
    ['an unreadable header', { basemapHeader: 'not json' }, 'header_unreadable'],
    ['a header without bounds', { basemapHeader: { tile_type: 'mvt', minzoom: 0, maxzoom: 14 } }, 'header_unreadable'],
    [
      'bounds with a string',
      { basemapHeader: { ...BASEMAP_HEADER, bounds: [6.04, 51.82, '6.16', 51.88] } },
      'header_unreadable',
    ],
  ])('a file whose archive is wrong: %s', async (_why, fake, code) => {
    const sb = await sandbox(fake);
    await stage(sb);
    await failsWith(promote(sb), code);
    await untouched(sb);
    expect(existsSync(join(sb.staging, 'result.json'))).toBe(true); // kept for the owner to look at
  });

  it('accepts bounds within 0.01 degrees of the bbox, and no more', async () => {
    const edge = { ...BASEMAP_HEADER, bounds: [5.995, 51.795, 6.205, 51.905] };
    const sb = await sandbox({ basemapHeader: edge });
    await stage(sb);
    await promote(sb);
    const sb2 = await sandbox({ basemapHeader: { ...BASEMAP_HEADER, bounds: [5.985, 51.82, 6.16, 51.88] } });
    await stage(sb2);
    await failsWith(promote(sb2), 'header_bounds');
  });

  it('a name in the served directory that holds other bytes (files are served immutable)', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await writeFile(join(sb.tiles, entry.basemap.file), 'other bytes');
    await failsWith(promote(sb), 'exists_different');
    expect(readFileSync(join(sb.tiles, entry.basemap.file), 'utf8')).toBe('other bytes');
    expect(existsSync(join(sb.tiles, 'manifest.json'))).toBe(false);
    expect(existsSync(join(sb.tiles, entry.planet.file))).toBe(false);
    expect(await names(sb.staging)).toContain(entry.basemap.file);
  });

  it('a name in the served directory that is a link', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await symlink(LOBITH, join(sb.tiles, entry.basemap.file));
    await failsWith(promote(sb), 'not_regular_file');
  });

  it('a staged file that is missing and not in the served directory', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await rm(join(sb.staging, entry.planet.file));
    await failsWith(promote(sb), 'staged_missing');
    await untouched(sb);
  });

  it.each([
    ['not JSON', 'nope'],
    ['an extra key', JSON.stringify({ schema_version: 1, extra: 1 })],
    ['another schema version', JSON.stringify({ schema_version: 2 })],
    ['an array', '[]'],
    ['too large', ' '.repeat(20_000)],
  ])('a result.json that is %s', async (_why, text) => {
    const sb = await sandbox();
    await stage(sb);
    await writeFile(join(sb.staging, 'result.json'), text);
    await failsWith(promote(sb), 'result_invalid');
    await untouched(sb);
  });

  it('a result.json with an extra key next to a valid entry', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await writeFile(join(sb.staging, 'result.json'), JSON.stringify({ schema_version: 1, ...entry, extra: true }));
    await failsWith(promote(sb), 'result_invalid');
  });

  it('a result.json that is a link', async () => {
    const sb = await sandbox();
    await stage(sb);
    await rename(join(sb.staging, 'result.json'), join(sb.root, 'result.json'));
    await symlink(join(sb.root, 'result.json'), join(sb.staging, 'result.json'));
    await failsWith(promote(sb), 'result_invalid');
  });

  it('a manifest that is present but not ours, before it moves anything', async () => {
    const sb = await sandbox();
    await stage(sb);
    await writeFile(join(sb.tiles, 'manifest.json'), '{"schema_version":2}');
    await failsWith(promote(sb), 'manifest_invalid');
    expect(await names(sb.tiles)).toEqual(['.staging', 'manifest.json']);
  });

  it('a tiles directory that does not exist is a configuration error', async () => {
    const sb = await sandbox();
    const err = await promote({ ...sb, tiles: join(sb.root, 'nope') }).catch((e) => e);
    expect(err).toMatchObject({ code: 'tiles_dir', exit: 78 });
  });
});

describe('promote: a run that was cut short is finished by the next one', () => {
  it('files moved, no manifest yet', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    // The crash: the basemap file was moved (and made 0644); the planet file and the manifest were not.
    await rename(join(sb.staging, entry.basemap.file), join(sb.tiles, entry.basemap.file));
    await chmod(join(sb.tiles, entry.basemap.file), 0o644);
    await promote(sb);
    expect(manifest(sb)).toEqual({ schema_version: 1, current: entry, previous: null });
    expect(sha(join(sb.tiles, entry.basemap.file))).toBe(LOBITH_SUM.sha256);
    expect(sha(join(sb.tiles, entry.planet.file))).toBe(PLANET_SUM.sha256);
    expect(await names(sb.staging)).toEqual([]);
  });

  it('both moved, and the staged copies are still there', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    place(sb.tiles, entry.basemap.file, LOBITH);
    place(sb.tiles, entry.planet.file, PLANET);
    await promote(sb);
    expect(manifest(sb).current.build).toBe(entry.build);
    expect(await names(sb.staging)).toEqual([]);
  });

  it('manifest written, retention and cleanup not done: previous is kept, stale files go', async () => {
    const sb = await sandbox();
    await stage(sb, '20260930');
    await promote(sb);
    const entry = await stage(sb, '20261001');
    await promote(sb);
    // The crash: back to the moment after the manifest was written (result.json and staged copies still there),
    // with a stale file that retention had not yet removed.
    place(sb.tiles, 'basemap-20250101.pmtiles');
    await stage(sb, '20261001');
    const before = manifest(sb);
    await promote(sb);
    const after = manifest(sb);
    expect(after.current.build).toBe('20261001');
    expect(after.previous).toEqual(before.previous);
    expect(after.previous?.build).toBe('20260930');
    expect(after.current.basemap).toEqual(entry.basemap);
    expect(existsSync(join(sb.tiles, 'basemap-20250101.pmtiles'))).toBe(false);
    expect(await names(sb.staging)).toEqual([]);
  });

  it('a converged file that no longer matches is refused', async () => {
    const sb = await sandbox();
    const entry = await stage(sb);
    await rename(join(sb.staging, entry.basemap.file), join(sb.tiles, entry.basemap.file));
    await appendFile(join(sb.tiles, entry.basemap.file), 'x');
    await failsWith(promote(sb), 'exists_different');
    expect(existsSync(join(sb.tiles, 'manifest.json'))).toBe(false);
  });
});

describe('nextManifest', () => {
  const e = (build: string) => ({
    build,
    version: '4.15.2',
    created_at: '2026-10-01T09:00:00Z',
    basemap: { file: `basemap-${build}.pmtiles`, sha256: 'a'.repeat(64), bytes: 1 },
    planet: { file: `planet-z6-${build}.pmtiles`, sha256: 'b'.repeat(64), bytes: 1 },
  });

  it('puts the entry on top of what was current', () => {
    expect(nextManifest(null, e('20261001'))).toEqual({ schema_version: 1, current: e('20261001'), previous: null });
    const m = { schema_version: 1 as const, current: e('20260930'), previous: e('20260929') };
    expect(nextManifest(m, e('20261001'))).toEqual({
      schema_version: 1,
      current: e('20261001'),
      previous: e('20260930'),
    });
  });

  it('keeps the previous when the same build is promoted again', () => {
    const m = { schema_version: 1 as const, current: e('20261001'), previous: e('20260930') };
    expect(nextManifest(m, e('20261001')).previous).toEqual(e('20260930'));
  });
});
