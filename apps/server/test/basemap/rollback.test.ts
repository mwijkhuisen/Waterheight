import { readFileSync } from 'node:fs';
import { appendFile, link, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TilesManifest } from '@rws/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runPromote } from '../../src/basemap/promote.ts';
import { runRollback } from '../../src/basemap/rollback.ts';
import { cleanSandboxes, logs, promoteDeps, type Sandbox, sandbox, stage } from './helpers.ts';

afterEach(cleanSandboxes);

const text = (sb: Sandbox) => readFileSync(join(sb.tiles, 'manifest.json'), 'utf8');
const manifest = (sb: Sandbox): TilesManifest => JSON.parse(text(sb));
const failsWith = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });
const names = (dir: string) => readdir(dir).then((n) => n.sort());

/** Two promoted builds: 20261001 current, 20260930 previous. */
async function twoBuilds(sb: Sandbox) {
  await stage(sb, '20260930');
  await runPromote(promoteDeps(sb).deps, { dryRun: false });
  await stage(sb, '20261001');
  await runPromote(promoteDeps(sb).deps, { dryRun: false });
}
const rollback = (sb: Sandbox, dryRun = false) => {
  const l = logs();
  const out: string[] = [];
  return {
    run: runRollback({ tilesDir: sb.tiles, log: l.log, out: (x) => out.push(x) }, { dryRun }),
    out,
    codes: l.codes,
  };
};

describe('rollback', () => {
  it('swaps current and previous, leaves every file alone, and a second rollback undoes it', async () => {
    const sb = await sandbox();
    await twoBuilds(sb);
    const before = manifest(sb);
    const files = await names(sb.tiles);

    const r = rollback(sb);
    await r.run;
    expect(r.codes()).toEqual(['rolled_back']);
    expect(manifest(sb)).toEqual({ schema_version: 1, current: before.previous, previous: before.current });
    expect(await names(sb.tiles)).toEqual(files);

    await rollback(sb).run;
    expect(manifest(sb)).toEqual(before);
    expect((await names(sb.tiles)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses without a previous build, and without a manifest', async () => {
    const sb = await sandbox();
    await failsWith(rollback(sb).run, 'no_manifest');
    await stage(sb);
    await runPromote(promoteDeps(sb).deps, { dryRun: false });
    const before = text(sb);
    await failsWith(rollback(sb).run, 'no_previous');
    expect(text(sb)).toBe(before);
  });

  it('refuses when the previous files are no longer exactly what the manifest says', async () => {
    const sb = await sandbox();
    await twoBuilds(sb);
    const before = text(sb);
    const prev = join(sb.tiles, 'basemap-20260930.pmtiles');
    await appendFile(prev, 'x');
    await failsWith(rollback(sb).run, 'previous_changed');
    expect(text(sb)).toBe(before);
  });

  it('refuses when a previous file is missing, a link, or has a second name', async () => {
    const sb = await sandbox();
    await twoBuilds(sb);
    const before = text(sb);
    const planet = join(sb.tiles, 'planet-z6-20260930.pmtiles');
    const moved = join(sb.root, 'moved.pmtiles');
    await rename(planet, moved);
    await failsWith(rollback(sb).run, 'previous_missing');
    await symlink(moved, planet);
    await failsWith(rollback(sb).run, 'not_regular_file');
    await rm(planet);
    await rename(moved, planet);
    await link(planet, join(sb.root, 'second-name'));
    await failsWith(rollback(sb).run, 'not_regular_file');
    expect(text(sb)).toBe(before);
  });

  it('refuses a manifest that is not ours', async () => {
    const sb = await sandbox();
    await writeFile(join(sb.tiles, 'manifest.json'), '{}');
    await failsWith(rollback(sb).run, 'manifest_invalid');
  });

  it('a dry run says what it would do and changes nothing', async () => {
    const sb = await sandbox();
    await twoBuilds(sb);
    const before = text(sb);
    const r = rollback(sb, true);
    await r.run;
    expect(r.out.join('\n')).toContain('would make 20260930 current again (previous 20261001)');
    expect(text(sb)).toBe(before);
  });
});
