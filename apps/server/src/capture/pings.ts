import type { Logger } from 'pino';
import { Client } from '../http/client.ts';

// healthchecks.io dead-man switches per provider group (A§11.3; the 9 contract
// slugs), also used by the watchdog role for its five checks. The ping key is
// a file secret, read again before every ping, so a key the owner fills in or
// rotates after the container started takes effect without a restart; a missing
// or malformed key means no ping. It is part of the URL, so no URL is ever
// logged. Owner groups send no body (no source ID leaves the VPS there).

export const PING_HOST = 'hc-ping.com';
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
/** The capture group slugs and the watchdog's five checks (P1b; `load` from P2a, `publisher` from P9a); nothing else is ever pinged from here. */
const SLUG = /^(?:cap-[a-z0-9-]+|watchdog|cert|disk|load|publisher)$/;

export type PingKind = 'start' | 'success' | 'fail';
/** The key itself (tests) or a reader of the key file, called before every ping. */
export type PingKey = string | undefined | (() => string | undefined);

const PING_TIMEOUT_MS = 10_000;
/** After a failed ping the host backs off: a ping waits at most this long, so it never holds a run for long. */
const PING_WAIT_MS = 30_000;

export class Pinger {
  private readonly client: Client;
  private readonly readKey: () => string | undefined;
  private readonly log: Pick<Logger, 'warn'>;
  private readonly timeoutMs: number;
  /** The last key state logged, so a missing key warns once, not every ping. */
  private state: 'ok' | 'missing' | 'malformed' | undefined;

  /** `client` and `timeoutMs` are test seams (constructor arguments only). */
  constructor(
    key: PingKey,
    userAgent: string,
    log: Pick<Logger, 'warn'>,
    client?: Client,
    timeoutMs = PING_TIMEOUT_MS,
  ) {
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.readKey = typeof key === 'function' ? key : () => key;
    this.client = client ?? new Client({ hosts: new Map([['hc', [PING_HOST]]]), userAgent });
    this.key();
  }

  /** The current key, or undefined (pings off); logs each change to missing or malformed once. */
  private key(): string | undefined {
    const raw = this.readKey();
    const key = raw !== undefined && KEY.test(raw) ? raw : undefined;
    const state = key !== undefined ? 'ok' : raw === undefined ? 'missing' : 'malformed';
    if (state !== this.state) {
      if (state === 'missing') this.log.warn('no /run/secrets/hc_ping_key: pings are off');
      if (state === 'malformed') this.log.warn('hc_ping_key has an unexpected format: pings are off');
      this.state = state;
    }
    return key;
  }

  get enabled(): boolean {
    return this.key() !== undefined;
  }

  /** Never throws; a failed ping is logged by slug only. */
  async ping(slug: string, kind: PingKind, body?: string): Promise<void> {
    if (!SLUG.test(slug)) return;
    const key = this.key();
    if (key === undefined) return;
    const suffix = kind === 'start' ? '/start' : kind === 'fail' ? '/fail' : '';
    const url = `https://${PING_HOST}/${key}/${slug}${suffix}`;
    const r = await this.client.fetch(
      'hc',
      { url, method: body === undefined ? 'GET' : 'POST', variant: slug, ...(body === undefined ? {} : { body }) },
      { maxBytes: 64 * 1024, timeoutMs: this.timeoutMs, deadline: Date.now() + PING_WAIT_MS },
    );
    if (!r.ok || r.res.status >= 400)
      this.log.warn({ slug, kind, error: r.ok ? r.res.status : r.error }, 'ping failed');
  }
}
