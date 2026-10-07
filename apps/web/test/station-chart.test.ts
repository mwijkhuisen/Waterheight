import { describe, expect, it } from 'vitest';
import {
  forecastView,
  fromAsofRun,
  mergeHistory,
  observedPoints,
  onAxis,
  type Run,
  recentGap,
  runName,
  xRange,
} from '../src/features/station/chartModel.ts';
import { creditLines, dhValue, trendGlyph } from '../src/features/station/provenance.ts';
import { seriesRows } from '../src/features/station/seriesRows.ts';
import { httpsHref } from '../src/lib/href.ts';

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

describe('mergeHistory', () => {
  it('puts the older points first and keeps recent.json’s point at the boundary instant', () => {
    const older: [number, number][] = [
      [1, 10],
      [2, 20],
      [3, 99],
    ];
    const recent: [number, number][] = [
      [3, 30],
      [4, 40],
    ];
    expect(mergeHistory(older, recent)).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ]);
  });

  it('is either list alone when the other is empty', () => {
    expect(mergeHistory([[1, 1]], [])).toEqual([[1, 1]]);
    expect(mergeHistory([], [[2, 2]])).toEqual([[2, 2]]);
  });
});

// Review round 1: when the panel asks the API for the part of its span before recent.json.
describe('recentGap', () => {
  const H = 3_600_000;
  const first = 100 * H;

  it('asks when the span starts over an hour before recent.json and the series has older data', () => {
    expect(recentGap(first - 48 * H, first, first - 30 * 24 * H)).toBe(true);
  });

  it('does not ask when the series starts inside the window, or within the hour before it', () => {
    expect(recentGap(first - 48 * H, first, first + H)).toBe(false);
    expect(recentGap(first - 48 * H, first, first - H)).toBe(false);
    expect(recentGap(first - 48 * H, first, first - H - 1)).toBe(true);
  });

  it('does not ask when the span starts inside recent.json or within the hour before it', () => {
    expect(recentGap(first + H, first, 0)).toBe(false);
    expect(recentGap(first - H, first, 0)).toBe(false);
  });

  it('does not ask without a first point or without dataSince', () => {
    expect(recentGap(0, undefined, 0)).toBe(false);
    expect(recentGap(0, first, undefined)).toBe(false);
  });
});

describe('xRange and onAxis', () => {
  it('is the span, stretched to the run end only when the run reaches further', () => {
    expect(xRange({ from: 10, to: 20 }, undefined)).toEqual({ min: 10, max: 20 });
    expect(xRange({ from: 10, to: 20 }, 30)).toEqual({ min: 10, max: 30 });
    expect(xRange({ from: 10, to: 20 }, 15)).toEqual({ min: 10, max: 20 });
  });

  it('shows an instant only inside the axis, both ends included', () => {
    const x = { min: 10, max: 20 };
    expect([9, 10, 15, 20, 21].map((at) => onAxis(at, x))).toEqual([false, true, true, true, false]);
  });
});

describe('seriesRows', () => {
  const view = forecastView(run, id, NOW);

  it('lists the union of measured and forecast instants, newest first, each once', () => {
    const rows = seriesRows(
      [
        [NOW - H, 7],
        [NOW, 8],
        [NOW + 2 * H, 9],
      ],
      view,
    );
    expect(rows.map((r) => r.ts)).toEqual([NOW + 3 * H, NOW + 2 * H, NOW + H, NOW, NOW - H]);
    // the junction instant (NOW + 2 h) belongs to the provider part and the estimate part: still one row
    expect(rows.filter((r) => r.ts === NOW + 2 * H)).toHaveLength(1);
  });

  it('folds the band into the forecast cell and leaves the empty cells null', () => {
    const rows = seriesRows([[NOW, 8]], view);
    const at = (h: number) => rows.find((r) => r.ts === NOW + h * H);
    expect(at(0)).toMatchObject({ measured: 8, forecast: 1, band: [0, 2] });
    expect(at(1)).toMatchObject({ measured: null, forecast: 2, band: [1, 3] });
    // a forecast value that is null stays an empty cell
    expect(at(2)?.forecast).toBeNull();
  });

  it('has only measured rows without a run', () => {
    expect(seriesRows([[NOW, 5]], undefined)).toEqual([{ ts: NOW, measured: 5, forecast: null, band: null }]);
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
    expect(httpsHref('https://a.example/x')).toBe('https://a.example/x');
    expect(httpsHref('http://a.example')).toBeUndefined();
    expect(httpsHref('javascript:alert(1)')).toBeUndefined();
    expect(httpsHref(null)).toBeUndefined();
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
