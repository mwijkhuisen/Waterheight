import {
  emptyNormalised,
  FORECAST_SOURCES,
  type ForecastPoint,
  type Normalised,
  parseInstant,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { Parsed } from './parse.ts';

// FR-4 Vigicrues forecast → one forecast run per station, parameter and capture (catalogue §2.5, A§6, A§7.4 item 9).
// Declared here, never inferred per row:
//  - time: `DtProdSimul` and every `DtPrev` carry their own offset (`iso-offset`: `+02:00` on the v1.1 route, `+00:00`
//    on the legacy one; the same instants either way, and the canonical run, hash included, is the same). A
//    forecast's valid times are ahead of the fetch by design, so the future-time rule of invariant 4 (observations)
//    is not applied; the loader refuses an issue time more than 15 minutes ahead of the fetch (`future_issue`) and
//    drops a valid time past issue + 72 h + 1 h (`beyond_horizon`, FORECAST_SOURCES['FR-4']);
//  - run: the points of one body are one run, issued at `DtProdSimul` (`issuedAt`, stated, not inferred), so the key
//    of a run is (series, first valid time, content hash) and a fetch of the same run is a confirmation, whatever
//    `Scenario.DateHeureCreationFichier` (the time of the file, which changes on every fetch) says;
//  - series: the body names its station and parameter (`CdEntVigiCru`, `GrdSimul`): the run is FR-1's series
//    `<CdEntVigiCru>/<GrdSimul>` (`target: 'FR-1'`; the spec lists FR-1 in `refTarget`). The manifest variant, when
//    there is one, must say the same (`variant_mismatch`). A station FR-1 does not register (all but the Rhine,
//    Meuse and Scheldt basins) is counted `unknown` by the loader, never guessed; a mirror takes no run;
//  - quantity: `GrdSimul` `H` is the stage in metres (× 100 to centimetres) and `Q` the discharge in m³/s, from the
//    forecast source's own declaration (packages/core FORECAST_SOURCES), never FR-1's millimetres and litres per
//    second. Rounded to the seven digits a `real` holds (`scale`);
//  - kind and columns: `quantiles`. `ResMinPrev`, `ResMoyPrev` and `ResMaxPrev` are the low, middle and high of an
//    interval stated to hold 80 % of the outcomes: p10, p50 and p90, and `value` is the p50. A null is an absent
//    column. The values are stored as published, never reordered; the loader flags a point whose columns break
//    the order (FORECAST_FLAGS.ORDER), and drops a point with no value (`gap`);
//  - step: irregular per body (10 minutes, half an hour, an hour, half a day, or a single value), so `stepMs` is
//    null. Valid times reach 72 h after `DtProdSimul`, the first up to 34 h after it. `providerSegmentEnd` is null
//    (the provider states no segment);
//  - no run: the national list, an empty `Prevs` and a "no content" body store nothing and count nothing (`dropped`
//    stays empty);
//  - never returned: `CommentSimul` (free text), `LbEntVigiCru` (the label), `Link` (never followed) and `Scenario`
//    (the header of the file). `parse.ts` drops them before this function sees them.

export const SOURCE = 'FR-4';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const DECL = FORECAST_SOURCES['FR-4'];
const UNIT = { H: 'm', Q: 'm3/s' } as const;
/** `<code>/<grd>` of a station body, `<grd>` of the list's root variant (`H`, `Q`). */
const VARIANT = /^(?:([A-Z][0-9A-Z]{9})\/)?([HQ])$/;

export type Context = {
  /** The manifest line's variant: `<CdEntVigiCru>/<GrdSimul>` of a station, `H` or `Q` of the list, or '' (recovered). */
  variant: string;
};

const when = (raw: string, path: string): number => {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (!(err instanceof TimeError)) throw err;
    throw new SchemaDrift(`time_${err.code}`, path);
  }
};

export function normalise(doc: Parsed, ctx: Context): Normalised {
  const out = emptyNormalised();
  const v = ctx.variant === '' ? null : VARIANT.exec(ctx.variant);
  if (ctx.variant !== '' && v === null) throw new SchemaDrift('bad_variant');
  if (doc.kind === 'none') return out;
  // The variant is ours (the capture's), the body the provider's: they must agree on the station and the parameter.
  if (v !== null) {
    const [, code, grd] = v;
    const same = doc.kind === 'list' ? code === undefined && grd === doc.grd : code === doc.code && grd === doc.grd;
    if (!same) throw new SchemaDrift('variant_mismatch');
  }
  if (doc.kind === 'list' || doc.prevs.length === 0) return out;
  const issuedAt = when(doc.producedAt, 'Simul.DtProdSimul');
  const [, factor] = DECL.units[UNIT[doc.grd]];
  const column = (x: number | null) => (x === null ? null : scale(factor, x));
  const points: ForecastPoint[] = doc.prevs.map((p, i) => {
    const p50 = column(p.ResMoyPrev);
    return {
      ts: toIso(when(p.DtPrev, `Simul.Prevs.${i}.DtPrev`)),
      flags: 0,
      value: p50,
      p10: column(p.ResMinPrev),
      p50,
      p90: column(p.ResMaxPrev),
    };
  });
  out.forecasts = [
    {
      target: 'FR-1',
      series: `${doc.code}/${doc.grd}`,
      kind: DECL.kind,
      stepMs: null,
      issuedAt: toIso(issuedAt),
      providerSegmentEnd: null,
      points,
    },
  ];
  return out;
}
