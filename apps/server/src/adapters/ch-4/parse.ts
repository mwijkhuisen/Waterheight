import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// CH-4 BAFU forecast plot (catalogue §2.7): the Plotly figure of one station, `plots/q_forecast/<id>_q_forecast_de.json`
// (a lake's level: `plots/p_forecast/<id>_p_forecast_de.json`, #78, the same traces; its unit: `parseAxisLabel`)
// (5 traces: the maximum, the minimum, the 25–75 % band as a closed polygon, the median and the measured trace).
// Only each trace's name, unit and x/y arrays are read, strictly typed; Plotly's styling keys are presentation and
// are not, and neither is the layout except its threshold bands, which a separate function reads (`parseBands`,
// P8b: the flood fixture of storm Ciarán only, never stored). The document and its `plot` are strict: a key the
// schema does not know is SchemaDrift. Which trace is which is decided by normalise, by position and by name.
// Provider strings are data (length-capped, never interpreted, never returned in an error).

const text = (max: number) => z.string().max(max);

/** The real traces have 118 to 119 points (the band polygon twice that plus one); 500 leaves room for a longer run. */
export const MAX_POINTS = 500;

const Trace = z.object({
  name: text(100),
  x: cappedArray(text(40), MAX_POINTS),
  y: cappedArray(z.number().nullable(), MAX_POINTS),
  meta: z.object({ unit: text(40) }),
});
export type Trace = z.infer<typeof Trace>;

/** At most this many traces are read (the figure has 5); normalise refuses any other count. */
const MAX_TRACES = 10;

const Document = z.strictObject({
  plot: z.strictObject({ layout: z.unknown(), data: cappedArray(z.unknown(), MAX_TRACES) }),
  hoverInfo: z.unknown(),
});

/** Node and depth caps: the real figure is about 1,600 values and 6 levels deep, a longer run adds two per point. */
export const JSON_CAPS = { maxNodes: 8_000, maxDepth: 8 } as const satisfies JsonCaps;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function document(body: Uint8Array): z.infer<typeof Document> {
  let doc: string;
  try {
    doc = utf8.decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  return parseStrict(Document, boundedJson(doc, JSON_CAPS));
}

export function parseForecast(body: Uint8Array): Trace[] {
  return document(body).plot.data.map((t, i) => {
    const trace = parseStrict(Trace, t, ['plot', 'data', i]);
    if (trace.x.length !== trace.y.length) throw new SchemaDrift('length_mismatch', `plot.data.${i}`);
    return trace;
  });
}

/** At most this many annotations are read (the figure has 2: the axis label and the run start). */
const MAX_ANNOTATIONS = 20;

const Annotated = z.object({ annotations: cappedArray(z.unknown(), MAX_ANNOTATIONS).optional() });
const Anchor = z.object({ xref: text(10).optional(), yref: text(10).optional() });
const Label = z.object({ text: text(100) });

/**
 * #78: the y-axis label of the figure, the one annotation placed on the paper on both axes (`m³/s` on a discharge
 * figure, `m ü.M.` on a lake figure; the other annotation, the run start, sits on the time axis). The lake figure
 * (`p_forecast`) states its traces in `m³/s` although its values are lake levels in metres: for that figure this
 * label is the unit (normalise, `axisUnit`). None or more than one is SchemaDrift (`ch4_axis_label`). Only the
 * label's text is read: another annotation's text (the run start) is not, so a longer note there changes nothing.
 */
export function parseAxisLabel(body: Uint8Array): string {
  const layout = parseStrict(Annotated, document(body).plot.layout ?? {}, ['plot', 'layout']);
  const at = (i: number) => ['plot', 'layout', 'annotations', i];
  const labels = (layout.annotations ?? []).flatMap((a, i) => {
    const { xref, yref } = parseStrict(Anchor, a, at(i));
    return xref === 'paper' && yref === 'paper' ? [{ a: a as { text?: unknown }, i }] : [];
  });
  const [label] = labels;
  if (labels.length !== 1 || label?.a.text === undefined) throw new SchemaDrift('ch4_axis_label', 'plot.layout');
  return parseStrict(Label, label.a, at(label.i)).text;
}

/** At most this many shapes are read (the figure has about 6 day lines and 8 bands per threshold). */
const MAX_SHAPES = 200;

const Layout = z.object({ shapes: cappedArray(z.unknown(), MAX_SHAPES).optional() });
const Shape = z.object({ type: text(20) });
const Rect = z.object({ yref: text(10), y0: z.number(), y1: z.number() });

/** One threshold band of the figure, in the plot's own unit: from `lower` up to `upper`. */
export type Band = { lower: number; upper: number };

/**
 * The threshold bands of `layout.shapes`: the `rect` shapes on the data axis (`yref` y or y1), each band once (BAFU
 * draws every band twice, a strong strip at the left edge and a faint one over the plot), by ascending lower edge.
 * The `lower` edges are the figure's thresholds (storm Ciarán: 700, 1100, 1450 and 1800 m³/s). Nothing here is
 * normalised, stored or returned by the adapter; the P8b flood test reads it from the storm-Ciarán capture, and a
 * figure without shapes has no band. A rect without numeric edges is SchemaDrift.
 */
export function parseBands(body: Uint8Array): Band[] {
  const layout = parseStrict(Layout, document(body).plot.layout ?? {}, ['plot', 'layout']);
  const seen = new Map<string, Band>();
  for (const [i, s] of (layout.shapes ?? []).entries()) {
    const at = ['plot', 'layout', 'shapes', i];
    if (parseStrict(Shape, s, at).type !== 'rect') continue;
    const rect = parseStrict(Rect, s, at);
    if (rect.yref !== 'y' && rect.yref !== 'y1') continue;
    seen.set(`${rect.y0}/${rect.y1}`, { lower: rect.y0, upper: rect.y1 });
  }
  return [...seen.values()].sort((a, b) => a.lower - b.lower || a.upper - b.upper);
}
