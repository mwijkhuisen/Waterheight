import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pinger } from '../../src/capture/pings.ts';
import { Client, errorCode, readBody, undiciTransport } from '../../src/http/client.ts';
import { Politeness } from '../../src/http/politeness.ts';
import type { Transport } from '../../src/http/types.ts';
import { fakeResolver } from '../helpers.ts';

// The production undici transport, against a local plain-HTTP server (no TLS
// key is committed). msw never sees undici; nothing here leaves the machine:
// every name resolves through a fake lookup to 127.0.0.1. Loopback is allowed
// only by the constructor argument in the positive-path tests.

const loopbackDns = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
const onlyLoopback = (a: string) => a === '127.0.0.1' || a === '::ffff:127.0.0.1';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; sockets: () => number }> {
  let sockets = 0;
  server = createServer(handler);
  server.on('connection', () => {
    sockets += 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, sockets: () => sockets };
}

const call = (t: ReturnType<typeof undiciTransport>['transport'], url: string, signal = AbortSignal.timeout(5000)) =>
  t({ url: new URL(url), method: 'GET', headers: {}, signal });

describe('undici transport', () => {
  it('refuses loopback in the connect-time lookup, before any connection', async () => {
    const s = await listen((_q, r) => r.end('x'));
    const { transport } = undiciTransport(new Set(['provider.test']), undefined, loopbackDns);
    const err = await call(transport, `http://provider.test:${s.port}/`).catch((e: unknown) => e);
    expect(errorCode(err, AbortSignal.timeout(1000))).toBe('private_address');
    expect(s.sockets()).toBe(0);
  });

  it('refuses a host outside the union allowlist', async () => {
    const s = await listen((_q, r) => r.end('x'));
    const { transport } = undiciTransport(new Set(['provider.test']), onlyLoopback, loopbackDns);
    const err = await call(transport, `http://other.test:${s.port}/`).catch((e: unknown) => e);
    expect(errorCode(err, AbortSignal.timeout(1000))).toBe('not_allowlisted');
    expect(s.sockets()).toBe(0);
  });

  it('opens at most two connections per origin', async () => {
    let active = 0;
    let peak = 0;
    const s = await listen((_q, r) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        r.end('ok');
      }, 50);
    });
    const { transport, agent } = undiciTransport(new Set(['provider.test']), onlyLoopback, loopbackDns);
    const bodies = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const res = await call(transport, `http://provider.test:${s.port}/`);
        const parts: Uint8Array[] = [];
        for await (const c of res.body) parts.push(c);
        return Buffer.concat(parts).toString();
      }),
    );
    expect(bodies).toEqual(Array(6).fill('ok'));
    expect(peak).toBeLessThanOrEqual(2);
    expect(s.sockets()).toBeLessThanOrEqual(2);
    await agent.close();
  });

  it('caps the raw bytes of an undici body while streaming', async () => {
    const s = await listen((_q, r) => {
      r.writeHead(200); // chunked: no Content-Length to trust or distrust
      r.end(Buffer.alloc(3 * 1024 * 1024, 0x61));
    });
    const { transport } = undiciTransport(new Set(['provider.test']), onlyLoopback, loopbackDns);
    const signal = AbortSignal.timeout(5000);
    const res = await call(transport, `http://provider.test:${s.port}/`, signal);
    const err = await readBody(res, 1024 * 1024, 4 * 1024 * 1024, signal).catch((e: unknown) => e);
    expect(errorCode(err, signal)).toBe('too_large');
  });

  it('maps an upstream that never answers to a timeout', async () => {
    const s = await listen(() => {});
    const { transport } = undiciTransport(new Set(['provider.test']), onlyLoopback, loopbackDns);
    const signal = AbortSignal.timeout(300);
    const err = await call(transport, `http://provider.test:${s.port}/`, signal).catch((e: unknown) => e);
    expect(errorCode(err, signal)).toBe('timeout');
  });
});

describe('the client over the undici transport (S1: no unhandled rejection)', () => {
  // The real undici transport; only the scheme and port are rewritten, because the client
  // accepts https on 443 only and no TLS key is committed.
  const local =
    (port: number): Transport =>
    (req) =>
      undiciTransport(new Set(['provider.test']), onlyLoopback, loopbackDns).transport({
        ...req,
        url: new URL(`http://provider.test:${port}${req.url.pathname}${req.url.search}`),
      });
  const unhandled: unknown[] = [];
  const record = (e: unknown) => unhandled.push(e);
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', record);
    process.on('uncaughtException', record);
  });
  afterEach(() => {
    process.off('unhandledRejection', record);
    process.off('uncaughtException', record);
  });
  const settle = () => new Promise((r) => setTimeout(r, 100));

  // An undici body destroyed before its end emits 'error' (N1): each answer the client drops unread.
  it.each([
    ['a 304', (r: ServerResponse) => r.writeHead(304).end(), { ok: true, res: { status: 304 } }],
    ['a 204', (r: ServerResponse) => r.writeHead(204).end(), { ok: true, res: { status: 204 } }],
    ['a 799', (r: ServerResponse) => r.writeHead(799).end('odd'), { ok: false, error: 'bad_status' }],
    [
      'a zstd body',
      (r: ServerResponse) => r.writeHead(200, { 'content-encoding': 'zstd' }).end('x'),
      { ok: false, error: 'bad_encoding' },
    ],
    [
      'a same-host 302, then a 200',
      (r: ServerResponse, path?: string) =>
        path === '/b' ? r.end('ok') : r.writeHead(302, { location: '/b' }).end('moved'),
      { ok: true, res: { status: 200, url: 'https://provider.test/b' } },
    ],
  ])('drops %s unread without an uncaught error', async (_, answer, expected) => {
    const s = await listen((q, r) => answer(r, q.url));
    const c = new Client({
      hosts: new Map([['NL-1', ['provider.test']]]),
      userAgent: 'ua',
      transport: local(s.port),
      resolver: fakeResolver(),
    });
    expect(await c.fetch('NL-1', { url: 'https://provider.test/a', method: 'GET', variant: 'v' })).toMatchObject(
      expected,
    );
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('waits out a Retry-After longer than the request timeout, then fetches', async () => {
    let n = 0;
    const s = await listen((_q, r) => {
      n += 1;
      if (n === 1) {
        r.writeHead(429, { 'retry-after': '1' });
        r.end('slow down');
      } else r.end('ok');
    });
    const c = new Client({
      hosts: new Map([['NL-1', ['provider.test']]]),
      userAgent: 'ua',
      transport: local(s.port),
      resolver: fakeResolver(),
    });
    const get = { url: 'https://provider.test/a', method: 'GET' as const, variant: 'v' };
    expect(await c.fetch('NL-1', get, { timeoutMs: 300 })).toMatchObject({ ok: true, res: { status: 429 } });
    // The 1 s wait is longer than the 300 ms timeout, which starts only after it.
    expect(await c.fetch('NL-1', get, { timeoutMs: 300 })).toMatchObject({ ok: true, res: { status: 200 } });
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('sends a ping after a failed ping, once the backoff has passed', async () => {
    let n = 0;
    const s = await listen((q, r) => {
      n += 1;
      if (n === 1) q.socket.destroy();
      else r.end('OK');
    });
    // Full jitter after one failure: 600 ms, twice the ping timeout below.
    const client = new Client({
      hosts: new Map([['hc', ['hc-ping.com']]]),
      userAgent: 'ua',
      transport: local(s.port),
      resolver: fakeResolver(),
      politeness: new Politeness(() => 0.02),
    });
    const warnings: unknown[] = [];
    const pinger = new Pinger('k'.repeat(22), 'ua', { warn: (...a: unknown[]) => warnings.push(a) }, client, 300);
    await pinger.ping('cap-nl', 'start');
    await pinger.ping('cap-nl', 'success');
    await settle();
    expect(n).toBe(2);
    expect(warnings).toHaveLength(1); // the reset connection only
    expect(unhandled).toEqual([]);
  });
});
