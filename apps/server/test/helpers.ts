import https from 'node:https';
import type { Resolver } from '../src/http/addresses.ts';
import { Client, type ClientOptions } from '../src/http/client.ts';
import type { Transport } from '../src/http/types.ts';

// Test-only transport: node:https, which msw intercepts and which never
// decodes a body, so tests see raw bytes as the undici transport does.
export const mswTransport: Transport = ({ url, method, headers, body, signal }) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, signal }, (res) =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

/** A resolver answering from a table (default: one public documentation-free address). */
export const fakeResolver =
  (answers: Record<string, string[]> = {}): Resolver =>
  async (host) =>
    answers[host] ?? ['93.184.215.14'];

export function testClient(hosts: Record<string, string[]>, extra: Partial<ClientOptions> = {}): Client {
  return new Client({
    hosts: new Map(Object.entries(hosts)),
    userAgent: 'rivierstanden/test (+https://example.invalid/over; test@example.invalid)',
    transport: mswTransport,
    resolver: fakeResolver(),
    ...extra,
  });
}
