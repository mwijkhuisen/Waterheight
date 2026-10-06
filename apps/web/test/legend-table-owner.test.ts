import { describe, expect, it } from 'vitest';
import { dhGlyph, dhItems, LHP_ALERT_CODES, qItems, stateItems } from '../src/features/legend/items.ts';
import { httpsHref } from '../src/features/owner/href.ts';
import { clampPage, dhCell, PAGE_SIZE, pageCount, pageOf, pageRange } from '../src/features/table/page.ts';

describe('legend items', () => {
  it('lists six states, no_ref last', () => {
    const s = stateItems();
    expect(s).toHaveLength(6);
    expect(s.at(-1)?.state).toBe('no_ref');
  });
  it('lists seven bins with glyphs', () => {
    const d = dhItems();
    expect(d.map((i) => i.glyph)).toEqual(['▼', '▼', '▼', '', '▲', '▲', '▲']);
    expect(dhGlyph('rising')).toBe('▲');
    expect(dhGlyph('steady')).toBe('');
  });
  it('lists the Q classes with the edges', () => {
    const q = qItems();
    expect(q.map((i) => i.kind)).toEqual(['lt', 'range', 'range', 'ge']);
    expect(q[0]?.hi).toBe(10);
    expect(q[1]).toMatchObject({ lo: 10, hi: 100 });
    expect(q[3]?.lo).toBe(1000);
    expect(LHP_ALERT_CODES).not.toContain('3');
  });
});

describe('table paging', () => {
  it('counts and clamps', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(clampPage(9, 250)).toBe(2);
    expect(clampPage(-1, 250)).toBe(0);
  });
  it('ranges and pages', () => {
    expect(pageRange(0, 0)).toEqual({ from: 0, to: 0 });
    expect(pageRange(0, 250)).toEqual({ from: 1, to: 100 });
    expect(pageRange(2, 250)).toEqual({ from: 201, to: 250 });
    expect(pageOf(99)).toBe(0);
    expect(pageOf(100)).toBe(1);
  });
  it('builds the dh cell', () => {
    expect(dhCell(null, 'H')).toBeNull();
    expect(dhCell({ dh: 60, trend: 'rising' }, 'H')).toMatchObject({ bin: 3 });
    expect(dhCell({ dh: 1, trend: 'steady' }, 'H')).toMatchObject({ bin: 0 });
  });
});

describe('owner href', () => {
  it('only https', () => {
    expect(httpsHref('https://example.org/x')).toBe('https://example.org/x');
    expect(httpsHref('http://example.org')).toBeUndefined();
    expect(httpsHref('javascript:alert(1)')).toBeUndefined();
    expect(httpsHref('nonsense')).toBeUndefined();
  });
});
