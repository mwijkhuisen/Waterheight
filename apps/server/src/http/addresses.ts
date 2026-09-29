import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

// Address checks of the SSRF guard (A§12.2; catalogue §6.7). Every address a
// socket connects to must be public; the same check runs once per request and
// redirect hop (resolveChecked) and again inside the connect-time DNS lookup
// (guardedLookup), which is the only resolution the socket uses.

const V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the 169.254.169.254 metadata service
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];
/** IPv6 is an allowlist: global unicast 2000::/3 only (RFC 4291), minus the special blocks inside it. */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const V6: [string, number][] = [
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation (RFC 9637)
];

const blocked = new BlockList();
for (const [a, p] of V4) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6) blocked.addSubnet(a, p, 'ipv6');

/**
 * True only for a globally routable unicast address. Refused: every IPv4
 * range above; every IPv6 address outside 2000::/3 (unspecified, loopback,
 * IPv4-mapped or -translated whatever it wraps, NAT64, ULA, link- and
 * site-local, multicast, the rest of ::/8) and the blocks above inside it;
 * zone-scoped and malformed addresses.
 */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && !GLOBAL_V6.check(address, 'ipv6')) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class GuardError extends Error {
  readonly code: 'not_allowlisted' | 'private_address' | 'dns';
  constructor(code: GuardError['code']) {
    super(`rws guard: ${code}`);
    this.code = code;
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** The system resolver, every answer (A and AAAA). */
export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: 'verbatim' }, (err, addrs) =>
      err ? reject(err) : resolve(addrs.map((a) => a.address)),
    );
  });

/** Resolves a host and requires every answer to be public (per request and per redirect hop). */
export async function resolveChecked(
  hostname: string,
  resolver: Resolver = systemResolver,
  isAllowed: (address: string) => boolean = isPublicAddress,
): Promise<string[]> {
  let addrs: string[];
  try {
    addrs = await resolver(hostname);
  } catch {
    throw new GuardError('dns');
  }
  if (addrs.length === 0) throw new GuardError('dns');
  if (!addrs.every(isAllowed)) throw new GuardError('private_address');
  return addrs;
}

type LookupOptions = { family?: number | string; all?: boolean; hints?: number };
type LookupCallback = (err: Error | null, address: string | LookupAddress[], family?: number) => void;
export type LookupFn = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

/**
 * The connect-time lookup for the undici Agent (net/tls `lookup` option). The
 * host must be in the union allowlist and every answer public; the socket then
 * connects only to a validated address. Handles both callback shapes (Node's
 * happy-eyeballs path asks with `all: true`).
 */
export function guardedLookup(
  allowedHosts: ReadonlySet<string>,
  isAllowed: (address: string) => boolean = isPublicAddress,
  lookup: typeof dnsLookup = dnsLookup,
): LookupFn {
  return (hostname, options, callback) => {
    if (!allowedHosts.has(hostname.toLowerCase())) {
      callback(new GuardError('not_allowlisted'), '');
      return;
    }
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family ?? 0) || 0;
    lookup(hostname, { all: true, family, order: 'verbatim' }, (err, addrs) => {
      if (err) return callback(err, '');
      if (addrs.length === 0 || !addrs.every((a) => isAllowed(a.address))) {
        return callback(new GuardError('private_address'), '');
      }
      if (options.all) return callback(null, addrs);
      const [first] = addrs as [LookupAddress];
      return callback(null, first.address, first.family);
    });
  };
}
