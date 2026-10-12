// verify-prod group "owner listener" (P12a, issue #27 criterion 10; A§11.5, ADR-0017). From outside, the owner site
// does not exist: on every public IPv4 and IPv6 address of the domain, TCP 443 with SNI and Host owner.<domain> is a
// failed TLS handshake (an unknown SNI) or the public catch-all's 421, never a 200 or a 401 of the owner site;
// TCP 8443 is closed; the name has no public DNS record; and robots.txt, the sitemap, sources.json and status.json
// name no owner-audience source. Pure classifiers plus one runner whose I/O is injected (the default talks to the
// network); verify-prod.ts only wires it in (see the report of WP-WG).

import { lookup } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import type { Result } from '../verify-prod.ts';

export type Probe =
  /** `ownerHeaders`: an owner-site header came with it, by its exact value (parseProbeHead); only --edge cloudflare reads it. */
  | { kind: 'answered'; status: number; wwwAuthenticate: boolean; ownerHeaders?: boolean }
  | { kind: 'handshake-failed' }
  /** The handshake completed with a certificate this client does not trust for owner.<domain>. */
  | { kind: 'certificate' }
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'unreachable' };

const pass = (check: string, detail: string): Result => ({ check, ok: true, detail });
const fail = (check: string, detail: string): Result => ({ check, ok: false, detail });
const na = (check: string, detail: string): Result => ({ check, ok: 'n/a', detail });

/** TCP 443 with SNI and Host owner.<domain>: a failed handshake or a 421; anything else is a miss. */
export function classify443(address: string, p: Probe): Result {
  const check = `owner listener 443 ${address}`;
  switch (p.kind) {
    case 'handshake-failed':
      return pass(check, 'TLS handshake refused for SNI owner.<domain> (unknown SNI)');
    case 'answered':
      if (p.status === 421 && !p.wwwAuthenticate) return pass(check, '421 from the public catch-all');
      return fail(
        check,
        `answered ${p.status}${p.wwwAuthenticate ? ' with a credentials challenge' : ''}, expected a failed handshake or 421`,
      );
    case 'certificate':
      return fail(
        check,
        'the handshake for SNI owner.<domain> completed with a certificate: something on the public address holds one for the owner name',
      );
    case 'unreachable':
      return na(check, 'address not reachable from here');
    default:
      return fail(check, `${p.kind}: the public listener should refuse the handshake or answer 421`);
  }
}

/** TCP 8443 on a public address: closed (refused, dropped or unreachable). Any TLS or HTTP answer is a miss. */
export function classify8443(address: string, p: Probe): Result {
  const check = `owner listener 8443 ${address}`;
  if (p.kind === 'refused' || p.kind === 'timeout') return pass(check, `closed (${p.kind})`);
  if (p.kind === 'unreachable') return na(check, 'address not reachable from here');
  return fail(check, p.kind === 'answered' ? `answered ${p.status}` : 'a TLS endpoint is listening');
}

/**
 * Behind a CDN (--edge cloudflare, issue #109) the edge addresses accept TCP 443 and 8443 and hold a wildcard
 * certificate, so a handshake or a CDN error page for owner.<domain> proves nothing. What would be a leak is our owner
 * site answering through the edge: a 200 or 401, a credentials challenge or an owner-site header. Same check names.
 */
export function classifyEdge(port: 443 | 8443, address: string, p: Probe): Result {
  const check = `owner listener ${port} ${address}`;
  if (p.kind === 'unreachable') return na(check, 'address not reachable from here');
  if (p.kind !== 'answered') return pass(check, `no owner answer through the edge (${p.kind})`);
  if (p.status === 200 || p.status === 401 || p.wwwAuthenticate || p.ownerHeaders === true)
    return fail(
      check,
      `answered ${p.status}${p.wwwAuthenticate ? ' with a credentials challenge' : ''}${p.ownerHeaders ? ' with owner-site headers' : ''}: the owner site is reachable through the edge`,
    );
  return pass(check, `edge answered ${p.status}, no owner site behind it`);
}

/** The owner hostname must have no public DNS record (the system resolver). */
export function classifyDns(addresses: readonly string[], errorCode?: string): Result {
  const check = 'owner listener DNS';
  if (addresses.length > 0) return fail(check, `owner.<domain> resolves publicly (${addresses.length} address(es))`);
  if (errorCode === 'ENOTFOUND' || errorCode === 'ENODATA' || errorCode === undefined) {
    return pass(check, 'no public DNS record');
  }
  return na(check, `resolver error ${errorCode}`);
}

/** A public document that exists must name no owner source (terms: ownerTerms(registry) of verify-prod.ts). */
export function classifyDocument(path: string, status: number, body: string, terms: readonly string[]): Result {
  const check = `owner listener ${path}`;
  if (status === 404 || status === 410) return pass(check, 'absent');
  if (status !== 200) return fail(check, `status ${status}`);
  const hits = terms.filter((t) => t.length > 0 && body.toLowerCase().includes(t.toLowerCase()));
  return hits.length === 0
    ? pass(check, 'names no owner-audience source')
    : fail(check, `names ${hits.length} owner term(s) (first: index ${terms.indexOf(hits[0] as string)})`);
}

export const OWNER_DOCUMENTS = [
  '/robots.txt',
  '/sitemap.xml',
  '/data/v1/sources.json',
  '/data/v1/status.json',
] as const;

export type Io = {
  /** Public IPv4 and IPv6 addresses of the domain. */
  addresses: (domain: string) => Promise<string[]>;
  probe: (address: string, port: number, domain: string) => Promise<Probe>;
  /** The system resolver's answer for a name: addresses, or the error code. */
  dns: (name: string) => Promise<{ addresses: string[]; code?: string | undefined }>;
  get: (domain: string, path: string) => Promise<{ status: number; body: string }>;
};

export async function checkOwnerListener(
  domain: string,
  terms: readonly string[],
  io: Io = networkIo,
  edge: 'direct' | 'cloudflare' = 'direct',
): Promise<Result[]> {
  const out: Result[] = [];
  const addresses = await io.addresses(domain);
  if (addresses.length === 0) out.push(fail('owner listener addresses', 'the domain has no public address'));
  for (const a of addresses) {
    const p443 = await io.probe(a, 443, domain);
    const p8443 = await io.probe(a, 8443, domain);
    out.push(
      edge === 'cloudflare' ? classifyEdge(443, a, p443) : classify443(a, p443),
      edge === 'cloudflare' ? classifyEdge(8443, a, p8443) : classify8443(a, p8443),
    );
  }
  const d = await io.dns(`owner.${domain}`);
  out.push(classifyDns(d.addresses, d.code));
  for (const path of OWNER_DOCUMENTS) {
    const r = await io.get(domain, path);
    out.push(classifyDocument(path, r.status, r.body, terms));
  }
  return out;
}

// ---------------------------------------------------------------- the network (not unit-tested; the CI e2e and the
// real run exercise it)
const UNREACHABLE = new Set(['ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTUNREACH']);
// Certificate verification errors: the server finished its side of the handshake for owner.<domain>. Verification
// stays on (no rejectUnauthorized: false): the public Caddy refuses the handshake for an unknown SNI, so any
// certificate offered for the owner name, trusted or not, is the leak this check looks for.
const CERTIFICATE = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
]);

/**
 * The status line and headers of an answer, as a probe result. `ownerHeaders` holds only the owner site's exact values
 * (owner.caddy: `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`): Cloudflare's own error pages
 * send `Cache-Control: private, max-age=0, no-store, …`, which is no owner sign (#109 review C2/S1).
 */
export function parseProbeHead(head: string): Probe {
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(head);
  if (!m) return { kind: 'handshake-failed' };
  return {
    kind: 'answered',
    status: Number(m[1]),
    wwwAuthenticate: /^www-authenticate:/im.test(head),
    ownerHeaders:
      /^x-robots-tag:[ \t]*noindex, nofollow[ \t]*\r?$/im.test(head) ||
      /^cache-control:[ \t]*private, no-store[ \t]*\r?$/im.test(head),
  };
}

export function probeTls(address: string, port: number, domain: string, timeoutMs = 8000): Promise<Probe> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (p: Probe) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(p);
    };
    const host = `owner.${domain}`;
    const socket = tlsConnect({ host: address, port, servername: host, timeout: timeoutMs }, () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: verify-prod\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', (c) => {
      buf += c.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0 && buf.length < 16_384) return;
      finish(parseProbeHead(buf.slice(0, end < 0 ? buf.length : end)));
    });
    socket.on('timeout', () => finish({ kind: 'timeout' }));
    socket.on('end', () => finish({ kind: 'handshake-failed' }));
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') finish({ kind: 'refused' });
      else if (e.code && UNREACHABLE.has(e.code)) finish({ kind: 'unreachable' });
      else if (e.code === 'ETIMEDOUT') finish({ kind: 'timeout' });
      else if (e.code && CERTIFICATE.has(e.code)) finish({ kind: 'certificate' });
      else finish({ kind: 'handshake-failed' });
    });
  });
}

export const networkIo: Io = {
  async addresses(domain) {
    const all = await lookup(domain, { all: true }).catch(() => []);
    return [...new Set(all.map((a) => a.address))];
  },
  probe: probeTls,
  async dns(name) {
    try {
      const all = await lookup(name, { all: true });
      return { addresses: all.map((a) => a.address) };
    } catch (e) {
      return { addresses: [], code: (e as NodeJS.ErrnoException).code };
    }
  },
  async get(domain, path) {
    const r = await fetch(`https://${domain}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: r.status, body: r.status === 200 ? await r.text() : '' };
  },
};
