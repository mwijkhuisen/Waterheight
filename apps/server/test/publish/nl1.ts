import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { rawFixture } from '../adapters/registry.ts';
import type { Harness } from '../load/harness.ts';

// A loader input for the P9a tests: the recorded NL-1 Lobith stage payload with its measurements replaced (real
// structure, generated values), written to the archive and loaded through the real Loader.

export const LOBITH_H = 'lobith.bovenrijn.tolkamer/H';
const PROVIDER_OFFSET_MS = 3_600_000; // RWS stamps its times at +01:00

export function lobithPayload(points: readonly (readonly [number, number])[]): Buffer {
  const doc = JSON.parse(rawFixture('NL-1', 'nl-1-obs-key').body.toString('utf8'));
  const list = doc.WaarnemingenLijst[0];
  const template = list.MetingenLijst[0];
  list.MetingenLijst = points.map(([ms, value]) => ({
    ...template,
    Meetwaarde: { Waarde_Alfanumeriek: String(value), Waarde_Numeriek: value },
    Tijdstip: `${new Date(ms + PROVIDER_OFFSET_MS).toISOString().slice(0, -1)}+01:00`,
  }));
  return Buffer.from(JSON.stringify(doc));
}

/** Archives the payload as fetched at `at` and runs the loader with the clock at `now`. */
export async function loadLobith(
  h: Harness,
  points: readonly (readonly [number, number])[],
  at: Date,
  now: Date,
): Promise<void> {
  const f = rawFixture('NL-1', 'nl-1-obs-key');
  await writePayload(h.archive, {
    source: 'NL-1',
    spec: 'nl-1-obs-key',
    variant: LOBITH_H,
    at,
    body: lobithPayload(points),
    url: f.meta.url,
  });
  const result = await h.loader({ now }).tick();
  if (result.loaded < 1) throw new Error(`payload not loaded: ${JSON.stringify(result)} ${JSON.stringify(h.alerts)}`);
}
