import type { LookupFunction } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { BACKLOG_MAX_AGE_S, HEALTH_MAX_AGE_MS, HealthAnswer, LAG_DEGRADED_S } from '@rws/contracts';
import { type Logger, pino } from 'pino';
import { z } from 'zod';
import { captureEnv, captureUserAgent, EXIT_CONFIG, readSecret } from '../capture/env.ts';
import { Pinger } from '../capture/pings.ts';
import { CaptureStatus } from '../capture/status.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { guardedLookup } from '../http/addresses.ts';
import { Client } from '../http/client.ts';

// The watchdog role (A§4, A§11.3; issue #16 P1b). Every 5 minutes it probes our
// own public site the way a visitor reaches it (public DNS, verified TLS,
// the SSRF-guarded client; egress only to our domain and hc-ping.com) and pings
// its five healthchecks: `watchdog` (site up, capture.json and ops.json fresh,
// last backup < 2 h), `cert` (certificate valid for >= 14 days), `disk`
// (disk < 75%) and, from P2a, `load` (the loader computes: /api/v1/health is the
// contract document, not down, fresh, no quarantine, lag < 2 min, no manifest
// line left unconsumed for 15 min). A provider that is down is not the loader's
// failure: that is capture's freshness. From P9a `publisher` (the static publisher:
// /data/v1/meta.json is the contract's generatedAt, < 5 min old; 404 = not deployed
// yet, no ping). The fifth check, `owner-publisher`, is pinged by the host's
// rws-tick from a file mtime: the owner site is never probed from here. A failure
// ping carries fixed codes only.

export const CYCLE_MS = 5 * 60_000;
export const CAPTURE_MAX_AGE_MS = 5 * 60_000;
export const OPS_MAX_AGE_MS = 30 * 60_000;
export const BACKUP_MAX_AGE_MS = 2 * 3_600_000;
export const CERT_MIN_DAYS = 14;
export const DISK_MAX_PCT = 75;
export const PUBLISHER_MAX_AGE_MS = 5 * 60_000;

const iso = z.iso.datetime();
const n = z.number().int().nonnegative();
/** The one field of /data/v1/meta.json the watchdog reads (the publisher's contract owns the rest). */
const StaticMetaAge = z.looseObject({ generatedAt: iso });

/** /status/ops.json (the P1a ↔ P1b contract): written by the backup, drill and tick jobs. */
export const OpsStatus = z.strictObject({
  generated_at: iso,
  last_backup: iso.nullable(),
  drill: z.strictObject({ at: iso, sampled: n, matched: n }).nullable(),
  disk_pct: z.number().min(0).max(100).nullable(),
});
export type OpsStatus = z.infer<typeof OpsStatus>;

export type Got = { status: number; body: Buffer } | { error: string };
export type Probe = {
  get(path: string): Promise<Got>;
  /** Whole days until the served certificate expires, or 'tls' when no valid certificate was served. */
  certDaysLeft(): Promise<number | 'tls'>;
};
/**
 * Failure codes per check; an empty list is a success. `load` is null while the
 * release with /api/v1/health is not deployed (the site answers 404): that check
 * is not pinged at all.
 */
export type Verdicts = {
  watchdog: string[];
  cert: string[];
  disk: string[];
  load: string[] | null;
  /** Like `load`: null while the release with /data/v1/meta.json is not deployed (404). */
  publisher: string[] | null;
};

export const CHECKS = [
  'watchdog: GET /healthz answers 200',
  `watchdog: /status/capture.json is the contract document, generated < ${CAPTURE_MAX_AGE_MS / 60_000} min ago`,
  `watchdog: /status/ops.json is the contract document, generated < ${OPS_MAX_AGE_MS / 60_000} min ago`,
  `watchdog: the last backup finished < ${BACKUP_MAX_AGE_MS / 3_600_000} h ago`,
  `cert: the certificate is valid and expires in >= ${CERT_MIN_DAYS} days`,
  `disk: /srv/rws is < ${DISK_MAX_PCT}% full (disk_pct of a fresh ops.json)`,
  `load: /api/v1/health is the contract document, not down, generated < ${HEALTH_MAX_AGE_MS / 60_000} min ago, no quarantined payload, loader lag p95 < ${LAG_DEGRADED_S} s, no manifest line unconsumed for ${BACKLOG_MAX_AGE_S / 60} min, no failing twin check (404 = not deployed yet: no load ping)`,
  `publisher: /data/v1/meta.json carries a generatedAt < ${PUBLISHER_MAX_AGE_MS / 60_000} min old (404 = not deployed yet: no publisher ping)`,
];

const ageMs = (at: string, now: Date) => now.getTime() - Date.parse(at);

function json<T>(got: Got, schema: z.ZodType<T>): T | string {
  if ('error' in got) return got.error;
  if (got.status !== 200) return `status_${got.status}`;
  try {
    const parsed = schema.safeParse(JSON.parse(got.body.toString('utf8')));
    return parsed.success ? parsed.data : 'contract';
  } catch {
    return 'json';
  }
}

/**
 * The `load` check (P2a): the loader's state as /api/v1/health reports it. A 404
 * means the release that serves the endpoint is not deployed yet: null, no ping
 * and no failure of `watchdog`, so P1b production keeps working until then.
 * Every other miss is a fixed code, never the response text.
 */
function loadCodes(got: Got, now: Date): string[] | null {
  if ('error' in got) return ['load_unreachable'];
  if (got.status === 404) return null;
  if (got.status !== 200) return ['load_unreachable'];
  const health = json(got, HealthAnswer);
  if (typeof health === 'string') return ['load_contract'];
  const codes: string[] = [];
  if (health.status === 'down') codes.push('load_down');
  if (health.generated_at === null || ageMs(health.generated_at, now) > HEALTH_MAX_AGE_MS) codes.push('load_stale');
  if (health.quarantined > 0) codes.push('load_quarantined');
  if (health.loader.lag_p95_s !== null && health.loader.lag_p95_s >= LAG_DEGRADED_S) codes.push('load_lag');
  // A stall: the loader computes health but has left a line unconsumed for too long.
  if (health.loader.backlog_age_s !== null && health.loader.backlog_age_s >= BACKLOG_MAX_AGE_S)
    codes.push('load_backlog');
  // A twin pair whose difference left its tolerance (Eijsden TAW − NAP): one side is wrong.
  if (health.twins.failing > 0) codes.push('load_twin');
  return codes;
}

/** The `publisher` check (P9a): the static meta.json is fresh. 404 = not deployed: null. Fixed codes only. */
function publisherCodes(got: Got, now: Date): string[] | null {
  if ('error' in got) return ['publisher_unreachable'];
  if (got.status === 404) return null;
  if (got.status !== 200) return ['publisher_unreachable'];
  const meta = json(got, StaticMetaAge);
  if (typeof meta === 'string') return ['publisher_contract'];
  return ageMs(meta.generatedAt, now) > PUBLISHER_MAX_AGE_MS ? ['publisher_stale'] : [];
}

/** One watchdog cycle: pure given the probe and the clock. */
export async function check(probe: Probe, now: Date): Promise<Verdicts> {
  const v: Verdicts = { watchdog: [], cert: [], disk: [], load: null, publisher: null };
  const [healthz, capture, ops, days, health, meta] = await Promise.all([
    probe.get('/healthz'),
    probe.get('/status/capture.json'),
    probe.get('/status/ops.json'),
    probe.certDaysLeft(),
    probe.get('/api/v1/health'),
    probe.get('/data/v1/meta.json'),
  ]);
  v.load = loadCodes(health, now);
  v.publisher = publisherCodes(meta, now);
  if ('error' in healthz) v.watchdog.push(`healthz_${healthz.error}`);
  else if (healthz.status !== 200) v.watchdog.push(`healthz_${healthz.status}`);

  const cap = json(capture, CaptureStatus);
  if (typeof cap === 'string') v.watchdog.push(`capture_${cap}`);
  else if (ageMs(cap.generated_at, now) > CAPTURE_MAX_AGE_MS) v.watchdog.push('capture_stale');

  const o = json(ops, OpsStatus);
  if (typeof o === 'string') {
    v.watchdog.push(`ops_${o}`);
    v.disk.push(`ops_${o}`);
  } else {
    const fresh = ageMs(o.generated_at, now) <= OPS_MAX_AGE_MS;
    if (!fresh) {
      v.watchdog.push('ops_stale');
      v.disk.push('ops_stale');
    }
    if (o.last_backup === null) v.watchdog.push('backup_none');
    else if (ageMs(o.last_backup, now) > BACKUP_MAX_AGE_MS) v.watchdog.push('backup_stale');
    if (o.disk_pct === null) v.disk.push('disk_unknown');
    else if (o.disk_pct >= DISK_MAX_PCT) v.disk.push('disk_full');
  }

  if (days === 'tls') v.cert.push('tls');
  else if (days < CERT_MIN_DAYS) v.cert.push('cert_expiring');
  return v;
}

/** Whole days until the certificate served for `domain` expires; 'tls' on any TLS or network failure. */
export function certDaysLeft(domain: string, lookup: LookupFunction, now = () => new Date()): Promise<number | 'tls'> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: domain, port: 443, servername: domain, lookup, ALPNProtocols: ['http/1.1'] });
    const done = (value: number | 'tls') => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(15_000, () => done('tls'));
    socket.once('error', () => done('tls'));
    socket.once('secureConnect', () => {
      const expires = Date.parse(socket.getPeerCertificate().valid_to);
      done(
        socket.authorized && Number.isFinite(expires) ? Math.floor((expires - now().getTime()) / 86_400_000) : 'tls',
      );
    });
  });
}

/** The production probe: our own domain through the guarded client and public DNS. `client` is a test seam (an argument only). */
export function liveProbe(
  domain: string,
  userAgent: string,
  client = new Client({ hosts: new Map([['own', [domain]]]), userAgent }),
): Probe {
  const lookup = guardedLookup(new Set([domain])) as unknown as LookupFunction;
  return {
    async get(path) {
      const r = await client.fetch(
        'own',
        { url: `https://${domain}${path}`, method: 'GET', variant: path },
        { maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000 },
      );
      return r.ok ? { status: r.res.status, body: r.res.body } : { error: r.error };
    },
    certDaysLeft: () => certDaysLeft(domain, lookup),
  };
}

/** Pings each check: success, or /fail with its failure codes; a check that does not apply yet (null) is skipped. */
export async function report(v: Verdicts, pinger: Pick<Pinger, 'ping'>): Promise<void> {
  for (const slug of ['watchdog', 'cert', 'disk', 'load', 'publisher'] as const) {
    const codes = v[slug];
    if (codes === null) continue;
    await (codes.length === 0 ? pinger.ping(slug, 'success') : pinger.ping(slug, 'fail', codes.join(' ')));
  }
}

export type Mode = 'loop' | 'once' | 'dry-run';

/**
 * The role: `watchdog` loops every 5 minutes until SIGTERM, `--once` runs one
 * cycle (exit 0 when every check passed), `--dry-run` lists the checks.
 */
export async function runWatchdog(
  env: Readonly<Record<string, string | undefined>>,
  mode: Mode,
  log: (line: string) => void,
): Promise<number> {
  if (mode === 'dry-run') {
    for (const c of CHECKS) log(c);
    return 0;
  }
  const cfg = captureEnv(env);
  if (typeof cfg === 'string') {
    log(`watchdog: ${cfg}`);
    return EXIT_CONFIG;
  }
  const logger: Logger = pino({ base: { role: 'watchdog' } });
  const userAgent = captureUserAgent(cfg);
  const probe = liveProbe(cfg.domain, userAgent);
  const pinger = new Pinger(() => readSecret('hc_ping_key'), userAgent, logger);
  const cycle = async (): Promise<Verdicts> => {
    const v = await check(probe, new Date());
    await report(v, pinger);
    logger.info(
      { watchdog: v.watchdog, cert: v.cert, disk: v.disk, load: v.load, publisher: v.publisher },
      'watchdog cycle',
    );
    return v;
  };
  if (mode === 'once') {
    const v = await cycle();
    return v.watchdog.length + v.cert.length + v.disk.length + (v.load?.length ?? 0) + (v.publisher?.length ?? 0) === 0
      ? 0
      : 1;
  }
  // A cycle never rejects: an unexpected error is logged by name only and the next cycle runs.
  const safeCycle = () =>
    cycle().catch((err: unknown) => {
      const name = (err as { name?: unknown } | null)?.name;
      logger.error({ name: typeof name === 'string' ? name.slice(0, 64) : 'other' }, 'watchdog cycle failed');
    });
  const stopHeartbeat = startHeartbeat();
  let running: Promise<unknown> = safeCycle();
  const timer = setInterval(() => {
    running = running.then(safeCycle);
  }, CYCLE_MS);
  return new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      void running.finally(() => {
        stopHeartbeat();
        resolve(0);
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
