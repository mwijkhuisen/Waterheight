// Generates registry/vigicrues-sections.yaml (the Vigicrues station → river section table, FR-5, catalogue §2.5, C38)
// from the TronEntVigiCru documents of the production archive and our FR-1 registry. Two forms:
//
//   node scripts/gen-fr5-sections.ts --extract <export dir>   derive registry/seed/fr-5-sections.csv
//   node scripts/gen-fr5-sections.ts [--check]                rebuild registry/vigicrues-sections.yaml (byte for byte)
//
// `--extract` reads the owner's archive export (Action D2: `fr-5-sections-<n>.raw` with its `.line.json`): the three
// territory documents (2, 3 and 29: the sections each lists) and one TronEntVigiCru document per section (the
// stations, `aNMoinsUn`, type 7). It writes one CSV row per link (section, territory, Vigicrues station code),
// sorted, with the provenance (the sha256 of each document) in the header. The default form needs only committed
// inputs: that CSV and registry/stations/fr-1.yaml, so CI can regenerate and diff it. `--check` diffs and exits 1.
//
// station = our FR-1 station id when FR-1 registers a primary stage series (H) of that Sandre code for the public
// site, else null (a Vigicrues station we do not register, or one that is withheld). `none` = our public FR-1
// stations on the French Escaut, Scarpe or Deûle: those rivers have no Vigicrues section (the ones at Valenciennes
// and Lille are not on the national map's sections), so no section level reaches them.
//
// Fails loudly on anything it does not know: a document that is not the expected type, a section the territory
// documents list without a document (or the reverse), a section whose own territory disagrees with the list that
// names it, a station in two sections, a `none` station that a section links.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseTron } from '../apps/server/src/adapters/fr-5/parse.ts';
import { VigicruesSectionsFile } from '../packages/contracts/src/tables.ts';

const root = join(import.meta.dirname, '..');
export const CSV = join(root, 'registry/seed/fr-5-sections.csv');
export const FR1 = join(root, 'registry/stations/fr-1.yaml');
export const OUTPUT = join(root, 'registry/vigicrues-sections.yaml');

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type Link = { section: string; territory: string; station: string };

/** The French rivers whose stations no Vigicrues section covers (catalogue §2.5). */
export const NO_SECTION_WATER = /\b(Escaut|Scarpe|Deule|Deûle)\b/i;

// ---- --extract -------------------------------------------------------------------------------------------------

export function extract(dir: string): string {
  const names = readdirSync(dir)
    .filter((n) => /^fr-5-sections-\d+\.raw$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const listed = new Map<string, string>(); // section → territory that lists it
  const own = new Map<string, { territory: string | null; stations: string[] }>();
  const files: string[] = [];
  const fetched: string[] = [];
  for (const name of names) {
    const body = readFileSync(join(dir, name));
    const line = JSON.parse(readFileSync(join(dir, name.replace(/\.raw$/, '.line.json')), 'utf8')) as {
      fetched_at: { start: string };
      sha256: string;
    };
    if (line.sha256 !== sha256(body)) throw new Error(`${name}: sha256 differs from its manifest line`);
    files.push(`${name} ${line.sha256}`);
    fetched.push(line.fetched_at.start);
    const doc = parseTron(body);
    if (doc.kind === 'territory') {
      for (const s of doc.sections) {
        if (listed.has(s)) throw new Error(`section ${s} listed by two territories`);
        listed.set(s, doc.code);
      }
    } else {
      if (own.has(doc.code)) throw new Error(`section ${doc.code} twice`);
      own.set(doc.code, { territory: doc.territory, stations: doc.stations });
    }
  }
  const territories = new Set(listed.values());
  for (const t of ['2', '3', '29'])
    if (!territories.has(t)) throw new Error(`the territory document of ${t} is missing`);
  for (const s of listed.keys()) if (!own.has(s)) throw new Error(`section ${s} is listed and has no document`);
  const links: Link[] = [];
  const owner = new Map<string, string>();
  for (const [section, d] of own) {
    const territory = listed.get(section);
    if (territory === undefined) throw new Error(`section ${section} has a document and no territory lists it`);
    if (d.territory !== territory)
      throw new Error(`section ${section}: its territory differs from the list that names it`);
    for (const station of d.stations) {
      const other = owner.get(station);
      if (other !== undefined) throw new Error(`station ${station} is in two sections (${other}, ${section})`);
      owner.set(station, section);
      links.push({ section, territory, station });
    }
  }
  links.sort((a, b) => byCode(a.section, b.section) || byCode(a.station, b.station));
  const sorted = fetched.sort();
  return [
    `# derived by scripts/gen-fr5-sections.ts --extract from the FR-5 archive export (${names.length} documents: the territories`,
    `#   ${[...territories].sort(byCode).join(', ')} and ${own.size} TronEntVigiCru sections), fetched ${sorted[0]} .. ${sorted[sorted.length - 1]},`,
    `#   sha256 of the documents' sorted "<name> <sha256>" lines ${sha256(files.sort(byCode).join('\n'))}`,
    ...files.sort(byCode).map((f) => `#   ${f}`),
    'section,territory,station',
    ...links.map((l) => `${l.section},${l.territory},${l.station}`),
    '',
  ].join('\n');
}

// ---- the default form ----------------------------------------------------------------------------------------------

export function readCsv(text: string): Link[] {
  const lines = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  if (lines[0] !== 'section,territory,station') throw new Error('fr-5-sections.csv: unexpected header');
  return lines.slice(1).map((l) => {
    const [section, territory, station, ...rest] = l.split(',');
    if (!section || !territory || !station || rest.length > 0) throw new Error(`fr-5-sections.csv: bad row ${l}`);
    return { section, territory, station };
  });
}

type Fr1Row = {
  id: string;
  provider_code: string;
  water_name: string | null;
  role: string;
  audience: string;
  quantity: string;
};

export function build(csvText: string, fr1Text: string): string {
  const links = readCsv(csvText);
  const fr1 = (parse(fr1Text) as { stations: Fr1Row[] }).stations;
  const primary = fr1.filter((r) => r.role === 'primary' && r.quantity === 'H' && r.audience === 'public');
  const idOf = new Map(primary.map((r) => [r.provider_code, r.id]));
  const seen = new Set<string>();
  for (const l of links) {
    if (seen.has(l.station)) throw new Error(`station ${l.station} is in two sections`);
    seen.add(l.station);
  }
  const sections = [...new Set(links.map((l) => l.section))].sort(byCode).map((section) => {
    const rows = links.filter((l) => l.section === section);
    const territory = new Set(rows.map((r) => r.territory));
    if (territory.size !== 1) throw new Error(`section ${section}: more than one territory`);
    return {
      section,
      territory: [...territory][0] as string,
      stations: rows
        .map((r) => ({ vigicrues: r.station, station: idOf.get(r.station) ?? null }))
        .sort((a, b) => byCode(a.vigicrues, b.vigicrues)),
    };
  });
  const none = [...new Set(primary.filter((r) => NO_SECTION_WATER.test(r.water_name ?? '')).map((r) => r.id))].sort(
    byCode,
  );
  const covered = new Set(sections.flatMap((s) => s.stations.flatMap((m) => (m.station === null ? [] : [m.station]))));
  for (const id of none)
    if (covered.has(id)) throw new Error(`${id} is on the Escaut, Scarpe or Deûle and in a section`);
  const file = VigicruesSectionsFile.parse({ sections, none });
  const linked = file.sections.flatMap((s) => s.stations).length;
  const registered = file.sections.flatMap((s) => s.stations).filter((m) => m.station !== null).length;
  return [
    '# Vigicrues station → river section table (FR-5, catalogue §2.5, C38): one row per TronEntVigiCru section.',
    '# GENERATED by scripts/gen-fr5-sections.ts from the inputs below. Do not edit by hand: change the generator (or an',
    '# input) and run `node scripts/gen-fr5-sections.ts`; registry/seed/fr-5-sections.csv comes from the archive export',
    '# through `node scripts/gen-fr5-sections.ts --extract <export dir>`. Reviewed corrections go in',
    '# registry/vigicrues-overrides.yaml, never here.',
    `#   registry/seed/fr-5-sections.csv  sha256 ${sha256(csvText)}`,
    `#   registry/stations/fr-1.yaml  sha256 ${sha256(fr1Text)}`,
    `# ${file.sections.length} sections of the territories 2, 3 and 29, ${linked} Vigicrues stations, of which ${registered} are FR-1 primary stage series of the public site (station) and ${linked - registered} are not (null).`,
    '# none: our public FR-1 stations on the French Escaut, Scarpe or Deûle, which no section covers.',
    stringify(file, { version: '1.1', lineWidth: 0 }),
  ].join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--extract');
  if (at >= 0) {
    const dir = args[at + 1];
    if (dir === undefined) {
      console.error('usage: gen-fr5-sections.ts --extract <export dir> | [--check]');
      process.exit(64);
    }
    writeFileSync(CSV, extract(dir));
  } else {
    const text = build(readFileSync(CSV, 'utf8'), readFileSync(FR1, 'utf8'));
    if (args.includes('--check')) {
      if (readFileSync(OUTPUT, 'utf8') !== text) {
        console.error('registry/vigicrues-sections.yaml differs from the generator output');
        process.exit(1);
      }
    } else writeFileSync(OUTPUT, text);
  }
}
