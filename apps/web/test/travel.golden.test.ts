import { describe, expect, it } from 'vitest';
import { travelText } from '../src/lib/travel.ts';
import { PRIORS } from './fixtures/travel-priors.ts';

describe('travelText goldens (catalogue §3.7 anchors)', () => {
  it('has unique ids', () => {
    expect(new Set(PRIORS.map((p) => p.id)).size).toBe(PRIORS.length);
  });

  it.each(PRIORS.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    expect(travelText(p.prior, 'nl')).toBe(p.nl);
    expect(travelText(p.prior, 'en')).toBe(p.en);
  });

  it('every shown text says indicatief/indicative', () => {
    for (const p of PRIORS) {
      if (p.nl !== null) expect(p.nl).toMatch(/^indicatief/);
      if (p.en !== null) expect(p.en).toMatch(/^indicative/);
    }
  });
});
