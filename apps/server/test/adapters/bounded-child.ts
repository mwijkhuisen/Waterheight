// Child process of bounded.int.test.ts (review S1): builds one hostile body by name
// and parses it under the heap the test gives it (--max-old-space-size). It
// prints the SchemaDrift message (or the guard's reason) and exits 0; anything
// else exits 1, and running out of memory kills it.
import { SchemaDrift } from '@rws/core';
import { strToU8, zipSync } from 'fflate';
import { parseCube } from '../../src/adapters/ch-1/parse.ts';
import { JSON_CAPS as CH2_CAPS, parseFeatures } from '../../src/adapters/ch-2/parse.ts';
import { JSON_CAPS as CH3_CAPS, parsePlot } from '../../src/adapters/ch-3/parse.ts';
import { JSON_CAPS, parseMeasurements, parseStations } from '../../src/adapters/de-1/parse.ts';
import { HEADER as DE7_HEADER, MAX_ROWS as DE7_MAX_ROWS } from '../../src/adapters/de-7/parse.ts';
import {
  HYDRO_HEADER,
  parseStations as parseDe8Stations,
  parseHydro,
  STATIONS_HEADER,
} from '../../src/adapters/de-8/parse.ts';
import {
  JSON_CAPS as FR1_CAPS,
  parseObservations as parseFr1Observations,
  parseStations as parseFr1Stations,
} from '../../src/adapters/fr-1/parse.ts';
import { JSON_CAPS as FR3_CAPS, parseSerie } from '../../src/adapters/fr-3/parse.ts';
import { parseCsv as parseLu1 } from '../../src/adapters/lu-1/parse.ts';
import { JSON_CAPS as LU6_CAPS, parseFeatures as parseLu6 } from '../../src/adapters/lu-6/parse.ts';
import { JSON_CAPS as NL1_CAPS, parseWaarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { JSON_CAPS as NL2_CAPS, parseCollection } from '../../src/adapters/nl-2/parse.ts';
import { parse as parseNl4 } from '../../src/adapters/nl-4/parse.ts';
import { checkXmlText, GuardFailure } from '../../src/http/guards.ts';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';

const MIB = 1024 * 1024;
const station = (timeseries: string) =>
  `{"uuid":"00000000-0000-4000-8000-000000000000","number":"1","shortname":"X","longname":"X","agency":"X",` +
  `"water":{"shortname":"X","longname":"X"},"timeseries":[${timeseries}]}`;
const list = (n: number, item: string) => Array(n).fill(item).join(',');
/** One empty object per three bytes: the shape that costs JSON.parse the most per byte. */
const objects = (bytes: number) => `[${list(Math.floor(bytes / 3) - 1, '{}')}]`;
/** An `OphalenWaarnemingen` response with one well-formed list header and the given values. */
const coded = '{"Code":"x","Omschrijving":"x"}';
const aquo = [
  'BemonsteringsApparaat',
  'BemonsteringsMethode',
  'BemonsteringsSoort',
  'BioTaxon',
  'BioTaxonType',
  'Compartiment',
  'Eenheid',
  'Groepering',
  'Grootheid',
  'Hoedanigheid',
  'MeetApparaat',
  'Orgaan',
  'Parameter',
  'Typering',
  'WaardeBepalingsMethode',
  'WaardeBepalingsTechniek',
  'WaardeBewerkingsMethode',
]
  .map((k) => `"${k}":${coded}`)
  .join(',');
const waarnemingen = (values: string) =>
  `{"Succesvol":true,"WaarnemingenLijst":[{"AquoMetadata":{${aquo},"Parameter_Wat_Omschrijving":"x","ProcesType":"meting"},` +
  `"Locatie":{"Code":"x","Coordinatenstelsel":"x","Lat":1,"Lon":1,"Naam":"x","Omschrijving":"x"},"MetingenLijst":[${values}]}]}`;
/** A complete NL-2 FeatureCollection of `n` features (its three counts say `n`). */
const collection = (n: number, feature: string) =>
  `{"type":"FeatureCollection","features":[${list(n, feature)}],"totalFeatures":${n},"numberMatched":${n},` +
  `"numberReturned":${n},"timeStamp":"2026-09-29T13:43:29.024Z",` +
  `"crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::4258"}}}`;
/** A Hub'Eau page (FR-1) with the given `data` values. */
const hubeau = (data: string) =>
  `{"count":0,"first":null,"prev":null,"next":null,"api_version":"2.0.1","data":[${data}]}`;
/** A Vigicrues series (FR-3) with the given points. */
const serie = (points: string) =>
  `{"Serie":{"CdStationHydro":"A850061001","LbStationHydro":"x","Link":"x","GrdSerie":"Q","ObssHydro":[${points}]},"VersionFlux":"x"}`;
/** A hydrodaten feature collection (CH-2) with the given features. */
const features = (fs: string) =>
  `{"type":"FeatureCollection","name":"x","crs":{"type":"name","properties":{"name":"x"}},"meta":null,"features":[${fs}]}`;
/** A hydrodaten plot (CH-3) whose one trace has the given x and y arrays. */
const plot = (x: string, y: string) =>
  `{"plot":{"layout":null,"data":[{"name":"Wasserstand","x":[${x}],"y":[${y}],"meta":{"unit":"m"}}]},"hoverInfo":null}`;
const CSV_HEADER = 'id,name,water,time,q,w,t,dl,wkt';
/** A geoportail.lu station collection (LU-6) with the given features. */
const lu6 = (fs: string) =>
  `{"type":"FeatureCollection","features":[${fs}],"numberReturned":0,"numberMatched":0,"links":[],"timeStamp":"x"}`;
const basin = (b: Uint8Array) => parseStations(b, JSON_CAPS.basin);
const meta = (b: Uint8Array) => parseStations(b, JSON_CAPS.meta);

const SML = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/**
 * Review S1 of P2b: the reviewers' three one-tag attribute floods and one spread over many small tags, each a
 * worksheet under the 8 MB XLSX member cap, with the code the XML bounds end it in.
 */
export const XML_FLOODS: Record<string, [() => string, string]> = {
  'one-tag-700k-attributes': [
    () =>
      `<worksheet ${SML}><sheetData ${Array.from({ length: 700_000 }, (_, i) => `a${i}=""`).join(' ')}/></worksheet>`,
    'xml_tag_too_long',
  ],
  'one-tag-3m-equals': [
    () => `<worksheet ${SML}><sheetData><row ${'a='.repeat(3_000_000)}/></sheetData></worksheet>`,
    'xml_tag_too_long',
  ],
  'one-tag-1.5m-quoted': [
    () => `<worksheet ${SML}><sheetData><row ${"a='' ".repeat(1_500_000)}/></sheetData></worksheet>`,
    'xml_tag_too_long',
  ],
  'many-tags-10-attributes': [
    () =>
      `<worksheet ${SML}><sheetData>${'<c a="" b="" c="" d="" e="" f="" g="" h="" i="" j=""/>'.repeat(136_364)}</sheetData></worksheet>`,
    'xml_too_many_items',
  ],
  // Review round 2 of P2b: 1.5 M unclosed tags (a stack entry each in the validator), and one processing
  // instruction carrying 1.6 M attributes (the parser builds them, whatever it is told to ignore).
  'unclosed-1.5m-tags': [() => `<worksheet ${SML}>${'<abc>'.repeat(1_500_000)}`, 'xml_too_deep'],
  'one-instruction-1.6m-attributes': [
    () => `<?x >${' a=""'.repeat(1_600_000)}?><worksheet ${SML}/>`,
    'xml_tag_too_long',
  ],
};
/** The NL-4 parser with the flood as its ParameterLimits sheet: the workbook, relationships and strings are sound. */
const nl4 = (b: Uint8Array) =>
  parseNl4(
    new Map([
      [
        'xl/workbook.xml',
        `<workbook ${SML} xmlns:r="${REL}"><sheets><sheet name="ParameterLimits" r:id="rId1"/></sheets></workbook>`,
      ],
      [
        'xl/_rels/workbook.xml.rels',
        `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
      ],
      ['xl/sharedStrings.xml', `<sst ${SML}/>`],
      ['xl/worksheets/sheet1.xml', Buffer.from(b).toString('utf8')],
    ]),
  );
const xml = (b: Uint8Array) => checkXmlText(Buffer.from(b).toString('utf8'));

/** The loader's DE-7 path: the ZIP guard inflates the member into the strict line sink (async). */
const de7Load = (b: Uint8Array) =>
  LOAD_ADAPTERS['DE-7']?.specs['de-7-messwerte']?.run(b, {
    registry: new Map(),
    fetchedAt: Date.parse('2026-09-29T13:43:26Z'),
    variant: '',
    unitMismatch: new Set(),
  });
/** A messwerte.zip whose one member is `text` (level 6: the ratio must stay under the guard's 50:1). */
const de7Zip = (text: string) => zipSync({ 'messwerte.txt': [strToU8(text), { level: 6 }] });
/** `n` plausible rows (increasing times, scattered values), about 50 bytes each, as a real member has. */
const de7Rows = (n: number) => {
  const out: string[] = [DE7_HEADER];
  let x = 12_345;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    const t = new Date(Date.UTC(2026, 8, 22, 13, 45) + i * 60_000).toISOString().replace('Z', '+01:00');
    out.push(`2847500000100;${t};${(x % 20_000) / 100}`);
  }
  return out.join('\r\n');
};
/** Letters from a fixed xorshift generator: a ZIP member that does not compress (a line that never ends). */
const noise = (bytes: number) => {
  const a = new Uint8Array(bytes);
  let x = 2_463_534_242;
  for (let i = 0; i < bytes; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    a[i] = 97 + ((x >>> 0) % 26);
  }
  return a;
};

export const BODIES: Record<string, [() => string | Uint8Array, (b: Uint8Array) => unknown]> = {
  // The reviewer's two: 8 MiB of [0,0,…] as a series window; a basin body of 101 valid-looking stations, one
  // of which has a timeseries array of 2 M zeros (both inside the byte caps).
  'series-zeros': [() => `[${list(4 * MIB - 1, '0')}]`, parseMeasurements],
  'basin-2m': [
    () =>
      `[${list(100, station('{"shortname":"W","longname":"X","unit":"cm","equidistance":15}'))},${station(list(2_000_000, '0'))}]`,
    basin,
  ],
  // At each spec's byte cap (4, 8 and 16 MiB).
  'basin-bytes': [() => objects(4 * MIB), basin],
  'series-bytes': [() => objects(8 * MIB), parseMeasurements],
  'meta-bytes': [() => objects(16 * MIB), meta],
  // Just under each spec's node cap, the shape that yields the most issues: one station whose 60 timeseries
  // hold 200 characteristic values each, every one of the wrong shape (4 missing keys, and 14 wrong items in meta).
  'basin-issues': [() => `[${station(list(60, `{"characteristicValues":[${list(200, '{}')}]}`))}]`, basin],
  'meta-issues': [
    () => `[${station(list(60, `{"characteristicValues":[${list(200, `{"occurrences":[${list(14, '0')}]}`)}]}`))}]`,
    meta,
  ],
  'series-issues': [() => `[${list(60_000, '{}')}]`, parseMeasurements],
  // NL-1 at its loader byte cap (4 MiB); a response whose list array, and one whose value array, is as long as
  // the node cap allows; and a full-length value list in which every value has the wrong shape.
  'nl1-bytes': [() => objects(4 * MIB), parseWaarnemingen],
  'nl1-lists': [
    () => `{"Succesvol":true,"WaarnemingenLijst":[${list(NL1_CAPS.maxNodes - 10, '0')}]}`,
    parseWaarnemingen,
  ],
  'nl1-values': [() => waarnemingen(list(NL1_CAPS.maxNodes - 100, '0')), parseWaarnemingen],
  'nl1-issues': [() => waarnemingen(list(NL1_CAPS.maxValues, '{}')), parseWaarnemingen],
  // NL-2 at its loader byte cap (8 MiB); a collection whose feature array is as long as the node cap allows; and a
  // full-length feature array in which every feature has the wrong shape.
  'nl2-bytes': [() => objects(8 * MIB), parseCollection],
  'nl2-features': [() => collection(NL2_CAPS.maxNodes - 20, '0'), parseCollection],
  'nl2-issues': [() => collection(NL2_CAPS.maxFeatures, '{}'), parseCollection],
  // P5a. Each parser at its spec's byte cap (FR-1 observations 16 MiB, referentiel 8 MiB, FR-3 4 MiB, CH-1 and CH-2
  // 4 MiB, CH-3 8 MiB), and the shape that yields the most issues: a full-length array of wrong-shaped elements.
  'fr1-bytes': [() => objects(16 * MIB), parseFr1Observations],
  'fr1-ref-bytes': [() => objects(8 * MIB), parseFr1Stations],
  'fr1-nodes': [() => hubeau(list(FR1_CAPS.obs.maxNodes, '0')), parseFr1Observations],
  'fr1-issues': [() => hubeau(list(FR1_CAPS.obs.maxItems, '{}')), parseFr1Observations],
  'fr1-ref-issues': [() => hubeau(list(FR1_CAPS.ref.maxItems, '{}')), parseFr1Stations],
  'fr3-bytes': [() => objects(4 * MIB), parseSerie],
  'fr3-nodes': [() => serie(list(FR3_CAPS.maxNodes, '0')), parseSerie],
  'fr3-issues': [() => serie(list(30_000, '0')), parseSerie],
  // A CSV has no JSON node count: rows, columns and fields are capped by the scan instead.
  'ch1-rows': [() => `${CSV_HEADER}\n${'x\n'.repeat(2 * MIB)}`, parseCube],
  'ch1-columns': [() => `${','.repeat(2 * MIB)}\n`, parseCube],
  'ch1-quote': [() => `${CSV_HEADER}\n"${'x'.repeat(4 * MIB)}`, parseCube],
  'ch1-issues': [() => `${CSV_HEADER}\n${Array(2000).fill(',,,,,,,,').join('\n')}\n`, parseCube],
  'ch2-bytes': [() => objects(4 * MIB), parseFeatures],
  'ch2-features': [() => features(list(CH2_CAPS.maxItems + 1, '0')), parseFeatures],
  'ch2-issues': [() => features(list(CH2_CAPS.maxItems, '{}')), parseFeatures],
  'ch3-bytes': [() => objects(8 * MIB), parsePlot],
  'ch3-nodes': [() => plot(list(CH3_CAPS.maxNodes, '"x"'), '0'), parsePlot],
  'ch3-issues': [() => plot(list(20_000, '0'), list(20_000, '0')), parsePlot],
  // P5b. DE-7 through the loader's own path (ZIP guard, line sink): a member of one row more than the cap, and a
  // member whose one line never ends (the splitter cuts it at 1 KB). LU-1 and DE-8 at their CSV caps, LU-6 as JSON.
  'de7-rows': [() => de7Zip(de7Rows(DE7_MAX_ROWS['messwerte.txt'] + 1)), de7Load],
  'de7-line': [
    () =>
      zipSync({ 'messwerte.txt': [Buffer.concat([Buffer.from(`${DE7_HEADER}\r\n`), noise(4 * MIB)]), { level: 6 }] }),
    de7Load,
  ],
  'lu1-rows': [() => `Name,Number,Unit,"25.09.2026 13:00"\n${'x\n'.repeat(2 * MIB)}`, parseLu1],
  'lu1-columns': [() => `${','.repeat(2 * MIB)}\n`, parseLu1],
  'lu1-quote': [() => `Name,Number,Unit,"25.09.2026 13:00"\n"${'x'.repeat(4 * MIB)}`, parseLu1],
  'lu1-issues': [() => `Name,Number,Unit,"25.09.2026 13:00"\n${Array(100).fill('"",,,,').join('\n')}\n`, parseLu1],
  'de8-stations-rows': [() => `${STATIONS_HEADER}\n${'x\n'.repeat(2 * MIB)}`, parseDe8Stations],
  'de8-stations-columns': [() => `${';'.repeat(2 * MIB)}\n`, parseDe8Stations],
  'de8-hydro-rows': [() => `${HYDRO_HEADER}\n${'x\n'.repeat(2 * MIB)}`, parseHydro],
  'de8-hydro-quote': [() => `${HYDRO_HEADER}\n"${'x'.repeat(4 * MIB)}`, parseHydro],
  'lu6-bytes': [() => objects(2 * MIB), parseLu6],
  'lu6-features': [() => lu6(list(LU6_CAPS.maxItems + 1, '0')), parseLu6],
  'lu6-issues': [() => lu6(list(LU6_CAPS.maxItems, '{}')), parseLu6],
  // The XML floods through the NL-4 parser and through the guard's XML rule (capture validity, readXlsx).
  ...Object.fromEntries(
    Object.entries(XML_FLOODS).flatMap(([name, [build]]) => [
      [`nl4-${name}`, [build, nl4]],
      [`xml-${name}`, [build, xml]],
    ]),
  ),
};

if (import.meta.main) {
  const [build, parse] = BODIES[process.argv[2] ?? ''] ?? [];
  if (build === undefined || parse === undefined) process.exit(64);
  try {
    const made = build();
    await parse(typeof made === 'string' ? Buffer.from(made) : made);
    console.log('parsed');
    process.exit(1);
  } catch (err) {
    const known = err instanceof SchemaDrift || err instanceof GuardFailure;
    console.log(err instanceof SchemaDrift ? err.message : err instanceof GuardFailure ? err.reason : 'other');
    process.exit(known ? 0 : 1);
  }
}
