import { readFileSync } from 'node:fs';

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
