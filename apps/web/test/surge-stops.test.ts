import { expect, it } from 'vitest';
import { SURGE_STOPS_CM } from '../src/features/legend/palette.ts';

it('SURGE_STOPS_CM is pinned, strictly increasing and diverging at 0', () => {
  expect([...SURGE_STOPS_CM]).toEqual([-100, -50, 0, 50, 100, 150, 200, 300]);
  for (let i = 1; i < SURGE_STOPS_CM.length; i++) {
    expect(SURGE_STOPS_CM[i] as number).toBeGreaterThan(SURGE_STOPS_CM[i - 1] as number);
  }
  expect(SURGE_STOPS_CM).toContain(0);
});
