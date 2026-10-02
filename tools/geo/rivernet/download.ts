// Downloads for the river-network pipeline (P6a): only the URLs of tools/geo/rivernet/sources.yaml (invariant 1).
//
//   node tools/geo/rivernet/download.ts --check-index            # every pinned region is in Geofabrik's index, same path
//   node tools/geo/rivernet/download.ts --region <id> --out <dir> # <dir>/<id>.osm.pbf and <id>.download.json
//
// Needs RWS_DOMAIN and RWS_CONTACT_EMAIL (the User-Agent; exit 78 without). Fail closed: every error is a fixed code
// naming at most our own region id, never provider text. `<id>-latest.osm.pbf` answers 307 to the dated file on the
// same host, so a redirect is followed by hand, at most twice and only to https on the same host; anything else is
// `redirect_refused`. The md5 is read first and compared with the md5 of the streamed bytes; a mismatch (Geofabrik
// rebuilds daily) re-fetches both once.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { captureEnv, captureUserAgent } from '../../../apps/server/src/capture/env.ts';
import { boundedJson, cappedArray } from '../../../packages/core/src/json.ts';
import { ALLOWED_HOSTS, readSources, type SourcesFile } from './sources.ts';

export const MD5_MAX_BYTES = 4096;
export const PBF_TIMEOUT_MS = 45 * 60_000;
const SHORT_TIMEOUT_MS = 60_000;
const MAX_HOPS = 2;

export type DownloadCode =
  | 'http_status'
  | 'too_large'
  | 'bad_md5_file'
  | 'md5_mismatch'
  | 'timeout'
  | 'redirect_refused'
  | 'bad_index'
  | 'region_missing'
  | 'region_changed'
  | 'unknown_region'
  | 'network';

export class DownloadError extends Error {
  readonly code: DownloadCode;
  readonly region: string | null;
  constructor(code: DownloadCode, region: string | null = null) {
    super(region === null ? code : `${code} ${region}`);
    this.name = 'DownloadError';
    this.code = code;
    this.region = region;
  }
}

type Region = SourcesFile['geofabrik']['regions'][number];

/** Discards an unread body without waiting for the stream to close. */
const drop = (res: Response) => void res.body?.cancel().catch(() => undefined);

/** One GET: https on an allowed host, status 200 only, redirects followed by hand (same host, at most twice). */
async function get(url: string, ua: string, signal: AbortSignal): Promise<Response> {
  const host = new URL(url).hostname;
  let target = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetch(target, { redirect: 'manual', signal, headers: { 'user-agent': ua } });
    } catch (err) {
      throw signal.aborted || (err instanceof Error && err.name === 'TimeoutError')
        ? new DownloadError('timeout')
        : new DownloadError('network');
    }
    if (res.status >= 300 && res.status < 400) {
      drop(res);
      let next: URL;
      try {
        next = new URL(res.headers.get('location') ?? '', target);
      } catch {
        throw new DownloadError('redirect_refused');
      }
      if (next.protocol !== 'https:' || next.hostname !== host || !(ALLOWED_HOSTS as readonly string[]).includes(host))
        throw new DownloadError('redirect_refused');
      target = next.href;
      continue;
    }
    if (res.status !== 200 || res.body === null) {
      drop(res);
      throw new DownloadError('http_status');
    }
    return res;
  }
  throw new DownloadError('redirect_refused');
}

/** The body as chunks, never more than `max` bytes. */
async function* capped(res: Response, max: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    drop(res);
    throw new DownloadError('too_large');
  }
  let size = 0;
  // A reader, not `for await`: leaving that loop early awaits the stream's cancel, which can hang on a live socket.
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > max) {
        reader.cancel().catch(() => undefined);
        throw new DownloadError('too_large');
      }
      yield value;
    }
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw signal.aborted ? new DownloadError('timeout') : new DownloadError('network');
  }
}

async function readText(url: string, ua: string, max: number, timeoutMs = SHORT_TIMEOUT_MS): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await get(url, ua, signal);
  const parts: Uint8Array[] = [];
  for await (const c of capped(res, max, signal)) parts.push(c);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw new DownloadError('bad_index');
  }
}

// ---- the index ------------------------------------------------------------------------------------------------

const Feature = z.looseObject({
  properties: z.looseObject({
    id: z.string().max(200),
    urls: z.looseObject({ pbf: z.string().max(500).optional() }).optional(),
  }),
});
const Index = z.looseObject({ features: cappedArray(Feature, 20_000) });
const INDEX_CAPS = { maxNodes: 500_000, maxDepth: 12 };

/** Pure: every region of the registry is in the index text with exactly its `urls.pbf`. Throws DownloadError only. */
export function checkIndexBody(text: string, regions: readonly Pick<Region, 'id' | 'url'>[]): void {
  let index: z.infer<typeof Index>;
  try {
    const r = Index.safeParse(boundedJson(text, INDEX_CAPS));
    if (!r.success) throw new DownloadError('bad_index');
    index = r.data;
  } catch (err) {
    throw err instanceof DownloadError ? err : new DownloadError('bad_index');
  }
  const pbf = new Map<string, string | undefined>();
  for (const f of index.features) pbf.set(f.properties.id, f.properties.urls?.pbf);
  for (const r of regions) {
    if (!pbf.has(r.id)) throw new DownloadError('region_missing', r.id);
    if (pbf.get(r.id) !== r.url) throw new DownloadError('region_changed', r.id);
  }
}

export async function checkIndex(sources: SourcesFile, ua: string): Promise<void> {
  const text = await readText(sources.geofabrik.index_url, ua, sources.geofabrik.index_max_bytes);
  checkIndexBody(text, sources.geofabrik.regions);
}

// ---- md5 and the PBF ------------------------------------------------------------------------------------------

/** `<32 hex>  <filename>` (md5sum format, one line). */
export function parseMd5(text: string, filename: string): string {
  const m = /^([0-9a-f]{32}) {2}(.+?)\n?$/.exec(text);
  if (m === null || m[2] !== filename) throw new DownloadError('bad_md5_file');
  return m[1] as string;
}

export interface DownloadRecord {
  bytes: number;
  id: string;
  md5: string;
  sha256: string;
  url: string;
}

async function attempt(
  region: Region,
  part: string,
  ua: string,
  timeoutMs: number,
): Promise<{ expected: string; md5: string; sha256: string; bytes: number }> {
  const filename = region.url.slice(region.url.lastIndexOf('/') + 1);
  const expected = parseMd5(await readText(`${region.url}.md5`, ua, MD5_MAX_BYTES), filename);
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await get(region.url, ua, signal);
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let bytes = 0;
  const fh = await open(part, 'w');
  try {
    for await (const chunk of capped(res, region.max_bytes, signal)) {
      md5.update(chunk);
      sha256.update(chunk);
      bytes += chunk.length;
      await fh.write(chunk);
    }
  } finally {
    await fh.close();
  }
  return { expected, md5: md5.digest('hex'), sha256: sha256.digest('hex'), bytes };
}

/** Downloads one region into `outDir`; on any error no `.part` or final file is left. */
export async function downloadRegion(
  region: Region,
  outDir: string,
  ua: string,
  timeoutMs = PBF_TIMEOUT_MS,
): Promise<DownloadRecord> {
  mkdirSync(outDir, { recursive: true });
  const part = join(outDir, `${region.id}.osm.pbf.part`);
  const final = join(outDir, `${region.id}.osm.pbf`);
  try {
    let r = await attempt(region, part, ua, timeoutMs);
    if (r.md5 !== r.expected) r = await attempt(region, part, ua, timeoutMs); // the daily rebuild: both again, once
    if (r.md5 !== r.expected) throw new DownloadError('md5_mismatch', region.id);
    renameSync(part, final);
    const rec: DownloadRecord = { bytes: r.bytes, id: region.id, md5: r.md5, sha256: r.sha256, url: region.url };
    writeFileSync(join(outDir, `${region.id}.download.json`), `${JSON.stringify(rec)}\n`);
    return rec;
  } catch (err) {
    rmSync(part, { force: true });
    rmSync(final, { force: true });
    throw err instanceof DownloadError && err.region === null ? new DownloadError(err.code, region.id) : err;
  }
}

async function main(argv: string[]): Promise<number> {
  const usage = 'usage: node tools/geo/rivernet/download.ts --check-index | --region <id> --out <dir>';
  const checkOnly = argv.length === 1 && argv[0] === '--check-index';
  const one = argv.length === 4 && argv[0] === '--region' && argv[2] === '--out';
  if (!checkOnly && !one) {
    console.error(usage);
    return 64;
  }
  const env = captureEnv(process.env);
  if (typeof env === 'string') {
    console.error(`download: ${env}`);
    return 78;
  }
  const ua = captureUserAgent(env);
  const sources = readSources();
  try {
    if (checkOnly) {
      await checkIndex(sources, ua);
      console.log(`index ok: ${sources.geofabrik.regions.length} regions`);
      return 0;
    }
    const region = sources.geofabrik.regions.find((r) => r.id === argv[1]);
    if (region === undefined) throw new DownloadError('unknown_region');
    const rec = await downloadRegion(region, argv[3] as string, ua);
    console.log(`${rec.id} ${rec.bytes} bytes md5 ${rec.md5} sha256 ${rec.sha256}`);
    return 0;
  } catch (err) {
    console.error(`download: ${err instanceof DownloadError ? err.message : 'failed'}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
