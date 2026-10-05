import type { Context, Hono } from 'hono';
import type { Logger } from 'pino';
import { z } from 'zod';
import { noQuery, Refused } from './params.ts';
import { failure, refuse } from './routes.ts';

// POST /api/v1/beacon (P9b, A§9.2, plan 4.8): CSP and Reporting API reports and our own client errors, logged and
// dropped. No database, no CORS, nothing reflected: the answer is a 204 with no body. Every string that reaches the
// log is provider-style untrusted text: control, format and line-separator characters are removed and it is cut at
// 200 characters; the client address and every header stay out of the line. Caddy answers 413 first in production
// (request_body 8 KiB); this is the same cap for a direct caller.

export type BeaconDeps = { log: Pick<Logger, 'info'> | undefined };

export const BEACON_MAX_BYTES = 8192;
const FIELD_MAX = 200;
const TYPES = new Set(['application/reports+json', 'application/csp-report', 'application/json']);

/** Control (Cc), format (Cf: bidi controls, zero-width) and the line and paragraph separators (Zl, Zp), then 200 chars. */
const clean = (s: string): string => s.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, FIELD_MAX);

const text = z.string().max(2000);
const count = z.number().int().min(0).max(1_000_000_000);

const Csp = z.strictObject({
  'csp-report': z.strictObject({
    'document-uri': text.optional(),
    referrer: text.optional(),
    'violated-directive': text.optional(),
    'effective-directive': text.optional(),
    'original-policy': text.optional(),
    disposition: text.optional(),
    'blocked-uri': text.optional(),
    'line-number': count.optional(),
    'column-number': count.optional(),
    'source-file': text.optional(),
    'status-code': count.optional(),
    'script-sample': text.optional(),
  }),
});

const Reports = z
  .array(
    z.strictObject({
      type: z.string().max(64),
      age: z.number().int().min(0),
      url: text,
      user_agent: z.string().max(500),
      body: z
        .record(z.string().max(100), z.union([text, z.number(), z.null()]))
        .refine((b) => Object.keys(b).length <= 30),
    }),
  )
  .min(1)
  .max(20);

const ClientError = z.strictObject({ kind: z.literal('client_error'), message: text, url: text });

type Fields = Record<string, string | number>;
const fieldsOf = (o: Record<string, unknown>): Fields =>
  Object.fromEntries(
    Object.entries(o).flatMap(([k, v]): [string, string | number][] =>
      typeof v === 'string' ? [[clean(k), clean(v)]] : typeof v === 'number' ? [[clean(k), v]] : [],
    ),
  );

/** The report lines of one validated body: [kind, fields]. */
function reports(type: string, json: unknown): [string, Fields][] {
  if (type === 'application/csp-report') return [['csp', fieldsOf(Csp.parse(json)['csp-report'])]];
  if (type === 'application/reports+json')
    return Reports.parse(json).map((r) => [
      `report:${clean(r.type)}`,
      fieldsOf({ ...r.body, url: r.url, user_agent: r.user_agent, age: r.age }),
    ]);
  const e = ClientError.parse(json);
  return [['client_error', fieldsOf({ message: e.message, url: e.url })]];
}

/** The body as text, never holding more than the cap (+ one byte): null when it is longer. */
async function readCapped(req: Request): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > BEACON_MAX_BYTES) return null;
  const reader = req.body?.getReader();
  if (reader === undefined) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BEACON_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function handle(c: Context, deps: BeaconDeps) {
  try {
    noQuery(c.req.url);
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!TYPES.has(type)) return refuse(c, 415, 'unsupported_type');
    const raw = await readCapped(c.req.raw);
    if (raw === null) return refuse(c, 413, 'too_large');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Refused('bad_parameter');
    }
    let lines: [string, Fields][];
    try {
      lines = reports(type, json);
    } catch (err) {
      if (!(err instanceof z.ZodError)) throw err;
      throw new Refused(err.issues.some((i) => i.code === 'unrecognized_keys') ? 'unknown_parameter' : 'bad_parameter');
    }
    // One line per request, whatever the number of reports in it (review SEC-3): the global beacon bucket then bounds
    // the log lines a second, not a twentieth of them.
    deps.log?.info({ beacon: lines.map(([kind, fields]) => ({ kind, fields })) }, 'beacon');
    return c.body(null, 204, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return failure(c, err);
  }
}

export function registerBeacon(app: Hono, deps: BeaconDeps): void {
  app.post('/api/v1/beacon', (c) => handle(c, deps));
}
