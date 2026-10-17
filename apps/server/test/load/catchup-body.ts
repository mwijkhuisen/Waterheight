import { rawFixture } from '../adapters/registry.ts';

// P16b: a catch-up body for the loader tests: the recorded lobith H payload (a registered roadmap-1 series) with its
// values replaced, so that a window can sit anywhere in time.

export const LOBITH_H = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
const MIN = 60_000;

/** The recorded lobith H payload with its values replaced: one every 10 minutes from `from` (UTC ms), `n` of them. */
export function catchupBody(from: number, n: number, offset = 0): Buffer {
  const doc = JSON.parse(rawFixture('NL-1', 'nl-1-obs-key').body.toString('utf8'));
  const list = doc.WaarnemingenLijst[0];
  const template = list.MetingenLijst[0];
  list.MetingenLijst = Array.from({ length: n }, (_, i) => {
    const local = new Date(from + i * 10 * MIN + 3_600_000).toISOString().replace('Z', '+01:00');
    const v = 1000 + (i % 50) + offset;
    return { ...template, Meetwaarde: { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v }, Tijdstip: local };
  });
  return Buffer.from(JSON.stringify(doc));
}
