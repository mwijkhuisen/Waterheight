import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isPublicAddress } from '../apps/server/src/http/addresses.ts';
import { server as msw } from './msw.setup.ts';

// P12a (issue #27): the CI-only fake upstream (deploy/tests/e2e/fake-upstream/, compose.fake.yaml). server.mjs runs
// here over plain HTTP (FAKE_PLAIN=1, which exists for this test only: it has no certificate) in a child process,
// the way the container runs it; the TLS path was tried by hand with setup.sh's leaf (see the PR).

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const FAKE_IP = '203.0.115.10';

type Route = { spec: string; host: string; path: string; query?: string; query_prefix?: string; body: string };
/** prepare.ts as setup.sh runs it (the `node` of this test is Node 26 too): the routes and the body sizes. */
function prepared(): { routes: Route[]; bodies: Map<string, number> } {
  const out = mkdtempSync(join(tmpdir(), 'rws-fake-prep-'));
  try {
    execFileSync(
      process.execPath,
      [new URL('../deploy/tests/e2e/fake-upstream/prepare.ts', import.meta.url).pathname, out],
      {
        stdio: 'pipe',
      },
    );
    const routes = JSON.parse(readFileSync(join(out, 'routes.json'), 'utf8')) as Route[];
    const bodies = new Map(
      readdirSync(join(out, 'bodies')).map((f) => [f, readFileSync(join(out, 'bodies', f)).length]),
    );
    return { routes, bodies };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
const { routes, bodies } = prepared();

describe('prepare.ts', () => {
  it('fakes four public providers only, each host on its source allowlist, and no owner source', () => {
    expect(new Set(routes.map((r) => r.host))).toEqual(
      new Set(['www.pegelonline.wsv.de', 'www.hydrodaten.admin.ch', 'inondations.public.lu', 'geo.rijkswaterstaat.nl']),
    );
    expect(routes.map((r) => r.spec).sort()).toEqual(['ch-2-pq', 'de-1-basin', 'de-1-meta', 'lu-1-csv', 'nl-2-wfs']);
    // prepare.ts fails for a spec that is not a public one of its source or whose recorded body fails its validity.
    for (const r of routes) expect(bodies.get(r.body)).toBeGreaterThan(1000);
    // DE-1's two specs share a path: told apart by their exact query; NL-2's request varies: a prefix.
    expect(routes.filter((r) => r.path === '/webservices/rest-api/v2/stations.json').every((r) => r.query)).toBe(true);
    expect(routes.find((r) => r.spec === 'nl-2-wfs')?.query_prefix).toMatch(/^SERVICE=WFS.*&$/);
  });
});

describe('compose.fake.yaml', () => {
  const compose = parse(read('deploy/tests/e2e/compose.fake.yaml')) as {
    services: Record<string, Record<string, unknown>>;
    networks: Record<string, { internal?: boolean; ipam: { config: { subnet: string }[] } }>;
  };

  it('maps exactly the faked hosts and hc-ping.com to the fake, for capture and the watchdog alike', () => {
    const want = [...new Set([...routes.map((r) => r.host), 'hc-ping.com'])].map((h) => `${h}:${FAKE_IP}`).sort();
    for (const s of ['capture', 'watchdog']) {
      const svc = compose.services[s] ?? {};
      expect([...(svc.extra_hosts as string[])].sort(), s).toEqual(want);
      expect(svc.environment, s).toEqual({ NODE_EXTRA_CA_CERTS: '/ci/fake/ca-bundle.pem' });
      expect(svc.networks, s).toEqual(['fake']);
    }
  });

  it('is hardened like the other services, on an internal network with a public-looking address', () => {
    const f = compose.services['fake-upstream'] ?? {};
    expect(f).toMatchObject({
      user: '65532:65532',
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      mem_limit: '64m',
      cpus: 0.25,
      pids_limit: 32,
      entrypoint: ['/nodejs/bin/node', '/fake/server.mjs'],
    });
    expect(f.networks).toEqual({ fake: { ipv4_address: FAKE_IP } });
    expect(compose.networks.fake?.internal).toBe(true);
    expect(compose.networks.fake?.ipam.config).toEqual([{ subnet: '203.0.115.0/24' }]);
    // The SSRF guard must let capture connect to it.
    expect(isPublicAddress(FAKE_IP)).toBe(true);
  });

  it('mounts only /ci/fake and names no production path, secret or CA key', () => {
    const text = read('deploy/tests/e2e/compose.fake.yaml');
    const mounts = [...text.matchAll(/^\s+- (\/\S+?):(\/\S+?)(?::ro)?$/gm)].map((m) => m[1]);
    expect(mounts.length).toBeGreaterThanOrEqual(4);
    for (const m of mounts) expect(m, m).toMatch(/^\/ci\/fake\//);
    const code = text.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/\/srv\/rws|\/etc\/rws|secrets|ca\.key|\/ci\/pki/);
  });

  it('is in no production compose file', () => {
    for (const f of ['deploy/compose.yaml', 'deploy/compose.owner.yaml']) {
      expect(read(f), f).not.toMatch(/fake|extra_hosts|NODE_EXTRA_CA_CERTS/i);
    }
  });
});

describe('server.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rws-fake-'));
  const state = join(dir, 'state');
  const control = join(dir, 'control');
  let child: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    mkdirSync(join(dir, 'bodies'), { recursive: true });
    mkdirSync(state);
    mkdirSync(control);
    writeFileSync(join(dir, 'bodies', 'a.raw'), '{"a":1}');
    writeFileSync(join(dir, 'bodies', 'b.raw'), 'b-body');
    writeFileSync(
      join(dir, 'routes.json'),
      JSON.stringify([
        {
          host: 'One.Example',
          path: '/p',
          query: 'x=1',
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: 'a.raw',
        },
        { host: 'one.example', path: '/p', query_prefix: 'y=', status: 203, headers: {}, body: 'b.raw' },
        {
          host: 'two.example',
          path: '/q',
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: '../../a.raw',
        },
      ]),
    );
    child = spawn(
      process.execPath,
      [new URL('../deploy/tests/e2e/fake-upstream/server.mjs', import.meta.url).pathname],
      {
        env: {
          PATH: process.env.PATH,
          FAKE_PLAIN: '1',
          FAKE_PORT: '0',
          FAKE_DIR: dir,
          FAKE_STATE: state,
          FAKE_CONTROL: control,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('the fake exited')));
      child.stdout?.on('data', (b: Buffer) => {
        const m = /listening on (\d+)/.exec(String(b));
        if (m) resolve(Number(m[1]));
      });
    });
    // msw fails every unhandled request; this one is the child process on loopback.
    msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => HttpResponse.error()));
  });
  afterAll(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (host: string, path: string, method = 'GET', timeout = 2000) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host }, timeout }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
        );
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  const hits = () =>
    readFileSync(join(state, 'hits.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { t: string; host: string; method: string; path: string; status: number });

  it('serves a route by host, path and exact query or query prefix, and 404s the rest', async () => {
    const a = await get('one.example:443', '/p?x=1');
    expect(a).toMatchObject({ status: 200, body: '{"a":1}' });
    expect(a.headers['content-type']).toBe('application/json');
    expect(a.headers['content-length']).toBe('7');
    expect(await get('one.example', '/p?y=anything&z=2')).toMatchObject({ status: 203, body: 'b-body' });
    expect(await get('one.example', '/p?x=2')).toMatchObject({ status: 404 });
    expect(await get('one.example', '/p')).toMatchObject({ status: 404 });
    expect(await get('other.example', '/p?x=1')).toMatchObject({ status: 404 });
    expect(await get('one.example', '/p?x=1', 'POST')).toMatchObject({ status: 404 });
    expect(await get('one.example', '/p?x=1', 'HEAD')).toMatchObject({ status: 200, body: '' });
    // A body name is a basename: ../../a.raw reads bodies/a.raw, never another directory.
    expect(await get('two.example', '/q')).toMatchObject({ status: 200, body: '{"a":1}' });
  });

  it('answers the fake healthchecks for any key, check and kind, on hc-ping.com only', async () => {
    const key = 'abcdefghijklmnop';
    for (const p of [`/${key}/cap-nl`, `/${key}/cap-nl/start`, `/${key}/cap-nl/fail`]) {
      expect(await get('hc-ping.com', p), p).toMatchObject({ status: 200, body: 'OK' });
    }
    expect(await get('hc-ping.com', `/${key}/cap-nl`, 'POST')).toMatchObject({ status: 200, body: 'OK' });
    expect(await get('hc-ping.com', `/${key}/cap-nl/other`)).toMatchObject({ status: 404 });
    expect(await get('hc-ping.com', '/')).toMatchObject({ status: 404 });
    expect(await get('one.example', `/${key}/cap-nl`)).toMatchObject({ status: 404 });
  });

  it('records every request as one JSON line without a query string', async () => {
    const before = hits().length;
    await get('one.example', '/p?y=1&secret=nope');
    const last = hits().slice(before);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ host: 'one.example', method: 'GET', path: '/p', status: 203 });
    expect(Number.isNaN(Date.parse(last[0]?.t ?? ''))).toBe(false);
    expect(readFileSync(join(state, 'hits.jsonl'), 'utf8')).not.toContain('secret');
    // The loopback healthcheck is not a hit.
    expect(await get('127.0.0.1', '/_health')).toMatchObject({ status: 200 });
    expect(hits()).toHaveLength(before + 1);
    expect(await get('one.example', '/_health')).toMatchObject({ status: 404 });
  });

  it('blackholes a listed host per request (file read every time), the others untouched', async () => {
    writeFileSync(join(control, 'blackhole'), '# comment\n\nONE.example\n');
    await expect(get('one.example', '/p?x=1', 'GET', 400)).rejects.toThrow('timeout');
    expect(hits().at(-1)).toMatchObject({ host: 'one.example', path: '/p', status: 0 });
    expect(await get('two.example', '/q')).toMatchObject({ status: 200 });
    expect(await get('hc-ping.com', '/abcdefghijklmnop/cap-nl/fail')).toMatchObject({ status: 200 });
    writeFileSync(join(control, 'blackhole'), 'hc-ping.com\n');
    await expect(get('hc-ping.com', '/abcdefghijklmnop/cap-nl/fail', 'GET', 400)).rejects.toThrow('timeout');
    expect(await get('one.example', '/p?x=1')).toMatchObject({ status: 200 });
    rmSync(join(control, 'blackhole'));
    expect(await get('hc-ping.com', '/abcdefghijklmnop/cap-nl')).toMatchObject({ status: 200 });
  });

  it('survives malformed requests', async () => {
    for (const junk of [
      'GARBAGE\r\n\r\n',
      'GET /\x00\x01 HTTP/1.1\r\nhost: \r\n\r\n',
      'GET / HTTP/1.1\r\n',
      `GET /${'a'.repeat(100_000)} HTTP/1.1\r\n\r\n`,
    ]) {
      await new Promise<void>((resolve) => {
        const s = connect(port, '127.0.0.1', () => s.write(junk));
        s.on('error', () => resolve());
        s.on('close', () => resolve());
        s.setTimeout(300, () => s.destroy());
      });
    }
    expect(child.exitCode).toBeNull();
    expect(await get('hc-ping.com', '/abcdefghijklmnop/cap-nl')).toMatchObject({ status: 200 });
  });
});
