import { Readable } from 'node:stream';
import { createGzip, gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { delay, HttpResponse, http } from 'msw';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { checkZip, flatNames, GuardFailure } from '../../src/http/guards.ts';
import { BREAKER_PROBE_MS, ByteBudget, Politeness } from '../../src/http/politeness.ts';
import type { Req } from '../../src/http/types.ts';
import { fakeResolver, testClient } from '../helpers.ts';

// Criterion "[CI] Client tests (msw) refuse or abort each of these" (issue #16).

const HOSTS = {
  'NL-1': ['ddapi20-waterwebservices.rijkswaterstaat.nl'],
  'LU-5': ['data.public.lu', 'download.data.public.lu'],
  'DE-7': ['www.hochwasserportal.nrw'],
};
const get = (url: string): Req => ({ url, method: 'GET', variant: 'v' });
const A = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';

describe('allowlist and URL checks', () => {
  it('refuses a host that is not allowlisted for the source, without sending anything', async () => {
    const c = testClient(HOSTS);
    expect(await c.fetch('NL-1', get('https://example.com/x'))).toEqual({ ok: false, error: 'not_allowlisted' });
    // Allowlisted for another source only: still refused.
    expect(await c.fetch('NL-1', get('https://data.public.lu/x'))).toEqual({ ok: false, error: 'not_allowlisted' });
  });

  it.each([
    'http://ddapi20-waterwebservices.rijkswaterstaat.nl/x',
    'https://user:pw@ddapi20-waterwebservices.rijkswaterstaat.nl/x',
    'https://ddapi20-waterwebservices.rijkswaterstaat.nl:8443/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://2130706433/x',
    'not a url',
  ])('refuses %s', async (url) => {
    const c = testClient({ ...HOSTS, 'NL-1': [...HOSTS['NL-1'], '127.0.0.1', '2130706433'] });
    expect(await c.fetch('NL-1', get(url))).toMatchObject({ ok: false });
  });
});

describe('DNS answers', () => {
  const bad = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1'];

  it.each(bad)('refuses a host that resolves to %s', async (ip) => {
    const c = testClient(HOSTS, { resolver: fakeResolver({ 'ddapi20-waterwebservices.rijkswaterstaat.nl': [ip] }) });
    expect(await c.fetch('NL-1', get(`${A}/x`))).toEqual({ ok: false, error: 'private_address' });
  });

  it('refuses when any one answer is private', async () => {
    const c = testClient(HOSTS, {
      resolver: fakeResolver({ 'ddapi20-waterwebservices.rijkswaterstaat.nl': ['93.184.215.14', '10.0.0.1'] }),
    });
    expect(await c.fetch('NL-1', get(`${A}/x`))).toEqual({ ok: false, error: 'private_address' });
  });

  it.each(bad)('re-checks on a redirect hop: refuses %s there', async (ip) => {
    let calls = 0;
    const c = testClient(HOSTS, {
      resolver: async () => (calls++ === 0 ? ['93.184.215.14'] : [ip]),
    });
    server.use(http.get(`${A}/a`, () => new HttpResponse(null, { status: 302, headers: { location: '/b' } })));
    expect(await c.fetch('NL-1', get(`${A}/a`))).toEqual({ ok: false, error: 'private_address' });
    expect(calls).toBe(2);
  });
});

describe('redirects', () => {
  it('follows a same-host redirect', async () => {
    server.use(
      http.get(`${A}/a`, () => new HttpResponse(null, { status: 301, headers: { location: `${A}/b` } })),
      http.get(`${A}/b`, () => HttpResponse.json({ ok: 1 })),
    );
    const r = await testClient(HOSTS).fetch('NL-1', get(`${A}/a`));
    expect(r.ok && r.res.url).toBe(`${A}/b`);
  });

  it('refuses a cross-host redirect, even between two hosts of the same source (data.public.lu → download)', async () => {
    server.use(
      http.get(
        'https://data.public.lu/r/latest',
        () => new HttpResponse(null, { status: 302, headers: { location: 'https://download.data.public.lu/r/x.xml' } }),
      ),
    );
    expect(await testClient(HOSTS).fetch('LU-5', get('https://data.public.lu/r/latest'))).toEqual({
      ok: false,
      error: 'redirect_cross_host',
    });
  });

  it('refuses a redirect to http', async () => {
    server.use(
      http.get(
        `${A}/a`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: 'http://ddapi20-waterwebservices.rijkswaterstaat.nl/b' },
          }),
      ),
    );
    expect(await testClient(HOSTS).fetch('NL-1', get(`${A}/a`))).toEqual({ ok: false, error: 'redirect_insecure' });
  });

  it('follows at most 3 hops', async () => {
    server.use(
      http.get(`${A}/:n`, ({ params }) => {
        const n = Number(params.n);
        return n < 9
          ? new HttpResponse(null, { status: 307, headers: { location: `/${n + 1}` } })
          : HttpResponse.text('end');
      }),
    );
    const c = testClient(HOSTS);
    expect((await c.fetch('NL-1', get(`${A}/6`))).ok).toBe(true); // 6→7→8→9: three hops
    expect(await c.fetch('NL-1', get(`${A}/5`))).toEqual({ ok: false, error: 'redirect_limit' });
  });
});

describe('size and time caps', () => {
  let bomb: Buffer;
  beforeAll(async () => {
    // 1 GB of zeros, gzipped as a stream (about 1 MB on the wire).
    const gz = createGzip({ level: 9 });
    const parts: Buffer[] = [];
    gz.on('data', (c: Buffer) => parts.push(c));
    const done = new Promise((r) => gz.on('end', r));
    const zeros = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 1024; i += 1) if (!gz.write(zeros)) await new Promise((r) => gz.once('drain', r));
    gz.end();
    await done;
    bomb = Buffer.concat(parts);
  }, 60_000);

  it('aborts a 30 MB body at 25 MB', async () => {
    server.use(http.get(`${A}/big`, () => new HttpResponse(Buffer.alloc(30 * 1024 * 1024, 0x61))));
    expect(await testClient(HOSTS).fetch('NL-1', get(`${A}/big`))).toEqual({ ok: false, error: 'too_large' });
  });

  it('aborts a gzip bomb (1 GB) at 100 MB decoded', async () => {
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    server.use(http.get(`${A}/bomb`, () => new HttpResponse(bomb, { headers: { 'content-encoding': 'gzip' } })));
    expect(await testClient(HOSTS).fetch('NL-1', get(`${A}/bomb`))).toEqual({ ok: false, error: 'too_large_decoded' });
  }, 30_000);

  it('refuses stacked and unknown content encodings', async () => {
    const twice = gzipSync(gzipSync(Buffer.from('x'.repeat(1000))));
    server.use(
      http.get(`${A}/twice`, () => new HttpResponse(twice, { headers: { 'content-encoding': 'gzip, gzip' } })),
      http.get(`${A}/zstd`, () => new HttpResponse('x', { headers: { 'content-encoding': 'compress' } })),
    );
    const c = testClient(HOSTS);
    expect(await c.fetch('NL-1', get(`${A}/twice`))).toEqual({ ok: false, error: 'bad_encoding' });
    expect(await c.fetch('NL-1', get(`${A}/zstd`))).toEqual({ ok: false, error: 'bad_encoding' });
  });

  it('decodes one gzip layer and reports raw and decoded sizes', async () => {
    const text = JSON.stringify({ v: 'y'.repeat(5000) });
    server.use(
      http.get(`${A}/gz`, () => new HttpResponse(gzipSync(text), { headers: { 'content-encoding': 'gzip' } })),
    );
    const r = await testClient(HOSTS).fetch('NL-1', get(`${A}/gz`));
    expect(r.ok && r.res.body.toString()).toBe(text);
    expect(r.ok && r.res.wireBytes).toBeLessThan(text.length);
  });

  it('aborts a slowloris upstream at the total deadline', async () => {
    server.use(
      http.get(`${A}/slow`, () => {
        const stream = new ReadableStream({
          async pull(ctl) {
            await delay(50);
            ctl.enqueue(new Uint8Array([0x20]));
          },
        });
        return new HttpResponse(stream);
      }),
      http.get(`${A}/hang`, async () => {
        await delay('infinite');
        return HttpResponse.text('never');
      }),
    );
    // A fresh client each: a timeout puts the host into backoff (tested below).
    const hang = await testClient(HOSTS).fetch('NL-1', get(`${A}/hang`), { timeoutMs: 400 });
    expect(hang).toEqual({ ok: false, error: 'timeout' });
    const slow = testClient(HOSTS);
    expect(await slow.fetch('NL-1', get(`${A}/slow`), { timeoutMs: 400 })).toEqual({ ok: false, error: 'timeout' });
    expect(slow.politeness.gate('ddapi20-waterwebservices.rijkswaterstaat.nl', Date.now())).not.toEqual({ wait: 0 });
  });
});

describe('ZIP payloads read through the client', () => {
  const names = flatNames(['messwerte.txt']);
  const fetchZip = async (zip: Uint8Array) => {
    server.use(http.get('https://www.hochwasserportal.nrw/data/downloads/messwerte.zip', () => new HttpResponse(zip)));
    const r = await testClient(HOSTS).fetch(
      'DE-7',
      get('https://www.hochwasserportal.nrw/data/downloads/messwerte.zip'),
    );
    if (!r.ok) throw new Error(r.error);
    return checkZip(r.res.body, { names });
  };

  it('refuses a ZIP with too many entries', async () => {
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, new Uint8Array([1])]));
    await expect(fetchZip(zipSync(files))).rejects.toMatchObject({ reason: 'zip_members' });
  });

  it('refuses a ZIP with a ../ path', async () => {
    await expect(fetchZip(zipSync({ '../evil.txt': new Uint8Array([1]) }))).rejects.toBeInstanceOf(GuardFailure);
  });
});

describe('Retry-After and backoff', () => {
  it('records a 503 with Retry-After and then waits for it, or skips when it does not fit', async () => {
    let now = 1_000_000;
    const slept: number[] = [];
    const c = testClient(HOSTS, {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    server.use(
      http.get(`${A}/busy`, () => new HttpResponse('busy', { status: 503, headers: { 'retry-after': '120' } })),
      http.get(`${A}/ok`, () => HttpResponse.text('ok')),
    );
    expect(await c.fetch('NL-1', get(`${A}/busy`))).toMatchObject({ ok: true, res: { status: 503 } });
    expect(await c.fetch('NL-1', get(`${A}/ok`), { deadline: now + 60_000 })).toEqual({ ok: false, error: 'backoff' });
    expect(await c.fetch('NL-1', get(`${A}/ok`), { deadline: now + 600_000 })).toMatchObject({ ok: true });
    expect(slept).toEqual([120_000]);
  });
});

describe('WAF answers (S9)', () => {
  it.each([403, 451])('a %i backs the host off like a 429, honouring Retry-After', async (status) => {
    let now = 1_000_000;
    const c = testClient(HOSTS, { now: () => now, politeness: new Politeness(() => 0.5) });
    server.use(
      http.get(`${A}/waf`, () => new HttpResponse('blocked', { status })),
      http.get(`${A}/limited`, () => new HttpResponse('blocked', { status, headers: { 'retry-after': '120' } })),
      http.get(`${A}/ok`, () => HttpResponse.text('ok')),
    );
    expect(await c.fetch('NL-1', get(`${A}/waf`))).toMatchObject({ ok: true, res: { status } });
    // Full jitter after one failure: 15 s here.
    expect(await c.fetch('NL-1', get(`${A}/ok`), { deadline: now + 10_000 })).toEqual({ ok: false, error: 'backoff' });
    now += 15_000;
    expect(await c.fetch('NL-1', get(`${A}/limited`))).toMatchObject({ ok: true, res: { status } });
    now += 60_000;
    expect(await c.fetch('NL-1', get(`${A}/ok`), { deadline: now + 30_000 })).toEqual({ ok: false, error: 'backoff' });
  });
});

describe('one bound per request (N6)', () => {
  it('the hops of a redirect chain share twice the timeout', async () => {
    server.use(
      http.get(`${A}/hop/:n`, async ({ params }) => {
        await delay(250);
        const n = Number(params.n);
        return n < 3
          ? new HttpResponse(null, { status: 307, headers: { location: `/hop/${n + 1}` } })
          : HttpResponse.text('end');
      }),
    );
    // Four hops of 250 ms: each within the 400 ms timeout, together past 800 ms.
    expect(await testClient(HOSTS).fetch('NL-1', get(`${A}/hop/0`), { timeoutMs: 400 })).toEqual({
      ok: false,
      error: 'timeout',
    });
  });

  it('a request that waited for memory while its host went into backoff is not sent, and is no failure', async () => {
    const c = testClient(HOSTS, { budget: new ByteBudget(1) });
    const failure = vi.spyOn(c.politeness, 'failure');
    let asked = 0;
    server.use(
      http.get(`${A}/busy`, async () => {
        await delay(100);
        return new HttpResponse('busy', { status: 503, headers: { 'retry-after': '60' } });
      }),
      http.get(`${A}/ok`, () => {
        asked += 1;
        return HttpResponse.text('ok');
      }),
    );
    const busy = c.fetch('NL-1', get(`${A}/busy`));
    const waiting = c.fetch('NL-1', get(`${A}/ok`)); // queued behind /busy for the whole budget
    expect(await busy).toMatchObject({ ok: true, res: { status: 503 } });
    expect(await waiting).toEqual({ ok: false, error: 'backoff' });
    expect(asked).toBe(0);
    expect(failure).toHaveBeenCalledTimes(1); // the 503 only
  });
});

describe('a status outside 100–599 (N7)', () => {
  it('counts as a failure of the host, so it is not polled at the full rate', async () => {
    const c = testClient(HOSTS, {
      transport: async () => ({ status: 799, headers: {}, body: Readable.from([]) }),
      politeness: new Politeness(() => 0.5),
    });
    expect(await c.fetch('NL-1', get(`${A}/odd`))).toEqual({ ok: false, error: 'bad_status' });
    expect(c.politeness.gate('ddapi20-waterwebservices.rijkswaterstaat.nl', Date.now())).not.toEqual({ wait: 0 });
  });
});

describe('the half-open probe (C1, S2)', () => {
  const H = 'ddapi20-waterwebservices.rijkswaterstaat.nl';
  /** A client whose breaker for H is open (5 × 503, no jitter), on a clock the test moves. */
  async function opened(resolver?: (host: string) => Promise<string[]>) {
    const clock = { now: 1_000_000 };
    const c = testClient(HOSTS, {
      now: () => clock.now,
      politeness: new Politeness(() => 0),
      ...(resolver ? { resolver } : {}),
    });
    server.use(
      http.get(`${A}/down`, () => new HttpResponse('down', { status: 503 })),
      http.get(`${A}/ok`, () => HttpResponse.text('ok')),
      http.get(`${A}/moved`, () => new HttpResponse(null, { status: 302, headers: { location: '/ok' } })),
    );
    for (let i = 0; i < 5; i += 1) await c.fetch('NL-1', get(`${A}/down`));
    expect(c.politeness.isOpen(H)).toBe(true);
    clock.now += BREAKER_PROBE_MS;
    return { c, clock };
  }

  it('a probe that ends on a DNS error re-arms the breaker; the next probe 30 min later is admitted', async () => {
    let dnsDown = false;
    const { c, clock } = await opened(async () => {
      if (dnsDown) throw new Error('EAI_AGAIN');
      return ['93.184.215.14'];
    });
    dnsDown = true;
    expect(await c.fetch('NL-1', get(`${A}/ok`))).toEqual({ ok: false, error: 'dns' });
    dnsDown = false;
    clock.now += 60_000;
    expect(await c.fetch('NL-1', get(`${A}/ok`))).toEqual({ ok: false, error: 'breaker_open' });
    clock.now += BREAKER_PROBE_MS;
    expect(await c.fetch('NL-1', get(`${A}/ok`))).toMatchObject({ ok: true, res: { status: 200 } });
    expect(c.politeness.isOpen(H)).toBe(false);
  });

  it('a same-host redirect hop belongs to the probe, and its success closes the breaker', async () => {
    const { c } = await opened();
    expect(await c.fetch('NL-1', get(`${A}/moved`))).toMatchObject({ ok: true, res: { status: 200, url: `${A}/ok` } });
    expect(c.politeness.isOpen(H)).toBe(false);
  });
});

describe('the byte budget (C2, S4)', () => {
  it('a host in backoff holds no memory: a request to another host is not delayed behind it', async () => {
    const sleepers: (() => void)[] = [];
    const c = testClient(HOSTS, { sleep: () => new Promise<void>((r) => sleepers.push(r)) });
    server.use(
      http.get(`${A}/busy`, () => new HttpResponse('busy', { status: 503, headers: { 'retry-after': '90' } })),
      http.get(`${A}/big`, () => HttpResponse.text('ok')),
      http.get('https://www.hochwasserportal.nrw/data/downloads/messwerte.zip', () => HttpResponse.text('b')),
    );
    await c.fetch('NL-1', get(`${A}/busy`));
    // Two 25 MB requests to the host in backoff; each would reserve 100 MB of the 128 MB budget.
    const big = { maxBytes: 25 * 1024 * 1024 };
    const a1 = c.fetch('NL-1', get(`${A}/big`), big);
    const a2 = c.fetch('NL-1', get(`${A}/big`), big);
    await new Promise((r) => setTimeout(r, 20));
    const b = await Promise.race([
      c.fetch('DE-7', get('https://www.hochwasserportal.nrw/data/downloads/messwerte.zip')),
      new Promise((r) => setTimeout(() => r('blocked'), 2000)),
    ]);
    expect(b).toMatchObject({ ok: true, res: { status: 200 } });
    expect(sleepers).toHaveLength(2);
    for (const wake of sleepers) wake();
    expect(await a1).toMatchObject({ ok: true });
    expect(await a2).toMatchObject({ ok: true });
  });
});
