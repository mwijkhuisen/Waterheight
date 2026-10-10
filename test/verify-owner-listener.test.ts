import { describe, expect, it } from 'vitest';
import {
  checkOwnerListener,
  classify443,
  classify8443,
  classifyDns,
  classifyDocument,
  type Io,
  OWNER_DOCUMENTS,
  type Probe,
} from '../scripts/lib/verify-owner-listener.ts';

// P12a, criterion 10: the owner site does not exist from outside.

describe('classify443', () => {
  it('passes a failed handshake and the 421 catch-all', () => {
    expect(classify443('203.0.113.1', { kind: 'handshake-failed' }).ok).toBe(true);
    expect(classify443('203.0.113.1', { kind: 'answered', status: 421, wwwAuthenticate: false }).ok).toBe(true);
  });
  it('fails a 200, a 401, a challenge and any other answer', () => {
    for (const status of [200, 401, 404, 308]) {
      expect(classify443('203.0.113.1', { kind: 'answered', status, wwwAuthenticate: false }).ok).toBe(false);
    }
    expect(classify443('203.0.113.1', { kind: 'answered', status: 421, wwwAuthenticate: true }).ok).toBe(false);
  });
  it('fails a refusal or timeout of the public listener, and is n/a where the address is unreachable', () => {
    expect(classify443('203.0.113.1', { kind: 'refused' }).ok).toBe(false);
    expect(classify443('203.0.113.1', { kind: 'timeout' }).ok).toBe(false);
    expect(classify443('2001:db8::1', { kind: 'unreachable' }).ok).toBe('n/a');
  });
});

describe('classify8443', () => {
  it('passes only a closed port', () => {
    expect(classify8443('a', { kind: 'refused' }).ok).toBe(true);
    expect(classify8443('a', { kind: 'timeout' }).ok).toBe(true);
    expect(classify8443('a', { kind: 'unreachable' }).ok).toBe('n/a');
    expect(classify8443('a', { kind: 'handshake-failed' }).ok).toBe(false);
    expect(classify8443('a', { kind: 'answered', status: 401, wwwAuthenticate: true }).ok).toBe(false);
  });
});

describe('classifyDns and classifyDocument', () => {
  it('needs no public record', () => {
    expect(classifyDns([], 'ENOTFOUND').ok).toBe(true);
    expect(classifyDns([], 'ENODATA').ok).toBe(true);
    expect(classifyDns(['10.66.0.1']).ok).toBe(false);
    expect(classifyDns([], 'ESERVFAIL').ok).toBe('n/a');
  });
  it('lets an absent document pass and fails one that names an owner term, without printing the term', () => {
    expect(classifyDocument('/robots.txt', 404, '', ['BE-3']).ok).toBe(true);
    expect(classifyDocument('/sitemap.xml', 200, '<urlset/>', ['BE-3']).ok).toBe(true);
    const r = classifyDocument('/data/v1/sources.json', 200, '{"id":"be-3"}', ['BE-3', 'LU-2']);
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('BE-3');
    expect(classifyDocument('/data/v1/status.json', 500, '', []).ok).toBe(false);
  });
});

describe('checkOwnerListener', () => {
  const io = (probe: (a: string, p: number) => Probe, dns = { addresses: [] as string[], code: 'ENOTFOUND' }): Io => ({
    addresses: async () => ['203.0.113.1', '2001:db8::1'],
    probe: async (a, p) => probe(a, p),
    dns: async () => dns,
    get: async () => ({ status: 404, body: '' }),
  });
  const good = (_a: string, p: number): Probe => (p === 443 ? { kind: 'handshake-failed' } : { kind: 'refused' });

  it('passes a closed-off site on every address', async () => {
    const r = await checkOwnerListener('rivierstanden.example', ['BE-3'], io(good));
    expect(r.every((x) => x.ok === true)).toBe(true);
    expect(r).toHaveLength(2 * 2 + 1 + OWNER_DOCUMENTS.length);
  });
  it('fails when one address answers as the owner site, on 8443 or in DNS', async () => {
    const leak = (a: string, p: number): Probe =>
      a.startsWith('2001') && p === 443 ? { kind: 'answered', status: 401, wwwAuthenticate: true } : good(a, p);
    expect((await checkOwnerListener('d.example', [], io(leak))).filter((x) => x.ok === false)).toHaveLength(1);
    const open = (a: string, p: number): Probe => (p === 8443 ? { kind: 'handshake-failed' } : good(a, p));
    expect((await checkOwnerListener('d.example', [], io(open))).filter((x) => x.ok === false)).toHaveLength(2);
    const dns = await checkOwnerListener('d.example', [], io(good, { addresses: ['192.0.2.9'], code: '' }));
    expect(dns.filter((x) => x.ok === false).map((x) => x.check)).toEqual(['owner listener DNS']);
  });
  it('fails a domain without any public address', async () => {
    const r = await checkOwnerListener('d.example', [], { ...io(good), addresses: async () => [] });
    expect(r[0]?.ok).toBe(false);
  });
});
