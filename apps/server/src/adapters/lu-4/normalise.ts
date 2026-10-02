import { parseStrict } from '@rws/core';
import { z } from 'zod';
import { slugOf } from '../_shared/age/slug.ts';
import type { Page } from './parse.ts';

// LU-4 AGE station page → the station's reference record (catalogue §2.6; owner audience, personal use: values
// are kept as published, nothing is rounded or converted). Declared here, never inferred:
//  - time: a page has no observation timestamps (no `TIME`, as DE-8 and LU-6); its one date, `serviceDate`
//    (`dd.mm.yyyy`), is the date from which the gauge zero holds. An impossible date (Heiderscheidergrund's, of the
//    form `dd.dddddd`) is `valid_from` null, counted `bad_date`; the zero itself is kept;
//  - levels: `levelsMax` is yellow, orange, red by position, in cm; 0 means not defined → null (almost everywhere
//    the yellow one);
//  - HQ: `newVigilanceList` lines whose legend names HQ2, HQ5, HQ10, HQ20, HQ50 or HQ100, as water levels in cm; a
//    legend that names none is `unknown_hq`, a value 0 is `undefined_hq`, a kind twice keeps its first (`duplicate_hq`);
//  - zero: `zeroScale` is metres on NG95 ("999.99 m NN", the tie to NAP), the datum declared here; a string that is
//    not that (or a value outside 0 … 1000 m) is `bad_zero`;
//  - river km: `pk`; position: the page's LUREF (EPSG:2169) easting and northing when they lie in Luxembourg
//    (E 45,000 … 110,000, N 55,000 … 140,000), else the LU-6 point of the station (Hesperange's easting has
//    six digits: `coordinates_from_lu6`), else null. A string that is not "E N" is `bad_coordinates`;
//  - an empty `zeroScale`, `pk`, `coordinates` or `serviceDate` is a value the page does not state: null, not counted;
//  - the banner and the operator are untrusted text, trimmed and length-capped, never interpreted.
// Pure: no I/O. Loading into reference_value is P7a.

export const SOURCE = 'LU-4';

export const HQ_KINDS = ['HQ2', 'HQ5', 'HQ10', 'HQ20', 'HQ50', 'HQ100'] as const;
const BANNER_MAX = 20_000;

const level = z.number().int().nullable();
const hq = z.strictObject({ kind: z.enum(HQ_KINDS), value_cm: z.number().int() });
const zero = z.strictObject({
  value_m: z.number(),
  datum: z.literal('NG95'),
  valid_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});
const position = z.discriminatedUnion('from', [
  z.strictObject({ crs: z.literal('EPSG:2169'), e: z.number(), n: z.number(), from: z.literal('page') }),
  z.strictObject({ lon: z.number(), lat: z.number(), from: z.literal('lu-6') }),
]);

export const StationReference = z.strictObject({
  /** The LU-1 slug of the station (the seed row's `station`). */
  station: z.string().min(1).max(100),
  page_id: z.string().min(1).max(500),
  levels: z.strictObject({ yellow: level, orange: level, red: level }),
  hq: z.array(hq).max(HQ_KINDS.length),
  zero: zero.nullable(),
  pk_km: z.number().nullable(),
  forecast_limit_h: z.union([z.literal(24), z.literal(48)]).nullable(),
  forecast_slug: z.string().max(500),
  position: position.nullable(),
  banner: z.string().min(1).max(BANNER_MAX).nullable(),
  operator: z.string().min(1).max(500).nullable(),
});
export type StationReference = z.infer<typeof StationReference>;

export type Context = {
  /** The LU-1 slug of the page's station, from its row of registry/seed/lu-4.csv. */
  station: string;
  /** LU-1 slug → the LU-6 point, from registry/stations/lu-1.yaml. */
  positions: ReadonlyMap<string, { lon: number; lat: number }>;
};
export type Normalised = { record: StationReference; dropped: Record<string, number> };

// One anchored pattern per string, bounded quantifiers, decimal comma or point. The forms measured on the 40 pages
// of 2026-10-02 (numbers made up): `999,99 m NN.` (a trailing dot; `m NN.` alone is no zero), `99,99 km`,
// `99999 E | 99999 N`.
const NUM = String.raw`\d{1,7}(?:[.,]\d{1,3})?`;
const ZERO = /^(\d{1,4}(?:[.,]\d{1,3})?) ?m(?: ?NN)?\.?$/i;
const NO_ZERO = /^m ?NN\.?$/i;
const PK = /^(\d{1,4}(?:[.,]\d{1,3})?)(?: ?km)?$/i;
const COORDINATES = new RegExp(
  `^(?:E ?:? ?)?(${NUM})(?: ?E)? ?(?:\\||[/;]|,\\s|\\s) ?(?:N ?:? ?)?(${NUM})(?: ?N)?$`,
  'i',
);
const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const LIMIT = /^h(24|48)$/i;
const HQ = /HQ\s*(2|5|10|20|50|100)\b/i;

const E_RANGE = [45_000, 110_000] as const;
const N_RANGE = [55_000, 140_000] as const;
const num = (s: string) => Number(s.replace(',', '.'));

/** `dd.mm.yyyy` as `YYYY-MM-DD`, or null when it is no date of the calendar. */
function isoDate(s: string): string | null {
  const m = DATE.exec(s);
  if (m === null) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1800 || y > 2200 || mo < 1 || mo > 12 || d < 1) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function normalise(page: Page, ctx: Context): Normalised {
  const dropped: Record<string, number> = {};
  const count = (code: string) => {
    dropped[code] = (dropped[code] ?? 0) + 1;
  };
  const cm = (v: number | undefined) => (v === undefined || v === 0 ? null : v);

  const [yellow, orange, red] = page.levelsMax.map((l) => cm(l.value));

  const hqs: StationReference['hq'] = [];
  for (const line of page.newVigilanceList) {
    const kind = HQ.exec(line.legend);
    if (kind === null) count('unknown_hq');
    else if (line.value === 0) count('undefined_hq');
    else if (hqs.some((h) => h.kind === `HQ${kind[1]}`)) count('duplicate_hq');
    else hqs.push({ kind: `HQ${kind[1]}` as (typeof HQ_KINDS)[number], value_cm: line.value });
  }

  const date = page.serviceDate.trim();
  const validFrom = date === '' ? null : isoDate(date);
  if (date !== '' && validFrom === null) count('bad_date');

  let zeroValue: StationReference['zero'] = null;
  const zeroText = page.zeroScale.trim();
  if (NO_ZERO.test(zeroText)) count('zero_missing');
  else if (zeroText !== '') {
    const m = ZERO.exec(zeroText);
    const value = m === null ? Number.NaN : num(m[1] as string);
    if (value > 0 && value <= 1000) zeroValue = { value_m: value, datum: 'NG95', valid_from: validFrom };
    else count('bad_zero');
  }

  let pk: number | null = null;
  const pkText = page.pk.trim();
  if (pkText !== '') {
    const m = PK.exec(pkText);
    if (m === null) count('bad_pk');
    else pk = num(m[1] as string);
  }

  let position: StationReference['position'] = null;
  const coordText = page.coordinates.trim();
  const m = coordText === '' ? null : COORDINATES.exec(coordText);
  if (coordText !== '' && m === null) count('bad_coordinates');
  if (m !== null) {
    const [e, n] = [num(m[1] as string), num(m[2] as string)];
    if (e >= E_RANGE[0] && e <= E_RANGE[1] && n >= N_RANGE[0] && n <= N_RANGE[1])
      position = { crs: 'EPSG:2169', e, n, from: 'page' };
  }
  if (position === null) {
    const point = ctx.positions.get(ctx.station);
    if (point !== undefined) {
      position = { lon: point.lon, lat: point.lat, from: 'lu-6' };
      count('coordinates_from_lu6');
    }
  }

  const limitText = page.forecastsLimit.trim();
  const limit = LIMIT.exec(limitText);
  if (limitText !== '' && limit === null) count('bad_forecast_limit');

  const named = page.forecastsFileName?.trim() ?? '';
  const banner = page.bannerInfoText.trim().slice(0, BANNER_MAX);
  const operator = page.operator.trim();

  return {
    record: parseStrict(StationReference, {
      station: ctx.station,
      page_id: page.id,
      levels: { yellow, orange, red },
      hq: hqs,
      zero: zeroValue,
      pk_km: pk,
      forecast_limit_h: limit === null ? null : Number(limit[1]),
      forecast_slug: slugOf(named === '' ? page.id : named),
      position,
      banner: banner === '' ? null : banner,
      operator: operator === '' ? null : operator,
    }),
    dropped,
  };
}
