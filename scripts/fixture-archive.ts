import { readFileSync } from 'node:fs';
import type { ManifestLine } from '../apps/server/src/archive/manifest.ts';
import { Archive, sha256 } from '../apps/server/src/archive/writer.ts';

// Builds a small raw archive from the recorded DE-1 fixtures, written by the
// recorder's own Archive class (real zstd objects, real manifest lines). The
// loader tests and the CI end-to-end run load it; nothing is fetched.
//
//   node scripts/fixture-archive.ts <raw dir>

const FIXTURES = new URL('../apps/server/src/adapters/de-1/fixtures/', import.meta.url);

export type FixtureLine = {
  source: string;
  spec: string;
  variant: string;
  /** When the fetch ended; the line is filed under the day the fetch started (one second earlier). */
  at: Date;
  body: Uint8Array;
  url: string;
  retention?: 'obs' | 'forever';
  validity?: ManifestLine['validity'];
  seed?: true;
};

/** A manifest line without a payload (304, an error, a closed gate) or with fields to override. */
export function bareLine(source: string, spec: string, at: Date, overrides: Partial<ManifestLine> = {}): ManifestLine {
  return {
    v: 1,
    source,
    spec,
    spec_version: 1,
    variant: '',
    request: { method: 'GET', url: 'https://example.org/' },
    fetched_at: { start: new Date(at.getTime() - 1000).toISOString(), end: at.toISOString() },
    status: 200,
    headers: {},
    sha256: null,
    bytes: null,
    stored_bytes: null,
    key: null,
    dup_of: null,
    gate: null,
    shape: null,
    shape_changed: false,
    validity: null,
    retention: 'obs',
    error: null,
    ...overrides,
  };
}

/** Stores the body and appends its line, as a capture run does. */
export async function writePayload(archive: Archive, f: FixtureLine): Promise<ManifestLine> {
  const hash = sha256(f.body);
  const { key, stored } = await archive.put(f.source, f.spec, f.at, f.body, hash);
  const line = bareLine(f.source, f.spec, f.at, {
    variant: f.variant,
    request: { method: 'GET', url: f.url },
    sha256: hash,
    bytes: f.body.length,
    stored_bytes: stored,
    key,
    gate: { kind: 'hash', key: null, open: true },
    validity: f.validity ?? { ok: true, reason: null, count: 1 },
    retention: f.retention ?? 'obs',
    ...(f.seed ? { seed: true as const } : {}),
  });
  await archive.append(line);
  return line;
}

export function recorded(name: string): { body: Buffer; at: Date; url: string } {
  const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, FIXTURES), 'utf8')) as {
    recorded_at: string;
    url: string;
  };
  return { body: readFileSync(new URL(`${name}.raw`, FIXTURES)), at: new Date(meta.recorded_at), url: meta.url };
}

/** `<station uuid>/<W|Q>` of a measurements URL. */
const variantOf = (url: string) => /stations\/([0-9a-f-]{36})\/([WQ])\//.exec(url)?.slice(1, 3).join('/') ?? '';

export const DE1_FIXTURES: readonly { spec: string; name: string; retention: 'obs' | 'forever'; seed?: true }[] = [
  { spec: 'de-1-meta', name: 'de-1-meta', retention: 'forever' },
  { spec: 'de-1-basin', name: 'de-1-basin', retention: 'obs' },
  { spec: 'de-1-series', name: 'de-1-series', retention: 'obs' },
  { spec: 'de-1-series', name: 'de-1-series-kaub-w-p31d', retention: 'obs', seed: true },
  { spec: 'de-1-series', name: 'de-1-series-ruhrwehr-ow-w', retention: 'obs' },
  { spec: 'de-1-series', name: 'de-1-series-maxau-q', retention: 'obs' },
];

/** The recorded DE-1 payloads at their recorded times. Returns the lines written. */
export async function buildFixtureArchive(rawDir: string): Promise<ManifestLine[]> {
  const archive = new Archive(rawDir);
  const lines: ManifestLine[] = [];
  for (const f of DE1_FIXTURES) {
    const { body, at, url } = recorded(f.name);
    lines.push(
      await writePayload(archive, {
        source: 'DE-1',
        spec: f.spec,
        variant: f.spec === 'de-1-series' ? variantOf(url) : '',
        at,
        body,
        url,
        retention: f.retention,
        ...(f.seed ? { seed: true as const } : {}),
      }),
    );
  }
  return lines;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined || process.argv.length !== 3) {
    console.error('usage: node scripts/fixture-archive.ts <raw dir>');
    process.exitCode = 64;
  } else {
    process.umask(0o027);
    const lines = await buildFixtureArchive(dir);
    console.log(`fixture-archive: ${lines.length} payloads and manifest lines written to ${dir}`);
  }
}
