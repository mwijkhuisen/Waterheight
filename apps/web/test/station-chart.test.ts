import { describe, expect, it } from 'vitest';
import {
  forecastView,
  fromAsofRun,
  observedPoints,
  type Run,
  referenceMarks,
  runName,
} from '../src/features/station/chartModel.ts';
import { creditLines, dhValue, httpsUrl, trendGlyph } from '../src/features/station/provenance.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const id = (v: number) => v;

const run: Run = {
  source: 'NL-1',
  agency: 'RWS',
  issuedAt: NOW,
  issuedInferred: false,
  providerSegmentEnd: NOW + 2 * H,
  ts: [0, 1, 2, 3, 60].map((h) => NOW + h * H),
  value: [1, 2, null, 4, 5],
  lo: [0, 1, 1, 3, 4],
  hi: [2, 3, 3, 5, 6],
};

describe('forecastView', () => {
  it('cuts at base + 48 h and splits the estimate at providerSegmentEnd, both holding the junction', () => {
    const v = forecastView(run, id, NOW);
    expect(v.end).toBe(NOW + 3 * H);
    expect(v.provider.map((p) => p[0])).toEqual([0, 1, 2].map((h) => NOW + h * H));
    expect(v.estimate.map((p) => p[0])).toEqual([2, 3].map((h) => NOW + h * H));
    expect(v.provider[2]?.[1]).toBeNull();
  });

  it('keeps nulls (no smoothing across a gap) and the band as lower + spread', () => {
    const v = forecastView(run, id, NOW);
    expect(v.hasBand).toBe(true);
    expect(v.lower.map((p) => p[1])).toEqual([0, 1, 1, 3]);
    expect(v.spread.map((p) => p[1])).toEqual([2, 2, 2, 2]);
  });

  it('no band, no provider cut: one dashed line', () => {
    const v = forecastView({ ...run, lo: null, hi: null, providerSegmentEnd: null }, id, NOW);
    expect(v.hasBand).toBe(false);
    expect(v.estimate).toEqual([]);
    expect(v.provider).toHaveLength(4);
  });

  it('end is the run end when it is shorter than 48 h', () => {
    expect(forecastView({ ...run, ts: [NOW, NOW + H] }, id, NOW).end).toBe(NOW + H);
  });
});

describe('fromAsofRun', () => {
  it('reads columns from points and the band from bandKind', () => {
    const r = fromAsofRun({
      source: 'CH-4',
      agency: 'BAFU',
      issuedAt: '2026-10-26T10:00:00Z',
      issuedInferred: true,
      fetchedAt: '2026-10-26T10:05:00Z',
      providerSegmentEnd: null,
      kind: 'quantiles',
      stepSeconds: 3600,
      bandKind: 'p25p75',
      horizonEnd: '2026-10-26T12:00:00Z',
      points: [{ ts: '2026-10-26T11:00:00Z', value: 3, lo: 2, hi: 4, flags: 0 }],
    } as never);
    expect(r.value).toEqual([3]);
    expect(r.lo).toEqual([2]);
    expect(runName(r, 'en')).toContain('BAFU');
    expect(runName(r, 'en')).toContain('fetched');
  });
});

describe('referenceMarks', () => {
  const refs = [
    { source: 'NL-4', kind: 'NL4_FROM', value: 300, unit: 'cm', priority: 1, label: 'Licht {c}' },
    { source: 'NL-4', kind: 'NL4_FROM', value: 100, unit: 'cm', priority: 1, label: null },
    { source: 'NL-4', kind: 'X', value: 5, unit: 'm3/s', priority: 1, label: 'wrong unit' },
  ];
  it('lines keep the raw label as text, bands join consecutive levels, other units are skipped', () => {
    const k = referenceMarks(
      refs,
      'H',
      (v) => v / 100,
      () => 'ours',
      (s) => s === 'NL-4',
      'en',
    );
    expect(k.lines).toHaveLength(2);
    expect(k.lines[0]?.text).toContain('Licht {c}');
    expect(k.lines[0]?.text).toContain('ours');
    expect(k.lines[0]?.text).toContain('owner only');
    expect(k.bands).toEqual([{ from: 1, to: 3, colour: expect.stringMatching(/^#/) }]);
  });
  it('a discharge takes m3/s references', () => {
    expect(
      referenceMarks(
        refs,
        'Q',
        id,
        () => undefined,
        () => false,
        'nl',
      ).lines,
    ).toHaveLength(1);
  });
});

describe('observedPoints', () => {
  it('filters to the span and converts', () => {
    const ts = ['2026-10-26T10:00:00Z', '2026-10-26T11:00:00Z'];
    const from = Date.parse(ts[1] as string);
    expect(observedPoints(ts, [1, 2], (v) => v * 10, from, from + 1)).toEqual([[from, 20]]);
  });
});

describe('provenance', () => {
  it('https only', () => {
    expect(httpsUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(httpsUrl('http://a.example')).toBeUndefined();
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpsUrl(null)).toBeUndefined();
  });
  it('credit lines prefer the page language and carry the licence date', () => {
    const lines = creditLines(
      {
        attribution: [
          { lang: 'nl', text: 'Bron RWS', url: 'https://x.example' },
          { lang: 'en', text: 'Source RWS', url: 'http://x.example' },
        ],
        dateKind: null,
        date: null,
        dateText: null,
      },
      'en',
    );
    expect(lines).toEqual([{ lang: 'en', text: 'Source RWS', href: undefined }]);
    const dated = creditLines(
      {
        attribution: [{ lang: null, text: 'Stand', url: null }],
        dateKind: 'stand',
        date: null,
        dateText: '01.01.2026',
      },
      'nl',
    );
    expect(dated[0]?.text).toBe('Stand (01.01.2026)');
  });
  it('Δh is signed with its unit, the glyph is per trend', () => {
    expect(dhValue(12, 'H', 'en')).toBe('+12 cm');
    expect(dhValue(-0.5, 'Q', 'nl')).toBe('-0,5 m³/s');
    expect(trendGlyph('rising')).toBe('▲');
    expect(trendGlyph('falling')).toBe('▼');
  });
});
