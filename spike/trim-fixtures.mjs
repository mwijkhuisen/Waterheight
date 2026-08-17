#!/usr/bin/env node
/**
 * Produce small, committable fixtures from the raw spike dumps.
 *
 * The raw responses are far too big for git (the WFS layer alone is ~173 MB),
 * but Phase 2's normaliser tests need real payloads with the real field names.
 * This writes trimmed versions that keep the exact response *shape* while
 * cutting the row counts, into fixtures/trimmed/.
 *
 * Usage: node spike/trim-fixtures.mjs [--in fixtures] [--out fixtures/trimmed]
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string', default: 'fixtures' },
    out: { type: 'string', default: 'fixtures/trimmed' },
  },
});

const IN = args.in;
const OUT = args.out;
await mkdir(OUT, { recursive: true });

async function readJson(name) {
  return JSON.parse(await readFile(join(IN, name), 'utf8'));
}

async function write(name, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await writeFile(join(OUT, name), body);
  const { size } = await stat(join(OUT, name));
  console.log(`  ${name.padEnd(52)} ${size.toLocaleString().padStart(10)} bytes`);
}

async function exists(name) {
  return !!(await stat(join(IN, name)).catch(() => null));
}

console.log(`Trimming fixtures from ${IN} -> ${OUT}`);

// --- OphalenWaarnemingen: keep the envelope, trim the measurement list -------
if (await exists('OphalenWaarnemingen.sample.json')) {
  const d = await readJson('OphalenWaarnemingen.sample.json');
  for (const w of d.WaarnemingenLijst ?? []) {
    const all = w.MetingenLijst ?? [];
    // Keep a head slice plus any quality-code outliers (e.g. "99" gaps), so the
    // normaliser tests still see the cases that matter.
    const head = all.slice(0, 40);
    const seen = new Set(head);
    const odd = all.filter(
      (m) => m.WaarnemingMetadata?.Kwaliteitswaardecode !== '00' && !seen.has(m),
    ).slice(0, 10);
    w.MetingenLijst = [...head, ...odd];
    w._trimmed = { originalMetingen: all.length, kept: w.MetingenLijst.length };
  }
  await write('OphalenWaarnemingen.sample.json', d);
}

// --- OphalenAantalWaarnemingen: keep a few series ---------------------------
if (await exists('OphalenAantalWaarnemingen.sample.json')) {
  const d = await readJson('OphalenAantalWaarnemingen.sample.json');
  const all = d.AantalWaarnemingenPerPeriodeLijst ?? [];
  d.AantalWaarnemingenPerPeriodeLijst = all.slice(0, 3);
  d._trimmed = { originalSeries: all.length, kept: d.AantalWaarnemingenPerPeriodeLijst.length };
  await write('OphalenAantalWaarnemingen.sample.json', d);
}

// --- Catalogue: keep every code list, trim the huge cross-reference table ----
if (await exists('OphalenCatalogus.json')) {
  const d = await readJson('OphalenCatalogus.json');
  const locs = d.LocatieLijst ?? [];
  const metas = d.AquoMetadataLijst ?? [];
  const links = d.AquoMetadataLocatieLijst ?? [];
  d._trimmed = {
    originalLocaties: locs.length,
    originalMetadata: metas.length,
    originalLinks: links.length,
  };
  d.LocatieLijst = locs.slice(0, 25);
  d.AquoMetadataLijst = metas.slice(0, 25);
  d.AquoMetadataLocatieLijst = links.slice(0, 50);
  await write('OphalenCatalogus.json', d);
}

// --- WFS locaties GeoJSON: keep a handful of features -----------------------
if (await exists('wfs-locaties.geojson')) {
  const d = await readJson('wfs-locaties.geojson');
  const all = d.features ?? [];
  d.features = all.slice(0, 25);
  d._trimmed = { originalFeatures: all.length, kept: d.features.length };
  await write('wfs-locaties.geojson', d);
}

// --- WFS locatiesmetlaatstewaarneming CSV: header + first N rows ------------
if (await exists('wfs-locatiesmetlaatstewaarneming.csv')) {
  const rl = createInterface({
    input: createReadStream(join(IN, 'wfs-locatiesmetlaatstewaarneming.csv')),
    crlfDelay: Infinity,
  });
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length >= 501) break;
  }
  rl.close();
  await write('wfs-locatiesmetlaatstewaarneming.csv', `${lines.join('\n')}\n`);
}

console.log('Done.');
