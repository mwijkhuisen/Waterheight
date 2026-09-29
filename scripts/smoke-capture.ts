// Opt-in fixture recorder (issue #16, P1a constraints). One request per spec
// (its first variant), at most 30 per run, through the real SSRF-guarded
// client with a polite contact User-Agent. It refuses to run under CI.
//
//   node scripts/smoke-capture.ts --contact <e-mail> --info-url <https url> --spec <id> [--spec <id> …]
//   node scripts/smoke-capture.ts --contact … --info-url … --discover <SOURCE-ID> <allowlisted https url>
//
// Every payload goes to the git-ignored .smoke/ first. A public spec's payload
// is also written to apps/server/src/adapters/<id>/fixtures/<spec>.raw (JSON
// and CSV over 1 MB trimmed, keeping their structure) with a .meta.json. An
// owner-audience payload never leaves .smoke/: only a synthetic copy is
// committed (invariant 11). --discover writes to .smoke/ only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactUrl } from '../apps/server/src/archive/manifest.ts';
import { validate } from '../apps/server/src/archive/validity.ts';
import { ADAPTERS } from '../apps/server/src/capture/adapters.ts';
import { userAgent } from '../apps/server/src/capture/env.ts';
import { baseRequest, loadRegistry, windowFor } from '../apps/server/src/capture/specs.ts';
import { Client, METADATA_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from '../apps/server/src/http/client.ts';
import type { Req } from '../apps/server/src/http/types.ts';

const MAX_REQUESTS = 30;
const TRIM_BYTES = 1024 * 1024;
const root = join(import.meta.dirname, '..');

function args(argv: string[]) {
  const specs: string[] = [];
  let contact = '';
  let infoUrl = '';
  let discover: [string, string] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--spec') specs.push(argv[++i] ?? '');
    else if (a === '--contact') contact = argv[++i] ?? '';
    else if (a === '--info-url') infoUrl = argv[++i] ?? '';
    else if (a === '--discover') discover = [argv[++i] ?? '', argv[++i] ?? ''];
    else throw new Error(`unknown argument ${a}`);
  }
  return { specs, contact, infoUrl, discover };
}

/** Halves the longest array until the JSON fits in 1 MB; the structure stays. */
export function trimJson(text: string): string {
  const doc = JSON.parse(text) as unknown;
  const longest = (v: unknown, best: unknown[] | null): unknown[] | null => {
    if (Array.isArray(v)) {
      let b = best === null || v.length > best.length ? v : best;
      for (const x of v.slice(0, 50)) b = longest(x, b) ?? b;
      return b;
    }
    if (v !== null && typeof v === 'object') {
      let b = best;
      for (const x of Object.values(v)) b = longest(x, b) ?? b;
      return b;
    }
    return best;
  };
  let out = JSON.stringify(doc);
  while (Buffer.byteLength(out) > TRIM_BYTES) {
    const arr = longest(doc, null);
    if (arr === null || arr.length <= 1) break;
    arr.length = Math.ceil(arr.length / 2);
    out = JSON.stringify(doc);
  }
  return out;
}

function trimCsv(text: string): string {
  const lines = text.split('\n');
  let keep = lines.length;
  while (keep > 2 && Buffer.byteLength(lines.slice(0, keep).join('\n')) > TRIM_BYTES) keep = Math.ceil(keep / 2);
  return `${lines.slice(0, keep).join('\n')}\n`;
}

async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('smoke-capture: refuses to run under CI (live requests are opt-in and manual)');
    return 2;
  }
  const { specs, contact, infoUrl, discover } = args(process.argv.slice(2));
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(contact) || !infoUrl.startsWith('https://')) {
    console.error('smoke-capture: --contact <e-mail> and --info-url <https url> are required');
    return 64;
  }
  const registry = loadRegistry();
  const client = new Client({ hosts: registry.hosts, userAgent: userAgent(infoUrl, contact) });
  mkdirSync(join(root, '.smoke'), { recursive: true });
  const now = new Date();

  if (discover !== undefined) {
    const [source, url] = discover;
    const r = await client.fetch(source, { url, method: 'GET', variant: 'discover' });
    if (!r.ok) {
      console.error(`discover ${source}: ${r.error}`);
      return 1;
    }
    const name = `discover-${source}-${Date.now()}.raw`;
    writeFileSync(join(root, '.smoke', name), r.res.body);
    console.log(`discover ${source}: ${r.res.status} ${r.res.body.length} bytes → .smoke/${name}`);
    return 0;
  }

  if (specs.length === 0 || specs.length > MAX_REQUESTS) {
    console.error(`smoke-capture: give 1 to ${MAX_REQUESTS} --spec ids (one request each)`);
    return 64;
  }
  let failed = 0;
  for (const id of specs) {
    const spec = registry.specs.find((s) => s.id === id);
    if (spec === undefined) {
      console.error(`${id}: no such spec`);
      failed += 1;
      continue;
    }
    const row = spec.rows[0] ?? {};
    let req: Req = baseRequest(spec, row);
    const adapter = ADAPTERS[spec.source];
    if (spec.request.build && adapter?.build) {
      req = adapter.build({ req, row, now, window: windowFor(spec, now, undefined), params: spec.params });
    }
    const r = await client.fetch(spec.source, req, {
      maxBytes: spec.max_bytes,
      timeoutMs: spec.timeout === 'metadata' ? METADATA_TIMEOUT_MS : TOTAL_TIMEOUT_MS,
    });
    if (!r.ok) {
      console.log(`${id}: FAILED ${r.error}`);
      failed += 1;
      continue;
    }
    const { res } = r;
    const v = await validate(spec.validity, res.status, res.body);
    writeFileSync(join(root, '.smoke', `${id}.raw`), res.body);
    const meta = {
      spec: id,
      source: spec.source,
      synthetic: false,
      recorded_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      status: res.status,
      content_type: res.headers['content-type'] ?? null,
      url: redactUrl(res.url),
      bytes: res.body.length,
      trimmed: false,
    };
    let where = '.smoke/ only (owner audience)';
    if (spec.audience === 'public') {
      const dir = join(root, 'apps/server/src/adapters', spec.source.toLowerCase(), 'fixtures');
      mkdirSync(dir, { recursive: true });
      let body: Buffer = res.body;
      if (body.length > TRIM_BYTES && (spec.validity.format === 'json' || spec.validity.format === 'csv')) {
        const text = body.toString('utf8');
        body = Buffer.from(spec.validity.format === 'json' ? trimJson(text) : trimCsv(text));
        meta.trimmed = true;
      }
      writeFileSync(join(dir, `${id}.raw`), body);
      writeFileSync(join(dir, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
      where = `apps/server/src/adapters/${spec.source.toLowerCase()}/fixtures/${id}.raw${meta.trimmed ? ' (trimmed)' : ''}`;
    }
    console.log(
      `${id}: ${res.status} ${res.body.length} B ${res.headers['content-type'] ?? '-'} valid=${v.ok}${v.reason ? `(${v.reason})` : ''} count=${v.count} → ${where}`,
    );
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
