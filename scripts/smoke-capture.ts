// Opt-in fixture recorder (issue #16, P1a constraints). One request per spec
// (its first variant, or the registry row that `--row <variant>` names), at
// most 30 per run, through the real SSRF-guarded client with a polite contact
// User-Agent. It refuses to run under CI.
//
//   node scripts/smoke-capture.ts --contact <e-mail> --info-url <https url> --spec <id> [--row <variant> | --keep-as <name>] [--from <D> --to <D>] [--method other:F###] [--spec <id> …]
//   node scripts/smoke-capture.ts --contact … --info-url … --discover <SOURCE-ID> <allowlisted https url>
//   RWS_LIVE=1 node scripts/smoke-capture.ts --contact … --info-url … \
//     --backfill <backfill spec> --series <provider_key> --from YYYY-MM-DD --to YYYY-MM-DD [--no-hoedanigheid]
//     --check <backfill spec> --series <provider_key> --year YYYY      (items repeat; each takes the flags after it)
//
// The backfill mode (P14a) builds its requests with the runner's own builders from registry/backfill.yaml, sends
// no X-API-KEY, needs RWS_LIVE=1 (never under CI), sends at most 5 requests per process (the owner's budget for
// the whole PR) and starts them at least 1 s apart. Its payloads are written whole (never trimmed): choose short
// windows. --no-hoedanigheid leaves the Hoedanigheid out of the body (the NVT test for Q).
//
// Every payload goes to the git-ignored .smoke/ first. A public spec's payload
// is also written to apps/server/src/adapters/<id>/fixtures/<spec>.raw (with
// --row: <spec>-<variant as a slug>.raw, so it never replaces the spec's own; JSON
// and CSV over 1 MB trimmed, keeping their structure) with a .meta.json. An
// owner-audience payload never leaves .smoke/: only a synthetic copy is
// committed (invariant 11). --discover writes to .smoke/ only.
//
// --from/--to after a --spec (P16b; NL-1 specs whose adapter builds the body, not ahead or verwachting) ask
// that window instead of the spec's own: from < to, at most 31 days, to at most now + 1 day. --method
// other:F### replaces the chosen row's method for that request only (NL-1 H rows; the registry is untouched).
// Either one appends -<from>-<to> (YYYYMMDD) and/or -<method slug> to the file name and adds window/method
// to the meta.
//
// --keep-as <name> (P15; after its --spec, never with --row, public specs only) writes the whole body,
// never trimmed, to fixtures/<spec>-<name>.raw, and only when the status is 200 and the spec's validity
// check passed. It never touches <spec>.raw, and it refuses (exit 1, before any request) when
// fixtures/<spec>-<name>.raw already exists.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactUrl } from '../apps/server/src/archive/manifest.ts';
import { validate } from '../apps/server/src/archive/validity.ts';
import { PROVIDERS } from '../apps/server/src/backfill/provider.ts';
import { loadBackfill } from '../apps/server/src/backfill/spec.ts';
import { requestFor } from '../apps/server/src/capture/adapters.ts';
import { userAgent } from '../apps/server/src/capture/env.ts';
import { loadRegistry, variantKey } from '../apps/server/src/capture/specs.ts';
import { Client, METADATA_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from '../apps/server/src/http/client.ts';

const MAX_REQUESTS = 30;
const BACKFILL_MAX_REQUESTS = 5;
const BACKFILL_GAP_MS = 1100;
const TRIM_BYTES = 1024 * 1024;
const KEEP_AS = /^[a-z0-9][a-z0-9-]{0,39}$/;
const root = join(import.meta.dirname, '..');

type Item = {
  kind: 'backfill' | 'check';
  spec: string;
  series: string;
  from?: string;
  to?: string;
  year?: string;
  noHoedanigheid?: boolean;
};

export function args(argv: string[]) {
  const specs: { id: string; row?: string; keepAs?: string; from?: string; to?: string; method?: string }[] = [];
  let contact = '';
  let infoUrl = '';
  let discover: [string, string] | undefined;
  const items: Item[] = [];
  // --from/--to belong to whichever of --spec or --backfill/--check came last.
  let lastIsSpec = false;
  const lastItem = () => {
    const last = items.at(-1);
    if (last === undefined)
      throw new Error('--series, --from, --to, --year and --no-hoedanigheid follow a --backfill or --check');
    return last;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--spec') {
      specs.push({ id: argv[++i] ?? '' });
      lastIsSpec = true;
    } else if (a === '--method') {
      const last = specs.at(-1);
      if (last === undefined) throw new Error('--method follows the --spec it belongs to');
      last.method = argv[++i] ?? '';
    } else if ((a === '--from' || a === '--to') && lastIsSpec) {
      const last = specs.at(-1);
      if (last === undefined) throw new Error(`${a} follows the --spec it belongs to`);
      last[a === '--from' ? 'from' : 'to'] = argv[++i] ?? '';
    } else if (a === '--row') {
      const last = specs.at(-1);
      if (last === undefined) throw new Error('--row follows the --spec it belongs to');
      last.row = argv[++i] ?? '';
    } else if (a === '--keep-as') {
      const last = specs.at(-1);
      if (last === undefined) throw new Error('--keep-as follows the --spec it belongs to');
      last.keepAs = argv[++i] ?? '';
    } else if (a === '--contact') contact = argv[++i] ?? '';
    else if (a === '--info-url') infoUrl = argv[++i] ?? '';
    else if (a === '--backfill' || a === '--check') {
      items.push({ kind: a === '--check' ? 'check' : 'backfill', spec: argv[++i] ?? '', series: '' });
      lastIsSpec = false;
    } else if (a === '--series') lastItem().series = argv[++i] ?? '';
    else if (a === '--from') lastItem().from = argv[++i] ?? '';
    else if (a === '--to') lastItem().to = argv[++i] ?? '';
    else if (a === '--year') lastItem().year = argv[++i] ?? '';
    else if (a === '--no-hoedanigheid') lastItem().noHoedanigheid = true;
    else if (a === '--discover') discover = [argv[++i] ?? '', argv[++i] ?? ''];
    else throw new Error(`unknown argument ${a}`);
  }
  return { specs, contact, infoUrl, discover, items };
}

/**
 * The --keep-as pre-check, pure: a repeated (spec, name) pair is exit 64, an existing `<spec>-<name>.raw` or
 * `.meta.json` in the target's directory is exit 1 (a stray meta counts: the write of the second file would fail).
 */
export function keepAsProblem(
  targets: { spec: string; name: string; dir: string }[],
  exists: (path: string) => boolean,
): { code: 1 | 64; message: string } | null {
  const seen = new Set<string>();
  for (const { spec, name, dir } of targets) {
    if (seen.has(`${spec}-${name}`)) return { code: 64, message: `${spec}: --keep-as ${name} is given twice` };
    seen.add(`${spec}-${name}`);
    for (const ext of ['raw', 'meta.json']) {
      if (exists(join(dir, `${spec}-${name}.${ext}`))) {
        return { code: 1, message: `${spec}: fixtures/${spec}-${name}.${ext} exists; --keep-as never replaces a file` };
      }
    }
  }
  return null;
}

const METHOD = /^other:F\d{3}$/;
const DAY_MS = 86_400_000;

/**
 * The --from/--to/--method pre-check, pure: a fixed message (exit 64) or the parsed window. `spec` is the
 * loaded spec's source, build flag and params; `row` the chosen registry row.
 */
export function windowProblem(
  spec: { source: string; request: { build?: boolean }; params?: Record<string, string> },
  row: Readonly<Record<string, string>>,
  want: { from?: string; to?: string; method?: string },
  now: Date,
): { message: string } | { window?: { from: Date; to: Date } } {
  const { from, to, method } = want;
  if (from === undefined && to === undefined && method === undefined) return {};
  if (spec.source !== 'NL-1' || !spec.request.build)
    return { message: '--from, --to and --method are for an NL-1 spec that builds its body' };
  if (method !== undefined) {
    if (!METHOD.test(method)) return { message: `--method takes ${METHOD.source}` };
    if (row.quantity === 'Q') return { message: '--method is refused on a Q row' };
  }
  if (from === undefined && to === undefined) return {};
  if (from === undefined || to === undefined) return { message: '--from and --to are given together' };
  if (spec.params?.ahead !== undefined || spec.params?.proces === 'verwachting')
    return { message: '--from and --to are ignored by an ahead or verwachting spec' };
  const at = (v: string) =>
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z)?$/.test(v) ? new Date(v) : new Date(Number.NaN);
  const w = { from: at(from), to: at(to) };
  if (Number.isNaN(w.from.getTime()) || Number.isNaN(w.to.getTime()))
    return { message: '--from and --to take YYYY-MM-DD or a UTC instant ending in Z' };
  if (w.from >= w.to) return { message: '--from must be before --to' };
  if (w.to.getTime() - w.from.getTime() > 31 * DAY_MS) return { message: 'the window is at most 31 days' };
  if (w.to.getTime() > now.getTime() + DAY_MS) return { message: '--to is at most one day after now' };
  return { window: w };
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

/** The P14a backfill and check requests: at most 5, 1 s apart, built from registry/backfill.yaml, no secret header. */
async function backfill(client: Client, items: Item[], now: Date): Promise<number> {
  if (process.env.RWS_LIVE !== '1') {
    console.error('smoke-capture: the backfill mode needs RWS_LIVE=1');
    return 2;
  }
  if (items.length > BACKFILL_MAX_REQUESTS) {
    console.error(`smoke-capture: at most ${BACKFILL_MAX_REQUESTS} backfill/check requests per process`);
    return 64;
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const loaded = loadBackfill(loadRegistry().hosts);
  // Resolve and build everything before the first request, so a mistake costs nothing.
  const plan = items.map((it) => {
    const spec = loaded.specs.find((s) => s.id === it.spec);
    const base = spec?.series.find((s) => s.series_key === it.series);
    if (spec === undefined || base === undefined)
      throw new Error(`${it.spec} / ${it.series}: not in registry/backfill.yaml`);
    const provider = PROVIDERS[spec.source];
    if (provider === undefined) throw new Error(`${spec.source}: no backfill provider`);
    const series = it.noHoedanigheid ? { ...base, hoedanigheid: undefined as unknown as string } : base;
    const slug = `${base.code.split('.')[0]}-${base.quantity.toLowerCase()}${it.noHoedanigheid ? '-nohoed' : ''}`;
    if (it.kind === 'check') {
      if (!/^\d{4}$/.test(it.year ?? '')) throw new Error('--check needs --year YYYY');
      const y = Number(it.year);
      const req = provider.checkRequest(spec, series, new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1)));
      return { it, spec, req, id: `${spec.source.toLowerCase()}-check-${slug}-${y}` };
    }
    if (!day.test(it.from ?? '') || !day.test(it.to ?? ''))
      throw new Error('--backfill needs --from and --to as YYYY-MM-DD');
    const chunk = { from: new Date(`${it.from}T00:00:00Z`), to: new Date(`${it.to}T00:00:00Z`) };
    const req = provider.chunkRequest(spec, series, chunk, now);
    return {
      it,
      spec,
      req,
      id: `${spec.source.toLowerCase()}-backfill-${slug}-${(it.from ?? '').replaceAll('-', '')}`,
    };
  });
  let failed = 0;
  let sent = 0;
  for (const { it, spec, req, id } of plan) {
    if (sent >= BACKFILL_MAX_REQUESTS) break;
    if (sent > 0) await new Promise((r) => setTimeout(r, BACKFILL_GAP_MS));
    sent += 1;
    const r = await client.fetch(spec.source, req, { maxBytes: spec.max_bytes, timeoutMs: TOTAL_TIMEOUT_MS });
    if (!r.ok) {
      console.log(`${id}: FAILED ${r.error}`);
      failed += 1;
      continue;
    }
    const { res } = r;
    writeFileSync(join(root, '.smoke', `${id}.raw`), res.body);
    const meta = {
      spec: spec.id,
      source: spec.source,
      synthetic: false,
      recorded_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      status: res.status,
      content_type: res.headers['content-type'] ?? null,
      url: redactUrl(res.url),
      bytes: res.body.length,
      trimmed: false,
      request: it.kind === 'check' ? { check: it.year } : { from: it.from, to: it.to },
    };
    const dir = join(root, 'apps/server/src/adapters', spec.source.toLowerCase(), 'fixtures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.raw`), res.body);
    writeFileSync(join(dir, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${id}: ${res.status} ${res.body.length} B ${res.headers['content-type'] ?? '-'} → fixtures/${id}.raw`);
  }
  return failed === 0 ? 0 : 1;
}

const fixturesDir = (source: string) => join(root, 'apps/server/src/adapters', source.toLowerCase(), 'fixtures');

async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('smoke-capture: refuses to run under CI (live requests are opt-in and manual)');
    return 2;
  }
  const { specs, contact, infoUrl, discover, items } = args(process.argv.slice(2));
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(contact) || !infoUrl.startsWith('https://')) {
    console.error('smoke-capture: --contact <e-mail> and --info-url <https url> are required');
    return 64;
  }
  const registry = loadRegistry();
  const client = new Client({ hosts: registry.hosts, userAgent: userAgent(infoUrl, contact) });
  mkdirSync(join(root, '.smoke'), { recursive: true });
  const now = new Date();

  if (items.length > 0) return backfill(client, items, now);

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
  // --keep-as is checked for every spec before the first request, so a refusal costs nothing.
  const keepTargets: { spec: string; name: string; dir: string }[] = [];
  for (const { id: specId, row, keepAs } of specs) {
    if (keepAs === undefined) continue;
    if (!KEEP_AS.test(keepAs) || row !== undefined) {
      console.error(`${specId}: --keep-as takes a name ${KEEP_AS.source} and is not combined with --row`);
      return 64;
    }
    const spec = registry.specs.find((s) => s.id === specId);
    if (spec?.audience !== 'public') {
      console.error(`${specId}: --keep-as is for a public spec only`);
      return 1;
    }
    keepTargets.push({ spec: specId, name: keepAs, dir: fixturesDir(spec.source) });
  }
  const problem = keepAsProblem(keepTargets, existsSync);
  if (problem !== null) {
    console.error(problem.message);
    return problem.code;
  }
  // Window and method are checked for every spec before the first request too.
  const asked = new Map<string, { from: Date; to: Date } | undefined>();
  for (const [n, s] of specs.entries()) {
    const spec = registry.specs.find((x) => x.id === s.id);
    if (spec === undefined) continue;
    const row =
      s.row === undefined ? (spec.rows[0] ?? {}) : spec.rows.find((r) => variantKey(r, spec.variants?.key) === s.row);
    if (row === undefined) continue;
    const p = windowProblem(spec, row, s, now);
    if ('message' in p) {
      console.error(`${s.id}: ${p.message}`);
      return 64;
    }
    asked.set(String(n), p.window);
  }
  let failed = 0;
  for (const [n, { id: specId, row: want, keepAs, method }] of specs.entries()) {
    const spec = registry.specs.find((s) => s.id === specId);
    if (spec === undefined) {
      console.error(`${specId}: no such spec`);
      failed += 1;
      continue;
    }
    // Only ever one of the registry's own rows (invariant 1): --row picks it by its variant key.
    const found =
      want === undefined ? (spec.rows[0] ?? {}) : spec.rows.find((r) => variantKey(r, spec.variants?.key) === want);
    const row = found === undefined || method === undefined ? found : { ...found, method };
    const window = asked.get(String(n));
    if (row === undefined) {
      console.error(`${specId}: no registry row ${want}`);
      failed += 1;
      continue;
    }
    const slugOf = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
    const extra =
      (window === undefined ? '' : `-${ymd(window.from)}-${ymd(window.to)}`) +
      (method === undefined ? '' : `-${slugOf(method)}`);
    const id =
      keepAs !== undefined ? `${specId}-${keepAs}` : `${specId}${want === undefined ? '' : `-${slugOf(want)}`}${extra}`;
    const r = await client.fetch(spec.source, requestFor(spec, row, now, window), {
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
      spec: specId,
      ...(want === undefined ? {} : { variant: want }),
      source: spec.source,
      synthetic: false,
      recorded_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      status: res.status,
      content_type: res.headers['content-type'] ?? null,
      url: redactUrl(res.url),
      bytes: res.body.length,
      trimmed: false,
      ...(window === undefined ? {} : { window: { from: window.from.toISOString(), to: window.to.toISOString() } }),
      ...(method === undefined ? {} : { method }),
    };
    let where = '.smoke/ only (owner audience)';
    if (keepAs !== undefined && (res.status !== 200 || !v.ok)) {
      where = '.smoke/ only (--keep-as needs a 200 that passes the validity check)';
      failed += 1;
    } else if (spec.audience === 'public') {
      const dir = fixturesDir(spec.source);
      mkdirSync(dir, { recursive: true });
      let body: Buffer = res.body;
      if (
        keepAs === undefined &&
        body.length > TRIM_BYTES &&
        (spec.validity.format === 'json' || spec.validity.format === 'csv')
      ) {
        const text = body.toString('utf8');
        body = Buffer.from(spec.validity.format === 'json' ? trimJson(text) : trimCsv(text));
        meta.trimmed = true;
      }
      // 'wx': a --keep-as file that appeared since the check above is still never replaced.
      const flag = keepAs === undefined ? 'w' : 'wx';
      writeFileSync(join(dir, `${id}.raw`), body, { flag });
      writeFileSync(join(dir, `${id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, { flag });
      where = `apps/server/src/adapters/${spec.source.toLowerCase()}/fixtures/${id}.raw${meta.trimmed ? ' (trimmed)' : ''}`;
    }
    console.log(
      `${id}: ${res.status} ${res.body.length} B ${res.headers['content-type'] ?? '-'} valid=${v.ok}${v.reason ? `(${v.reason})` : ''} count=${v.count} → ${where}`,
    );
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
