import type { Logger } from 'pino';
import { Client } from '../http/client.ts';

// healthchecks.io dead-man switches per provider group (A§11.3; the 9 contract
// slugs). The ping key is a file secret: it is part of the URL, so no URL is
// ever logged. Owner groups send no body (no source ID leaves the VPS there).

export const PING_HOST = 'hc-ping.com';
const KEY = /^[A-Za-z0-9_-]{16,64}$/;

export type PingKind = 'start' | 'success' | 'fail';

export class Pinger {
  private readonly client: Client | null;
  private readonly key: string | undefined;
  private readonly log: Pick<Logger, 'warn'>;

  constructor(key: string | undefined, userAgent: string, log: Pick<Logger, 'warn'>, client?: Client) {
    this.log = log;
    this.key = key !== undefined && KEY.test(key) ? key : undefined;
    if (key === undefined) log.warn('no /run/secrets/hc_ping_key: pings are off');
    else if (this.key === undefined) log.warn('hc_ping_key has an unexpected format: pings are off');
    this.client =
      this.key === undefined ? null : (client ?? new Client({ hosts: new Map([['hc', [PING_HOST]]]), userAgent }));
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Never throws; a failed ping is logged by slug only. */
  async ping(slug: string, kind: PingKind, body?: string): Promise<void> {
    if (this.client === null || this.key === undefined || !/^cap-[a-z0-9-]+$/.test(slug)) return;
    const suffix = kind === 'start' ? '/start' : kind === 'fail' ? '/fail' : '';
    const url = `https://${PING_HOST}/${this.key}/${slug}${suffix}`;
    const r = await this.client.fetch(
      'hc',
      { url, method: body === undefined ? 'GET' : 'POST', variant: slug, ...(body === undefined ? {} : { body }) },
      { maxBytes: 64 * 1024, timeoutMs: 10_000 },
    );
    if (!r.ok || r.res.status >= 400)
      this.log.warn({ slug, kind, error: r.ok ? r.res.status : r.error }, 'ping failed');
  }
}
