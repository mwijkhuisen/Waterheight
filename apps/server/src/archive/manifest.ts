import { z } from 'zod';

// One line of raw/_manifest/{yyyy-mm-dd}.jsonl (A§7.1). No secret, no provider
// error text and no header outside the allowlist ever reaches it (invariant 6).

export const SOURCE_RE = /^(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?$/;
export const SPEC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'content-encoding',
  'etag',
  'last-modified',
  'date',
  'cache-control',
  'expires',
  'age',
  'retry-after',
  'location',
] as const;

export const ERROR_CODES = [
  'bad_url',
  'not_allowlisted',
  'private_address',
  'dns',
  'redirect_cross_host',
  'redirect_insecure',
  'redirect_limit',
  'too_large',
  'too_large_decoded',
  'bad_encoding',
  'timeout',
  'network',
  'backoff',
  'breaker_open',
] as const;

const iso = z.iso.datetime();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();

export const ManifestLine = z.strictObject({
  v: z.literal(1),
  source: z.string().regex(SOURCE_RE),
  spec: z.string().regex(SPEC_RE),
  spec_version: z.number().int().positive(),
  variant: z.string().max(200),
  seed: z.literal(true).optional(),
  recovered: z.literal(true).optional(),
  /** Null only on a recovered line. The URL has secret-looking query values redacted. */
  request: z
    .strictObject({
      method: z.enum(['GET', 'POST']),
      url: z.string().max(2048),
      body: z.string().max(8192).optional(),
    })
    .nullable(),
  fetched_at: z.strictObject({ start: iso, end: iso.nullable() }),
  status: z.number().int().min(100).max(599).nullable(),
  headers: z.partialRecord(z.enum(HEADER_ALLOWLIST), z.string().max(256)),
  /** sha256 and bytes of the decoded body; stored_bytes of the zstd object. */
  sha256: hex64.nullable(),
  bytes: count.nullable(),
  stored_bytes: count.nullable(),
  key: z.string().max(300).nullable(),
  dup_of: z.string().max(300).nullable(),
  gate: z
    .strictObject({
      kind: z.enum(['hash', 'field', 'new-resource', 'lastmod-runstart']),
      key: z.string().max(200).nullable(),
      open: z.boolean(),
    })
    .nullable(),
  shape: z.string().max(64).nullable(),
  shape_changed: z.boolean(),
  validity: z
    .strictObject({ ok: z.boolean(), reason: z.string().max(40).nullable(), count: count.nullable() })
    .nullable(),
  retention: z.enum(['obs', 'forever']),
  error: z.enum(ERROR_CODES).nullable(),
});
export type ManifestLine = z.infer<typeof ManifestLine>;

const SECRET_PARAM =
  /^(?:key|apikey|api[-_]?key|token|access[-_]?token|secret|password|passwd|sig|signature|subscription[-_]key)$/i;

/** The URL as recorded: values of secret-looking query parameters are replaced. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[invalid url]';
  }
  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) url.searchParams.set(name, 'REDACTED');
  }
  return url.href.slice(0, 2048);
}

/** Only allowlisted response headers, length-capped; Set-Cookie and everything else are dropped. */
export function keptHeaders(headers: Record<string, string>): ManifestLine['headers'] {
  const out: ManifestLine['headers'] = {};
  for (const name of HEADER_ALLOWLIST) {
    const v = headers[name];
    if (v !== undefined) out[name] = v.replace(/[\r\n\0]/g, ' ').slice(0, 256);
  }
  return out;
}
