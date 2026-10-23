import { describe, expect, it } from 'vitest';
import { SURGE_COLOURS, SURGE_STOPS_CM } from '../src/features/legend/palette.ts';
import { layerPaints } from '../src/features/map/stationLayer.ts';

it('SURGE_STOPS_CM is pinned, strictly increasing and diverging at 0', () => {
  expect([...SURGE_STOPS_CM]).toEqual([-100, -50, 0, 50, 100, 150, 200, 300]);
  for (let i = 1; i < SURGE_STOPS_CM.length; i++) {
    expect(SURGE_STOPS_CM[i] as number).toBeGreaterThan(SURGE_STOPS_CM[i - 1] as number);
  }
  expect(SURGE_STOPS_CM).toContain(0);
});

describe('SURGE_COLOURS (P19a T2)', () => {
  const rgb = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
  // WCAG 2.x relative luminance and contrast ratio.
  const lum = (c: string) => {
    const [r, g, b] = rgb(c).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const zero = SURGE_STOPS_CM.indexOf(0);
  const at = (i: number) => SURGE_COLOURS[i] as string;

  it('is parallel to the stops, with valid #rrggbb colours, all distinct', () => {
    expect(SURGE_COLOURS).toHaveLength(SURGE_STOPS_CM.length);
    for (const c of SURGE_COLOURS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(SURGE_COLOURS).size).toBe(SURGE_COLOURS.length);
  });
  it('is a light neutral at 0', () => {
    const [r, g, b] = rgb(at(zero));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(16);
    expect(lum(at(zero))).toBeGreaterThan(0.85);
  });
  it('diverges: bluish/purple below 0, orange/brown above', () => {
    SURGE_COLOURS.forEach((c, i) => {
      const [r, , b] = rgb(c);
      if (i < zero) expect(b, c).toBeGreaterThan(r);
      if (i > zero) expect(r, c).toBeGreaterThan(b);
    });
  });
  it('gets darker away from 0 on both sides', () => {
    for (let i = 1; i < zero; i++) expect(lum(at(i - 1))).toBeLessThan(lum(at(i)));
    for (let i = zero + 2; i < SURGE_COLOURS.length; i++) expect(lum(at(i))).toBeLessThan(lum(at(i - 1)));
  });
  it('the marker keeps its dark ring (the plan alternative): #525252 reads against the light middle and the map', () => {
    const stroke = layerPaints('state').stations?.['circle-stroke-color'] as unknown[];
    // The last branch of the case is the ordinary marker (not selected, not a ring, not hollow): a coast marker with surge.
    expect(stroke[stroke.length - 1]).toBe('#525252');
    expect(contrast('#525252', at(zero))).toBeGreaterThanOrEqual(3);
    expect(contrast('#525252', '#ffffff')).toBeGreaterThanOrEqual(3);
    // The dark end has no 3:1 against the ring, so the scale cannot do without a ring that contrasts with the map.
    expect(contrast('#525252', at(SURGE_COLOURS.length - 1))).toBeLessThan(3);
  });
});
