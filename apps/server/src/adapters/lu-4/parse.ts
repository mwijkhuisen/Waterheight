import { dataToJson, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// LU-4 AGE station pages (owner audience, catalogue §2.6, §6.7): `https://inondations.public.lu/fr/<basin>/<river>/<station>.html`.
// The only thing read is the `data-to-json` attribute of the page's one `<cmp-dashboard-station>` element
// (`dataToJson` of packages/core: comments, scripts and other attributes are never read, and no script ever runs).
// Its JSON is held to the strict schema below, the field set of the P1 recording; every provider string is
// length-capped, untrusted data and never interpreted here. A page without the element or the attribute, with
// invalid JSON or with another shape is a SchemaDrift with a fixed code, never provider text. The meaning of the
// strings (`zeroScale`, `pk`, `coordinates`, `serviceDate`, the legends) is normalise's business.

/** The long free text fields: `bannerInfoText` and `otherInfo` (FR/DE/EN notes). */
const NOTE_MAX = 20_000;
const text = (max = 500) => z.string().max(max);
const int = z.number().int();

const Level = z.strictObject({ value: int, label: text() });
const Vigilance = z.strictObject({ legend: text(), value: int });
/** Exactly the three vigilance levels, yellow, orange and red, in that order; the length is checked before any element. */
const levelsMax = z.array(z.unknown()).length(3).pipe(z.array(Level));
/** HQ2 … HQ100 are six; 12 leaves room for a new line without letting a flood of them through. */
const MAX_VIGILANCE = 12;
const vigilanceList = z.array(z.unknown()).max(MAX_VIGILANCE).pipe(z.array(Vigilance));
/** The header logos by name: a handful of paths. */
const MAX_LOGOS = 20;
const logos = z.record(text(100), text(1000)).refine((o) => Object.keys(o).length <= MAX_LOGOS, { message: 'too_big' });

export const Page = z.strictObject({
  id: z.string().min(1).max(500),
  levelsMax,
  vigilanceThreshold: int,
  jsonFile: text(),
  // Absent on 24 of the 40 pages of 2026-10-02 (stations without a forecast).
  legendForecasts: text().optional(),
  forecastsLimit: text(),
  /** The forecast file's name where it differs from `id`; the page lacks it where it does not. */
  forecastsFileName: text().optional(),
  showImage: z.boolean(),
  imagePath: text(),
  putLogoHeader: z.boolean(),
  logosHeaderPath: logos,
  stationPath: text(),
  startYAxis: int,
  endYAxis: int,
  stepYAxis: int,
  isDashboard: z.boolean(),
  bannerInfoText: text(NOTE_MAX),
  displayInfoBanner: z.boolean(),
  stationName: text(),
  waterCourse: text(),
  basinVersion: text(),
  zeroScale: text(),
  pk: text(),
  coordinates: text(),
  repTel: text(),
  serviceDate: text(),
  serviceStatus: text(),
  operator: text(),
  forecastsCalcul: text(),
  otherInfo: text(NOTE_MAX),
  moreInfoBtn: text(),
  imageStationPath: text(),
  addNewVigilance: z.boolean(),
  newVigilanceList: vigilanceList,
  addForecasts: z.boolean(),
});
export type Page = z.infer<typeof Page>;

/** One station page (the HTML bytes) → its `data-to-json` document. Throws SchemaDrift. */
export function parsePage(body: Uint8Array): Page {
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  return parseStrict(Page, dataToJson(html));
}
