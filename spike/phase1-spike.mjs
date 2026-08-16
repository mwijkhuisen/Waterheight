#!/usr/bin/env node
/**
 * Phase 1 spike & sizing script for the Rijkswaterstaat monitoring map.
 *
 * Throwaway by design. It probes the live WaterWebservices (WADAR / ddapi20)
 * and the OGC WFS, dumps every raw response to fixtures/, and prints a sizing
 * report that decides the backfill scope:
 *
 *   1. OphalenCatalogus            — timed; quantities/compartments inventory
 *   2. WFS GetCapabilities         — is GeoJSON output offered?
 *   3. WFS locaties                — count of ALL water-management locations
 *   4. WFS locatiesmetlaatstewaarneming — locations with a latest observation,
 *                                    plus a freshness histogram (7-day active cut)
 *   5. Bulk service probe          — does AanvragenBulkWaarnemingen exist on ddapi20?
 *   6. OphalenAantalWaarnemingen   — real per-month counts on a sample of active
 *                                    locations, projected to the full population
 *
 * Usage:
 *   node spike/phase1-spike.mjs [--sample 15] [--skip-catalogue] [--out fixtures]
 *
 * No dependencies; requires Node >= 18 (built-in fetch).
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

// Node's fetch (undici) ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set,
// which is read at startup — so re-exec once with it enabled. Without this,
// requests bypass the proxy and a sandboxed egress gateway rejects them with
// an opaque 403 that looks like an API error rather than a networking one.
if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== '1') {
  const { status } = spawnSync(
    process.execPath,
    ['--no-warnings', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } },
  );
  process.exit(status ?? 1);
}

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string', default: '15' },
    'skip-catalogue': { type: 'boolean', default: false },
    // Reuse already-downloaded WFS fixtures instead of re-fetching them; the
    // locatiesmetlaatstewaarneming layer is ~170 MB and takes ~90 s.
    reuse: { type: 'boolean', default: false },
    out: { type: 'string', default: 'fixtures' },
  },
});

const API_BASE =
  process.env.RWS_API_BASE ?? 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const WFS_URL =
  process.env.RWS_WFS_URL ?? 'https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows';
const OUT_DIR = args.out;
const SAMPLE_SIZE = Number(args.sample);
const ACTIVE_WINDOW_DAYS = Number(process.env.ACTIVE_WINDOW_DAYS ?? 7);
const CONCURRENCY = 4;

// The report object everything below appends to; dumped as phase1-report.json.
const report = {
  ranAt: new Date().toISOString(),
  apiBase: API_BASE,
  wfsUrl: WFS_URL,
  errors: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function saveFixture(name, body) {
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  log(`  fixture -> ${path} (${(typeof body === 'string' ? body.length : JSON.stringify(body).length)} bytes)`);
  return path;
}

/**
 * POST to a ddapi20 endpoint. Returns { status, ms, bytes, json, text }.
 * 204 means "no data" (not an error); 404 bodies are parsed, not discarded.
 */
async function rwsPost(path, body, { timeoutMs = 300_000 } = {}) {
  const started = performance.now();
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Not required today, but RWS asks clients to send one so future
      // key-based rate limiting does not break them.
      'X-API-KEY': process.env.RWS_API_KEY ?? 'dummy',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body; keep text */
  }
  return { status: res.status, ms, bytes: text.length, json, text };
}

async function wfsGet(params, { timeoutMs = 300_000 } = {}) {
  const url = new URL(WFS_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const started = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  return { status: res.status, ms, bytes: text.length, text, url: url.toString() };
}

/**
 * Stream a WFS response straight to disk.
 *
 * `locatiesmetlaatstewaarneming` is ~940k features; buffering it as a string
 * blows past V8's ~512 MB string cap, so every layer goes to a file and is
 * parsed from there.
 */
async function wfsGetToFile(params, filename, { timeoutMs = 900_000 } = {}) {
  const url = new URL(WFS_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, filename);
  if (args.reuse) {
    const existing = await stat(path).catch(() => null);
    if (existing?.size) {
      log(`  reusing -> ${path} (${existing.size.toLocaleString()} bytes)`);
      return { path, bytes: existing.size, ms: 0, reused: true };
    }
  }
  const started = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`WFS HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  const ms = Math.round(performance.now() - started);
  const { size } = await stat(path);
  log(`  streamed -> ${path} (${size.toLocaleString()} bytes, ${ms} ms)`);
  return { path, bytes: size, ms };
}

/** Split one CSV line into fields, honouring quoted fields and "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Yield each CSV record of a file as an object, without loading it all. */
async function* readCsvRecords(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const fields = splitCsvLine(line);
    if (!header) { header = fields; continue; }
    yield Object.fromEntries(header.map((h, i) => [h, fields[i]]));
  }
}

/** Run tasks with bounded concurrency; each failure is recorded, not fatal. */
async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

function fail(step, err) {
  const msg = `${step}: ${err?.message ?? err}`;
  report.errors.push(msg);
  log(`  ERROR ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. OphalenCatalogus (known to be slow — this timing is itself a deliverable)
// ---------------------------------------------------------------------------

let catalogue = null;
if (!args['skip-catalogue']) {
  log('1. OphalenCatalogus (this is documented as slow; timing it)...');
  try {
    const r = await rwsPost('/METADATASERVICES/OphalenCatalogus', {
      CatalogusFilter: { Compartimenten: true, Grootheden: true, Parameters: true, Eenheden: true },
    });
    report.catalogue = { status: r.status, ms: r.ms, bytes: r.bytes };
    log(`  status=${r.status} in ${r.ms} ms, ${r.bytes} bytes`);
    if (r.status === 200 && r.json) {
      catalogue = r.json;
      await saveFixture('OphalenCatalogus.json', r.json);
      const locaties = catalogue.LocatieLijst ?? [];
      const metas = catalogue.AquoMetadataLijst ?? [];
      const links = catalogue.AquoMetadataLocatieLijst ?? [];
      const grootheden = [...new Set(metas.map((m) => m.Grootheid?.Code).filter(Boolean))].sort();
      const compartimenten = [...new Set(metas.map((m) => m.Compartiment?.Code).filter(Boolean))].sort();
      report.catalogue.locations = locaties.length;
      report.catalogue.metadataCombos = metas.length;
      report.catalogue.locationMetadataLinks = links.length;
      report.catalogue.grootheden = grootheden;
      report.catalogue.compartimenten = compartimenten;
      log(`  catalogue: ${locaties.length} locations, ${metas.length} metadata combos, ${links.length} location-metadata links`);
      log(`  grootheden (${grootheden.length}): ${grootheden.join(', ')}`);
      log(`  compartimenten: ${compartimenten.join(', ')}`);
    } else {
      await saveFixture('OphalenCatalogus.error.txt', `HTTP ${r.status}\n\n${r.text}`);
      fail('OphalenCatalogus', `HTTP ${r.status}`);
    }
  } catch (err) {
    fail('OphalenCatalogus', err);
  }
}

// ---------------------------------------------------------------------------
// 2. WFS GetCapabilities — is GeoJSON offered?
// ---------------------------------------------------------------------------

log('2. WFS GetCapabilities...');
let geojsonOffered = false;
try {
  const r = await wfsGet({ SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetCapabilities' });
  await saveFixture('wfs-GetCapabilities.xml', r.text);
  geojsonOffered = /application\/json|geojson/i.test(r.text);
  const typenames = [...r.text.matchAll(/<Name>([^<]*locatie[^<]*)<\/Name>/gi)].map((m) => m[1]);
  report.wfs = {
    getCapabilities: { status: r.status, ms: r.ms, bytes: r.bytes },
    geojsonOffered,
    locationTypenames: [...new Set(typenames)],
  };
  log(`  status=${r.status} in ${r.ms} ms; GeoJSON offered: ${geojsonOffered}`);
  log(`  location-ish typenames: ${[...new Set(typenames)].join(', ') || '(none matched — inspect fixture)'}`);
} catch (err) {
  fail('WFS GetCapabilities', err);
  report.wfs = { geojsonOffered: false };
}

// ---------------------------------------------------------------------------
// 3 + 4. WFS layers: locaties (all) and locatiesmetlaatstewaarneming (active-ish)
// ---------------------------------------------------------------------------

/**
 * Cheap feature count via resultType=hits — one small XML response instead of
 * downloading the layer.
 */
async function wfsHits(typename) {
  const r = await wfsGet({
    SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature',
    TYPENAME: typename, resultType: 'hits',
  });
  const m = r.text.match(/numberOfFeatures="(\d+)"/);
  return { count: m ? Number(m[1]) : null, ms: r.ms };
}

log('3. WFS layer: locaties (all water-management locations)...');
try {
  const hits = await wfsHits('locaties');
  // Small enough to keep whole (~5.8 MB) and GeoJSON gives standard [lon, lat].
  const dl = await wfsGetToFile(
    {
      SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature',
      TYPENAME: 'locaties', outputFormat: 'application/json',
    },
    'wfs-locaties.geojson',
  );
  report.wfsLocaties = { format: 'geojson', ms: dl.ms, bytes: dl.bytes, count: hits.count };
  log(`  ${hits.count?.toLocaleString()} features`);
} catch (err) {
  fail('WFS locaties', err);
}

log('4. WFS layer: locatiesmetlaatstewaarneming (authoritative for this app)...');

// Real field names on this layer, confirmed against the live service. The full
// GeoJSON for all ~940k features exceeds V8's string cap, so we request CSV
// restricted to the columns we need and stream it to disk.
const ML = {
  code: 'CODE',
  name: 'NAAM',
  timestamp: 'TIJDSTIP_LAATSTE_METING',
  value: 'WAARDE_LAATSTE_METING',
  grootheid: 'GROOTHEIDCODE',
  compartiment: 'COMPARTIMENTCODE',
  eenheid: 'EENHEIDCODE',
  geometry: 'GEOMETRY',
};

/** CSV geometry is `POINT (lat lon)` — note the axis order differs from GeoJSON. */
function parsePointLatLon(wkt) {
  const m = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt ?? '');
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : { lat: null, lon: null };
}

/** code -> Set of "COMPARTIMENT|GROOTHEID", for the count sample in step 6. */
const quantitiesByCode = new Map();
let activeCodes = [];

try {
  const hits = await wfsHits('locatiesmetlaatstewaarneming');
  const dl = await wfsGetToFile(
    {
      SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature',
      TYPENAME: 'locatiesmetlaatstewaarneming', outputFormat: 'csv',
      PROPERTYNAME: Object.values(ML).join(','),
    },
    'wfs-locatiesmetlaatstewaarneming.csv',
  );
  report.wfsMetLaatste = {
    format: 'csv', ms: dl.ms, bytes: dl.bytes, count: hits.count, fields: ML,
  };

  const now = Date.now();
  const buckets = { fresh_24h: 0, lt_7d: 0, lt_30d: 0, lt_365d: 0, older: 0, unparseable: 0 };
  const newestByLoc = new Map();
  const meta = new Map();
  const sampleRecords = [];
  let rows = 0;

  for await (const rec of readCsvRecords(dl.path)) {
    rows++;
    if (sampleRecords.length < 50) sampleRecords.push(rec);
    const code = String(rec[ML.code] ?? '').toLowerCase();
    if (!code) continue;
    const t = Date.parse(rec[ML.timestamp]);
    if (Number.isNaN(t)) { buckets.unparseable++; continue; }
    // One location appears once per quantity (and per sampling depth, etc.), so
    // freshness is judged per location on its single newest observation.
    if (!newestByLoc.has(code) || t > newestByLoc.get(code)) newestByLoc.set(code, t);
    if (!meta.has(code)) {
      meta.set(code, { name: rec[ML.name], ...parsePointLatLon(rec[ML.geometry]) });
    }
    if (!quantitiesByCode.has(code)) quantitiesByCode.set(code, new Set());
    quantitiesByCode.get(code).add(`${rec[ML.compartiment]}|${rec[ML.grootheid]}`);
  }

  await saveFixture('wfs-locatiesmetlaatstewaarneming.sample-records.json', sampleRecords);

  for (const t of newestByLoc.values()) {
    const ageDays = (now - t) / 86_400_000;
    if (ageDays <= 1) buckets.fresh_24h++;
    else if (ageDays <= 7) buckets.lt_7d++;
    else if (ageDays <= 30) buckets.lt_30d++;
    else if (ageDays <= 365) buckets.lt_365d++;
    else buckets.older++;
  }

  const cutoff = now - ACTIVE_WINDOW_DAYS * 86_400_000;
  activeCodes = [...newestByLoc.entries()].filter(([, t]) => t >= cutoff).map(([c]) => c).sort();

  const activeSeries = activeCodes.reduce(
    (n, c) => n + (quantitiesByCode.get(c)?.size ?? 0), 0,
  );
  Object.assign(report.wfsMetLaatste, {
    rowsParsed: rows,
    uniqueLocations: newestByLoc.size,
    freshness: buckets,
    activeWindowDays: ACTIVE_WINDOW_DAYS,
    activeWithinWindow: activeCodes.length,
    activeDistinctSeries: activeSeries,
  });
  log(`  ${rows.toLocaleString()} rows -> ${newestByLoc.size.toLocaleString()} unique locations`);
  log(`  active (< ${ACTIVE_WINDOW_DAYS}d): ${activeCodes.length.toLocaleString()} locations, ${activeSeries.toLocaleString()} distinct location+quantity series`);
  log(`  freshness: ${JSON.stringify(buckets)}`);
} catch (err) {
  fail('WFS locatiesmetlaatstewaarneming', err);
}

// ---------------------------------------------------------------------------
// 5. Bulk service probe
// ---------------------------------------------------------------------------

log('5. Probing bulk service on ddapi20...');
report.bulkService = [];
for (const path of [
  '/BULKWAARNEMINGENSERVICES/AanvragenBulkWaarnemingen',
  '/ONLINEWAARNEMINGENSERVICES/AanvragenBulkWaarnemingen',
]) {
  try {
    // Deliberately minimal body: we only need to distinguish "endpoint exists"
    // (200/400 with a validation error body) from "endpoint gone" (404).
    const r = await rwsPost(path, {});
    report.bulkService.push({ path, status: r.status, body: r.text.slice(0, 500) });
    log(`  ${path} -> ${r.status}`);
    if (r.text) await saveFixture(`bulk-probe${path.replaceAll('/', '_')}.txt`, `HTTP ${r.status}\n\n${r.text}`);
  } catch (err) {
    report.bulkService.push({ path, error: String(err) });
    fail(`bulk probe ${path}`, err);
  }
}

// ---------------------------------------------------------------------------
// 6. OphalenAantalWaarnemingen on a sample of active locations
// ---------------------------------------------------------------------------

log(`6. OphalenAantalWaarnemingen on a sample of ${SAMPLE_SIZE} active locations...`);

// Period: the trailing 12 full months, with explicit UTC offset. Using +00:00
// everywhere sidesteps the DST trap for this sizing pass.
const now = new Date();
const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
const periode = {
  Begindatumtijd: from.toISOString().replace('Z', '+00:00'),
  Einddatumtijd: to.toISOString().replace('Z', '+00:00'),
};
report.countSample = { periode, results: [] };

// The (compartiment, grootheid) combos per location come straight from the
// locatiesmetlaatstewaarneming layer — it already states which series each
// location actually reports, so no catalogue cross-referencing is needed.
function combosForLocation(codeLower) {
  return [...(quantitiesByCode.get(codeLower) ?? [])].map((s) => s.split('|'));
}

if (activeCodes.length) {
  // Deterministic spread across the list instead of Math.random: reproducible
  // sample, still representative of the population ordering.
  const step = Math.max(1, Math.floor(activeCodes.length / SAMPLE_SIZE));
  const sampleCodes = activeCodes.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
  log(`  sample codes: ${sampleCodes.join(', ')}`);

  const results = await pool(sampleCodes, async (code) => {
    const combos = combosForLocation(code);
    const body = {
      AquoMetadataLijst: combos.map(([comp, grootheid]) => ({
        Compartiment: { Code: comp },
        Grootheid: { Code: grootheid },
      })),
      Groeperingsperiode: 'Maand',
      LocatieLijst: [{ Code: code }],
      Periode: periode,
    };
    const r = await rwsPost('/ONLINEWAARNEMINGENSERVICES/OphalenAantalWaarnemingen', body);
    return { code, combosTried: combos.length, status: r.status, ms: r.ms, bytes: r.bytes, json: r.json, text: r.text };
  });

  let totalPoints = 0;
  let seriesWithData = 0;
  let savedFixture = false;
  /** grootheid code -> { points, series } across the whole sample. */
  const byGrootheid = new Map();
  for (const r of results) {
    if (!r.ok) { fail('OphalenAantalWaarnemingen', r.error); continue; }
    const { code, status, ms, json, text } = r.value;
    if (status === 204) {
      report.countSample.results.push({ code, status, points: 0 });
      log(`  ${code}: 204 (no data in period)`);
      continue;
    }
    if (status !== 200 || !json) {
      report.countSample.results.push({ code, status, error: text?.slice(0, 300) });
      log(`  ${code}: HTTP ${status}`);
      continue;
    }
    if (!savedFixture) {
      await saveFixture('OphalenAantalWaarnemingen.sample.json', json);
      savedFixture = true;
    }
    // Real shape (verified live): a top-level AantalWaarnemingenPerPeriodeLijst
    // with one entry per physical series, each holding a per-month
    // AantalMetingenPerPeriodeLijst of { AantalMetingen, Groeperingsperiode }.
    //
    // One (compartiment, grootheid) pair expands into several physical series,
    // because AquoMetadata also varies by instrument, sampling height and so
    // on — so `series` here is materially larger than `combosTried`.
    const seriesList = json.AantalWaarnemingenPerPeriodeLijst ?? [];
    let points = 0;
    for (const s of seriesList) {
      let seriesPoints = 0;
      for (const p of s.AantalMetingenPerPeriodeLijst ?? []) {
        const n = Number(p.AantalMetingen ?? 0);
        if (!Number.isNaN(n)) seriesPoints += n;
      }
      points += seriesPoints;
      // Per-quantity totals are what decide the tiering, so accumulate them
      // rather than only the per-location sum.
      const g = s.AquoMetadata?.Grootheid?.Code ?? 'UNKNOWN';
      const agg = byGrootheid.get(g) ?? { points: 0, series: 0 };
      agg.points += seriesPoints;
      agg.series += 1;
      byGrootheid.set(g, agg);
    }
    const series = seriesList.length;
    totalPoints += points;
    seriesWithData += series;
    report.countSample.results.push({
      code, status, ms, combosTried: r.value.combosTried, seriesWithData: series, points,
    });
    log(`  ${code}: ${points.toLocaleString()} points across ${series} series from ${r.value.combosTried} quantity combos (${ms} ms)`);
  }

  // -------------------------------------------------------------------------
  // 6b. Time a real one-month OphalenWaarnemingen fetch, so the download ETA is
  //     measured rather than guessed.
  // -------------------------------------------------------------------------
  log('6b. Timing real one-month OphalenWaarnemingen fetches...');
  const monthStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
  const monthEnd = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const timingTargets = sampleCodes.slice(0, 5).flatMap((code) =>
    combosForLocation(code).slice(0, 1).map(([comp, grootheid]) => ({ code, comp, grootheid })),
  );
  const timings = await pool(timingTargets, async ({ code, comp, grootheid }) => {
    const r = await rwsPost('/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen', {
      Locatie: { Code: code },
      AquoPlusWaarnemingMetadata: {
        AquoMetadata: {
          Compartiment: { Code: comp },
          Grootheid: { Code: grootheid },
          ProcesType: 'meting',
        },
      },
      Periode: {
        Begindatumtijd: monthStart.toISOString().replace('Z', '+00:00'),
        Einddatumtijd: monthEnd.toISOString().replace('Z', '+00:00'),
      },
    });
    return { code, grootheid, status: r.status, ms: r.ms, bytes: r.bytes, json: r.json };
  });

  const okTimings = timings.filter((t) => t.ok && (t.value.status === 200 || t.value.status === 204));
  report.observationTiming = okTimings.map((t) => ({
    code: t.value.code, grootheid: t.value.grootheid,
    status: t.value.status, ms: t.value.ms, bytes: t.value.bytes,
  }));
  for (const t of okTimings) {
    log(`  ${t.value.code}/${t.value.grootheid}: HTTP ${t.value.status}, ${t.value.ms} ms, ${t.value.bytes.toLocaleString()} bytes`);
  }
  // Record one real payload as the fixture the Phase 2 normaliser is tested on.
  const withBody = okTimings.find((t) => t.value.status === 200 && t.value.json);
  if (withBody) await saveFixture('OphalenWaarnemingen.sample.json', withBody.value.json);

  const measuredSeconds = okTimings.length
    ? okTimings.reduce((s, t) => s + t.value.ms, 0) / okTimings.length / 1000
    : null;

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------
  const sampled = report.countSample.results.filter((r) => r.status === 200 || r.status === 204);
  if (sampled.length) {
    const activeCount = report.wfsMetLaatste?.activeWithinWindow ?? 0;
    const activeSeries = report.wfsMetLaatste?.activeDistinctSeries ?? 0;
    const combosTried = sampled.reduce((n, r) => n + (r.combosTried ?? 0), 0);

    // Project per *physical series*, not per location: the per-location mean is
    // dominated by a couple of offshore platforms carrying 50-130 series each,
    // so it badly overestimates the median coastal station.
    const avgPointsPerSeriesYear = totalPoints / Math.max(1, seriesWithData);
    // One (compartiment, grootheid) pair fans out into several physical series
    // (different instrument, sampling height, ...). Measure that fan-out.
    const seriesExpansion = seriesWithData / Math.max(1, combosTried);
    const projectedSeries = Math.round(activeSeries * seriesExpansion);
    const projectedRows = Math.round(projectedSeries * avgPointsPerSeriesYear);
    // ~120 bytes/row for (code, quantity, ts, value, quality, proces_type)
    // plus index overhead, before TimescaleDB compression.
    const projectedDiskGb = (projectedRows * 120) / 1e9;

    const perLocation = sampled.map((r) => r.points ?? 0).sort((a, b) => a - b);
    const median = perLocation[Math.floor(perLocation.length / 2)];

    // One request per (series, month) — the backfill's unit of work.
    const monthChunkRequests = projectedSeries * 12;
    const reqSeconds = measuredSeconds ?? 2.5;
    const wallClockHours = (monthChunkRequests * reqSeconds) / CONCURRENCY / 3600;

    // Per-quantity totals, so the Tier 1 / Tier 2 split is driven by evidence.
    const quantities = [...byGrootheid.entries()]
      .map(([grootheid, v]) => ({
        grootheid,
        points: v.points,
        series: v.series,
        pointsPerSeriesYear: Math.round(v.points / v.series),
        shareOfSamplePct: Number(((v.points / totalPoints) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.points - a.points);

    const tier1 = quantities.filter((q) => q.grootheid === 'WATHTE' || q.grootheid === 'Q');
    const tier1Points = tier1.reduce((n, q) => n + q.points, 0);

    report.projection = {
      sampledLocations: sampled.length,
      totalPointsInSample: totalPoints,
      seriesInSample: seriesWithData,
      combosRequestedInSample: combosTried,
      seriesExpansionFactor: Number(seriesExpansion.toFixed(2)),
      avgPointsPerSeriesYear: Math.round(avgPointsPerSeriesYear),
      medianPointsPerLocationYear: median,
      meanPointsPerLocationYear: Math.round(totalPoints / sampled.length),
      activeLocations: activeCount,
      activeDistinctQuantityPairs: activeSeries,
      projectedPhysicalSeries: projectedSeries,
      projectedRowsOneYear: projectedRows,
      projectedDiskGbUncompressed: Number(projectedDiskGb.toFixed(1)),
      projectedMonthChunkRequests: monthChunkRequests,
      secondsPerRequest: Number(reqSeconds.toFixed(2)),
      secondsPerRequestSource: measuredSeconds ? 'measured' : 'assumed',
      concurrency: CONCURRENCY,
      projectedWallClockHours: Number(wallClockHours.toFixed(1)),
      tier1ShareOfSamplePct: Number(((tier1Points / totalPoints) * 100).toFixed(1)),
      quantities,
    };

    log('  points by quantity (sample):');
    for (const q of quantities.slice(0, 15)) {
      log(`    ${q.grootheid.padEnd(12)} ${String(q.points).padStart(10)} pts  ${String(q.series).padStart(4)} series  ${q.shareOfSamplePct}%`);
    }
  }
} else {
  log('  SKIPPED: no active locations discovered from WFS (see errors above)');
}

// ---------------------------------------------------------------------------
// 7. DST behaviour across the March and October transitions
//
// The brief warns that +01:00 and +02:00 both occur inside a single month
// chunk. Verify that against the live service rather than assuming it.
// ---------------------------------------------------------------------------

log('7. Checking timestamp offsets across DST transitions...');
report.dstProbe = [];
for (const [label, begin, end] of [
  ['march', '2026-03-01T00:00:00.000+00:00', '2026-04-01T00:00:00.000+00:00'],
  ['october', '2025-10-01T00:00:00.000+00:00', '2025-11-01T00:00:00.000+00:00'],
]) {
  try {
    const r = await rwsPost('/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen', {
      Locatie: { Code: 'vlissingen' },
      AquoPlusWaarnemingMetadata: {
        AquoMetadata: {
          Compartiment: { Code: 'OW' },
          Grootheid: { Code: 'WATHTE' },
          ProcesType: 'meting',
        },
      },
      Periode: { Begindatumtijd: begin, Einddatumtijd: end },
    });
    const metingen = r.json?.WaarnemingenLijst?.[0]?.MetingenLijst ?? [];
    const offsets = {};
    for (const m of metingen) {
      const off = m.Tijdstip.slice(-6);
      offsets[off] = (offsets[off] ?? 0) + 1;
    }
    const sorted = metingen.map((m) => m.Tijdstip).sort();
    const entry = {
      month: label, status: r.status, points: metingen.length, offsets,
      first: sorted[0], last: sorted.at(-1),
    };
    report.dstProbe.push(entry);
    log(`  ${label}: ${metingen.length} points, offsets=${JSON.stringify(offsets)}`);
    log(`    first=${entry.first} last=${entry.last}`);
  } catch (err) {
    fail(`DST probe ${label}`, err);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

await saveFixture('phase1-report.json', report);

console.log('\n================ PHASE 1 REPORT ================');
console.log(`Catalogue:          ${report.catalogue ? `${report.catalogue.ms} ms, ${report.catalogue.locations ?? '?'} locations, ${report.catalogue.metadataCombos ?? '?'} metadata combos` : 'skipped/failed'}`);
console.log(`GeoJSON on WFS:     ${report.wfs?.geojsonOffered}`);
console.log(`locaties:           ${report.wfsLocaties?.count ?? 'FAILED'}`);
console.log(`met laatste:        ${report.wfsMetLaatste?.count ?? 'FAILED'} rows / ${report.wfsMetLaatste?.uniqueLocations ?? '?'} unique locations`);
console.log(`active (<${ACTIVE_WINDOW_DAYS}d):       ${report.wfsMetLaatste?.activeWithinWindow ?? '?'}`);
console.log(`Bulk service:       ${report.bulkService.map((b) => `${b.path.split('/').pop()}=${b.status ?? 'ERR'}`).join(', ')}`);
if (report.projection) {
  const p = report.projection;
  console.log(`Projected 1y rows:  ${p.projectedRowsOneYear.toLocaleString()} (~${p.projectedDiskGbUncompressed} GB uncompressed)`);
  console.log(`Projected download: ~${p.projectedMonthChunkRequests.toLocaleString()} month-chunk requests, ~${p.projectedWallClockHours} h at concurrency ${p.concurrency}`);
}
if (report.errors.length) {
  console.log(`\nErrors (${report.errors.length}):`);
  for (const e of report.errors) console.log(`  - ${e}`);
}
console.log('================================================');
