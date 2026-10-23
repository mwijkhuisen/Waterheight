import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// No flow animation inside the tidal zone (P19b, critic C13): every layer flowLayer.ts adds carries the one FILTER,
// and FILTER leaves out tidal reaches. Read as text, like map-layers.test.ts reads it.

const src = readFileSync(new URL('../src/features/flow/flowLayer.ts', import.meta.url), 'utf8');

describe('flowLayer filter', () => {
  it('excludes the tidal reaches', () => {
    expect(src).toMatch(/const FILTER[^=]*=[^;]*\['!=', \['get', 'tidal'\], true\]/s);
  });
  it('puts FILTER on every addLayer call', () => {
    const calls = src.split('map.addLayer(').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.split(/\n {2}\)/)[0], c.slice(0, 80)).toMatch(/filter: FILTER,/);
  });
});
