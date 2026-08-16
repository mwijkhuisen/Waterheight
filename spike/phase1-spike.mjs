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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    sample: { type: 'string', default: '15' },
    'skip-catalogue': { type: 'boolean', default: false },
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

/** Minimal CSV parser handling quoted fields and embedded commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], records: [] };
  const [header, ...rest] = rows;
  return {
    header,
    records: rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))),
  };
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

/** Fetch one WFS layer, preferring GeoJSON, falling back to CSV. */
async function fetchLayer(typename) {
  const base = { SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature', TYPENAME: typename };
  if (geojsonOffered) {
    const r = await wfsGet({ ...base, outputFormat: 'application/json' });
    if (r.status === 200 && r.text.trimStart().startsWith('{')) {
      const json = JSON.parse(r.text);
      await saveFixture(`wfs-${typename}.geojson`, json);
      return {
        format: 'geojson', status: r.status, ms: r.ms, bytes: r.bytes,
        features: (json.features ?? []).map((f) => ({
          ...f.properties,
          _lon: f.geometry?.coordinates?.[0],
          _lat: f.geometry?.coordinates?.[1],
        })),
      };
    }
    log(`  GeoJSON request for ${typename} did not return JSON (status ${r.status}); falling back to CSV`);
  }
  const r = await wfsGet({ ...base, outputFormat: 'csv' });
  if (r.status !== 200) throw new Error(`WFS ${typename} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  await saveFixture(`wfs-${typename}.csv`, r.text);
  const { records } = parseCsv(r.text);
  return { format: 'csv', status: r.status, ms: r.ms, bytes: r.bytes, features: records };
}

/** Case-insensitive property lookup across unknown WFS schemas. */
function prop(obj, patterns) {
  for (const key of Object.keys(obj)) {
    if (patterns.some((p) => p.test(key))) return { key, value: obj[key] };
  }
  return null;
}

log('3. WFS layer: locaties (all water-management locations)...');
let allLocations = [];
try {
  const layer = await fetchLayer('locaties');
  allLocations = layer.features;
  report.wfsLocaties = { format: layer.format, ms: layer.ms, bytes: layer.bytes, count: layer.features.length };
  log(`  ${layer.features.length} features (${layer.format}, ${layer.ms} ms)`);
} catch (err) {
  fail('WFS locaties', err);
}

log('4. WFS layer: locatiesmetlaatstewaarneming (authoritative for this app)...');
let activeLocations = [];
try {
  const layer = await fetchLayer('locatiesmetlaatstewaarneming');
  const feats = layer.features;
  report.wfsMetLaatste = { format: layer.format, ms: layer.ms, bytes: layer.bytes, count: feats.length };
  log(`  ${feats.length} features (${layer.format}, ${layer.ms} ms)`);

  if (feats.length) {
    // Field names on this layer are not documented; discover them and record
    // the mapping so Phase 2 can rely on the fixture, not guesswork.
    const sample = feats[0];
    await saveFixture('wfs-locatiesmetlaatstewaarneming.sample-feature.json', sample);
    report.wfsMetLaatste.propertyNames = Object.keys(sample);

    const tsProp = prop(sample, [/tijdstip/i, /datum/i, /waarneming.*(tijd|date)/i, /^time/i, /_at$/i]);
    const codeProp = prop(sample, [/^locatie.?code$/i, /^code$/i, /^loc_code$/i]);
    const grootheidProp = prop(sample, [/grootheid/i, /parameter/i]);
    report.wfsMetLaatste.discovered = {
      timestampField: tsProp?.key ?? null,
      codeField: codeProp?.key ?? null,
      grootheidField: grootheidProp?.key ?? null,
    };
    log(`  discovered fields: timestamp=${tsProp?.key}, code=${codeProp?.key}, grootheid=${grootheidProp?.key}`);

    if (tsProp) {
      const now = Date.now();
      const buckets = { 'fresh_24h': 0, 'lt_7d': 0, 'lt_30d': 0, 'lt_365d': 0, older: 0, unparseable: 0 };
      // A "location" can appear once per quantity in this layer; freshness is
      // judged per unique location on its newest observation.
      const newestByLoc = new Map();
      for (const f of feats) {
        const code = String(codeProp ? f[codeProp.key] : JSON.stringify(f)).toLowerCase();
        const t = Date.parse(f[tsProp.key]);
        if (Number.isNaN(t)) { buckets.unparseable++; continue; }
        if (!newestByLoc.has(code) || t > newestByLoc.get(code)) newestByLoc.set(code, t);
      }
      for (const t of newestByLoc.values()) {
        const ageDays = (now - t) / 86_400_000;
        if (ageDays <= 1) buckets.fresh_24h++;
        else if (ageDays <= 7) buckets.lt_7d++;
        else if (ageDays <= 30) buckets.lt_30d++;
        else if (ageDays <= 365) buckets.lt_365d++;
        else buckets.older++;
      }
      const activeCount = buckets.fresh_24h + buckets.lt_7d;
      report.wfsMetLaatste.uniqueLocations = newestByLoc.size;
      report.wfsMetLaatste.freshness = buckets;
      report.wfsMetLaatste.activeWithinWindow = activeCount;
      report.wfsMetLaatste.activeWindowDays = ACTIVE_WINDOW_DAYS;
      log(`  unique locations: ${newestByLoc.size}; active (< ${ACTIVE_WINDOW_DAYS}d): ${activeCount}`);
      log(`  freshness: ${JSON.stringify(buckets)}`);

      const cutoff = now - ACTIVE_WINDOW_DAYS * 86_400_000;
      const activeCodes = new Set(
        [...newestByLoc.entries()].filter(([, t]) => t >= cutoff).map(([c]) => c),
      );
      activeLocations = feats.filter(
        (f) => codeProp && activeCodes.has(String(f[codeProp.key]).toLowerCase()),
      );
    } else {
      log('  WARNING: no timestamp field discovered — inspect the sample-feature fixture');
    }
  }
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

// Build location -> set of (compartiment, grootheid) from the catalogue links.
// Falls back to a common-quantities probe when the catalogue was skipped/failed.
const FALLBACK_COMBOS = [
  ['OW', 'WATHTE'], ['OW', 'Q'], ['OW', 'T'], ['OW', 'Hm0'],
  ['OW', 'STROOMSHD'], ['LT', 'WINDSHD'], ['OW', 'SALNTT'], ['OW', 'O2'],
];

function combosForLocation(codeLower) {
  if (!catalogue) return FALLBACK_COMBOS;
  const loc = (catalogue.LocatieLijst ?? []).find(
    (l) => String(l.Code).toLowerCase() === codeLower,
  );
  if (!loc) return FALLBACK_COMBOS;
  const metaById = new Map(
    (catalogue.AquoMetadataLijst ?? []).map((m) => [m.AquoMetadata_MessageID, m]),
  );
  const combos = [];
  for (const link of catalogue.AquoMetadataLocatieLijst ?? []) {
    if (link.Locatie_MessageID !== loc.Locatie_MessageID) continue;
    const m = metaById.get(link.AquoMetaData_MessageID);
    if (m?.Grootheid?.Code) combos.push([m.Compartiment?.Code ?? 'OW', m.Grootheid.Code]);
  }
  return combos.length ? combos : FALLBACK_COMBOS;
}

if (activeLocations.length) {
  const codeProp = report.wfsMetLaatste?.discovered?.codeField;
  const uniqueCodes = [...new Set(
    activeLocations.map((f) => String(f[codeProp]).toLowerCase()),
  )];
  // Deterministic spread across the list instead of Math.random: reproducible
  // sample, still representative of the population ordering.
  const step = Math.max(1, Math.floor(uniqueCodes.length / SAMPLE_SIZE));
  const sampleCodes = uniqueCodes.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
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
    // Expected shape (mirrors classic service): AantalWaarnemingenPerPeriodeLijst
    // nested under per-location/metadata entries. Sum every numeric count we
    // can find so a shape drift still yields a usable total (and the fixture
    // records the real shape for Phase 2).
    let points = 0;
    let series = 0;
    (function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        if (Array.isArray(node.AantalWaarnemingenPerPeriodeLijst)) {
          series++;
          for (const p of node.AantalWaarnemingenPerPeriodeLijst) {
            const n = Number(p.AantalWaarnemingen ?? p.Aantal ?? 0);
            if (!Number.isNaN(n)) points += n;
          }
        }
        Object.values(node).forEach(walk);
      }
    })(json);
    totalPoints += points;
    seriesWithData += series;
    report.countSample.results.push({ code, status, ms, seriesWithData: series, points });
    log(`  ${code}: ${points.toLocaleString()} points across ${series} series (${ms} ms)`);
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------
  const sampled = report.countSample.results.filter((r) => r.status === 200 || r.status === 204);
  if (sampled.length) {
    const avgPointsPerLocationYear = totalPoints / sampled.length;
    const activeCount = report.wfsMetLaatste?.activeWithinWindow ?? 0;
    const projectedRows = Math.round(avgPointsPerLocationYear * activeCount);
    // ~55 bytes/row heap estimate for (code, quantity, ts, value, quality,
    // procestype) + index overhead, pre-compression.
    const projectedDiskGb = (projectedRows * 120) / 1e9;
    const avgSeriesPerLocation = seriesWithData / Math.max(1, sampled.length);
    const monthlyRequests = Math.round(activeCount * avgSeriesPerLocation * 12);
    const avgReqSeconds = 2.5; // refine with observed OphalenWaarnemingen latency
    const wallClockHours = (monthlyRequests * avgReqSeconds) / CONCURRENCY / 3600;
    report.projection = {
      sampledLocations: sampled.length,
      totalPointsInSample: totalPoints,
      avgPointsPerLocationYear: Math.round(avgPointsPerLocationYear),
      activeLocations: activeCount,
      projectedRowsOneYear: projectedRows,
      projectedDiskGbUncompressed: Number(projectedDiskGb.toFixed(1)),
      avgSeriesPerLocation: Number(avgSeriesPerLocation.toFixed(1)),
      projectedMonthChunkRequests: monthlyRequests,
      assumedSecondsPerRequest: avgReqSeconds,
      concurrency: CONCURRENCY,
      projectedWallClockHours: Number(wallClockHours.toFixed(1)),
    };
  }
} else {
  log('  SKIPPED: no active locations discovered from WFS (see errors above)');
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
