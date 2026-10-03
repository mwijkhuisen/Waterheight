import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { captureEnv, captureUserAgent, EXIT_CONFIG } from '../../../apps/server/src/capture/env.ts';
import { boundedJson } from '../../../packages/core/src/json.ts';

// Opt-in Wikidata lookup (P6a): for the river and canal names of wikidata-labels.txt it lists every
// candidate item with its OSM relation (P402), mouth (P403), country (P17) and nl/en labels, so the
// registry (registry/rivers.yaml) is curated by hand. Nothing is guessed. Wikidata is CC0. The
// endpoint is a constant here; tools/geo/rivernet/sources.ts may take it over later.

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
export const WIKIDATA_HOST = 'query.wikidata.org';
export const LIMITS = {
  batch: 30,
  maxRequests: 80,
  minIntervalMs: 1000,
  timeoutMs: 60_000,
  maxBodyBytes: 8 * 1024 * 1024,
  maxLabelChars: 80,
  json: { maxNodes: 1_000_000, maxDepth: 8 },
} as const;

/** The only error of this module: a fixed code, never provider text. */
export class LookupError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'LookupError';
    this.code = code;
  }
}

export interface Label {
  lang: string;
  label: string;
}

/** `lang:label` per line, `#` comments and blank lines skipped; duplicates dropped, order kept. */
export function parseLabels(text: string): Label[] {
  const seen = new Set<string>();
  const out: Label[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-z]{2,3}):(.+)$/.exec(line);
    if (!m) throw new LookupError('bad_label_line');
    const [, lang, label] = m as unknown as [string, string, string];
    if (label.length > LIMITS.maxLabelChars || /[\p{Cc}\p{Cf}]/u.test(label)) throw new LookupError('bad_label');
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ lang, label });
  }
  return out;
}

const literal = ({ lang, label }: Label) => `"${label.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"@${lang}`;

export function buildQuery(labels: readonly Label[]): string {
  return `SELECT ?item ?label ?osm ?mouth ?mouthLabel ?country ?nl ?en WHERE {
  VALUES ?label { ${labels.map(literal).join(' ')} }
  ?item rdfs:label ?label .
  OPTIONAL { ?item wdt:P402 ?osm }
  OPTIONAL { ?item wdt:P403 ?mouth . OPTIONAL { ?mouth rdfs:label ?mouthLabel FILTER(lang(?mouthLabel) = "en") } }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item rdfs:label ?nl FILTER(lang(?nl) = "nl") }
  OPTIONAL { ?item rdfs:label ?en FILTER(lang(?en) = "en") }
  FILTER(BOUND(?osm) || BOUND(?mouth))
}`;
}

const Term = z.strictObject({
  type: z.string().max(20),
  value: z.string().max(2000),
  'xml:lang': z.string().max(20).optional(),
  datatype: z.string().max(200).optional(),
});
const SparqlResults = z.strictObject({
  head: z.looseObject({ vars: z.array(z.string().max(40)).max(20) }),
  results: z.strictObject({ bindings: z.array(z.record(z.string().max(40), Term)).max(100_000) }),
});
export type Binding = Record<string, z.infer<typeof Term>>;

/** One SPARQL JSON response: bounded, then a strict parse. Throws only LookupError. */
export function parseSparql(text: string): Binding[] {
  let doc: unknown;
  try {
    doc = boundedJson(text, LIMITS.json);
  } catch {
    throw new LookupError('bad_json');
  }
  const r = SparqlResults.safeParse(doc);
  if (!r.success) throw new LookupError('bad_shape');
  return r.data.results.bindings;
}

export interface Candidate {
  qid: string;
  osm_relation: number | null;
  mouth_qid: string | null;
  mouth_en: string | null;
  countries: string[];
  nl: string | null;
  en: string | null;
}
export interface LabelResult extends Label {
  candidates: Candidate[];
}

const qidOf = (t: Binding[string] | undefined): string | null => {
  if (!t) return null;
  const m = /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9][0-9]{0,9})$/.exec(t.value);
  if (!m) throw new LookupError('bad_value');
  return m[1] as string;
};
const cmp = (a: string | number | null, b: string | number | null) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;

/** Groups the bindings of all batches per input label; sorted, deduplicated. Throws only LookupError. */
export function groupCandidates(labels: readonly Label[], bindings: readonly Binding[]): LabelResult[] {
  const byLabel = new Map<string, Map<string, Candidate>>();
  for (const b of bindings) {
    const l = b.label;
    const qid = qidOf(b.item);
    if (!l || !qid) throw new LookupError('bad_value');
    const lang = l['xml:lang'] ?? '';
    const osmText = b.osm?.value ?? null;
    if (osmText !== null && !/^[1-9][0-9]{0,15}$/.test(osmText)) throw new LookupError('bad_value');
    const osm = osmText === null ? null : Number(osmText);
    const mouth = qidOf(b.mouth);
    const key = `${lang}:${l.value}`;
    const per = byLabel.get(key) ?? new Map<string, Candidate>();
    byLabel.set(key, per);
    const ck = `${qid}|${osm}|${mouth}`;
    const c = per.get(ck) ?? {
      qid,
      osm_relation: osm,
      mouth_qid: mouth,
      mouth_en: b.mouthLabel?.value ?? null,
      countries: [],
      nl: b.nl?.value ?? null,
      en: b.en?.value ?? null,
    };
    per.set(ck, c);
    const country = qidOf(b.country);
    if (country && !c.countries.includes(country)) c.countries.push(country);
  }
  return labels
    .map((x) => ({
      ...x,
      candidates: [...(byLabel.get(`${x.lang}:${x.label}`)?.values() ?? [])]
        .map((c) => ({ ...c, countries: c.countries.toSorted() }))
        .sort((a, b) => cmp(a.qid, b.qid) || cmp(a.osm_relation, b.osm_relation) || cmp(a.mouth_qid, b.mouth_qid)),
    }))
    .sort((a, b) => cmp(a.label, b.label) || cmp(a.lang, b.lang));
}

export interface LookupDeps {
  userAgent: string;
  endpoint?: string;
  maxRequests?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called with each raw response body (n from 1). */
  record?: (n: number, body: string) => void;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) throw new LookupError('no_body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.maxBodyBytes) {
      reader.cancel().catch(() => {});
      throw new LookupError('body_too_large');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new LookupError('bad_utf8');
  }
}

export async function lookup(labels: readonly Label[], deps: LookupDeps): Promise<LabelResult[]> {
  const endpoint = deps.endpoint ?? WIKIDATA_ENDPOINT;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new LookupError('bad_endpoint');
  }
  if (url.protocol !== 'https:' || url.hostname !== WIKIDATA_HOST || url.port !== '')
    throw new LookupError('bad_endpoint');
  const chunks: Label[][] = [];
  for (let i = 0; i < labels.length; i += LIMITS.batch) chunks.push(labels.slice(i, i + LIMITS.batch));
  if (chunks.length > (deps.maxRequests ?? LIMITS.maxRequests)) throw new LookupError('budget_exceeded');
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const bindings: Binding[] = [];
  let last: number | null = null;
  for (const [i, chunk] of chunks.entries()) {
    if (last !== null) {
      const wait = LIMITS.minIntervalMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    last = now();
    url.search = new URLSearchParams({ query: buildQuery(chunk) }).toString();
    let res: Response;
    try {
      res = await doFetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(LIMITS.timeoutMs),
        headers: { accept: 'application/sparql-results+json', 'user-agent': deps.userAgent },
      });
    } catch {
      throw new LookupError('fetch_failed');
    }
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      throw new LookupError('http_status');
    }
    const body = await readCapped(res);
    deps.record?.(i + 1, body);
    bindings.push(...parseSparql(body));
  }
  return groupCandidates(labels, bindings);
}

export const toTsv = (results: readonly LabelResult[]): string =>
  results
    .flatMap((r) =>
      r.candidates.length === 0
        ? [[r.lang, r.label, '-', '-', '-', '-', '-', '-', '-']]
        : r.candidates.map((c) => [
            r.lang,
            r.label,
            c.qid,
            c.osm_relation ?? '-',
            c.mouth_qid ?? '-',
            c.mouth_en ?? '-',
            c.countries.join(',') || '-',
            c.nl ?? '-',
            c.en ?? '-',
          ]),
    )
    .map((cols) => `${cols.join('\t')}`.replace(/[\r\n]/g, ' '))
    .join('\n');

/** The CLI; returns the exit code (0 ok, 1 failure, 64 usage or CI, 78 without RWS_DOMAIN/RWS_CONTACT_EMAIL). */
const usage = (log: (s: string) => void) => {
  log('usage: --out <file.json> [--record <dir>]');
  return 64;
};

export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: Partial<LookupDeps> = {},
  log: (s: string) => void = console.log,
): Promise<number> {
  if (env.CI) {
    log('refused: opt-in tool, not for CI');
    return 64;
  }
  let out: string | undefined;
  let record: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const v = argv[i + 1];
    if (v === undefined || (argv[i] !== '--out' && argv[i] !== '--record')) return usage(log);
    if (argv[i] === '--out') out = v;
    else record = v;
  }
  if (!out) return usage(log);
  const ce = captureEnv(env);
  if (typeof ce === 'string') {
    log(ce);
    return EXIT_CONFIG;
  }
  try {
    const labels = parseLabels(readFileSync(join(ROOT, 'tools/geo/rivernet/wikidata-labels.txt'), 'utf8'));
    if (record) mkdirSync(record, { recursive: true });
    const results = await lookup(labels, {
      userAgent: captureUserAgent(ce),
      ...deps,
      record: (n, body) => record && writeFileSync(join(record, `sparql-${n}.json`), body),
    });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    log(toTsv(results));
    return 0;
  } catch (e) {
    log(`error: ${e instanceof LookupError ? e.code : 'internal'}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), process.env);
