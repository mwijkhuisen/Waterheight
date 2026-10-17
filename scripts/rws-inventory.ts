// Generates the Rijkswaterstaat inventory block of docs/sources/SOURCE-CATALOGUE.md §2.1 (P15, issue #63):
// the live RWS locations by water type, with their live H and Q series and the forecast, astronomical and
// high- and low-water series the catalogue lists for them. Inputs are two untrimmed recordings, read as data:
// the full NL-1 catalogue (`OphalenCatalogus`) and an NL-2 WFS snapshot. The water type of a location is
// curated in TABLE below: RWS metadata cannot tell a river from a tidal or lake gauge (catalogue §2.1).
//
//   node scripts/rws-inventory.ts [--check] [repo-root]   (--check diffs and exits 1; usage errors exit 64)
//
// The block sits between the markers `<!-- rws-inventory:begin -->` and `<!-- rws-inventory:end -->`, which
// must each appear exactly once; the script never inserts them. Deterministic: no clock, sorted output, and
// the fixtures named with a 12-character sha256 prefix. Fails, naming the code, on a live location without a
// TABLE row, a TABLE row that is not live, a structure-internal row without a reason, a reason on another
// type, and an unknown GETET* grouping.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CATALOGUE = 'apps/server/src/adapters/nl-1/fixtures/nl-1-catalogue-full.raw';
export const WFS = 'apps/server/src/adapters/nl-2/fixtures/nl-2-wfs-20261016.raw';
export const DOC = 'docs/sources/SOURCE-CATALOGUE.md';
export const BEGIN = '<!-- rws-inventory:begin -->';
export const END = '<!-- rws-inventory:end -->';

/** The eight water types, in output order. */
export const TYPES = {
  lake: 'Lake and closed estuary',
  coast: 'Coast and Wadden Sea',
  scheldt: 'Scheldt estuaries',
  delta: 'Tidal delta',
  river: 'River',
  canal: 'Canal and regulated water',
  offshore: 'Offshore (MSL)',
  structure: 'Structure-internal',
} as const;
export type WaterType = keyof typeof TYPES;
/** Why a structure-internal location is never shown (D24 default; catalogue §2.1 WFS pitfall 5). */
export const REASONS = ['lock chamber', 'gate slot', 'pumping station', 'pannerden.regelwerk.*'] as const;
export type Reason = (typeof REASONS)[number];
export type Row = { type: WaterType; reason?: Reason };

/**
 * Every GETET* grouping of the full catalogue (§2.1 "Aquo combinations"): what its WATHTE series is.
 * GETETOZBRKD2 ("Getijextreem opzet berekend") is a computed surge at the extremes, not a high or low water
 * level, so it is counted nowhere. Each kind has one ProcesType; another is a failure.
 */
export const GROUPINGS: Readonly<Record<string, 'measured' | 'astronomical' | null>> = {
  GETETM2: 'measured',
  GETETMSL2: 'measured',
  GETETBRKD2: 'astronomical',
  GETETBRKDMSL2: 'astronomical',
  GETETOZBRKD2: null,
};
const PROCES = { measured: 'meting', astronomical: 'astronomisch' } as const;

const lake: Row = { type: 'lake' };
const coast: Row = { type: 'coast' };
const scheldt: Row = { type: 'scheldt' };
const delta: Row = { type: 'delta' };
const river: Row = { type: 'river' };
const canal: Row = { type: 'canal' };
const offshore: Row = { type: 'offshore' };
const lock: Row = { type: 'structure', reason: 'lock chamber' };
const gate: Row = { type: 'structure', reason: 'gate slot' };
const pump: Row = { type: 'structure', reason: 'pumping station' };
const regelwerk: Row = { type: 'structure', reason: 'pannerden.regelwerk.*' };

/**
 * Live location code -> water type, curated from the name, the position, catalogue §2.1 and issues #64/#65.
 * A gauge on one side of a lock or a pumping station takes the type of the water it measures; only a lock
 * chamber (`kolk`), a gate slot (`schuif`, `gat`, a flap), a single pump of a pumping station and
 * `pannerden.regelwerk.*` are structure-internal. Fixture text is data.
 */
export const TABLE: Readonly<Record<string, Row>> = {
  // Offshore platforms: every live series is cm MSL.
  a12: offshore,
  amelandwestgat: offshore,
  borsselealpha: offshore,
  d15: offshore,
  europlatform: offshore,
  f3: offshore,
  'goeree.lichteiland': offshore,
  'hollandsekust.noord.alpha': offshore,
  'hollandsekust.zuid.alpha': offshore,
  j6: offshore,
  k14: offshore,
  l9: offshore,

  // Coast and Wadden Sea, with the Eems-Dollard and the outer harbours on the North Sea.
  'ameland.nes': coast,
  'brouwershavensche.gat.08': coast,
  'cadzand.1': coast,
  'dantziggat.pietscheveplaat.zuid': coast,
  delfzijl: coast,
  'denhelder.marsdiep': coast,
  'denhelder.veersteiger': coast,
  'denoever.waddenzee.voorhaven': coast,
  'eemshaven.waddenzee': coast,
  // Seaward of the Haringvliet sluices, which #65 makes the Haringvliet's mouth into the Noordzee.
  'haringvliet.10': coast,
  'harlingen.waddenzee': coast,
  hoekvanholland: coast,
  'holwerd.vaargeul': coast,
  huibertgat: coast,
  'ijgeul.1': coast,
  'ijmuiden.buitenhaven': coast,
  'ijmuiden.noordersluis.west': coast,
  'kornwerderzand.waddenzee.buitenhaven': coast,
  'lauwersoog.waddenzee': coast,
  // The Maasvlakte basins open onto the Maasmond, seaward of the Nieuwe Waterweg.
  'maasvlakte.amaliahaven': coast,
  'maasvlakte.europahaven': coast,
  'maasvlakte.hartelhaven': coast,
  'nieuwestatenzijl.dollard': coast,
  scheveningen: coast,
  'schiermonnikoog.waddenzee': coast,
  'stellendam.buitenhaven': coast,
  'terschelling.noordzee': coast,
  'terschelling.west': coast,
  'texel.noordzee': coast,
  'texel.oudeschild': coast,
  'vlieland.haven': coast,
  vlaktevanderaan: coast,
  westkapelle: coast,
  wierumergronden: coast,

  // Scheldt estuaries: the Westerschelde (with the Zeeschelde at Antwerpen) and the Oosterschelde. The
  // `oosterschelde.*` posts and both sides of the Roompotsluis are typed by their name.
  antwerpen: scheldt,
  borssele: scheldt,
  'breskens.handelshaven': scheldt,
  'bruinisse.krammersluis.oosterschelde.2': scheldt,
  hansweert: scheldt,
  'kloosterzande.baalhoek': scheldt,
  marollegat: scheldt,
  'oosterschelde.14': scheldt,
  'oosterschelde.4': scheldt,
  'oosterschelde.roompotsluis.binnen': scheldt,
  'oosterschelde.roompotsluis.buiten': scheldt,
  ossenisse: scheldt,
  'rilland.bath': scheldt,
  'rilland.bathsespuisluis.buiten': scheldt,
  schaarvandenoord: scheldt,
  'sintannaland.oosterschelde': scheldt,
  stavenisse: scheldt,
  terneuzen: scheldt,
  'terneuzen.westsluis.buiten': scheldt,
  'tholen.bergsediepsluis.buiten': scheldt,
  vlissingen: scheldt,
  walsoorden: scheldt,
  yerseke: scheldt,

  // Tidal delta: #65's lower-delta channels and the Rotterdam port waters on them. #61 lists Haringvliet and
  // Hollandsch Diep among the lakes and D31 among the tidal delta; we follow #65 (P17), which makes both
  // delta channels of the declared tidal zone (the Haringvliet also gets a water body), so hellevoetsluis,
  // willemstad.hollandschdiep and moerdijk are tidal delta. The Lek below Hagestein is tidal too, but #65
  // does not list it, so its gauges stay river.
  'botlek.geulhaven': delta,
  'dordrecht.oudemaas.benedenmerwede': delta,
  'europoort.harmsenbrug': delta,
  'europoort.hartelbrug': delta,
  'gouda.hollandscheijssel': delta,
  'hank.bergschemaas': delta,
  heesbeen: delta,
  'heinenoord.goidschalxoord': delta,
  hellevoetsluis: delta,
  'krimpenaandeijssel.hollandscheijssel': delta,
  maassluis: delta,
  moerdijk: delta,
  parksluis: delta,
  'rotterdam.ijzerwerkerkade': delta,
  'rotterdam.nieuwemaas.boerengat': delta,
  'rozenburgsesluis.noordzijde': delta,
  'rozenburgsesluis.zuidzijde': delta,
  'spijkenisse.oudemaas': delta,
  'suurhofbrug.noordzijde': delta,
  vlaardingen: delta,
  // On the Bergsche Maas, north of the town.
  waalwijk: delta,
  'werkendam.binnenkievitswaard': delta,
  'werkendam.happenhennip': delta,
  'werkendam.kleinezalm': delta,
  'werkendam.kooike': delta,
  'werkendam.middelstekievitswaard': delta,
  'werkendam.nieuwemerwede': delta,
  'werkendam.steenenmuur': delta,
  'werkendam.steurgat': delta,
  'werkendam.vogelenzang': delta,
  'willemstad.hollandschdiep': delta,
  'zuidland.spui': delta,

  // Lakes and closed estuaries: IJsselmeer, Markermeer, Ketelmeer, Zwarte Meer, the Randmeren, Eemmeer,
  // Volkerak-Zoommeer, Grevelingen and Veerse Meer.
  'almere.hollandsebrug': lake,
  // The Buiten-IJ, east of the Oranjesluizen: Markermeer level.
  'amsterdam.schellingwouderbrug': lake,
  'arnemuiden.oranjeplaat': lake,
  bommenede: lake,
  'denoever.ijsselmeer.binnenhaven': lake,
  'dinteloord.volkerak': lake,
  'dronten.reevesluis.drontermeer': lake,
  'dronten.reevesluis.vossemeer': lake,
  edam: lake,
  // The Eem's mouth into the Eemmeer.
  eemdijk: lake,
  'elburg.elburgerbrug': lake,
  'kadoelen.zwanediep': lake,
  'kamperland.schotsman': lake,
  // The Zandkreekdam's exchange between the Veerse Meer and the Oosterschelde.
  'kats.zandkreekdam': lake,
  'ketelhaven.ketelmeer': lake,
  'kornwerderzand.ijsselmeer.binnenhaven': lake,
  'krabbersgat.ijsselmeer': lake,
  'krabbersgat.markermeer': lake,
  'lelystad.houtribsluis.noord': lake,
  'lelystad.houtribsluis.zuid': lake,
  'lemmer.ijsselmeer': lake,
  'lemmer.ijsselmeer.woudagemaal': lake,
  'markermeer.midden': lake,
  'markermeer.trintelzand': lake,
  nieuwvossemeer: lake,
  'nijkerk.nijkerkernauw': lake,
  'nijkerk.nuldernauw': lake,
  'ramspolbrug.ramsdiep': lake,
  'ramspolkering.ketelmeer': lake,
  'rotterdamsehoek.ijsselmeer': lake,
  // The IJsselmeer side of the Hoogland pumping station.
  'stavoren.gemaalhoogland.buiten': lake,
  'swifterbant.ketelmeer': lake,
  'willemstad.volkerak': lake,

  // Rivers: Rhine branches, IJssel, Zwarte Water, Vecht, Meuse (with the Belgian border points), Geul.
  'amerongen.beneden': river,
  'amerongen.boven': river,
  'belfeld.boven': river,
  buggenum: river,
  culemborg: river,
  dalem: river,
  'dalfsen.vechterweerd': river,
  desteeg: river,
  deventer: river,
  dodewaard: river,
  'doesburg.ijssel': river,
  'driel.beneden': river,
  'driel.boven': river,
  'eijsden.grens': river,
  'eisdenmazenhove.maas': river,
  'eisdenmazenhove.maesbempdergreend': river,
  'elsloo.maas': river,
  'epen.geul.cottessen': river,
  genemuiden: river,
  gennep: river,
  'grave.beneden': river,
  'grave.boven': river,
  'hagestein.beneden': river,
  'hagestein.boven': river,
  'hasselt.zwartewater': river,
  'heel.maas': river,
  herenlaak: river,
  'holtheme.vecht': river,
  'huissen.nederrijn': river,
  // The IJssel's outflow channel into the Ketelmeer.
  'kampen.keteldiep': river,
  'kampen.ijssel': river,
  'krimpenaandelek.lek': river,
  lanaken: river,
  'linne.stuw.beneden': river,
  'lith.beneden': river,
  'lith.boven': river,
  'lith.sluis': river,
  lixhebiefaval: river,
  'lobith.bovenrijn.haven': river,
  'lobith.bovenrijn.tolkamer': river,
  maaseik: river,
  'maastricht.borgharen.maas.beneden': river,
  'maastricht.sintpieter': river,
  'maastricht.sintpieter.zuid': river,
  meeswijk: river,
  'megen.maas': river,
  millingenaanderijn: river,
  'millingenaanderijn.pannerdensekop': river,
  mook: river,
  neer: river,
  'negenoord.oost': river,
  'negenoord.west': river,
  'nijmegen.waal': river,
  olst: river,
  'ommen.vecht': river,
  'pannerden.pannerdenschkanaal': river,
  'rhenen.grebbeberg': river,
  'roermond.boven': river,
  'roermond.hambeek': river,
  rotem: river,
  'sambeek.beneden': river,
  'sambeek.boven': river,
  schoonhoven: river,
  // Crèvecoeur, where the Dieze meets the Maas: the Maas side.
  'shertogenbosch.crevecoeur': river,
  'shertogenbosch.empel.maas': river,
  'shertogenbosch.engelen': river,
  spaanjerd: river,
  stevensweert: river,
  steyl: river,
  'tiel.waal': river,
  uikhoven: river,
  venlo: river,
  well: river,
  'westervoort.1': river,
  'westervoort.2': river,
  'westervoort.hondsbroekschepleij.ijssel': river,
  'westervoort.ijsselkop': river,
  wijhe: river,
  zaltbommel: river,
  'zutphen.ijssel': river,
  'zwartsluis.zwartewater': river,
  'zwolle.ijssel': river,
  // The Mark at Breda, regulated by the Marksluis.
  breda: river,

  // Canals and regulated water: the Groningen and Frisian canals and boezem, Twentekanaal, Overijssel canals,
  // Noordzeekanaal, Amsterdam-Rijnkanaal, Lekkanaal, Maas-Waalkanaal, Julianakanaal, the Brabant and Limburg
  // canals (Zuid-Willemsvaart, Wilhelminakanaal, Beatrixkanaal, Noordervaart, Kanaal Wessem-Nederweert) with
  // the intakes and outlets RWS measures on them, Schelde-Rijnkanaal and Kanaal Gent-Terneuzen.
  // The regulated Brabant brooks and weirs (blaarthem.dommel, aa.helmond, berlicum.schijndelseloop,
  // beekendonk.biezenloop, lieshout.donkersvoortseloop, sonenbreugel.beeksewaterloop, poeldonk.aa.uitlaat,
  // helmond.guldenaa*) are regulated brooks typed as canal and regulated water here; P17a decides their graph kind.
  'aa.helmond': canal,
  aadorp: canal,
  'aarlerixtel.goorloop.wilhelminakanaal': canal,
  'aarlerixtel.schabbert.beneden': canal,
  'aarlerixtel.schabbert.boven': canal,
  'aarlerixtel.schabbert.inlaat': canal,
  'aarlerixtel.schabbert.uitlaat': canal,
  almen: canal,
  'amsterdam.surinamekade': canal,
  'beekendonk.biezenloop': canal,
  'beekendonk.sluis6.beneden': canal,
  'beekendonk.sluis6.boven': canal,
  'beekendonk.sluis6.inlaat': canal,
  'beekendonk.sluis6.uitlaat': canal,
  'berlicum.schijndelseloop': canal,
  'blaarthem.dommel': canal,
  'borgsweer.verbindingskanaal': canal,
  buitenhuizen: canal,
  'bunde.kanaal': canal,
  'burgum.burgumerdaam.boezem': canal,
  'delden.sluis.beneden': canal,
  'delden.sluis.boven': canal,
  'delfzijl.oudeeemskanaal.spuisluis': canal,
  'dongen.kanaal': canal,
  'dorkwerd.reitdiep': canal,
  'echt.kanaal': canal,
  'eefde.sluis.beneden': canal,
  'eefde.sluis.boven': canal,
  eibersburen: canal,
  'eindhoven.blaarthem.kanaal': canal,
  'eindhoven.gender': canal,
  'erp.sluis5.beneden': canal,
  'erp.sluis5.boven': canal,
  'erp.sluis5.inlaat': canal,
  'erp.sluis5.uitlaat': canal,
  'grijpskerk.gaarkeuken.oost': canal,
  'grijpskerk.gaarkeuken.west': canal,
  groningen: canal,
  'haghorst.sluis4.beneden': canal,
  'haghorst.sluis4.boven': canal,
  'haghorst.sluis4.uitlaat': canal,
  'heel.kanaal': canal,
  'helmond.aflaat': canal,
  'helmond.aflaat.boven': canal,
  'helmond.devries': canal,
  'helmond.guldenaa': canal,
  'helmond.guldenaa.a': canal,
  'helmond.guldenaa.b': canal,
  'helmond.scheepstal': canal,
  'helmond.schotenseloop': canal,
  'helmond.sluis.aflaat1': canal,
  'helmond.sluis.boven': canal,
  'helmond.sluis7': canal,
  'helmond.sluis9.inlaat': canal,
  'helmond.sluis9.uitlaat': canal,
  'helmond.spaarpand': canal,
  'helmond.zuidwillemsvaart.inlaatnieuweaa': canal,
  'hengelo.koppelleiding': canal,
  'hengelo.sluis.beneden': canal,
  'hengelo.sluis.boven': canal,
  'ijmuiden.noordersluis.oost': canal,
  // The Reevediep side of the Scheeresluis.
  'kampen.scheeresluis.beneden': canal,
  // What kanne measures (Jeker/Geer or canal) is open (catalogue §10 R9); §3 lists it as a canal transfer.
  kanne: canal,
  'lemmer.stroomkanaal.teroelsterkolk': canal,
  'lemmer.woudagemaal.stroomkanaal': canal,
  'lieshout.donkersvoortseloop': canal,
  'lierop.sluis10.beneden': canal,
  'lierop.sluis10.boven': canal,
  'lierop.sluis9': canal,
  'lierop.sluis9.boven': canal,
  'maarssen.kanaal': canal,
  'malden.maaswaalkanaal.inlaatteersesluispolder': canal,
  'maastricht.borgharen.julianakanaal': canal,
  'maastricht.bosscherveld': canal,
  markelo: canal,
  'maurik.mauriksewetering': canal,
  'meijel.kanaal.beneden': canal,
  'meijel.kanaal.boven': canal,
  'meppel.hoofdvaart': canal,
  'mierlo.goorloop.gemaal': canal,
  'mierlo.goorloop.inlaat1': canal,
  'nederweert.sluis15.boven': canal,
  'nederweert.sluis15.voedingskanaal': canal,
  'nederweerteind.noordervaart': canal,
  'nieuwegein.doorslag': canal,
  'nieuwegein.lekkanaal': canal,
  'nijmegen.maaswaalkanaal.inlaatlandsweijer': canal,
  'nijmegen.maaswaalkanaal.inlaatweurt': canal,
  'ommen.ommerkanaal': canal,
  'oosterhout.marksluis.beneden': canal,
  'oosterhout.marksluis.boven': canal,
  'oosterhout.marksluis.inlaat': canal,
  'oosterhout.marksluis.uitlaat': canal,
  'oosterhout.sluis1.boven': canal,
  'oosterhout.sluis1.gemaal': canal,
  'oosterhout.sluis1.inlaat': canal,
  'oosterhout.sluis1.spui': canal,
  'oosterhout.sluis1.spuikanaal': canal,
  'oosterhout.sluis1.uitlaat': canal,
  'panheel.gemaal': canal,
  'panheel.sluis.boven': canal,
  'panheel.sluis.inlaat': canal,
  'panheel.sluis.uitlaat': canal,
  'poeldonk.aa.uitlaat': canal,
  'rijswijk.betuwepand': canal,
  'rijswijk.drielandenpunt': canal,
  'rilland.antwerpskanaalpand': canal,
  'rilland.bathsebrug': canal,
  'rilland.bathsespuisluis': canal,
  'rilland.bathsespuisluis.binnen': canal,
  'rosmalen.hintham.beneden': canal,
  'rosmalen.hinthamsluis.beneden': canal,
  'rosmalen.hinthamsluis.boven': canal,
  sasvangent: canal,
  schijndel: canal,
  'schijndel.sluis.beneden': canal,
  'schijndel.sluis.boven': canal,
  'schijndel.sluis.inlaat': canal,
  'schijndel.sluis.spuikanaal': canal,
  'shertogenbosch.empel.kanaal': canal,
  'shertogenbosch.engelen.dieze': canal,
  'shertogenbosch.poeldonk.aa': canal,
  'shertogenbosch.poeldonk.zuidwillemsvaart': canal,
  'slochtersluis.boven': canal,
  'smeermaas.zuidwillemsvaart': canal,
  'someren.sluis11.beneden': canal,
  'someren.sluis11.boven': canal,
  'someren.sluis12.beneden': canal,
  'someren.sluis12.boven': canal,
  'someren.sluis13': canal,
  'someren.sluis13.beneden': canal,
  'someren.sluis13.boven': canal,
  'sonenbreugel.beeksewaterloop': canal,
  'sonenbreugel.wilhelminakanaal': canal,
  'stavoren.johanfrisokanaal': canal,
  'terherne.beneden': canal,
  'terherne.boven': canal,
  'terneuzen.sluiskilbrug': canal,
  'tiel.sluis.kanaal': canal,
  'tilburg.sluis2.beneden': canal,
  'tilburg.sluis2.boven': canal,
  'tilburg.sluis3': canal,
  'tilburg.sluis3.beneden': canal,
  'tilburg.sluis3.boven': canal,
  'veghel.sluis4.beneden': canal,
  'veghel.sluis4.boven': canal,
  'veghel.sluis4.inlaat': canal,
  'veghel.sluis4.uitlaat': canal,
  'velsenzuid.velsertunnel': canal,
  'weert.lozen': canal,
  'weert.sluis16.beneden': canal,
  'weert.sluis16.boven': canal,
  'weesp.amsterdamrijnkanaal': canal,
  'wijkbijduurstede.amsterdamrijnkanaal': canal,
  'zwartsluis.meppelerdiep': canal,
  // The Zwolle-IJsselkanaal at the Spooldersluis, beside zwolle.ijssel.
  'zwolle.zwartewater.kanaal': canal,

  // Structure-internal: registered `off` with a reason, never shown (D24 default).
  'beekendonk.sluis6.kolk': lock,
  'haghorst.sluis4.kolk': lock,
  'kats.zandkreeksluis.kolk1': lock,
  'oosterhout.sluis1.kolk': lock,
  'schijndel.sluis.kolk': lock,
  'tilburg.sluis3.kolk': lock,
  'brouwersdam.spui.binnen.schuif6': gate,
  'brouwersdam.spui.buiten.schuif2': gate,
  'haghorst.sluis4.schuif': gate,
  'haghorst.sluis4.schuif1': gate,
  // The right flap of the spillway channel of sluis 1.
  'oosterhout.sluis1.spuikanaal.kleprechts': gate,
  'willemstad.volkeraksluizen.schuif2': gate,
  'willemstad.volkeraksluizen.schuif3': gate,
  'zwartsluis.gemaal.pomp1': pump,
  'zwartsluis.gemaal.pomp2': pump,
  'zwartsluis.gemaal.pomp3': pump,
  'pannerden.regelwerk.beneden': regelwerk,
  'pannerden.regelwerk.boven': regelwerk,
};

type Obj = Record<string, unknown>;
function obj(v: unknown, at: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at}: expected an object`);
  return v as Obj;
}
function arr(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${at}: expected an array`);
  return v;
}
function str(v: unknown, at: string, empty = false): string {
  if (typeof v !== 'string' || (v === '' && !empty)) throw new Error(`${at}: expected a string`);
  return v;
}
function int(v: unknown, at: string): number {
  if (!Number.isSafeInteger(v)) throw new Error(`${at}: expected an integer`);
  return v as number;
}
const code = (v: unknown, at: string) => str(obj(v, at).Code, `${at}.Code`, true);

/** Series counts of one water type. */
export type Counts = {
  locations: number;
  h: number;
  q: number;
  forecast: number;
  astronomical: number;
  hwlwMeasured: number;
  hwlwAstronomical: number;
};
const COLUMNS = ['locations', 'h', 'q', 'forecast', 'astronomical', 'hwlwMeasured', 'hwlwAstronomical'] as const;
export type Inventory = { counts: Record<WaterType, Counts>; structure: [string, Reason][] };

type Kind = 'forecast' | 'astronomical' | 'hwlwMeasured' | 'hwlwAstronomical';
/** One catalogue (location, AquoMetadata) link of a live location: what P16a's tide seed is made of. */
export type Combo = { id: number; hoedanigheid: string; groepering: string; method: string };
/** A live location: its row, its live WFS series (`quantity/Hoedanigheid` -> methods) and its catalogue links. */
export type Location = {
  row: Row;
  /** The distinct live WFS series: quantity, Hoedanigheid as the WFS states it, and the methods it carries. */
  series: { quantity: 'H' | 'Q'; hoedanigheid: string; methods: string[] }[];
  /** The WATHTE (forecast: or Q) catalogue links by kind, one entry per distinct AquoMetadata. */
  combos: Record<Kind, Combo[]>;
};

/**
 * The live locations with their series and catalogue combinations (what `inventory()` counts, and what the
 * P16a seeds list). H and Q: the distinct live WFS series (`CODE/GROOTHEID/HOEDANIGHEID/METHOD`, so a duplicate
 * feature counts once). The catalogue links are distinct (location, AquoMetadata) pairs of the live locations:
 * forecast = WATHTE or Q `verwachting`; astronomical = WATHTE `astronomisch` without a grouping; high and low
 * water = WATHTE under a GETET* grouping, by its GROUPINGS kind. Sorted by code.
 */
export function locations(
  catalogue: unknown,
  wfs: unknown,
  table: Readonly<Record<string, Row>> = TABLE,
): Map<string, Location> {
  const live = new Map<string, Map<string, Set<string>>>();
  for (const [i, raw] of arr(obj(wfs, 'wfs').features, 'wfs.features').entries()) {
    const at = `features[${i}]`;
    const p = obj(obj(raw, at).properties, `${at}.properties`);
    const prop = (name: string) => str(p[name], `${at}.${name}`);
    const c = prop('CODE');
    const g = prop('GROOTHEIDCODE');
    if (g !== 'WATHTE' && g !== 'Q') throw new Error(`${at}: unexpected GROOTHEIDCODE ${g}`);
    const l = live.get(c) ?? new Map<string, Set<string>>();
    const key = `${g}/${prop('HOEDANIGHEIDCODE')}`;
    l.set(key, (l.get(key) ?? new Set<string>()).add(prop('WAARDEBEPALINGSMETHODECODE')));
    live.set(c, l);
  }

  const rows = new Map(Object.entries(table));
  for (const c of live.keys()) if (!rows.has(c)) throw new Error(`live location ${c} has no TABLE row`);
  for (const [c, row] of rows) {
    if (!live.has(c)) throw new Error(`TABLE row ${c} is not a live location`);
    if (!Object.hasOwn(TYPES, row.type)) throw new Error(`TABLE row ${c}: unknown type ${row.type}`);
    if (row.type === 'structure' && !REASONS.includes(row.reason as Reason))
      throw new Error(`TABLE row ${c}: a structure-internal row needs a reason`);
    if (row.type !== 'structure' && row.reason !== undefined)
      throw new Error(`TABLE row ${c}: only a structure-internal row has a reason`);
  }

  const doc = obj(catalogue, 'catalogue');
  const codes = new Map<number, string>();
  for (const [i, raw] of arr(doc.LocatieLijst, 'catalogue.LocatieLijst').entries()) {
    const l = obj(raw, `LocatieLijst[${i}]`);
    codes.set(int(l.Locatie_MessageID, `LocatieLijst[${i}].Locatie_MessageID`), str(l.Code, `LocatieLijst[${i}].Code`));
  }
  const kinds = new Map<number, { kind: Kind; combo: Combo }>();
  for (const [i, raw] of arr(doc.AquoMetadataLijst, 'catalogue.AquoMetadataLijst').entries()) {
    const at = `AquoMetadataLijst[${i}]`;
    const a = obj(raw, at);
    const id = int(a.AquoMetadata_MessageID, `${at}.AquoMetadata_MessageID`);
    const g = code(a.Grootheid, `${at}.Grootheid`);
    const proces = str(a.ProcesType, `${at}.ProcesType`);
    const grouping = code(a.Groepering, `${at}.Groepering`);
    let kind: Kind | undefined;
    if (grouping.startsWith('GETET')) {
      if (!Object.hasOwn(GROUPINGS, grouping)) throw new Error(`${at}: unknown grouping ${grouping}`);
      const k = GROUPINGS[grouping] ?? null;
      if (k !== null && proces !== PROCES[k]) throw new Error(`${at}: grouping ${grouping} with ProcesType ${proces}`);
      if (k !== null && g === 'WATHTE') kind = k === 'measured' ? 'hwlwMeasured' : 'hwlwAstronomical';
    } else if (grouping === '' && proces === 'verwachting' && (g === 'WATHTE' || g === 'Q')) kind = 'forecast';
    else if (grouping === '' && proces === 'astronomisch' && g === 'WATHTE') kind = 'astronomical';
    if (kind !== undefined)
      kinds.set(id, {
        kind,
        combo: {
          id,
          hoedanigheid: code(a.Hoedanigheid, `${at}.Hoedanigheid`),
          groepering: grouping,
          method: code(a.WaardeBepalingsMethode, `${at}.WaardeBepalingsMethode`),
        },
      });
  }

  const out = new Map<string, Location>();
  for (const c of [...live.keys()].sort()) {
    const series = [...(live.get(c) as Map<string, Set<string>>)].map(([key, methods]) => {
      const [g, hoedanigheid] = key.split('/') as [string, string];
      return { quantity: g === 'WATHTE' ? ('H' as const) : ('Q' as const), hoedanigheid, methods: [...methods].sort() };
    });
    out.set(c, {
      row: rows.get(c) as Row,
      series,
      combos: { forecast: [], astronomical: [], hwlwMeasured: [], hwlwAstronomical: [] },
    });
  }
  const seen = new Set<string>();
  for (const [i, raw] of arr(doc.AquoMetadataLocatieLijst, 'catalogue.AquoMetadataLocatieLijst').entries()) {
    const at = `AquoMetadataLocatieLijst[${i}]`;
    const l = obj(raw, at);
    const a = int(l.AquoMetaData_MessageID, `${at}.AquoMetaData_MessageID`);
    const c = codes.get(int(l.Locatie_MessageID, `${at}.Locatie_MessageID`));
    const k = kinds.get(a);
    const loc = c === undefined ? undefined : out.get(c);
    if (c === undefined || k === undefined || loc === undefined || seen.has(`${c}/${a}`)) continue;
    seen.add(`${c}/${a}`);
    loc.combos[k.kind].push(k.combo);
  }
  for (const loc of out.values())
    for (const k of Object.keys(loc.combos) as Kind[]) loc.combos[k].sort((x, y) => x.id - y.id);
  return out;
}

/** Counts per water type, from `locations()`. */
export function inventory(catalogue: unknown, wfs: unknown, table: Readonly<Record<string, Row>> = TABLE): Inventory {
  const zero = (): Counts => ({
    locations: 0,
    h: 0,
    q: 0,
    forecast: 0,
    astronomical: 0,
    hwlwMeasured: 0,
    hwlwAstronomical: 0,
  });
  const counts = Object.fromEntries(Object.keys(TYPES).map((t) => [t, zero()])) as Record<WaterType, Counts>;
  const structure: [string, Reason][] = [];
  for (const [c, l] of locations(catalogue, wfs, table)) {
    const n = counts[l.row.type];
    n.locations += 1;
    for (const s of l.series) n[s.quantity === 'H' ? 'h' : 'q'] += s.methods.length;
    for (const k of ['forecast', 'astronomical', 'hwlwMeasured', 'hwlwAstronomical'] as const)
      n[k] += l.combos[k].length;
    if (l.row.reason !== undefined) structure.push([c, l.row.reason]);
  }
  structure.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { counts, structure };
}

const sha12 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The block between the markers (without them), from an inventory and the two fixtures' sha256 prefixes. */
export function render(inv: Inventory, hashes: { catalogue: string; wfs: string }): string {
  const total = (k: (typeof COLUMNS)[number]) => Object.values(inv.counts).reduce((s, n) => s + n[k], 0);
  return [
    `<!-- Generated by scripts/rws-inventory.ts from ${base(CATALOGUE)} (sha256 ${hashes.catalogue}…) and ${base(WFS)} (sha256 ${hashes.wfs}…). Do not edit: run node scripts/rws-inventory.ts. -->`,
    '',
    '**Rijkswaterstaat inventory (generated, P15).** A live location is a distinct `CODE` of the NL-2 WFS snapshot (WATHTE and Q, last 12 h); its water type is curated in `TABLE` of `scripts/rws-inventory.ts`. H and Q count the distinct live WFS series (location, quantity, Hoedanigheid, method). The other columns count, for the same locations, the WATHTE and Q combinations of the full NL-1 catalogue: Forecast `verwachting`, Astronomical `astronomisch` without a grouping, HW/LW measured `GETETM2`/`GETETMSL2`, HW/LW astronomical `GETETBRKD2`/`GETETBRKDMSL2` (`GETETOZBRKD2`, the computed surge at the extremes, is not counted).',
    '',
    '| Water type | Locations | H | Q | Forecast | Astronomical | HW/LW measured | HW/LW astronomical |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...(Object.keys(TYPES) as WaterType[]).map(
      (t) => `| ${TYPES[t]} | ${COLUMNS.map((k) => inv.counts[t][k]).join(' | ')} |`,
    ),
    `| **Total** | ${COLUMNS.map((k) => `**${total(k)}**`).join(' | ')} |`,
    '',
    'Structure-internal locations (registered `off` with a reason, never shown):',
    '',
    ...inv.structure.map(([c, r]) => `- \`${c}\` · ${r}`),
  ].join('\n');
}

/** The document with its inventory block regenerated; the markers must each appear exactly once, in order. */
export function generate(
  catalogue: Buffer,
  wfs: Buffer,
  doc: string,
  table: Readonly<Record<string, Row>> = TABLE,
): string {
  const b = doc.split(BEGIN).length - 1;
  const e = doc.split(END).length - 1;
  const i = doc.indexOf(BEGIN);
  const j = doc.indexOf(END);
  if (b !== 1 || e !== 1 || j < i) throw new Error(`${DOC}: needs exactly one ${BEGIN} followed by one ${END}`);
  const inv = inventory(JSON.parse(catalogue.toString('utf8')), JSON.parse(wfs.toString('utf8')), table);
  const block = render(inv, { catalogue: sha12(catalogue), wfs: sha12(wfs) });
  return `${doc.slice(0, i + BEGIN.length)}\n${block}\n${doc.slice(j)}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const rest = check ? args.slice(1) : args;
  if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) {
    console.error('usage: node scripts/rws-inventory.ts [--check] [repo-root]');
    process.exit(64);
  }
  const root = resolve(rest[0] ?? join(import.meta.dirname, '..'));
  try {
    const doc = readFileSync(join(root, DOC), 'utf8');
    const out = generate(readFileSync(join(root, CATALOGUE)), readFileSync(join(root, WFS)), doc);
    if (out === doc) console.log('rws-inventory: OK');
    else if (check) {
      console.error(`rws-inventory: the §2.1 block of ${DOC} is out of date (run: node scripts/rws-inventory.ts)`);
      process.exit(1);
    } else {
      writeFileSync(join(root, DOC), out);
      console.log('rws-inventory: written');
    }
  } catch (e) {
    console.error(`rws-inventory: ${(e as Error).message}`);
    process.exit(1);
  }
}
