import { isIP, type Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip } from 'node:zlib';
import { Agent, buildConnector, request } from 'undici';
import {
  GuardError,
  guardedLookup,
  isPublicAddress,
  type Resolver,
  resolveChecked,
  systemResolver,
} from './addresses.ts';
import { ByteBudget, Politeness, parseRetryAfter } from './politeness.ts';
import type { ErrorCode, FetchResult, Req, Transport, TransportResponse } from './types.ts';

// The polite, SSRF-guarded client (A§7.3, A§12.2; catalogue §6.7). Fetch
// targets come only from the registry (invariant 1): a URL must be https, on a
// host allowlisted for its source ID, and resolve to public addresses only,
// on the first request and on every redirect hop.

export const MAX_WIRE_BYTES = 25 * 1024 * 1024;
export const MAX_DECODED_BYTES = 100 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 60_000;
export const METADATA_TIMEOUT_MS = 120_000;
export const MAX_REDIRECTS = 3;
export const IN_FLIGHT_BYTES = 128 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Besides 5xx: throttling, and a WAF that blocks us (403, 451), back off like 429 (catalogue §10 R7). */
const BACK_OFF = new Set([403, 429, 451]);

/**
 * The production transport: one undici Agent for every source, at most two
 * connections per origin. Its connect-time lookup enforces the union
 * allowlist and public addresses, and the connected peer address is checked
 * again. `isAllowed` exists for the transport test only (a constructor
 * argument, never reachable from env or config).
 */
export function undiciTransport(
  allowedHosts: ReadonlySet<string>,
  isAllowed: (address: string) => boolean = isPublicAddress,
  lookup?: Parameters<typeof guardedLookup>[2],
): { transport: Transport; agent: Agent } {
  const connector = buildConnector({
    timeout: CONNECT_TIMEOUT_MS,
    lookup: guardedLookup(allowedHosts, isAllowed, lookup),
    autoSelectFamily: true,
  } as buildConnector.BuildOptions);
  const agent = new Agent({
    connections: 2,
    pipelining: 1,
    // The per-request AbortSignal is the real total deadline; these only backstop it.
    headersTimeout: METADATA_TIMEOUT_MS,
    bodyTimeout: METADATA_TIMEOUT_MS,
    connect: (options, callback) =>
      connector(options, (err, socket) => {
        if (err !== null) return callback(err, null);
        const remote = (socket as Socket).remoteAddress;
        if (remote === undefined || !isAllowed(remote)) {
          socket.destroy();
          return callback(new GuardError('private_address'), null);
        }
        return callback(null, socket);
      }),
  });
  const transport: Transport = async ({ url, method, headers, body, signal }) => {
    const res = await request(url, { dispatcher: agent, method, headers, body: body ?? null, signal });
    return { status: res.statusCode, headers: res.headers, body: res.body };
  };
  return { transport, agent };
}

class CapError extends Error {
  readonly code: 'too_large' | 'too_large_decoded' | 'bad_encoding';
  constructor(code: CapError['code']) {
    super(code);
    this.code = code;
  }
}

export function header(headers: TransportResponse['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function flatHeaders(headers: TransportResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers))
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** Drops a body unread. An undici body destroyed before its end emits 'error', which needs a listener (N1). */
function discard(body: TransportResponse['body']): void {
  body.on('error', () => {});
  body.destroy();
}

/**
 * Reads the body while counting raw bytes (never trusting Content-Length) and
 * decodes one layer of gzip or br (what we advertise) with a decoded cap.
 * Anything else, stacked encodings included, is refused.
 */
export async function readBody(
  res: TransportResponse,
  maxWire: number,
  maxDecoded: number,
  signal: AbortSignal,
): Promise<{ body: Buffer; wire: number }> {
  const encoding = (header(res.headers, 'content-encoding') ?? '').trim().toLowerCase();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : null;
  if (decoder === null && encoding !== '' && encoding !== 'identity') {
    discard(res.body);
    throw new CapError('bad_encoding');
  }
  let wire = 0;
  let decoded = 0;
  const chunks: Buffer[] = [];
  const countWire = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      wire += chunk.length;
      if (wire > maxWire) throw new CapError('too_large');
      yield chunk;
    }
  };
  const collect = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      decoded += chunk.length;
      if (decoded > maxDecoded) throw new CapError('too_large_decoded');
      chunks.push(chunk);
    }
  };
  const run = decoder
    ? pipeline(res.body, countWire, decoder, collect, { signal })
    : pipeline(res.body, countWire, collect, { signal });
  try {
    await abortable(run, signal);
  } catch (e) {
    discard(res.body);
    throw e;
  }
  return { body: Buffer.concat(chunks), wire };
}

/**
 * Rejects when the signal aborts, even if the wrapped promise never settles.
 * The wrapped promise is always observed, so its late rejection is never an
 * unhandled rejection (which would end the process).
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export function errorCode(e: unknown, signal: AbortSignal): ErrorCode {
  if (e instanceof CapError) return e.code;
  for (let x: unknown = e; x instanceof Error; x = x.cause) if (x instanceof GuardError) return x.code;
  if (signal.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError') return 'timeout';
  const code = String((e as { code?: unknown } | null)?.code ?? '');
  if (code.includes('TIMEOUT')) return 'timeout';
  if (code.startsWith('Z_') || code.startsWith('ERR__ZLIB')) return 'bad_encoding';
  return 'network';
}

export type ClientOptions = {
  /** Allowlisted hosts per source ID (registry/capture.yaml). */
  hosts: ReadonlyMap<string, readonly string[]>;
  userAgent: string;
  /** Extra headers per source ID, e.g. the RWS X-API-KEY. */
  sourceHeaders?: ReadonlyMap<string, Record<string, string>>;
  /** Tests inject a msw-backed transport; production uses undici. */
  transport?: Transport;
  resolver?: Resolver;
  politeness?: Politeness;
  budget?: ByteBudget;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type FetchOptions = {
  /** Raw-byte cap (≤ 25 MB); the decoded cap is min(100 MB, 4×). */
  maxBytes?: number;
  timeoutMs?: number;
  /** Epoch ms: a backoff wait that would end later is not waited for. */
  deadline?: number;
  signal?: AbortSignal;
};

export class Client {
  readonly politeness: Politeness;
  private readonly hosts: ReadonlyMap<string, readonly string[]>;
  private readonly transport: Transport;
  private readonly resolver: Resolver;
  private readonly budget: ByteBudget;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.hosts = options.hosts;
    this.transport = options.transport ?? undiciTransport(new Set([...options.hosts.values()].flat())).transport;
    this.resolver = options.resolver ?? systemResolver;
    this.politeness = options.politeness ?? new Politeness();
    this.budget = options.budget ?? new ByteBudget(IN_FLIGHT_BYTES);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * The static URL checks, also applied to every provider-supplied URL (a
   * Hub'Eau `next`, an LU-5 resource `url`): https, no userinfo, no IP
   * literal, port 443, host allowlisted for this source ID.
   */
  checkUrl(sourceId: string, raw: string): URL | ErrorCode {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'bad_url';
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return 'bad_url';
    if (url.port !== '' && url.port !== '443') return 'bad_url';
    const host = url.hostname.toLowerCase();
    if (host.startsWith('[') || isIP(host) !== 0) return 'bad_url';
    if (!this.hosts.get(sourceId)?.includes(host)) return 'not_allowlisted';
    return url;
  }

  async fetch(sourceId: string, req: Req, opts: FetchOptions = {}): Promise<FetchResult> {
    const first = this.checkUrl(sourceId, req.url);
    if (typeof first === 'string') return { ok: false, error: first };
    const maxWire = Math.min(opts.maxBytes ?? MAX_WIRE_BYTES, MAX_WIRE_BYTES);
    const maxDecoded = Math.min(MAX_DECODED_BYTES, 4 * maxWire);
    const timeoutMs = opts.timeoutMs ?? TOTAL_TIMEOUT_MS;
    // A deadline starts after every wait before it, so a wait never turns into a timeout.
    const deadline = () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      return opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    };
    const headers: Record<string, string> = {
      ...this.options.sourceHeaders?.get(sourceId),
      ...req.headers,
      'user-agent': this.options.userAgent,
      'accept-encoding': 'gzip, br',
    };
    // Redirects stay on this host. One gate per request: a redirect hop is part of the same request (and probe).
    const host = first.hostname.toLowerCase();
    const gate = this.politeness.gate(host, this.now());
    if ('skip' in gate) return { ok: false, error: gate.skip };
    try {
      if (gate.wait > 0) {
        if (opts.deadline !== undefined && this.now() + gate.wait > opts.deadline)
          return { ok: false, error: 'backoff' };
        await this.sleep(gate.wait);
      }
      let url = first;
      let method = req.method;
      let body = req.body;
      for (let hop = 0; ; hop += 1) {
        try {
          await abortable(resolveChecked(host, this.resolver), deadline());
        } catch (e) {
          return { ok: false, error: e instanceof GuardError ? e.code : 'dns' };
        }
        // Memory is reserved for the transfer only: never across a wait, a DNS lookup or another host's backoff.
        const release = await this.budget.acquire(maxDecoded);
        try {
          // The total deadline of this hop (headers and body) starts here, after the waits.
          const signal = deadline();
          // Only the caller can have aborted it: nothing was sent, so it is no failure of the host.
          if (signal.aborted) return { ok: false, error: 'backoff' };
          const pending = this.transport({ url, method, headers, ...(body === undefined ? {} : { body }), signal });
          let res: TransportResponse;
          try {
            // Raced against the deadline: the total timeout holds even if a transport ignores the signal.
            res = await abortable(pending, signal);
          } catch (e) {
            // Such a transport's late answer must not keep its socket open.
            pending.then(
              (r) => discard(r.body),
              () => {},
            );
            return this.failed(host, errorCode(e, signal));
          }
          if (res.status < 100 || res.status > 599) {
            discard(res.body);
            return { ok: false, error: 'bad_status' };
          }
          const location = header(res.headers, 'location');
          if (REDIRECTS.has(res.status) && location !== undefined) {
            discard(res.body);
            if (hop >= MAX_REDIRECTS) return { ok: false, error: 'redirect_limit' };
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              return { ok: false, error: 'bad_url' };
            }
            if (next.protocol !== 'https:') return { ok: false, error: 'redirect_insecure' };
            if (next.hostname.toLowerCase() !== host) {
              return { ok: false, error: 'redirect_cross_host' };
            }
            const checked = this.checkUrl(sourceId, next.href);
            if (typeof checked === 'string') return { ok: false, error: checked };
            url = checked;
            if (res.status === 303) {
              method = 'GET';
              body = undefined;
            }
            continue;
          }
          let read: { body: Buffer; wire: number };
          try {
            if (res.status === 204 || res.status === 304) {
              discard(res.body);
              read = { body: Buffer.alloc(0), wire: 0 };
            } else {
              read = await readBody(res, maxWire, maxDecoded, signal);
            }
          } catch (e) {
            const code = errorCode(e, signal);
            return code === 'timeout' || code === 'network' ? this.failed(host, code) : { ok: false, error: code };
          }
          const now = this.now();
          if (res.status >= 500 || BACK_OFF.has(res.status)) {
            this.politeness.failure(host, now, parseRetryAfter(header(res.headers, 'retry-after'), now));
          } else {
            this.politeness.success(host);
          }
          return {
            ok: true,
            res: {
              status: res.status,
              headers: flatHeaders(res.headers),
              body: read.body,
              wireBytes: read.wire,
              url: url.href,
            },
          };
        } finally {
          release();
        }
      }
    } finally {
      // A probe released on every exit path: one without a success or a failure re-arms the breaker.
      if (gate.probe) this.politeness.release(host, this.now());
    }
  }

  private failed(host: string, error: ErrorCode): FetchResult {
    if (error === 'timeout' || error === 'network') this.politeness.failure(host, this.now());
    return { ok: false, error };
  }
}
