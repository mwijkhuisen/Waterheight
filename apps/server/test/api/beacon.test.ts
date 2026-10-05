import { describe, expect, it, vi } from 'vitest';
import { Limiter } from '../../src/api/limiter.ts';
import { createApp } from '../../src/app.ts';

// The beacon (P9b, plan 4.8, C14): validation, caps, log hygiene and the fixed answers. No database.

const URL = '/api/v1/beacon';
const json = (o: unknown) => JSON.stringify(o);
const csp = (extra: Record<string, unknown> = {}) =>
  json({ 'csp-report': { 'violated-directive': 'img-src', ...extra } });

function setup(opts: { limiter?: Limiter } = {}) {
  const info = vi.fn();
  const app = createApp({ beaconLog: { info }, ...opts });
  const post = (body: RequestInit['body'], type: string | null = 'application/csp-report', init: RequestInit = {}) =>
    app.request(URL, {
      method: 'POST',
      ...(body === undefined ? {} : { body }),
      headers: type === null ? {} : { 'Content-Type': type },
      ...init,
    });
  return { app, info, post };
}

async function refusal(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe(`{"error":"${code}","attribution":[]}`);
}

const noCors = (res: Response) =>
  expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);

const line = (info: { mock: { calls: unknown[][] } }, i: number) =>
  (info.mock.calls[i] as unknown[])[0] as { beacon: string; fields: Record<string, string | number> };

describe('accepted reports', () => {
  it('application/csp-report: 204, no body, one log line', async () => {
    const { info, post } = setup();
    const res = await post(csp({ 'line-number': 12, 'blocked-uri': 'https://x.test/a' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    noCors(res);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      {
        beacon: 'csp',
        fields: { 'violated-directive': 'img-src', 'line-number': 12, 'blocked-uri': 'https://x.test/a' },
      },
      'beacon',
    );
  });

  it('application/reports+json: one line per report, charset parameter and case ignored', async () => {
    const { info, post } = setup();
    const report = (type: string) => ({
      type,
      age: 5,
      url: 'https://example.org/',
      user_agent: 'UA',
      body: { blockedURL: 'inline', lineNumber: 3, sample: null },
    });
    const res = await post(
      json([report('csp-violation'), report('deprecation')]),
      'Application/Reports+JSON; charset=utf-8',
    );
    expect(res.status).toBe(204);
    expect(info.mock.calls.map((c) => (c[0] as { beacon: string }).beacon)).toEqual([
      'report:csp-violation',
      'report:deprecation',
    ]);
    expect(info.mock.calls[0]?.[0]).toEqual({
      beacon: 'report:csp-violation',
      fields: { blockedURL: 'inline', lineNumber: 3, url: 'https://example.org/', user_agent: 'UA', age: 5 },
    });
  });

  it('application/json: our client error', async () => {
    const { info, post } = setup();
    const res = await post(json({ kind: 'client_error', message: 'boom', url: '/x' }), 'application/json');
    expect(res.status).toBe(204);
    expect(info).toHaveBeenCalledWith({ beacon: 'client_error', fields: { message: 'boom', url: '/x' } }, 'beacon');
  });

  it('strips control, ANSI, bidi, zero-width and separator characters, cuts at 200, and keeps quotes inert', async () => {
    const { info, post } = setup();
    const [ESC, RLO, LRI, PDI, ZWSP, LS, PS] = [0x1b, 0x202e, 0x2066, 0x2069, 0x200b, 0x2028, 0x2029].map((n) =>
      String.fromCodePoint(n),
    );
    const tail = '"}],"beacon":"forged';
    const dirty = `a\nb\r${ESC}[31mred${ESC}[0m${RLO}evil${LRI}x${PDI}${ZWSP}z${LS}${PS}${tail}`;
    const res = await post(json({ kind: 'client_error', message: dirty, url: 'x'.repeat(1900) }), 'application/json');
    expect(res.status).toBe(204);
    const fields = line(info, 0).fields;
    expect(fields.message).toBe(`ab[31mred[0mevilxz${tail}`);
    expect(String(fields.message)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(fields.url).toHaveLength(200);
    const long = await post(csp({ 'script-sample': 'y'.repeat(2000) }));
    expect(long.status).toBe(204);
    expect(line(info, 1).fields['script-sample']).toHaveLength(200);
    // The line is one JSON object whatever the text holds.
    expect(JSON.parse(JSON.stringify(line(info, 0)))).toEqual(line(info, 0));
  });

  it('cleans the keys of a report body too', async () => {
    const { info, post } = setup();
    const key = `k\ney${String.fromCodePoint(0x202e)}`;
    const res = await post(
      json([{ type: 't', age: 0, url: 'u', user_agent: 'ua', body: { [key]: 'v' } }]),
      'application/reports+json',
    );
    expect(res.status).toBe(204);
    expect(line(info, 0).fields.key).toBe('v');
  });

  it('is read and dropped when no beacon log is wired', async () => {
    const res = await createApp().request(URL, {
      method: 'POST',
      body: csp(),
      headers: { 'Content-Type': 'application/csp-report' },
    });
    expect(res.status).toBe(204);
  });
});

describe('refusals', () => {
  it('415 for text/plain, a missing type and application/jsonx', async () => {
    const { info, post } = setup();
    await refusal(await post(csp(), 'text/plain'), 415, 'unsupported_type');
    await refusal(await post(csp(), null), 415, 'unsupported_type');
    await refusal(await post(csp(), 'application/jsonx'), 415, 'unsupported_type');
    expect(info).not.toHaveBeenCalled();
  });

  it('413 for a 9,000-byte body with a Content-Length', async () => {
    const { info, post } = setup();
    await refusal(await post('x'.repeat(9000)), 413, 'too_large');
    expect(info).not.toHaveBeenCalled();
  });

  it('413 for a stream with no Content-Length, which is cancelled long before 1 MB', async () => {
    const { post } = setup();
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024).fill(120);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= 1024) return controller.close();
          pulled += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const res = await post(stream, 'application/csp-report', { duplex: 'half' } as RequestInit);
    await refusal(res, 413, 'too_large');
    expect(cancelled).toBe(true);
    expect(pulled * 1024).toBeLessThan(16 * 1024);
  });

  it('accepts exactly the cap and refuses one byte more', async () => {
    const { post } = setup();
    const body = (n: number) => csp({ 'script-sample': 'y'.repeat(n) }) + ' '.repeat(0);
    const base = Buffer.byteLength(body(0));
    const fits = body(Math.min(2000, 8192 - base));
    expect((await post(fits)).status).toBe(204);
    await refusal(await post(fits + ' '.repeat(8193 - Buffer.byteLength(fits))), 413, 'too_large');
  });

  it('400 bad_parameter for invalid JSON, a wrong shape and a 21-entry report array', async () => {
    const { info, post } = setup();
    await refusal(await post('{not json'), 400, 'bad_parameter');
    await refusal(await post(json({ 'csp-report': { 'line-number': -1 } })), 400, 'bad_parameter');
    await refusal(await post(json({ 'csp-report': { 'violated-directive': 'x'.repeat(2001) } })), 400, 'bad_parameter');
    await refusal(await post(json([]), 'application/reports+json'), 400, 'bad_parameter');
    const one = { type: 't', age: 0, url: 'u', user_agent: 'ua', body: {} };
    await refusal(await post(json(Array(21).fill(one)), 'application/reports+json'), 400, 'bad_parameter');
    const body31 = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 1]));
    await refusal(await post(json([{ ...one, body: body31 }]), 'application/reports+json'), 400, 'bad_parameter');
    await refusal(
      await post(json({ kind: 'other', message: 'm', url: 'u' }), 'application/json'),
      400,
      'bad_parameter',
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('400 unknown_parameter for unknown keys at any level', async () => {
    const { info, post } = setup();
    await refusal(await post(json({ 'csp-report': {}, extra: 1 })), 400, 'unknown_parameter');
    await refusal(await post(json({ 'csp-report': { surprise: 'x' } })), 400, 'unknown_parameter');
    await refusal(
      await post(
        json([{ type: 't', age: 0, url: 'u', user_agent: 'ua', body: {}, more: 1 }]),
        'application/reports+json',
      ),
      400,
      'unknown_parameter',
    );
    await refusal(
      await post(json({ kind: 'client_error', message: 'm', url: 'u', x: 1 }), 'application/json'),
      400,
      'unknown_parameter',
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('400 unknown_parameter for any query string, before the body is read', async () => {
    const { app } = setup();
    for (const q of ['?x=1', '?x', '?a=1&a=2']) {
      const res = await app.request(URL + q, {
        method: 'POST',
        body: csp(),
        headers: { 'Content-Type': 'application/csp-report' },
      });
      expect(res.status, q).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(JSON.parse(await res.text()).attribution).toEqual([]);
    }
  });

  it('405 with Allow: POST for GET, HEAD and OPTIONS', async () => {
    const { app } = setup();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await app.request(URL, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('POST');
      expect(res.headers.get('cache-control'), method).toBe('no-store');
      if (method !== 'HEAD') expect(await res.text()).toBe('{"error":"method_not_allowed","attribution":[]}');
      noCors(res);
    }
  });

  it('sends no Access-Control header on any answer', async () => {
    const { app, post } = setup();
    const origin = { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' };
    noCors(
      await post(csp(), 'application/csp-report', { headers: { 'Content-Type': 'application/csp-report', ...origin } }),
    );
    noCors(await post('{', 'application/csp-report'));
    noCors(await post(csp(), 'text/plain'));
    noCors(await app.request(URL, { method: 'OPTIONS', headers: origin }));
  });
});

describe('the rate limit', () => {
  it('answers the 11th beacon of a burst with 429 and Retry-After', async () => {
    let clock = 0;
    const { app } = setup({ limiter: new Limiter({ now: () => clock }) });
    const send = () =>
      app.request(URL, {
        method: 'POST',
        body: csp(),
        headers: { 'Content-Type': 'application/csp-report', 'x-rws-client': '203.0.113.9' },
      });
    for (let i = 0; i < 10; i++) expect((await send()).status, `beacon ${i + 1}`).toBe(204);
    const res = await send();
    await refusal(res, 429, 'rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    clock += 5_000;
    expect((await send()).status).toBe(204);
  });
});
