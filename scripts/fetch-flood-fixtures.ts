// Opt-in, run by hand once (P7a): the flood-state fixtures of catalogue §0.4 that no capture recorded, because
// every source was at low water when the recorder started. Three fixed targets, never from input: the LHP test
// server (the January 2024 flood, frozen: station classes 1–3, alert classes 1/2/4/5) and the Wayback capture of
// Vigicrues' InfoVigiCru of 2023-12-11 (sections at levels 2 and 3, the old key casing). One request each, the
// project User-Agent, refused under CI; a redirect is followed only to the same https host, at most 3 times, and the
// body is read as a stream that stops at MAX_BYTES (`fetchCapped`, review SR-8); the bodies become committed
// fixtures with provenance.
//   node scripts/fetch-flood-fixtures.ts --contact <e-mail> --info-url <url> --yes
// The Wayback body is cut at 1 MiB by the archive: `wayback` keeps its complete features and closes the
// collection (`trimTruncated`, the rule its meta names); the untrimmed body stays in the git-ignored .smoke/.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userAgent } from '../apps/server/src/capture/env.ts';

const root = new URL('..', import.meta.url).pathname;
const MAX_BYTES = 4 * 1024 * 1024;

export const TARGETS = [
  {
    fixture: 'de-6-stations-test',
    source: 'DE-6',
    spec: 'de-6-stations',
    url: 'https://api.hochwasserzentralen.de/public/v1/test/data/stations?format=json',
    wayback: false,
  },
  {
    fixture: 'de-6-alerts-test',
    source: 'DE-6',
    spec: 'de-6-alerts',
    url: 'https://api.hochwasserzentralen.de/public/v1/test/data/alerts',
    wayback: false,
  },
  {
    fixture: 'fr-5-vigilance-wayback',
    source: 'FR-5',
    spec: 'fr-5-vigilance',
    url: 'https://web.archive.org/web/20231211164225id_/https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson/',
    wayback: true,
  },
] as const;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const MAX_REDIRECTS = 3;

/**
 * GET `url`: a redirect (301, 302, 303, 307, 308) is followed only to an https URL on the same host (the Wayback
 * Machine answers some captures with a 302 to another timestamp), at most MAX_REDIRECTS times; the body is read as
 * a stream and refused (`too_big`) as soon as it passes `maxBytes`. Throws with a fixed message, never a URL.
 */
export async function fetchCapped(
  url: string,
  headers: Record<string, string>,
  maxBytes = MAX_BYTES,
): Promise<{ status: number; contentType: string | null; body: Buffer }> {
  const host = new URL(url).host;
  let at = url;
  for (let hop = 0; ; hop += 1) {
    const res = await fetch(at, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      res.body?.cancel().catch(() => {});
      const next = new URL(res.headers.get('location') ?? '', at);
      if (hop >= MAX_REDIRECTS) throw new Error('too_many_redirects');
      if (next.protocol !== 'https:' || next.host !== host) throw new Error('redirect_off_host');
      at = next.href;
      continue;
    }
    const chunks: Buffer[] = [];
    let n = 0;
    const reader = res.body?.getReader();
    for (let r = await reader?.read(); reader && r && !r.done; r = await reader.read()) {
      n += r.value.byteLength;
      if (n > maxBytes) {
        // Nothing more is read; the cancel is not awaited (a stalled server must not hold the script).
        reader.cancel().catch(() => {});
        throw new Error('too_big');
      }
      chunks.push(Buffer.from(r.value));
    }
    return { status: res.status, contentType: res.headers.get('content-type'), body: Buffer.concat(chunks) };
  }
}

/**
 * A GeoJSON FeatureCollection cut inside its `features` array: everything before the array as published, then
 * every feature whose object closes before the cut, then `]}`. Strings are skipped by their quotes and escapes, so
 * a brace inside a label cannot end a feature. Throws when the text has no `"features":[`.
 */
export function trimTruncated(text: string): { body: string; kept: number } {
  const open = text.indexOf('"features"');
  const start = open < 0 ? -1 : text.indexOf('[', open);
  if (start < 0) throw new Error('no features array');
  let depth = 0;
  let inString = false;
  let featureStart = -1;
  let lastEnd = -1;
  let kept = 0;
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) featureStart = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && featureStart >= 0) {
        lastEnd = i + 1;
        kept += 1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  if (lastEnd < 0) throw new Error('no complete feature');
  return { body: `${text.slice(0, lastEnd)}]}`, kept };
}

function args(argv: string[]): { contact: string | undefined; infoUrl: string | undefined; yes: boolean } {
  const out: { contact: string | undefined; infoUrl: string | undefined; yes: boolean } = {
    contact: undefined,
    infoUrl: undefined,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--contact') out.contact = argv[++i];
    else if (argv[i] === '--info-url') out.infoUrl = argv[++i];
    else if (argv[i] === '--yes') out.yes = true;
  }
  return out;
}

async function main(): Promise<number> {
  if (process.env.CI !== undefined) {
    console.error('refused under CI: this script makes live requests');
    return 64;
  }
  const { contact, infoUrl, yes } = args(process.argv.slice(2));
  if (contact === undefined || infoUrl === undefined || !yes) {
    console.error('usage: node scripts/fetch-flood-fixtures.ts --contact <e-mail> --info-url <url> --yes');
    return 64;
  }
  const ua = userAgent(infoUrl, contact);
  for (const t of TARGETS) {
    const res = await fetchCapped(t.url, { 'user-agent': ua, accept: 'application/json, application/geo+json' });
    const raw = res.body;
    console.log(`${t.fixture}: ${res.status} ${raw.length} B`);
    if (res.status !== 200) return 1;
    const recorded_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const dir = join(root, 'apps/server/src/adapters', t.source.toLowerCase(), 'fixtures');
    const base = {
      spec: t.spec,
      source: t.source,
      synthetic: false,
      recorded_at,
      status: res.status,
      content_type: res.contentType,
      url: t.url,
      bytes: raw.length,
    };
    if (!t.wayback) {
      writeFileSync(join(dir, `${t.fixture}.raw`), raw);
      writeFileSync(join(dir, `${t.fixture}.meta.json`), `${JSON.stringify({ ...base, trimmed: false }, null, 2)}\n`);
      continue;
    }
    mkdirSync(join(root, '.smoke'), { recursive: true });
    writeFileSync(join(root, '.smoke', `${t.fixture}.untrimmed.raw`), raw);
    const { body, kept } = trimTruncated(raw.toString('utf8'));
    writeFileSync(join(dir, `${t.fixture}.raw`), body);
    const meta = {
      ...base,
      from: 'trimmed',
      source_sha256: sha256(raw),
      trimmed: `the Wayback capture is cut at 1 MiB inside the features: its ${kept} complete features kept as published, the collection closed with ]} (scripts/fetch-flood-fixtures.ts trimTruncated)`,
    };
    writeFileSync(join(dir, `${t.fixture}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
