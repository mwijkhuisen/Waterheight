// The synthetic Vigicrues map of the flood drill (P12a, issue #27): fr-5-vigilance-level4.synthetic. The Wayback capture of
// the December 2023 floods (fr-5-vigilance-wayback) has the levels 2 and 3 but only south-west France: none of its 37
// sections is one of the 56 of registry/vigicrues-sections.yaml, so the loader refuses it as a whole map
// (`too_few_areas`, adapters/fr-5/normalise.ts). This derives a map the loader accepts and the drill can watch: the 56
// sections of the recorded archive map (real geometries and keys, fr-5-vigilance-archive, all at level 1) in the
// Wayback capture's spelling of the property names (`LbEntCru`, `TypEnSup_1`, ...), without the map's own time (the
// 2023 body was cut before `DtHrInfoVigiCru`, so a capture is dated by its fetch), with five sections raised: two to
// level 2 (jaune), two to 3 (orange) and one to 4 (rouge, a level no recording has). Pure and deterministic:
//   node scripts/lib/shift-fr5.ts            writes apps/server/src/adapters/fr-5/fixtures/fr-5-vigilance-level4.synthetic.raw
// (the test of the drill checks that the committed file is exactly this function's output).

import { readFileSync, writeFileSync } from 'node:fs';

/** The sections raised above level 1, with the stations the table puts in them (registry/vigicrues-sections.yaml). */
export const RAISED: Readonly<Record<string, number>> = { SA16: 2, LO13: 2, LO10: 3, LO24: 3, LO19: 4 };

/** The archive map's lower-case property names (2026) and the Wayback spelling (2023) of the ones that differ. */
const OLD_CASE: Readonly<Record<string, string>> = {
  typentcru: 'TypEntCru',
  lbentcru: 'LbEntCru',
  acroentcru: 'AcroEntCru',
  cddient_1: 'CdDiEnt_1',
  dhcentcru: 'DhCEntCru',
  dhmentcru: 'DhMEntCru',
  stentcru: 'StEntCru',
  typensup_1: 'TypEnSup_1',
  cdint: 'CdInt',
};
/** The property order of a Wayback feature. */
const ORDER = [
  'id',
  'CdEntCru',
  'TypEntCru',
  'LbEntCru',
  'AcroEntCru',
  'CdDiEnt_1',
  'DhCEntCru',
  'DhMEntCru',
  'StEntCru',
  'CdTCC',
  'cdensup_1',
  'TypEnSup_1',
  'CdInt',
  'NivInfViCr',
] as const;

type Feature = { type: string; properties: Record<string, unknown>; geometry: unknown };
type Collection = { type: string; name?: string; bbox?: number[]; features: Feature[] };

export function deriveLevel4(archive: Uint8Array): Buffer {
  const doc = JSON.parse(Buffer.from(archive).toString('utf8')) as Collection;
  const seen = new Set<string>();
  const features = doc.features.map((f) => {
    const p = Object.fromEntries(Object.entries(f.properties).map(([k, v]) => [OLD_CASE[k] ?? k, v]));
    const code = p.CdEntCru as string;
    seen.add(code);
    const raised = RAISED[code];
    // The Wayback capture states `id` as a number; the 2026 map as a string.
    const props: Record<string, unknown> = { ...p, id: Number(p.id), NivInfViCr: raised ?? p.NivInfViCr };
    return {
      type: 'Feature',
      properties: Object.fromEntries(ORDER.map((k) => [k, props[k]])),
      geometry: f.geometry,
      id: null,
    };
  });
  for (const code of Object.keys(RAISED)) if (!seen.has(code)) throw new Error(`section ${code} is not in the map`);
  return Buffer.from(
    `${JSON.stringify({ type: 'FeatureCollection', name: 'InfoVigiCru', bbox: doc.bbox, features })}\n`,
  );
}

if (import.meta.main) {
  const dir = new URL('../../apps/server/src/adapters/fr-5/fixtures/', import.meta.url);
  const out = deriveLevel4(readFileSync(new URL('fr-5-vigilance-archive.raw', dir)));
  writeFileSync(new URL('fr-5-vigilance-level4.synthetic.raw', dir), out);
  console.log(`fr-5-vigilance-level4.synthetic.raw: ${out.length} bytes`);
}
