import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as web from '../apps/web/src/features/flow/reaches/bins.ts';
import { ReachesFile } from '../packages/contracts/src/reaches.ts';
import * as tools from '../tools/geo/rivernet/bins.ts';
import { haversine, type LonLat } from '../tools/geo/rivernet/network.ts';
import { repoRoot } from './catalogue.ts';

// The position bins (#112 item 2): the web holds the same rule as tools/geo (it cannot import tools/geo), the line cut
// is contiguous, and the committed fixture tiles carry the `reach_bins` layer with its fields.

const fixture = ReachesFile.parse(JSON.parse(readFileSync(`${repoRoot}test/fixtures/reaches-fixture.json`, 'utf8')));

describe('the web and the tools bin rule', () => {
  it('agree on the constants', () => {
    expect(web.BIN_M).toBe(tools.BIN_M);
    expect(web.BIN_MAX).toBe(tools.BIN_MAX);
    expect(web.BIN_MINZOOM).toBe(tools.BIN_MINZOOM);
    expect([tools.BIN_M, tools.BIN_MAX, tools.BIN_MINZOOM]).toEqual([500, 8, 8]);
  });

  it('agree on the count for every fixture reach length and the edge lengths', () => {
    const lengths = [...fixture.reaches.map((r) => r.length_km), 0, 0.499, 0.5, 0.999, 1, 3.999, 4, 4.0004, 100, null];
    expect(fixture.reaches.length).toBeGreaterThan(600);
    for (const len of lengths) expect(web.binCount(len), String(len)).toBe(tools.binCount(len));
  });

  it('counts floor(metres / 500) clamped to 1..8, a null length being 1', () => {
    const want: [number | null, number][] = [
      [0, 1],
      [0.499, 1],
      [0.5, 1],
      [0.999, 1],
      [1, 2],
      [3.999, 7],
      [4, 8],
      [4.0004, 8],
      [100, 8],
      [null, 1],
    ];
    for (const [len, n] of want) expect(tools.binCount(len), String(len)).toBe(n);
  });

  it('names a bin <reach>/<i>', () => {
    expect(web.segOf('rhine.56', 3)).toBe('rhine.56/3');
    expect(web.BINS_LAYER).toBe('reach_bins');
  });
});

describe('binLines', () => {
  const line: LonLat[] = [
    [5.0, 52.0],
    [5.01, 52.003],
    [5.02, 51.999],
    [5.05, 52.01],
    [5.06, 52.02],
  ];
  const len = (c: readonly LonLat[]) => c.slice(1).reduce((a, p, i) => a + haversine(c[i] as LonLat, p), 0);

  it('cuts a line into n contiguous parts from its start to its end, of equal length within 1 m', () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const parts = tools.binLines(line, n);
      expect(parts).toHaveLength(n);
      expect(parts[0]?.[0]).toEqual(line[0]);
      expect(parts[n - 1]?.at(-1)).toEqual(line.at(-1));
      for (let i = 1; i < n; i++) {
        const prev = parts[i - 1]?.at(-1) as LonLat;
        const next = parts[i]?.[0] as LonLat;
        expect(haversine(prev, next), `${n}: part ${i} starts where ${i - 1} ended`).toBeLessThan(0.01);
      }
      const total = len(line);
      for (const [i, p] of parts.entries()) {
        expect(p.length, `${n}/${i}`).toBeGreaterThanOrEqual(2);
        expect(Math.abs(len(p) - total / n), `${n}/${i}`).toBeLessThan(1);
      }
    }
  });
});

describe('the committed fixture tiles', () => {
  it('list the layers rivers and reach_bins, the bins with reach_id, bin, seg and tidal', () => {
    const buf = readFileSync(`${repoRoot}tools/geo/fixtures/rivers-fixture.pmtiles`);
    // PMTiles v3 header: magic, version 3, then the metadata offset (u64 at 24), length (u64 at 32), internal
    // compression (u8 at 97: 1 none, 2 gzip).
    expect(buf.subarray(0, 7).toString('latin1')).toBe('PMTiles');
    expect(buf[7]).toBe(3);
    const offset = Number(buf.readBigUInt64LE(24));
    const length = Number(buf.readBigUInt64LE(32));
    const slice = buf.subarray(offset, offset + length);
    const text = (buf[97] === 2 ? gunzipSync(slice) : slice).toString('utf8');
    const meta = JSON.parse(text) as { vector_layers: { id: string; fields: Record<string, string> }[] };
    const layers = new Map(meta.vector_layers.map((l) => [l.id, l.fields]));
    expect([...layers.keys()].sort()).toEqual(['reach_bins', 'rivers']);
    expect(Object.keys(layers.get('reach_bins') ?? {}).sort()).toEqual(['bin', 'reach_id', 'seg', 'tidal']);
    expect(Object.keys(layers.get('rivers') ?? {})).toContain('reach_id');
  });
});
