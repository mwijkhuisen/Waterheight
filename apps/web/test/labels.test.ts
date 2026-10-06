import { describe, expect, it } from 'vitest';
import { basisLabel, lhpColour, type OwnerLabels, referenceLabel, riverName } from '../src/lib/labels/labels.ts';

const owner: OwnerLabels = {
  keys: Object.assign(Object.create(null), {
    'BE-3\nnivcru\n*': 'lbl_be_3_nivcru_any',
    'BE-3\nreference\nP05': 'lbl_be_3_reference_p05',
  }),
  nl: Object.assign(Object.create(null), { lbl_be_3_nivcru_any: 'NL owner', lbl_be_3_reference_p05: 'P05 nl' }),
  en: Object.assign(Object.create(null), { lbl_be_3_nivcru_any: 'EN owner', lbl_be_3_reference_p05: 'P05 en' }),
};

describe('label lookup', () => {
  it('a DE-6 gauge class: prefix stripped, exact code', () => {
    expect(basisLabel({ source: 'DE-6', kind: 'provider_class', ref: 'RP:2' }, 'en')).toBe('Moderate flood');
    expect(basisLabel({ source: 'DE-6', kind: 'provider_class', ref: 'RP:2' }, 'nl')).toBe('Middelgroot hoogwater');
  });
  it('an area class needs the feature level; none is raw only', () => {
    expect(basisLabel({ source: 'DE-6', kind: 'area', ref: 'x' }, 'en', { areaLevelRaw: '4' })).toBe('Flood');
    expect(basisLabel({ source: 'DE-6', kind: 'area', ref: 'x' }, 'en', { areaLevelRaw: null })).toBeUndefined();
    expect(basisLabel({ source: 'DE-6', kind: 'area', ref: 'x' }, 'en')).toBeUndefined();
  });
  it('NL-4 by stem; a multi-part reference has no text', () => {
    expect(basisLabel({ source: 'NL-4', kind: 'provider_class', ref: 'Normaal' }, 'en')).toBe(
      'Normal (Waterinfo class)',
    );
    expect(basisLabel({ source: 'DE-1', kind: 'operational', ref: 'MNW/MHW' }, 'en')).toBeUndefined();
  });
  it('owner sources resolve only through the owner labels, exact else the * row', () => {
    const b = { source: 'BE-3', kind: 'provider_class', ref: 'WHATEVER' } as const;
    expect(basisLabel(b, 'en')).toBeUndefined();
    expect(basisLabel(b, 'en', { owner })).toBe('EN owner');
    expect(referenceLabel('BE-3', 'P05', 'nl')).toBeUndefined();
    expect(referenceLabel('BE-3', 'P05', 'nl', owner)).toBe('P05 nl');
  });
  it('colours and rivers', () => {
    expect(lhpColour('station', '-1')).toBe('#7b7b7b');
    expect(lhpColour('alert', '2')).toBeUndefined();
    expect(riverName('rhine', 'en')).toBe('Rhine');
    expect(riverName('rhine', 'nl')).toBe('Rijn');
  });
  it('prototype keys are never found', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(riverName(k, 'en')).toBeUndefined();
      expect(referenceLabel(k, k, 'en', owner)).toBeUndefined();
      expect(basisLabel({ source: k, kind: 'provider_class', ref: k }, 'en', { owner })).toBeUndefined();
      expect(basisLabel({ source: 'DE-6', kind: 'area', ref: k }, 'en', { areaLevelRaw: k })).toBeUndefined();
      expect(lhpColour(k as 'alert', k)).toBeUndefined();
    }
  });
});
