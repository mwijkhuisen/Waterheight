import { readFileSync } from 'node:fs';
import { SOURCE_RE } from '../archive/manifest.ts';
import type { Group, LoadedSpec, Registry } from './specs.ts';

// The P1a ↔ P1b contract: env names, file secrets and the User-Agent (A§7.3).
// Secrets are files under /run/secrets only; they never reach a log, the
// manifest or a status file (invariant 6).

export const VERSION = '0.1.0';
export const EXIT_CONFIG = 78;
export const SECRETS_DIR = '/run/secrets';

export type CaptureEnv = {
  rawDir: string;
  statusDir: string;
  ownerStatusDir: string;
  domain: string;
  contactEmail: string;
};

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The capture role's environment. Without a valid RWS_DOMAIN and
 * RWS_CONTACT_EMAIL it returns an error (the A2 switch): no request ever goes
 * out without a contact User-Agent.
 */
export function captureEnv(env: Readonly<Record<string, string | undefined>>): CaptureEnv | string {
  const domain = env.RWS_DOMAIN ?? '';
  const contactEmail = env.RWS_CONTACT_EMAIL ?? '';
  if (!DOMAIN.test(domain)) return 'RWS_DOMAIN is missing or not a domain name (owner action A2)';
  if (!EMAIL.test(contactEmail)) return 'RWS_CONTACT_EMAIL is missing or not an e-mail address (owner action A2)';
  return {
    rawDir: env.RWS_RAW_DIR || '/data/raw',
    statusDir: env.RWS_STATUS_DIR || '/data/status',
    ownerStatusDir: env.RWS_OWNER_STATUS_DIR || '/data/owner-status',
    domain,
    contactEmail,
  };
}

export const userAgent = (infoUrl: string, contact: string) => `rivierstanden/${VERSION} (+${infoUrl}; ${contact})`;

export const captureUserAgent = (env: Pick<CaptureEnv, 'domain' | 'contactEmail'>) =>
  userAgent(`https://${env.domain}/over`, env.contactEmail);

/** A file secret, trimmed; undefined when absent or unreadable. The name is fixed by the registry. */
export function readSecret(name: string, dir = SECRETS_DIR): string | undefined {
  if (!/^[a-z0-9_]+$/.test(name)) return undefined;
  try {
    const v = readFileSync(`${dir}/${name}`, 'utf8').trim();
    return v === '' || /[\r\n]/.test(v) ? undefined : v;
  } catch {
    return undefined;
  }
}

/** The fixed codes `RWS_CAPTURE_SKIP` can fail with: never the offending text (it is operator input, not a spec). */
export const SKIP_MALFORMED = 'RWS_CAPTURE_SKIP_MALFORMED';
export const SKIP_UNKNOWN = 'RWS_CAPTURE_SKIP_UNKNOWN';

/**
 * `RWS_CAPTURE_SKIP` (A19, the rebuild drill): comma-separated catalogue source IDs whose specs this capture
 * process leaves out, so that a drill VPS does not spend a provider's budget next to production. Unset or empty
 * skips nothing. A malformed list is a fixed code, as is an ID that is not a captured source (see `applyCaptureSkip`).
 */
export function parseCaptureSkip(env: Readonly<Record<string, string | undefined>>): string[] | string {
  const raw = env.RWS_CAPTURE_SKIP ?? '';
  if (raw === '') return [];
  const ids = raw.split(',');
  return ids.every((id) => SOURCE_RE.test(id)) && new Set(ids).size === ids.length ? ids : SKIP_MALFORMED;
}

/**
 * The registry without the specs of the skipped sources, groups recomputed. It only removes: no spec, host or
 * secret is added (invariant 1), and an ID that has no spec in the registry is refused rather than ignored,
 * so that a typo cannot leave a source captured that the drill meant to skip.
 */
export function applyCaptureSkip(registry: Registry, skip: readonly string[]): Registry | string {
  if (skip.length === 0) return registry;
  const captured = new Set(registry.specs.map((s) => s.source));
  if (!skip.every((id) => captured.has(id))) return SKIP_UNKNOWN;
  const specs = registry.specs.filter((s) => !skip.includes(s.source));
  const groups = registry.groups.flatMap((g): Group[] => {
    const sources = g.sources.filter((id) => !skip.includes(id));
    const members = specs.filter((s) => s.group === g.slug && s.cadence_s !== null);
    const anchor = members.reduce<LoadedSpec | undefined>(
      (a, b) => (a === undefined || (b.cadence_s as number) < (a.cadence_s as number) ? b : a),
      undefined,
    );
    return anchor === undefined
      ? []
      : [{ slug: g.slug, sources, cadence_s: anchor.cadence_s as number, anchor: anchor.id }];
  });
  return { ...registry, specs, groups };
}
