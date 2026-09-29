import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuardError, guardedLookup, isPublicAddress, resolveChecked } from '../../src/http/addresses.ts';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '::ffff:0:a9fe:a9fe', // SIIT IPv4-translated 169.254.169.254
    'fec0::1', // site-local
    '::1:0:0:0', // the rest of ::/8
    '3fff::1', // documentation (RFC 9637)
    '2001:2::1', // benchmarking
    '2001:10::1', // ORCHID
    '2001:20::1', // ORCHIDv2
    '5f00::1', // SRv6 SIDs
    '4000::1', // outside 2000::/3
    'not-an-ip',
    '',
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.215.14', '145.97.39.155', '2a00:1450:4001:80b::200e', '2606:4700::6810:84e5'])(
    'accepts the public address %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe('resolveChecked', () => {
  it('fails closed on an empty answer or a resolver error', async () => {
    await expect(resolveChecked('h', async () => [])).rejects.toMatchObject({ code: 'dns' });
    await expect(
      resolveChecked('h', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toMatchObject({ code: 'dns' });
  });
});

describe('guardedLookup (connect time)', () => {
  type Answer = { address: string; family: number }[];
  const fakeDns = (answer: Answer) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: Answer) => void) => cb(null, answer)) as never;
  const run = (host: string, answer: Answer, all: boolean) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      guardedLookup(new Set(['api.hochwasserzentralen.de']), undefined, fakeDns(answer))(
        host,
        { all },
        (err, address, family) => resolve({ err, address, ...(family === undefined ? {} : { family }) }),
      ),
    );

  it('refuses a host outside the union allowlist before resolving', async () => {
    const r = await run('evil.example', [{ address: '8.8.8.8', family: 4 }], false);
    expect(r.err).toBeInstanceOf(GuardError);
    expect((r.err as GuardError).code).toBe('not_allowlisted');
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1'])(
    'refuses an answer of %s',
    async (ip) => {
      const r = await run('api.hochwasserzentralen.de', [{ address: ip, family: ip.includes(':') ? 6 : 4 }], true);
      expect((r.err as GuardError).code).toBe('private_address');
    },
  );

  it('answers both callback shapes with the validated addresses only', async () => {
    const answer = [
      { address: '93.184.215.14', family: 4 },
      { address: '2606:4700::6810:84e5', family: 6 },
    ];
    expect(await run('API.hochwasserzentralen.de', answer, true)).toEqual({ err: null, address: answer });
    expect(await run('api.hochwasserzentralen.de', answer, false)).toEqual({
      err: null,
      address: '93.184.215.14',
      family: 4,
    });
  });
});

describe('TLS verification', () => {
  it('is never switched off anywhere in apps/server/src', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(new URL('../../src', import.meta.url).pathname);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files)
      expect(readFileSync(f, 'utf8')).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});
