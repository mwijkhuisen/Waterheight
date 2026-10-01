import { existsSync, readFileSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { delay, HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { server } from '../../../../test/msw.setup.ts';
import { COMMANDS, parseArgs, runBasemap, USAGE } from '../../src/basemap/index.ts';
import { EXIT_CONFIG, EXIT_USAGE, ROLES, run } from '../../src/main.ts';
import { fakeResolver, mswTransport } from '../helpers.ts';
import {
  BUILD,
  BUILDS_URL,
  cleanSandboxes,
  LOBITH_SUM,
  logs,
  NOW,
  type Sandbox,
  sandbox,
  stage,
  TILES_BASE,
  testBasemap,
} from './helpers.ts';

afterEach(cleanSandboxes);

const quiet = () => {};

describe('argument parsing', () => {
  it('knows the role and its commands', () => {
    expect(ROLES).toContain('basemap');
    expect(COMMANDS).toEqual(['fetch', 'promote', 'rollback']);
  });

  it.each([
    [['fetch'], { cmd: 'fetch', dryRun: false }],
    [['fetch', '--dry-run'], { cmd: 'fetch', dryRun: true }],
    [['fetch', '--build', '20260930'], { cmd: 'fetch', dryRun: false, build: '20260930' }],
    [['fetch', '--dry-run', '--build', '20260930'], { cmd: 'fetch', dryRun: true, build: '20260930' }],
    [['fetch', '--build', '20260930', '--dry-run'], { cmd: 'fetch', dryRun: true, build: '20260930' }],
    [['promote'], { cmd: 'promote', dryRun: false }],
    [['promote', '--dry-run'], { cmd: 'promote', dryRun: true }],
    [['rollback'], { cmd: 'rollback', dryRun: false }],
    [['rollback', '--dry-run'], { cmd: 'rollback', dryRun: true }],
  ])('parses %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([
    [[]],
    [['nope']],
    [['FETCH']],
    [['fetch', 'extra']],
    [['fetch', '--build']],
    [['fetch', '--build', '--dry-run']],
    [['fetch', '--build', '2026-09-30']],
    [['fetch', '--build', '2026093']],
    [['fetch', '--build', '20260931']],
    [['fetch', '--build', '20261301']],
    [['fetch', '--build', '20260930', '--build', '20260929']],
    [['fetch', '--build=20260930']],
    [['fetch', '--dry-run', '--dry-run']],
    [['fetch', '--force']],
    [['promote', '--build', '20260930']],
    [['rollback', '--build', '20260930']],
    [['rollback', 'now']],
    [['promote', '-n']],
  ])('rejects %j', (argv) => {
    expect(parseArgs(argv)).toBeNull();
  });

  it('a usage error is exit 64, from the role dispatcher too, before anything is touched', async () => {
    const lines: string[] = [];
    expect(await runBasemap(['fetch', '--wat'], {}, (l) => lines.push(l))).toBe(EXIT_USAGE);
    expect(lines).toEqual([USAGE]);
    expect(await run(['basemap'], {}, quiet)).toBe(EXIT_USAGE);
    expect(await run(['basemap', 'nope'], {}, quiet)).toBe(EXIT_USAGE);
    expect(await run(['basemap', 'promote', '--build', '20261001'], {}, quiet)).toBe(EXIT_USAGE);
    expect(await run(['capture', 'fetch'], {}, quiet)).toBe(EXIT_USAGE);
  });
});

/** The env of a job container, with a registry file in the sandbox. */
async function env(sb: Sandbox, over: Record<string, string | undefined> = {}) {
  const registry = join(sb.work, 'basemap.yaml');
  await writeFile(registry, stringify(testBasemap()));
  return {
    PATH: process.env.PATH,
    RWS_BASEMAP_REGISTRY: registry,
    RWS_TILES_DIR: sb.tiles,
    RWS_STAGING_DIR: sb.staging,
    RWS_PMTILES_BIN: sb.bin,
    RWS_DOMAIN: 'example.org',
    RWS_CONTACT_EMAIL: 'owner@example.org',
    ...over,
  };
}

const exec = async (argv: string[], e: Record<string, string | undefined>, over = {}) => {
  const l = logs();
  const code = await runBasemap(argv, e, quiet, { log: l.log, out: quiet, ...over });
  return { code, lines: l.lines, codes: l.codes() };
};

describe('configuration errors are exit 78', () => {
  it('fetch refuses to start without a contact User-Agent (the A2 switch), before any request', async () => {
    const sb = await sandbox();
    for (const over of [
      { RWS_DOMAIN: undefined },
      { RWS_CONTACT_EMAIL: undefined },
      { RWS_DOMAIN: 'not a domain' },
      { RWS_CONTACT_EMAIL: 'nobody' },
    ]) {
      const r = await exec(['fetch'], await env(sb, over));
      expect(r.code).toBe(EXIT_CONFIG);
      expect(r.codes).toContain('env_contact');
    }
    // The real dispatcher, with the process environment of this test run having neither.
    expect(await run(['basemap', 'fetch'], { RWS_BASEMAP_REGISTRY: (await env(sb)).RWS_BASEMAP_REGISTRY }, quiet)).toBe(
      EXIT_CONFIG,
    );
  });

  it.each([
    ['a missing file', async () => '/nonexistent/basemap.yaml', 'registry_unreadable'],
    ['not YAML', async (sb: Sandbox) => write(sb, 'a: [unclosed'), 'registry_invalid'],
    ['not a basemap registry', async (sb: Sandbox) => write(sb, 'version: 1\n'), 'registry_invalid'],
    ['an unknown key', async (sb: Sandbox) => write(sb, stringify({ ...testBasemap(), extra: 1 })), 'registry_invalid'],
    [
      'a build URL on a host that is not allowlisted',
      async (sb: Sandbox) => {
        const b = testBasemap();
        b.protomaps.builds_url = 'https://evil.example/builds.json';
        return write(sb, stringify(b));
      },
      'registry_invalid',
    ],
    [
      'far too large',
      async (sb: Sandbox) => write(sb, `# ${'x'.repeat(70_000)}\n${stringify(testBasemap())}`),
      'registry_invalid',
    ],
  ])('fetch and promote refuse a registry that is %s', async (_why, make, code) => {
    const sb = await sandbox();
    const registry = await make(sb);
    for (const cmd of ['fetch', 'promote']) {
      const r = await exec([cmd], await env(sb, { RWS_BASEMAP_REGISTRY: registry }));
      expect(r).toMatchObject({ code: EXIT_CONFIG });
      expect(r.codes).toEqual([code]);
    }
  });

  it('rollback needs no registry: it is the emergency path', async () => {
    const sb = await sandbox();
    const r = await exec(['rollback'], await env(sb, { RWS_BASEMAP_REGISTRY: '/nonexistent/basemap.yaml' }));
    expect(r).toMatchObject({ code: 1, codes: ['no_manifest'] });
  });

  it('a directory that does not exist', async () => {
    const sb = await sandbox();
    expect((await exec(['promote'], await env(sb, { RWS_TILES_DIR: join(sb.root, 'nope') }))).code).toBe(EXIT_CONFIG);
    expect((await exec(['rollback'], await env(sb, { RWS_TILES_DIR: join(sb.root, 'nope') }))).code).toBe(EXIT_CONFIG);
    const fetch = await exec(['fetch'], await env(sb, { RWS_STAGING_DIR: join(sb.root, 'nope') }));
    expect(fetch).toMatchObject({ code: EXIT_CONFIG, codes: ['staging_dir'] });
  });
});

async function write(sb: Sandbox, text: string): Promise<string> {
  const path = join(sb.work, 'other.yaml');
  await writeFile(path, text);
  return path;
}

describe('the role end to end (offline)', () => {
  const list = (build: string, version: string) => [{ key: `${build}.pmtiles`, version }];
  const serve = (build: string, version: string, agents: string[] = []) =>
    server.use(
      http.get(BUILDS_URL, ({ request }) => {
        agents.push(request.headers.get('user-agent') ?? '');
        return HttpResponse.json(list(build, version));
      }),
      http.get(
        `${TILES_BASE}${build}.pmtiles`,
        () => new HttpResponse(new Uint8Array([0]), { status: 206, headers: { 'content-range': 'bytes 0-0/1000' } }),
      ),
    );
  const offline = {
    transport: mswTransport,
    resolver: fakeResolver(),
    now: () => NOW,
    statfs: async () => ({ blocks: 1e9, bfree: 9e8, bavail: 9e8, bsize: 4096 }),
  };

  it('fetch, promote, then fetch again (already current), and rollback after a second build', async () => {
    const sb = await sandbox();
    const e = await env(sb);
    const agents: string[] = [];
    serve(BUILD, '4.15.2', agents);

    expect(await exec(['fetch', '--dry-run'], e, offline)).toMatchObject({ code: 0 });
    expect(await readdir(sb.staging)).toEqual([]);

    const fetched = await exec(['fetch'], e, offline);
    expect(fetched).toMatchObject({ code: 0 });
    expect(fetched.codes).toContain('staged');
    // The dry run and the real run: every request carries the project User-Agent.
    expect(agents).toHaveLength(2);
    for (const agent of agents)
      expect(agent).toBe('rivierstanden/0.1.0 (+https://example.org/over; owner@example.org)');
    expect(await readdir(sb.staging)).toContain('result.json');

    const promoted = await exec(['promote'], e);
    expect(promoted).toMatchObject({ code: 0 });
    const manifest = JSON.parse(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8'));
    expect(manifest.current.build).toBe(BUILD);
    expect(manifest.current.basemap.sha256).toBe(LOBITH_SUM.sha256);
    expect(manifest.previous).toBeNull();

    // The same build again: nothing to do, and no probe of the tiles (no handler for it now).
    server.use(http.get(BUILDS_URL, () => HttpResponse.json(list(BUILD, '4.15.2'))));
    expect(await exec(['fetch'], e, offline)).toMatchObject({
      code: 0,
      codes: ['staging_cleared', 'builds_listed', 'already_current'],
    });

    // A newer build, then a rollback to the first.
    serve('20261002', '4.15.3');
    expect(await exec(['fetch'], e, { ...offline, now: () => new Date('2026-10-02T12:00:00Z') })).toMatchObject({
      code: 0,
    });
    expect(await exec(['promote'], e)).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8')).previous.build).toBe(BUILD);
    expect(await exec(['rollback', '--dry-run'], e)).toMatchObject({ code: 0 });
    expect(JSON.parse(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8')).current.build).toBe('20261002');
    expect(await exec(['rollback'], e)).toMatchObject({ code: 0, codes: ['rolled_back'] });
    expect(JSON.parse(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8')).current.build).toBe(BUILD);
    // The daily run does not take the build that was rolled away from.
    expect(await exec(['fetch'], e, { ...offline, now: () => new Date('2026-10-02T12:00:00Z') })).toMatchObject({
      code: 0,
      codes: ['staging_cleared', 'builds_listed', 'rolled_back_build'],
    });
  });

  it('fetch with a failing extract exits 1 and leaves nothing staged', async () => {
    const sb = await sandbox({ failExtract: 'planet' });
    serve(BUILD, '4.15.2');
    const r = await exec(['fetch'], await env(sb), offline);
    expect(r.code).toBe(1);
    expect(r.codes.at(-1)).toBe('extract_failed');
    expect(await readdir(sb.staging)).toEqual([]);
  });

  it('a network failure is exit 1 with a fixed code and nothing of the provider in the log', async () => {
    const sb = await sandbox();
    server.use(http.get(BUILDS_URL, () => HttpResponse.text('SECRET-PROVIDER-TEXT <script>', { status: 503 })));
    const r = await exec(['fetch'], await env(sb), offline);
    expect(r).toMatchObject({ code: 1 });
    expect(r.codes.at(-1)).toBe('builds_status');
    expect(JSON.stringify(r.lines)).not.toContain('SECRET-PROVIDER-TEXT');
  });

  it('a timeout is exit 1', async () => {
    const sb = await sandbox();
    server.use(
      http.get(BUILDS_URL, async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      }),
    );
    // The role's own timeout is 60 s; an injected stop signal ends it sooner.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const r = await exec(['fetch'], await env(sb), { ...offline, signal: stop.signal });
    expect(r.code).toBe(1);
  });

  it('an unexpected error is exit 1, logged with its name only', async () => {
    const sb = await sandbox();
    server.use(http.get(BUILDS_URL, () => HttpResponse.json([])));
    const now = () => {
      throw new TypeError('message with /secret/path');
    };
    const r = await exec(['fetch'], await env(sb), { ...offline, now });
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toEqual({ level: 'error', code: 'unexpected', name: 'TypeError', error_code: 'other' });
    expect(JSON.stringify(r.lines)).not.toContain('/secret/path');
  });

  it('promote with nothing staged is exit 0 through the real dispatcher', async () => {
    const sb = await sandbox();
    expect(await run(['basemap', 'promote'], await env(sb), quiet)).toBe(0);
    expect(existsSync(join(sb.tiles, 'manifest.json'))).toBe(false);
  });

  it('promote of a staged build through the dispatcher', async () => {
    const sb = await sandbox();
    await stage(sb);
    expect(await run(['basemap', 'promote'], await env(sb), quiet)).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.tiles, 'manifest.json'), 'utf8')).current.build).toBe(BUILD);
  });
});
