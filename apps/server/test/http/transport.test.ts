import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { errorCode, readBody, undiciTransport } from '../../src/http/client.ts';

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
