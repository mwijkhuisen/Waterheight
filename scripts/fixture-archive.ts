import { readFileSync } from 'node:fs';
import type { ManifestLine } from '../apps/server/src/archive/manifest.ts';
import { Archive, sha256 } from '../apps/server/src/archive/writer.ts';

// Builds a small raw archive from the recorded DE-1, NL-1 and NL-2 fixtures,
// written by the recorder's own Archive class (real zstd objects, real
// manifest lines). The loader tests and the CI end-to-end run load it;
// nothing is fetched.
//
//   node scripts/fixture-archive.ts <raw dir>

const fixtureDir = (source: string) =>
  new URL(`../apps/server/src/adapters/${source.toLowerCase()}/fixtures/`, import.meta.url);

export type FixtureLine = {
  source: string;
  spec: string;
  variant: string;
  /** When the fetch ended; the line is filed under the day the fetch started (one second earlier). */
  at: Date;
  body: Uint8Array;
  url: string;
  /** The request method the recorder logged; the loader does not read it. */
  method?: 'GET' | 'POST';
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
    request: { method: f.method ?? 'GET', url: f.url },
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

export function recorded(name: string, source = 'DE-1'): { body: Buffer; at: Date; url: string } {
  const dir = fixtureDir(source);
  const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, dir), 'utf8')) as {
    recorded_at: string;
    url: string;
  };
  return { body: readFileSync(new URL(`${name}.raw`, dir)), at: new Date(meta.recorded_at), url: meta.url };
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

/** The recorded NL-1 payloads (one POST per gauge and quantity) and the NL-2 snapshot, with the recorder's variant. */
export const NL_FIXTURES: readonly {
  source: 'NL-1' | 'NL-2';
  spec: string;
  name: string;
  variant: string;
  retention: 'obs' | 'forever';
}[] = [
  {
    source: 'NL-1',
    spec: 'nl-1-obs-key',
    name: 'nl-1-obs-key',
    variant: 'lobith.bovenrijn.tolkamer/H',
    retention: 'obs',
  },
  {
    source: 'NL-1',
    spec: 'nl-1-obs-key',
    name: 'nl-1-obs-key-eijsden-grens-h',
    variant: 'eijsden.grens/H',
    retention: 'obs',
  },
  { source: 'NL-1', spec: 'nl-1-obs-twin', name: 'nl-1-obs-twin', variant: 'eijsden.grens/H', retention: 'obs' },
  {
    source: 'NL-1',
    spec: 'nl-1-obs-other',
    name: 'nl-1-obs-other-lobith-bovenrijn-tolkamer-q',
    variant: 'lobith.bovenrijn.tolkamer/Q',
    retention: 'obs',
  },
  {
    source: 'NL-1',
    spec: 'nl-1-obs-other',
    name: 'nl-1-obs-other-driel-boven-q',
    variant: 'driel.boven/Q',
    retention: 'obs',
  },
  { source: 'NL-2', spec: 'nl-2-wfs', name: 'nl-2-wfs', variant: '', retention: 'obs' },
];

/** The recorded HTTP 204 of arnhem.nederrijn Q: RWS has no data, so the recorder wrote a line and no object. */
const NL_NO_DATA = { name: 'nl-1-obs-other-arnhem-nederrijn-q', spec: 'nl-1-obs-other', variant: 'arnhem.nederrijn/Q' };

/** The recorded NL-1 and NL-2 payloads at their recorded times, and the 204 line. Returns the lines written. */
export async function buildNlFixtureArchive(rawDir: string): Promise<ManifestLine[]> {
  const archive = new Archive(rawDir);
  const lines: ManifestLine[] = [];
  for (const f of NL_FIXTURES) {
    const { body, at, url } = recorded(f.name, f.source);
    lines.push(
      await writePayload(archive, {
        source: f.source,
        spec: f.spec,
        variant: f.variant,
        at,
        body,
        url,
        method: f.source === 'NL-1' ? 'POST' : 'GET',
        retention: f.retention,
      }),
    );
  }
  const { at, url } = recorded(NL_NO_DATA.name, 'NL-1');
  const line = bareLine('NL-1', NL_NO_DATA.spec, at, {
    variant: NL_NO_DATA.variant,
    request: { method: 'POST', url },
    status: 204,
  });
  await archive.append(line);
  lines.push(line);
  return lines;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined || process.argv.length !== 3) {
    console.error('usage: node scripts/fixture-archive.ts <raw dir>');
    process.exitCode = 64;
  } else {
    process.umask(0o027);
    const lines = [...(await buildFixtureArchive(dir)), ...(await buildNlFixtureArchive(dir))];
    const payloads = lines.filter((l) => l.key !== null).length;
    console.log(`fixture-archive: ${lines.length} manifest lines (${payloads} payloads) written to ${dir}`);
  }
}
