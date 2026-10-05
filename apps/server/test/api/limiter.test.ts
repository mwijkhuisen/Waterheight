import { describe, expect, it } from 'vitest';
import { ROUTES, rateClass } from '../../src/api/channels.ts';
import {
  BEACON_GLOBAL,
  BUCKETS,
  clientKey,
  GATEWAY,
  GATEWAY_FACTOR,
  Limiter,
  MAX_KEYS,
  UNKNOWN,
} from '../../src/api/limiter.ts';

// The per-client token buckets of the API (P9b, A§9.2): the key, the arithmetic, the bound.

function setup(opts: { maxKeys?: number; onGateway?: () => void; start?: number } = {}) {
  const clock = { t: opts.start ?? 0 };
  const limiter = new Limiter({
    now: () => clock.t,
    ...(opts.maxKeys !== undefined ? { maxKeys: opts.maxKeys } : {}),
    ...(opts.onGateway !== undefined ? { onGateway: opts.onGateway } : {}),
  });
  return { clock, limiter };
}

/** Takes `n` tokens of `cls` for `key`, returning how many were allowed. */
function drain(limiter: Limiter, key: string, cls: 'general' | 'heavy' | 'beacon', n: number): number {
  let ok = 0;
  for (let i = 0; i < n; i++) if (limiter.take(key, cls) === 0) ok += 1;
  return ok;
}

describe('clientKey', () => {
  it.each([
    ['203.0.113.5', '203.0.113.5'],
    ['  203.0.113.5 ', '203.0.113.5'],
    ['8.8.8.8', '8.8.8.8'],
    // Just outside 100.64/10 (carrier-grade NAT) and 169.254/16: ordinary clients.
    ['100.63.255.255', '100.63.255.255'],
    ['100.128.0.1', '100.128.0.1'],
    ['169.253.0.1', '169.253.0.1'],
    ['172.15.0.1', '172.15.0.1'],
    ['172.32.0.1', '172.32.0.1'],
    ['192.169.0.1', '192.169.0.1'],
    ['11.0.0.1', '11.0.0.1'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['::FFFF:203.0.113.5', '203.0.113.5'],
    // The same address written in hex (review F11).
    ['::ffff:cb00:7105', '203.0.113.5'],
  ])('IPv4 %j is %j', (header, key) => {
    expect(clientKey(header)).toBe(key);
  });

  it.each([
    '2001:db8:1:2:3:4:5:6',
    '2001:db8:1:2::9',
    '[2001:db8:1:2::9]',
    '2001:db8:1:2::9%eth0',
    '[2001:DB8:1:2:ffff:ffff:ffff:ffff]',
    '2001:0db8:0001:0002:0000:0000:0000:0009',
  ])('IPv6 %j is its /64', (header) => {
    expect(clientKey(header)).toBe('2001:db8:1:2::/64');
  });

  it('the same /64 gives the same key and another /64 another', () => {
    expect(clientKey('2001:db8:1:2::1')).toBe(clientKey('2001:db8:1:2:ffff::2'));
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
    expect(clientKey('2001:db9:1:2::1')).not.toBe(clientKey('2001:db8:1:2::1'));
  });

  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.65.1',
    '127.0.0.1',
    '127.9.9.9',
    '169.254.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '::1',
    '[::1]',
    'fd00::1',
    'fc00::1',
    'fdff:ffff::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
  ])('private, loopback, ULA and link-local %j is the gateway key', (header) => {
    expect(clientKey(header)).toBe(GATEWAY);
    expect(GATEWAY).toBe('unknown-gw');
  });

  it.each([
    undefined,
    '',
    '   ',
    'garbage',
    'unknown',
    '999.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '2001:db8::1::2',
    '2001:db8:1:2:3:4:5:6:7',
    'g001:db8:1:2::1',
    '1.2.3.4, 5.6.7.8',
    '1.2.3.4,5.6.7.8',
    '1.2.3.4:8080',
    '2001:db8:1:2:3:4:5:6'.repeat(3),
    'a'.repeat(200),
  ])('missing or invalid %j is unknown', (header) => {
    expect(clientKey(header)).toBe(UNKNOWN);
    expect(UNKNOWN).toBe('unknown');
  });

  it('global unicast addresses are ordinary clients, not the gateway', () => {
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2a00:1450:4001:81d::200e')).toBe('2a00:1450:4001:81d::/64');
  });
});

describe('Limiter: the general bucket', () => {
  it('allows the burst of 120, then refuses with Retry-After of at least 1', () => {
    const { limiter } = setup();
    expect(BUCKETS.general).toEqual({ rate: 30, burst: 120 });
    expect(drain(limiter, '1.2.3.4', 'general', 120)).toBe(120);
    const wait = limiter.take('1.2.3.4', 'general');
    expect(wait).toBe(1);
    expect(Number.isInteger(wait)).toBe(true);
  });

  it('keys are independent', () => {
    const { limiter } = setup();
    expect(drain(limiter, 'a', 'general', 121)).toBe(120);
    expect(limiter.take('b', 'general')).toBe(0);
  });

  it('refills at 30 tokens a second, and never past the burst', () => {
    const { clock, limiter } = setup();
    drain(limiter, 'a', 'general', 120);
    expect(limiter.take('a', 'general')).toBeGreaterThan(0);
    clock.t += 200; // 6 tokens
    expect(drain(limiter, 'a', 'general', 10)).toBe(6);
    clock.t += 3_600_000; // an hour: still only the burst
    expect(drain(limiter, 'a', 'general', 200)).toBe(120);
  });

  it('a refused request does not move the bucket: the wait is for one whole token', () => {
    const { clock, limiter } = setup();
    drain(limiter, 'a', 'general', 120);
    for (let i = 0; i < 50; i++) expect(limiter.take('a', 'general')).toBe(1);
    clock.t += 34; // 1.02 tokens
    expect(limiter.take('a', 'general')).toBe(0);
    expect(limiter.take('a', 'general')).toBe(1);
  });

  it('works on its own monotonic clock when none is injected', () => {
    const limiter = new Limiter();
    expect(limiter.take('a', 'general')).toBe(0);
    expect(limiter.size).toBe(1);
  });
});

describe('Limiter: the heavy class', () => {
  it('has its own 5/s, burst 20 and takes the general bucket as well', () => {
    expect(BUCKETS.heavy).toEqual({ rate: 5, burst: 20 });
    const { limiter } = setup();
    expect(drain(limiter, 'a', 'heavy', 25)).toBe(20);
    expect(limiter.take('a', 'heavy')).toBe(1);
    // 20 general tokens went with them: 100 are left.
    expect(drain(limiter, 'a', 'general', 120)).toBe(100);
  });

  it('is refused when the general bucket is empty, whatever the heavy one holds', () => {
    const { limiter } = setup();
    expect(drain(limiter, 'a', 'general', 120)).toBe(120);
    expect(limiter.take('a', 'heavy')).toBe(1);
  });

  it('a refused request takes nothing from either bucket', () => {
    const { clock, limiter } = setup();
    expect(drain(limiter, 'a', 'heavy', 15)).toBe(15); // heavy 5 left, general 105
    expect(drain(limiter, 'a', 'general', 105)).toBe(105); // general empty
    for (let i = 0; i < 50; i++) expect(limiter.take('a', 'heavy')).toBeGreaterThan(0);
    clock.t += 1_000; // general 30, heavy 10
    expect(drain(limiter, 'a', 'heavy', 15)).toBe(10);
  });

  it('a refused heavy request (its bucket empty) leaves the general bucket as it was', () => {
    const { limiter } = setup();
    expect(drain(limiter, 'a', 'heavy', 20)).toBe(20); // general 100 left
    for (let i = 0; i < 50; i++) expect(limiter.take('a', 'heavy')).toBe(1);
    expect(drain(limiter, 'a', 'general', 120)).toBe(100);
  });
});

describe('Limiter: the beacon class', () => {
  it('has its own 1/s, burst 10 per client and never takes general', () => {
    expect(BUCKETS.beacon).toEqual({ rate: 1, burst: 10 });
    const { limiter } = setup();
    expect(drain(limiter, 'a', 'beacon', 15)).toBe(10);
    expect(limiter.take('a', 'beacon')).toBe(1);
    expect(drain(limiter, 'a', 'general', 121)).toBe(120);
  });

  it('an empty general bucket does not stop a beacon', () => {
    const { limiter } = setup();
    drain(limiter, 'a', 'general', 120);
    expect(limiter.take('a', 'general')).toBeGreaterThan(0);
    expect(limiter.take('a', 'beacon')).toBe(0);
  });

  it('refills at 1 a second', () => {
    const { clock, limiter } = setup();
    drain(limiter, 'a', 'beacon', 10);
    expect(limiter.take('a', 'beacon')).toBe(1);
    clock.t += 3_000;
    expect(drain(limiter, 'a', 'beacon', 10)).toBe(3);
  });

  it('every client together has the global bucket of 20/s, burst 100', () => {
    expect(BEACON_GLOBAL).toEqual({ rate: 20, burst: 100 });
    const { clock, limiter } = setup();
    let ok = 0;
    for (let i = 0; i < 12; i++) ok += drain(limiter, `client-${i}`, 'beacon', 10);
    expect(ok).toBe(100);
    expect(limiter.take('fresh-client', 'beacon')).toBe(1);
    clock.t += 500; // 10 global tokens
    expect(drain(limiter, 'fresh-client', 'beacon', 20)).toBe(10);
  });

  it('a refused beacon takes nothing from the global bucket', () => {
    const { limiter } = setup();
    expect(drain(limiter, 'a', 'beacon', 30)).toBe(10); // 20 refused of the one client
    let ok = 0;
    for (let i = 0; i < 9; i++) ok += drain(limiter, `client-${i}`, 'beacon', 10);
    expect(ok).toBe(90); // 100 in all: a's refusals did not use any
    expect(limiter.take('client-9', 'beacon')).toBe(1);
  });

  it('the global bucket does not touch the general bucket of anyone', () => {
    const { limiter } = setup();
    for (let i = 0; i < 12; i++) drain(limiter, `client-${i}`, 'beacon', 10);
    expect(drain(limiter, 'another', 'general', 121)).toBe(120);
  });
});

describe('Limiter: the gateway key', () => {
  it('has 100 times the rate and the burst', () => {
    expect(GATEWAY_FACTOR).toBe(100);
    const { clock, limiter } = setup();
    expect(drain(limiter, GATEWAY, 'general', 12_100)).toBe(12_000);
    expect(limiter.take(GATEWAY, 'general')).toBe(1);
    clock.t += 1_000; // 3,000 tokens a second
    expect(drain(limiter, GATEWAY, 'general', 4_000)).toBe(3_000);
  });

  it('has a heavy bucket of 500/s, burst 2,000', () => {
    const { limiter } = setup();
    expect(drain(limiter, GATEWAY, 'heavy', 2_100)).toBe(2_000);
  });

  it('is not scaled for the global beacon bucket', () => {
    const { limiter } = setup();
    expect(drain(limiter, GATEWAY, 'beacon', 500)).toBe(100);
  });

  it('calls onGateway on the first take and at most once a minute', () => {
    let calls = 0;
    const { clock, limiter } = setup({ onGateway: () => (calls += 1) });
    limiter.take('1.2.3.4', 'general');
    expect(calls).toBe(0);
    limiter.take(GATEWAY, 'general');
    limiter.take(GATEWAY, 'general');
    clock.t += 59_999;
    limiter.take(GATEWAY, 'general');
    expect(calls).toBe(1);
    clock.t += 1;
    limiter.take(GATEWAY, 'general');
    limiter.take(GATEWAY, 'heavy');
    expect(calls).toBe(2);
    clock.t += 60_000;
    limiter.take(GATEWAY, 'beacon');
    expect(calls).toBe(3);
  });

  it('works without an onGateway', () => {
    const { limiter } = setup();
    expect(limiter.take(GATEWAY, 'general')).toBe(0);
  });
});

describe('Limiter: the bound', () => {
  it('holds at most maxKeys entries and evicts the least recently used', () => {
    const { limiter } = setup({ maxKeys: 3 });
    drain(limiter, 'a', 'general', 120);
    drain(limiter, 'b', 'general', 120);
    drain(limiter, 'c', 'general', 120);
    expect(limiter.size).toBe(3);
    // d evicts a, the oldest: a starts full again, b and c are still empty.
    expect(limiter.take('d', 'general')).toBe(0);
    expect(limiter.size).toBe(3);
    expect(limiter.take('b', 'general')).toBeGreaterThan(0);
    expect(limiter.take('c', 'general')).toBeGreaterThan(0);
    expect(limiter.take('a', 'general')).toBe(0);
    expect(limiter.size).toBe(3);
  });

  it('a re-used key moves to the end of the order', () => {
    const { limiter } = setup({ maxKeys: 3 });
    expect(drain(limiter, 'a', 'general', 119)).toBe(119);
    drain(limiter, 'b', 'general', 120);
    drain(limiter, 'c', 'general', 120);
    // a's last token: a is now the most recently used (order b, c, a) and empty.
    expect(limiter.take('a', 'general')).toBe(0);
    // d evicts b, not a.
    expect(limiter.take('d', 'general')).toBe(0);
    expect(limiter.take('a', 'general')).toBeGreaterThan(0);
    expect(limiter.take('c', 'general')).toBeGreaterThan(0);
    expect(limiter.take('b', 'general')).toBe(0);
    expect(limiter.size).toBe(3);
  });

  it('a flood of distinct keys never grows the map past maxKeys', () => {
    const { limiter } = setup({ maxKeys: 50 });
    for (let i = 0; i < 1_000; i++) limiter.take(`k${i}`, 'general');
    expect(limiter.size).toBe(50);
  });

  it('one request of a two-bucket class counts its entries: heavy uses two keys, beacon two', () => {
    const { limiter } = setup();
    limiter.take('a', 'heavy');
    expect(limiter.size).toBe(2);
    limiter.take('b', 'beacon');
    expect(limiter.size).toBe(4); // + b|beacon and the global one
  });

  it('MAX_KEYS is 50,000', () => {
    expect(MAX_KEYS).toBe(50_000);
  });
});

describe('Limiter: the sweep', () => {
  it('drops the entries whose bucket is full again, every 30 s', () => {
    const { clock, limiter } = setup({ start: 100_000 });
    for (let i = 0; i < 10; i++) limiter.take(`k${i}`, 'general');
    limiter.take('h', 'heavy');
    limiter.take('b', 'beacon');
    expect(limiter.size).toBe(10 + 2 + 2);
    clock.t += 30_000;
    limiter.take('after', 'general');
    expect(limiter.size).toBe(1);
  });

  it('keeps an entry that is not full yet, and sweeps no more often than every 30 s', () => {
    const { clock, limiter } = setup({ start: 100_000 });
    limiter.take('first', 'general'); // the first sweep, at 100,000
    clock.t += 29_999;
    drain(limiter, 'drained', 'general', 120);
    limiter.take('x', 'general'); // under 30 s since the sweep: none
    expect(limiter.size).toBe(3);
    clock.t += 1; // 30 s since the first sweep: `first` is full again, `drained` is not
    limiter.take('y', 'general');
    expect(limiter.size).toBe(3); // drained, x (taken 1 ms ago) and y
    expect(limiter.take('drained', 'general')).toBe(1);
  });

  it('a gateway entry is swept by its own, larger, burst', () => {
    const { clock, limiter } = setup({ start: 100_000 });
    limiter.take(GATEWAY, 'general');
    expect(limiter.size).toBe(1);
    clock.t += 30_000;
    limiter.take('x', 'general');
    expect(limiter.size).toBe(1);
  });

  it('the global beacon entry is swept too, once it is full again', () => {
    const { clock, limiter } = setup({ start: 100_000 });
    limiter.take('a', 'beacon');
    expect(limiter.size).toBe(2);
    clock.t += 30_000;
    limiter.take('b', 'general');
    expect(limiter.size).toBe(1);
  });
});

describe('rateClass against ROUTES', () => {
  it.each(ROUTES.map((r) => [r.method, r.path, r.rate] as const))('%s %s is %s', (method, path, rate) => {
    expect(rateClass(method, path.replaceAll(':id', '123'))).toBe(rate);
  });

  it('a POST elsewhere and a GET of the beacon path are general', () => {
    expect(rateClass('POST', '/api/v1/stations')).toBe('general');
    expect(rateClass('GET', '/api/v1/beacon')).toBe('general');
  });

  it('series paths, whatever follows, are heavy', () => {
    expect(rateClass('GET', '/api/v1/series/9/forecast')).toBe('heavy');
    expect(rateClass('HEAD', '/api/v1/series/9')).toBe('heavy');
  });
});
