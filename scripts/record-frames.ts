// Opt-in, run by hand by the lead (P11b, D-3): records the public hourly-frames files of the live site as fixtures
// for the low-water visual scene. It never runs under CI (exit 2) and talks to ONE host, the constant HOST below
// (not configurable). At most MAX_REQUESTS requests per run, redirects and the preflight included, counted and
// printed: meta.json first, then stations.json, then frames/<day>/v<n>.json per given day (v from that meta: absent
// is 1, 0 has no static file and is skipped, an unsettled day has none either). Every body is validated with the
// public contracts before it is written, verbatim, to <out>/<name>; <name minus .json>.meta.json beside it says where
// it came from. Public files only: the owner host and its data are never involved (invariant 11).
//   node scripts/record-frames.ts --out <dir> --days <YYYY-MM-DD,...> [--report <seriesId>]
// `--report` prints, per day, the daily mean of that series (to pick the lowest Lobith day).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DAY_RE,
  FramesFile,
  framesPath,
  isSettled,
  StaticMeta,
  StaticStations,
} from '../packages/contracts/src/static.ts';

export const HOST = 'https://rk.wijkhuisen.info';
export const USER_AGENT = 'Waterheight-fixture-recorder/1 (+https://github.com/mwijkhuisen/Waterheight)';
export const MAX_REQUESTS = 20;
export const MAX_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type Args = { out: string | undefined; days: string[]; report: number | undefined; ok: boolean };

export function args(argv: string[]): Args {
  const out: Args = { out: undefined, days: [], report: undefined, ok: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--out' && v !== undefined) out.out = argv[++i];
    else if (a === '--days' && v !== undefined) out.days = argv[++i]?.split(',') ?? [];
    else if (a === '--report' && v !== undefined) out.report = Number(argv[++i]);
    else out.ok = false;
  }
  if (out.days.some((d) => !DAY_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) out.ok = false;
  if (out.report !== undefined && !Number.isInteger(out.report)) out.ok = false;
  out.days = [...new Set(out.days)].sort();
  return out;
}

/** What `run` writes to; the tests collect it. */
export type Log = (line: string) => void;

export async function run(argv: string[], env: NodeJS.ProcessEnv, log: Log = console.log): Promise<number> {
  if (env.CI !== undefined) {
    log('refused under CI: this script makes live requests');
    return 2;
  }
  const a = args(argv);
  if (!a.ok || a.out === undefined || a.days.length === 0 || 2 + a.days.length > MAX_REQUESTS) {
    log(
      `usage: node scripts/record-frames.ts --out <dir> --days <YYYY-MM-DD,...> [--report <seriesId>] (at most ${MAX_REQUESTS - 2} days)`,
    );
    return 64;
  }
  const out = resolve(a.out);
  mkdirSync(out, { recursive: true });
  let requests = 0;

  /** GET one path of HOST; a redirect only to the same https host. Every hop counts against the cap. */
  async function get(path: string): Promise<{ url: string; status: number; body: Buffer }> {
    let url = new URL(path, HOST).href;
    for (let hop = 0; ; hop += 1) {
      if (requests >= MAX_REQUESTS) throw new Error('request_cap');
      requests += 1;
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.body?.cancel().catch(() => {});
        const next = new URL(res.headers.get('location') ?? '', url);
        if (hop >= MAX_REDIRECTS) throw new Error('too_many_redirects');
        if (next.origin !== HOST) throw new Error('redirect_off_host');
        url = next.href;
        continue;
      }
      const chunks: Buffer[] = [];
      let n = 0;
      const reader = res.body?.getReader();
      for (let r = await reader?.read(); reader && r && !r.done; r = await reader.read()) {
        n += r.value.byteLength;
        if (n > MAX_BYTES) {
          reader.cancel().catch(() => {});
          throw new Error('too_big');
        }
        chunks.push(Buffer.from(r.value));
      }
      return { url, status: res.status, body: Buffer.concat(chunks) };
    }
  }

  /** Validate with the public contract, then write the body verbatim and its provenance. */
  function keep(name: string, url: string, body: Buffer, parse: (data: unknown) => unknown): void {
    parse(JSON.parse(body.toString('utf8')));
    writeFileSync(join(out, name), body);
    const meta = {
      from: 'recording',
      url,
      sha256: createHash('sha256').update(body).digest('hex'),
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    writeFileSync(join(out, `${name.replace(/\.json$/, '')}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    log(`${name}: ${body.length} B`);
  }

  try {
    const metaRes = await get('/data/v1/meta.json');
    if (metaRes.status !== 200) throw new Error(`meta_status_${metaRes.status}`);
    const meta = StaticMeta.parse(JSON.parse(metaRes.body.toString('utf8')));
    keep('meta.json', metaRes.url, metaRes.body, (d) => StaticMeta.parse(d));
    const stRes = await get('/data/v1/stations.json');
    if (stRes.status !== 200) throw new Error(`stations_status_${stRes.status}`);
    keep('stations.json', stRes.url, stRes.body, (d) => StaticStations.parse(d));

    const now = Date.parse(meta.now);
    for (const day of a.days) {
      const v = Object.hasOwn(meta.dayVersions, day) ? (meta.dayVersions[day] as number) : 1;
      if (!isSettled(day, now)) {
        log(`${day}: skipped, not settled (no static file)`);
        continue;
      }
      if (v === 0) {
        log(`${day}: skipped, version 0 (the API serves it)`);
        continue;
      }
      const res = await get(`/data/v1/${framesPath(day, v)}`);
      if (res.status !== 200) {
        log(`${day}: skipped, status ${res.status}`);
        continue;
      }
      let file: FramesFile | undefined;
      keep(`frames-${day}-v${v}.json`, res.url, res.body, (d) => {
        file = FramesFile.parse(d);
      });
      if (a.report !== undefined && file !== undefined) {
        const row = file.vlast[file.series.indexOf(a.report)];
        const vals = (row ?? []).filter((x): x is number => x !== null);
        log(
          vals.length === 0
            ? `${day}: series ${a.report} has no values`
            : `${day}: series ${a.report} mean ${(vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(3)} over ${vals.length} h`,
        );
      }
    }
    return 0;
  } catch (e) {
    // A fixed code only: the message of a thrown error may hold a URL or provider text.
    log(`failed: ${e instanceof Error && /^[a-z_0-9]+$/.test(e.message) ? e.message : 'invalid_or_unreachable'}`);
    return 1;
  } finally {
    log(`requests: ${requests}/${MAX_REQUESTS}`);
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), process.env);
