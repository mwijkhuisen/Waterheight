import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkTilesManifest, TILE_FILE_RE } from '@rws/core';
import { delay, HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { runFetch } from '../../src/basemap/fetch.ts';
import {
  BUILD,
  BUILDS_URL,
  cleanSandboxes,
  fetchDeps,
  LOBITH_SUM,
  PLANET_SUM,
  type Sandbox,
  sandbox,
  TILES_BASE,
  testBasemap,
} from './helpers.ts';

afterEach(cleanSandboxes);

const PROBE_TOTAL = 138_507_309_367;
/** A build list entry as the provider writes it. */
const listed = (build: string, version: string) => ({ key: `${build}.pmtiles`, size: PROBE_TOTAL, version });
const GOOD = [listed('20260929', '4.14.0'), listed('20260930', '4.15.1'), listed(BUILD, '4.15.2')];

const serveList = (body: unknown, init?: ResponseInit) =>
  server.use(
    http.get(BUILDS_URL, () =>
      typeof body === 'string' ? new HttpResponse(body, init) : HttpResponse.json(body as never, init),
    ),
  );
/** The tiles host answers a ranged read of one byte, as Protomaps does. */
const serveTiles = (build: string, seen?: Headers[]) =>
  server.use(
    http.get(`${TILES_BASE}${build}.pmtiles`, ({ request }) => {
      seen?.push(request.headers);
      return new HttpResponse(new Uint8Array([0]), {
        status: 206,
        headers: { 'content-range': `bytes 0-0/${PROBE_TOTAL}` },
      });
    }),
  );

const names = (dir: string) => readdir(dir).then((n) => n.sort());
const calls = (sb: Sandbox) =>
  existsSync(join(sb.work, 'calls.log')) ? readFileSync(join(sb.work, 'calls.log'), 'utf8').trim().split('\n') : [];
const failsWith = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe('selecting the build', () => {
  it('takes the newest eligible build: old majors, malformed keys, impossible dates and the future are ignored', async () => {
    const sb = await sandbox();
    serveList([
      listed('20261003', '3.9.0'), // older tiles major
      listed('20261004', '5.0.0'), // newer tiles major than the style supports
      listed('20261002', '4.15.3-beta'), // not a plain version
      listed('20261301', '4.15.9'), // not a date
      listed('20260231', '4.15.9'), // not a date
      listed('20261105', '4.16.0'), // after today (2026-10-01)
      { key: '20261002.pmtiles.bak', version: '4.15.3' },
      { key: 'latest.pmtiles', version: '4.15.3' },
      { key: '2026100.pmtiles', version: '4.15.3' },
      { key: '../20261002.pmtiles', version: '4.15.3' },
      { key: 7, version: '4.15.3' },
      'text',
      null,
      ...GOOD,
    ]);
    serveTiles(BUILD);
    const { deps, codes } = fetchDeps(sb);
    await runFetch(deps, { dryRun: false });
    expect(codes()).toContain('staged');
    const result = JSON.parse(readFileSync(join(sb.staging, 'result.json'), 'utf8'));
    expect([result.build, result.version]).toEqual([BUILD, '4.15.2']);
  });

  it('allows tomorrow (a day of slack for clock skew) but not the day after', async () => {
    const sb = await sandbox();
    serveList([listed('20261002', '4.15.3'), listed('20261003', '4.15.4'), listed(BUILD, '4.15.2')]);
    serveTiles('20261002');
    const { deps, out } = fetchDeps(sb);
    await runFetch(deps, { dryRun: true });
    expect(out.join('\n')).toContain('would stage build 20261002 (tiles 4.15.3)');
  });

  it('--build picks that exact listed build, with its own version', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles('20260930');
    const { deps } = fetchDeps(sb);
    await runFetch(deps, { build: '20260930', dryRun: false });
    const result = JSON.parse(readFileSync(join(sb.staging, 'result.json'), 'utf8'));
    expect([result.build, result.version]).toEqual(['20260930', '4.15.1']);
    expect(calls(sb)[0]).toContain('https://build.protomaps.com/20260930.pmtiles');
  });

  it.each([
    ['not listed', '20260928'],
    ['an older tiles major', '20260927'],
    ['a future date', '20261105'],
  ])('--build refuses a build that is %s', async (_why, build) => {
    const sb = await sandbox();
    serveList([...GOOD, listed('20260927', '3.9.0'), listed('20261105', '4.16.0')]);
    const { deps } = fetchDeps(sb);
    await failsWith(runFetch(deps, { build, dryRun: false }), 'build_not_eligible');
    expect(calls(sb)).toEqual([]);
    expect(await names(sb.staging)).toEqual([]);
  });

  it('fails with no_eligible_build when nothing qualifies', async () => {
    const sb = await sandbox();
    serveList([listed('20260930', '3.9.0')]);
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'no_eligible_build');
  });

  it('a date listed twice with two versions is ambiguous and is not taken', async () => {
    const sb = await sandbox();
    serveList([listed(BUILD, '4.15.2'), listed(BUILD, '4.15.9'), listed('20260930', '4.15.1')]);
    serveTiles('20260930');
    const { deps, out } = fetchDeps(sb);
    await runFetch(deps, { dryRun: true });
    expect(out.join('\n')).toContain('would stage build 20260930 (tiles 4.15.1)');
  });
});

describe('what is current', () => {
  const manifestOf = (build: string, previous: string | null = null) => {
    const entry = (b: string) => ({
      build: b,
      version: '4.15.2',
      created_at: '2026-09-30T09:00:00Z',
      basemap: { file: `basemap-${b}.pmtiles`, sha256: LOBITH_SUM.sha256, bytes: LOBITH_SUM.bytes },
      planet: { file: `planet-z6-${b}.pmtiles`, sha256: PLANET_SUM.sha256, bytes: PLANET_SUM.bytes },
    });
    return `${JSON.stringify({ schema_version: 1, current: entry(build), previous: previous === null ? null : entry(previous) })}\n`;
  };

  it('is a no-op when the chosen build is already current: nothing probed, nothing extracted, staging emptied', async () => {
    const sb = await sandbox();
    await writeFile(join(sb.tiles, 'manifest.json'), manifestOf(BUILD));
    await writeFile(join(sb.staging, 'leftover.pmtiles'), 'old');
    await mkdir(join(sb.staging, '.tmp'));
    serveList(GOOD); // no handler for the tiles host: a probe would fail the test
    const { deps, codes, out } = fetchDeps(sb);
    await runFetch(deps, { dryRun: false });
    expect(codes()).toContain('already_current');
    expect(out.join('\n')).toContain('already current');
    expect(calls(sb)).toEqual([]);
    expect(await names(sb.staging)).toEqual([]);
  });

  it('is a no-op for --build of the current build too', async () => {
    const sb = await sandbox();
    await writeFile(join(sb.tiles, 'manifest.json'), manifestOf('20260930'));
    serveList(GOOD);
    const { deps, codes } = fetchDeps(sb);
    await runFetch(deps, { build: '20260930', dryRun: false });
    expect(codes()).toContain('already_current');
  });

  it('does not move backwards, and does not take a build that was rolled back, unless --build asks for it', async () => {
    const sb = await sandbox();
    // Rolled back to 20260930; 20261001 is the previous (the bad one) and the newest listed build.
    await writeFile(join(sb.tiles, 'manifest.json'), manifestOf('20260930', BUILD));
    serveList(GOOD);
    const first = fetchDeps(sb);
    await runFetch(first.deps, { dryRun: false });
    expect(first.codes()).toContain('rolled_back_build');
    expect(calls(sb)).toEqual([]);

    // Current is newer than anything listed: nothing to do either.
    await writeFile(join(sb.tiles, 'manifest.json'), manifestOf('20261002'));
    const second = fetchDeps(sb);
    await runFetch(second.deps, { dryRun: false });
    expect(second.codes()).toContain('not_newer');

    // --build of the build that was rolled away from (now the previous one) is refused: a second rollback brings it back.
    await writeFile(join(sb.tiles, 'manifest.json'), manifestOf('20260930', BUILD));
    serveTiles(BUILD);
    const third = fetchDeps(sb);
    await failsWith(runFetch(third.deps, { build: BUILD, dryRun: false }), 'build_is_previous');
    expect(calls(sb)).toEqual([]);
  });

  it('--build of the previous build fails before staging is touched or anything is fetched, and names --rollback', async () => {
    const sb = await sandbox();
    // Two promotes: current 20261001, previous 20260930.
    await writeFile(join(sb.tiles, 'manifest.json'), manifestOf(BUILD, '20260930'));
    await writeFile(join(sb.staging, 'leftover'), 'x');
    let requests = 0;
    server.use(
      http.get(BUILDS_URL, () => {
        requests += 1;
        return HttpResponse.json(GOOD);
      }),
    );
    serveTiles('20260930');
    const { deps, out, codes } = fetchDeps(sb);
    for (const dryRun of [false, true])
      await failsWith(runFetch(deps, { build: '20260930', dryRun }), 'build_is_previous');
    expect(requests).toBe(0);
    expect(calls(sb)).toEqual([]);
    expect(await names(sb.staging)).toEqual(['leftover']);
    expect(codes()).toEqual([]);
    expect(out).toEqual([
      '20260930 is the previous build: make it current again with rws-basemap-refresh --rollback',
      '20260930 is the previous build: make it current again with rws-basemap-refresh --rollback',
    ]);
    // --build of the current build is still the no-op it was.
    const again = fetchDeps(sb);
    await runFetch(again.deps, { build: BUILD, dryRun: false });
    expect(again.codes()).toContain('already_current');
  });

  it('refuses a manifest that is present but not ours', async () => {
    const sb = await sandbox();
    await writeFile(join(sb.tiles, 'manifest.json'), '{"schema_version":2}');
    serveList(GOOD);
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'manifest_invalid');
  });
});

describe('the network', () => {
  it('sends the project User-Agent and a one-byte range to the tiles host, and no other request', async () => {
    const sb = await sandbox();
    const agents: string[] = [];
    server.use(
      http.get(BUILDS_URL, ({ request }) => {
        agents.push(request.headers.get('user-agent') ?? '');
        return HttpResponse.json(GOOD);
      }),
    );
    const seen: Headers[] = [];
    serveTiles(BUILD, seen);
    const { deps } = fetchDeps(sb);
    await runFetch(deps, { dryRun: true });
    expect(agents).toEqual([deps.userAgent]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get('range')).toBe('bytes=0-0');
    expect(seen[0]?.get('user-agent')).toBe(deps.userAgent);
  });

  it('treats a redirect on the build list as a failure and follows nothing', async () => {
    const sb = await sandbox();
    let requests = 0;
    server.use(
      http.get(BUILDS_URL, () => {
        requests += 1;
        return new HttpResponse(null, { status: 302, headers: { location: `${BUILDS_URL}?again=1` } });
      }),
    );
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'builds_redirect');
    expect(requests).toBe(1);
    expect(await names(sb.staging)).toEqual([]);
  });

  it('treats a redirect on the tiles probe as a failure (go-pmtiles would follow it to any host)', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    let requests = 0;
    server.use(
      http.get(`${TILES_BASE}${BUILD}.pmtiles`, () => {
        requests += 1;
        // Even to the same host, and even with a plain 200 behind it: no redirect is followed.
        return new HttpResponse(null, { status: 307, headers: { location: `${TILES_BASE}${BUILD}.pmtiles?x=1` } });
      }),
    );
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'tiles_redirect');
    expect(requests).toBe(1);
    expect(calls(sb)).toEqual([]);
  });

  it('refuses a host that is not in protomaps.hosts, before any request', async () => {
    const sb = await sandbox();
    const basemap = testBasemap();
    basemap.protomaps.hosts = ['build.protomaps.com']; // the build list's host is not listed
    await failsWith(runFetch(fetchDeps(sb, { basemap }).deps, { dryRun: false }), 'builds_not_allowlisted');
    const other = testBasemap();
    other.protomaps.hosts = ['build-metadata.protomaps.dev']; // the tiles host is not listed
    serveList(GOOD);
    await failsWith(runFetch(fetchDeps(sb, { basemap: other }).deps, { dryRun: false }), 'tiles_not_allowlisted');
  });

  it('refuses plain http and a private address', async () => {
    const sb = await sandbox();
    const basemap = testBasemap();
    basemap.protomaps.builds_url = 'http://build-metadata.protomaps.dev/builds.json';
    await failsWith(runFetch(fetchDeps(sb, { basemap }).deps, { dryRun: false }), 'builds_bad_url');
    const resolver = async () => ['10.0.0.7'];
    await failsWith(runFetch(fetchDeps(sb, { resolver }).deps, { dryRun: false }), 'builds_private_address');
  });

  it('rejects an oversized build list while it streams, before anything parses it', async () => {
    const sb = await sandbox();
    // Not JSON at all: the code is the cap, so the cap came first.
    serveList('x'.repeat(5000));
    await failsWith(
      runFetch(fetchDeps(sb, { basemap: testBasemap({ buildsMax: 1024 }) }).deps, { dryRun: false }),
      'builds_too_large',
    );
  });

  it.each([
    ['not JSON', 'nope', 'builds_invalid'],
    ['not an array', '{"key":"20261001.pmtiles"}', 'builds_invalid'],
    ['nested too deep', `${'['.repeat(40)}${']'.repeat(40)}`, 'builds_invalid'],
  ])('rejects a build list that is %s', async (_why, body, code) => {
    const sb = await sandbox();
    serveList(body);
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), code);
  });

  it('fails on a status other than 200 for the list, and other than 206 with a total for the probe', async () => {
    const sb = await sandbox();
    serveList('[]', { status: 500 });
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'builds_status');

    serveList(GOOD);
    // A server that ignores the range answers 200 (here a tiny body): go-pmtiles needs ranges.
    server.use(http.get(`${TILES_BASE}${BUILD}.pmtiles`, () => new HttpResponse(new Uint8Array([0]))));
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'tiles_status');
    server.use(http.get(`${TILES_BASE}${BUILD}.pmtiles`, () => new HttpResponse(new Uint8Array([0]), { status: 206 })));
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'tiles_status');
    server.use(
      http.get(
        `${TILES_BASE}${BUILD}.pmtiles`,
        () => new HttpResponse(new Uint8Array([0]), { status: 206, headers: { 'content-range': 'bytes 0-0/0' } }),
      ),
    );
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'tiles_status');
    expect(calls(sb)).toEqual([]);
  });

  it('a server that ignores the range and streams the file is cut off at the probe cap', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    server.use(http.get(`${TILES_BASE}${BUILD}.pmtiles`, () => new HttpResponse(new Uint8Array(200_000))));
    await failsWith(runFetch(fetchDeps(sb).deps, { dryRun: false }), 'tiles_too_large');
  });

  it('has a total timeout', async () => {
    const sb = await sandbox();
    server.use(
      http.get(BUILDS_URL, async () => {
        await delay('infinite');
        return HttpResponse.json(GOOD);
      }),
    );
    await failsWith(runFetch(fetchDeps(sb, { httpTimeoutMs: 100 }).deps, { dryRun: false }), 'builds_timeout');
  });
});

describe('the disk guard', () => {
  const disk = (usedFraction: number) => async () => ({
    blocks: 1_000_000,
    bfree: Math.round(1_000_000 * (1 - usedFraction)),
    bavail: Math.round(1_000_000 * (1 - usedFraction)),
    bsize: 1_000_000, // 1 TB; the test registry's extracts take 15 MB
  });

  it('refuses before downloading when used + the extracts would pass disk_max_pct', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const { deps, codes } = fetchDeps(sb, { statfs: disk(0.75) });
    await failsWith(runFetch(deps, { dryRun: false }), 'disk');
    expect(calls(sb)).toEqual([]);
    expect(codes()).not.toContain('extract_started');
  });

  it('passes just under the limit and counts what the extracts may take', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const { deps, codes } = fetchDeps(sb, { statfs: disk(0.74) });
    await runFetch(deps, { dryRun: true });
    expect(codes()).toContain('disk_ok');
    // The extracts that may take 75% of the disk, on an empty disk, are refused as well.
    const big = testBasemap({ basemapMax: 750_000_000_000 });
    await failsWith(runFetch(fetchDeps(sb, { basemap: big, statfs: disk(0.1) }).deps, { dryRun: true }), 'disk');
  });

  it('fails closed when the disk cannot be measured', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const statfs = async () => {
      throw new Error('boom');
    };
    await failsWith(runFetch(fetchDeps(sb, { statfs }).deps, { dryRun: false }), 'disk_unknown');
  });
});

describe('staging', () => {
  it('writes both files under their final names and a result.json that promote will accept', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    await writeFile(join(sb.staging, 'old-leftover'), 'x'); // every run starts clean
    const { deps } = fetchDeps(sb);
    await runFetch(deps, { dryRun: false });

    expect(await names(sb.staging)).toEqual([`basemap-${BUILD}.pmtiles`, `planet-z6-${BUILD}.pmtiles`, 'result.json']);
    const result = JSON.parse(readFileSync(join(sb.staging, 'result.json'), 'utf8'));
    expect(result).toEqual({
      schema_version: 1,
      build: BUILD,
      version: '4.15.2',
      created_at: '2026-10-01T12:00:00Z',
      basemap: { file: `basemap-${BUILD}.pmtiles`, ...LOBITH_SUM },
      planet: { file: `planet-z6-${BUILD}.pmtiles`, ...PLANET_SUM },
    });
    const { schema_version: _v, ...entry } = result;
    expect(() => checkTilesManifest({ schema_version: 1, current: entry, previous: null })).not.toThrow();
    for (const name of await names(sb.staging)) if (name !== 'result.json') expect(TILE_FILE_RE.test(name)).toBe(true);
    // The tiles dir (what Caddy serves) is never written.
    expect(await names(sb.tiles)).toEqual(['.staging']);
  });

  it('runs go-pmtiles with an argument array, the registry extracts and a scrubbed environment', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const { deps } = fetchDeps(sb, {
      env: { PATH: process.env.PATH, GOMEMLIMIT: '300MiB', RWS_CONTACT_EMAIL: 'o@example.org', EXTRA_VAR: 'x' },
    });
    await runFetch(deps, { dryRun: false });
    const scratch = join(sb.staging, '.tmp');
    expect(calls(sb)).toEqual([
      `extract --quiet https://build.protomaps.com/${BUILD}.pmtiles ${scratch}/basemap-${BUILD}.pmtiles --bbox=6,51.8,6.2,51.9 --minzoom=0 --maxzoom=14 --download-threads=4`,
      `extract --quiet https://build.protomaps.com/${BUILD}.pmtiles ${scratch}/planet-z6-${BUILD}.pmtiles --minzoom=0 --maxzoom=2 --download-threads=4`,
    ]);
    const env = readFileSync(join(sb.work, 'env.log'), 'utf8');
    expect(env).toContain(`TMPDIR=${scratch}`);
    expect(env).toContain('GOMEMLIMIT=300MiB');
    expect(env).not.toMatch(/RWS_|EXTRA_VAR/);
  });

  it.each([[undefined], ['lots'], ['300 MiB']])('uses 400MiB for GOMEMLIMIT %s', async (limit) => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const env = limit === undefined ? { PATH: process.env.PATH } : { PATH: process.env.PATH, GOMEMLIMIT: limit };
    await runFetch(fetchDeps(sb, { env }).deps, { dryRun: false });
    expect(readFileSync(join(sb.work, 'env.log'), 'utf8')).toContain('GOMEMLIMIT=400MiB');
  });

  it.each([['basemap'], ['planet']] as const)(
    'a failed %s extract leaves no final-named file, no .tmp and no result.json',
    async (kind) => {
      const sb = await sandbox({ failExtract: kind });
      serveList(GOOD);
      serveTiles(BUILD);
      const { deps, lines } = fetchDeps(sb);
      await failsWith(runFetch(deps, { dryRun: false }), 'extract_failed');
      expect(await names(sb.staging)).toEqual([]);
      // The size of the partial output, read before the cleanup (the fake writes "partial\n"): go-pmtiles prints
      // nothing under --quiet when the file size limit stops it, so this number is what shows the limit.
      expect(lines.find((l) => l.code === 'extract_failed')).toMatchObject({
        kind,
        status: 'exit 3',
        partial_bytes: 8,
      });
    },
  );

  it('refuses an extract larger than the registry allows, and cleans up', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const { deps } = fetchDeps(sb, { basemap: testBasemap({ planetMax: 100 }) });
    await failsWith(runFetch(deps, { dryRun: false }), 'extract_output');
    expect(await names(sb.staging)).toEqual([]);
  });

  it('a go-pmtiles that does not exist is a failure, not a crash', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    const { deps, lines } = fetchDeps(sb, { pmtiles: join(sb.work, 'missing') });
    await failsWith(runFetch(deps, { dryRun: false }), 'extract_failed');
    expect(await names(sb.staging)).toEqual([]);
    // No output file at all: 0, not a missing field.
    expect(lines.find((l) => l.code === 'extract_failed')).toMatchObject({ kind: 'basemap', partial_bytes: 0 });
  });

  it('a stop signal ends go-pmtiles and cleans up', async () => {
    const sb = await sandbox({ hang: 30 });
    serveList(GOOD);
    serveTiles(BUILD);
    const stop = new AbortController();
    const run = runFetch(fetchDeps(sb, { signal: stop.signal }).deps, { dryRun: false });
    setTimeout(() => stop.abort(), 400);
    await failsWith(run, 'extract_failed');
    expect(await names(sb.staging)).toEqual([]);
  });

  it('go-pmtiles is killed at its time limit', async () => {
    const sb = await sandbox({ hang: 30 });
    serveList(GOOD);
    serveTiles(BUILD);
    await failsWith(runFetch(fetchDeps(sb, { extractTimeoutMs: 300 }).deps, { dryRun: false }), 'extract_failed');
    expect(await names(sb.staging)).toEqual([]);
  });

  it('a dry run lists the plan and extracts nothing, and leaves staging as it is', async () => {
    const sb = await sandbox();
    serveList(GOOD);
    serveTiles(BUILD);
    await writeFile(join(sb.staging, 'keep-me'), 'x');
    const { deps, out } = fetchDeps(sb);
    await runFetch(deps, { dryRun: true });
    expect(calls(sb)).toEqual([]);
    expect(await names(sb.staging)).toEqual(['keep-me']);
    const text = out.join('\n');
    expect(text).toContain(`build ${BUILD}`);
    expect(text).toContain(`https://build.protomaps.com/${BUILD}.pmtiles`);
    expect(text).toContain('--bbox=6,51.8,6.2,51.9');
    expect(text).toContain('--maxzoom=2');
  });

  it('needs its directories: a missing staging directory is a configuration error', async () => {
    const sb = await sandbox();
    const err = await runFetch(fetchDeps(sb, { stagingDir: join(sb.root, 'nope') }).deps, { dryRun: false }).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'staging_dir', exit: 78 });
    const err2 = await runFetch(fetchDeps(sb, { tilesDir: join(sb.root, 'nope') }).deps, { dryRun: false }).catch(
      (e) => e,
    );
    expect(err2).toMatchObject({ code: 'tiles_dir', exit: 78 });
  });
});
