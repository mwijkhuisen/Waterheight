import { isIP } from 'node:net';
import type { RateClass } from './channels.ts';

// Per-client token buckets of the API (P9b, A§9.2). The key comes only from `X-Rws-Client`, which Caddy sets to the
// TCP peer (`header_up X-Rws-Client {remote_host}`), replacing whatever a client sent; no trusted_proxies, so a
// client's X-Forwarded-For, Forwarded or X-Real-IP never reaches a key. Static files never meet this code: Caddy
// serves /data, /assets, /tiles and the pages itself. The limiter keeps its own monotonic clock, never the app's.

export type Bucket = { rate: number; burst: number };
export const BUCKETS: Readonly<Record<RateClass, Bucket>> = {
  general: { rate: 30, burst: 120 },
  heavy: { rate: 5, burst: 20 },
  beacon: { rate: 1, burst: 10 },
};
/** Every client's beacons together (C14): one log line per report, so a many-source flood is capped too. */
// ponytail: one bucket for every client's beacons, so a flood from many sources caps the log at 20 lines a second
// but can also crowd out honest reports meanwhile; per-/48 buckets if that is ever seen.
export const BEACON_GLOBAL: Bucket = { rate: 20, burst: 100 };
/**
 * A peer in a private or loopback range is a Docker bridge gateway or the host (C7: docker-proxy collapses every
 * client to it). Its bucket is 100× larger, so a collapse degrades to "barely limited", never a lockout of everyone.
 */
export const GATEWAY_FACTOR = 100;
export const MAX_KEYS = 50_000;
const SWEEP_MS = 30_000;

/** The shared key of a request without a usable `X-Rws-Client` (Caddy always sets it in production). */
export const UNKNOWN = 'unknown';
export const GATEWAY = 'unknown-gw';

function ipv6Groups(text: string): number[] | undefined {
  const [head, tail, ...more] = text.split('::');
  if (more.length > 0 || head === undefined) return undefined;
  const part = (s: string) => (s === '' ? [] : s.split(':'));
  const h = part(head);
  const t = tail === undefined ? [] : part(tail);
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0) return undefined;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** 10/8, 127/8, 172.16/12, 192.168/16, link-local 169.254/16 and the carrier-grade 100.64/10. */
const PRIVATE_V4 = (o: number[]) =>
  (o[0] === 169 && o[1] === 254) ||
  (o[0] === 100 && (o[1] as number) >= 64 && (o[1] as number) < 128) ||
  o[0] === 10 ||
  o[0] === 127 ||
  (o[0] === 172 && (o[1] as number) >= 16 && (o[1] as number) < 32) ||
  (o[0] === 192 && o[1] === 168);

/**
 * The bucket key of a peer address: IPv4 as is, IPv4-mapped IPv6 as its IPv4, other IPv6 by its /64 (expanded,
 * lowercase); a private or loopback peer is GATEWAY; anything missing or invalid is UNKNOWN.
 */
export function clientKey(header: string | undefined): string {
  if (header === undefined) return UNKNOWN;
  let text = header.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  text = text.replace(/%[0-9A-Za-z._~-]{1,32}$/, ''); // a zone id
  if (text.length > 45) return UNKNOWN;
  const mapped = /^::ffff:([0-9.]+)$/i.exec(text);
  if (mapped !== null) text = mapped[1] as string;
  const kind = isIP(text);
  if (kind === 4) {
    const o = text.split('.').map(Number);
    return PRIVATE_V4(o) ? GATEWAY : o.join('.');
  }
  if (kind !== 6) return UNKNOWN;
  const g = ipv6Groups(text);
  if (g === undefined) return UNKNOWN;
  const first = g[0] as number;
  // ::1, the unspecified address, ULA fc00::/7 and link-local fe80::/10 are the host's or a bridge's, never a client's.
  if (g.slice(0, 7).every((x) => x === 0) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return GATEWAY;
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

type State = { tokens: number; at: number };

/**
 * The buckets of one process, a bounded map: an entry whose bucket would be full again is dropped on access and by a
 * sweep every 30 s, and past MAX_KEYS keys the least recently used is evicted (the evicted client simply starts full).
 */
// ponytail: an attacker rotating /64s inside a large allocation evicts other clients early (they start full again);
// add a second, per-/48 tier if that is ever seen.
export class Limiter {
  readonly #state = new Map<string, State>();
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #onGateway: (() => void) | undefined;
  #swept = 0;
  #gatewayLogged = Number.NEGATIVE_INFINITY;

  constructor(opts: { now?: () => number; maxKeys?: number; onGateway?: () => void } = {}) {
    this.#now = opts.now ?? (() => performance.now());
    this.#maxKeys = opts.maxKeys ?? MAX_KEYS;
    this.#onGateway = opts.onGateway;
  }

  get size(): number {
    return this.#state.size;
  }

  /**
   * Takes one token of each bucket the class needs (`heavy` also takes `general`; `beacon` its own and the global
   * beacon bucket). 0 when allowed, else the whole seconds until one token is back (Retry-After, at least 1); a
   * refused request takes nothing.
   */
  take(key: string, cls: RateClass): number {
    const now = this.#now();
    this.#sweep(now);
    const scale = key === GATEWAY ? GATEWAY_FACTOR : 1;
    if (key === GATEWAY && now - this.#gatewayLogged >= 60_000) {
      this.#gatewayLogged = now;
      this.#onGateway?.();
    }
    const need: [string, Bucket][] =
      cls === 'beacon'
        ? [
            [`${key}|beacon`, BUCKETS.beacon],
            ['*|beacon', BEACON_GLOBAL],
          ]
        : cls === 'heavy'
          ? [
              [`${key}|general`, BUCKETS.general],
              [`${key}|heavy`, BUCKETS.heavy],
            ]
          : [[`${key}|general`, BUCKETS.general]];
    const states = need.map(([k, b]) => {
      const bucket = k.startsWith('*') ? b : { rate: b.rate * scale, burst: b.burst * scale };
      return { k, bucket, s: this.#refill(k, bucket, now) };
    });
    const wait = Math.max(...states.map(({ bucket, s }) => (s.tokens >= 1 ? 0 : (1 - s.tokens) / bucket.rate)));
    if (wait > 0) return Math.max(1, Math.ceil(wait));
    for (const { k, s } of states) {
      s.tokens -= 1;
      this.#put(k, s);
    }
    return 0;
  }

  #refill(k: string, b: Bucket, now: number): State {
    const old = this.#state.get(k);
    if (old === undefined) return { tokens: b.burst, at: now };
    return { tokens: Math.min(b.burst, old.tokens + ((now - old.at) / 1000) * b.rate), at: now };
  }

  #put(k: string, s: State): void {
    this.#state.delete(k); // re-inserted: Map order is the recency order
    if (this.#state.size >= this.#maxKeys) {
      const oldest = this.#state.keys().next();
      if (!oldest.done) this.#state.delete(oldest.value);
    }
    this.#state.set(k, s);
  }

  /** Drops the entries whose bucket is full again: they hold nothing a fresh entry would not. */
  #sweep(now: number): void {
    if (now - this.#swept < SWEEP_MS) return;
    this.#swept = now;
    for (const [k, s] of this.#state) {
      const cls = k.slice(k.lastIndexOf('|') + 1) as RateClass;
      const base = k.startsWith('*') ? BEACON_GLOBAL : BUCKETS[cls];
      const scale = k.startsWith(`${GATEWAY}|`) ? GATEWAY_FACTOR : 1;
      if (s.tokens + ((now - s.at) / 1000) * base.rate * scale >= base.burst * scale) this.#state.delete(k);
    }
  }
}
