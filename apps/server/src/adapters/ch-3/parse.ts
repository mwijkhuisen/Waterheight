import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// CH-3 hydrodaten 40-day plot JSON (catalogue §2.7; the seed only): a Plotly
// figure of one station, `p_q_40days/<id>_p_q_40days_de.json`. Only each
// trace's name, unit and x/y arrays are read, strictly; Plotly's styling keys
// and the layout (threshold bands, P7) are presentation and are not. Provider
// strings are data.

const text = (max: number) => z.string().max(max);

/** 40 days of 5-minute points is 11,520; the fixture has 11,404. */
const MAX_POINTS = 20_000;

const Trace = z.object({
  name: text(100),
  x: cappedArray(text(40), MAX_POINTS),
  y: cappedArray(z.number().nullable(), MAX_POINTS),
  meta: z.object({ unit: text(40) }),
});
export type Trace = z.infer<typeof Trace>;

const Document = z.strictObject({
  plot: z.strictObject({ layout: z.unknown(), data: cappedArray(z.unknown(), 10) }),
  hoverInfo: z.unknown(),
});

/** Node and depth caps: two values per point and trace (the fixture: about 46,000 values, depth 6). */
export const JSON_CAPS = { maxNodes: 150_000, maxDepth: 10 } as const satisfies JsonCaps;

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

export function parsePlot(body: Uint8Array): Trace[] {
  const doc = parseStrict(Document, boundedJson(decode(body), JSON_CAPS));
  return doc.plot.data.map((t, i) => {
    const trace = parseStrict(Trace, t, ['plot', 'data', i]);
    if (trace.x.length !== trace.y.length) throw new SchemaDrift('length_mismatch', `plot.data.${i}`);
    return trace;
  });
}
