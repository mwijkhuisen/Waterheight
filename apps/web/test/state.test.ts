import { describe, expect, it } from 'vitest';
import { basisKind, heightText, popupLine, stateWord } from '../src/features/station/state.ts';

const basis = {
  source: 'NL-4',
  kind: 'provider_class',
  measure: 'stage',
  ref: 'Licht verhoogd',
  label: '<b>x</b>',
} as const;
const value = { state: 'elevated', basis, section: true } as never;

describe('state text', () => {
  it('words in both languages', () => {
    expect(stateWord('elevated', 'nl')).toBe('verhoogd');
    expect(stateWord('no_ref', 'en')).toBe('no reference');
  });

  it('the NL-4 basis carries the disclaimer', () => {
    expect(basisKind(basis, 'nl')).toBe('RWS Waterinfo-legenda, geen officiële waarschuwing');
    expect(basisKind(basis, 'en')).toBe('RWS Waterinfo legend, not an official warning');
  });

  it('the popup line keeps the label verbatim and marks a section', () => {
    expect(popupLine('Waterstand', value, 'nl')).toBe(
      'Waterstand: verhoogd, RWS Waterinfo-legenda, geen officiële waarschuwing: <b>x</b>, (sectie)',
    );
  });

  it('height: NAP, an unverified zero, or nothing', () => {
    expect(heightText({ nap: { m: 1.234, pm: 0.05 } }, 'en')).toBe('≈ 1.23 m NAP (± 5 cm)');
    // An exact zero (a level in its own datum) or one that rounds to 0 cm shows no "± 0 cm".
    expect(heightText({ nap: { m: 1.234, pm: 0 } }, 'nl')).toBe('≈ 1,23 m NAP');
    expect(heightText({ nap: { m: 1.234, pm: 0.004 } }, 'en')).toBe('≈ 1.23 m NAP');
    expect(heightText({ zero: { m: 12.5, datum: 'IGN69' } }, 'nl')).toBe(
      "nulpunt: 12,5 m IGN69 (Hub'Eau-metadata, niet geverifieerd)",
    );
    expect(heightText({}, 'nl')).toBeNull();
  });
});
