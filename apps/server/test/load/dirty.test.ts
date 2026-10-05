import { describe, expect, it } from 'vitest';
import { bumpedDays, dirtyEntriesOf, narrow, type Visible, visibilityChange } from '../../src/load/dirty.ts';

// P9a: the loader's day bumps (a superset of settled) and migrate's precise registry bump (§9 C10).

describe('bumpedDays', () => {
  it('lists the days of a range that began more than 48 h before now', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(bumpedDays(Date.parse('2026-09-30T23:00:00Z'), now, now)).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(bumpedDays(Date.parse('2026-10-02T12:00:00Z'), now, now)).toEqual(['2026-10-02']);
    expect(bumpedDays(Date.parse('2026-10-03T00:00:00Z'), now, now)).toEqual([]);
  });
});

describe('narrow', () => {
  it('keeps the narrower audience', () => {
    expect(narrow('public', 'owner')).toBe('owner');
    expect(narrow('owner', 'off')).toBe('off');
    expect(narrow('public', 'public')).toBe('public');
  });
});

describe('visibilityChange', () => {
  const base: Visible = { series: { '1': [3600, true], '2': [7200, false] }, nl4: 'a', attribution: 'b' };
  const with_ = (patch: Partial<Visible>): Visible => ({ ...base, ...patch });
  it('bumps nothing on pure additions', () => {
    expect(visibilityChange(base, base)).toBeUndefined();
    expect(visibilityChange(base, with_({ series: { ...base.series, '3': [60, true] } }))).toBeUndefined();
  });
  it('narrows when a series goes or loses history_export', () => {
    expect(visibilityChange(base, with_({ series: { '1': [3600, true] } }))).toBe('narrowed');
    expect(visibilityChange(base, with_({ series: { '1': [3600, false], '2': [7200, false] } }))).toBe('narrowed');
    expect(visibilityChange(base, with_({ series: { '1': [60, true] }, nl4: 'x' }))).toBe('narrowed');
  });
  it("calls a staleness, a widening or a digest change 'registry'", () => {
    expect(visibilityChange(base, with_({ series: { '1': [60, true], '2': [7200, false] } }))).toBe('registry');
    expect(visibilityChange(base, with_({ series: { '1': [3600, true], '2': [7200, true] } }))).toBe('registry');
    expect(visibilityChange(base, with_({ nl4: 'x' }))).toBe('registry');
    expect(visibilityChange(base, with_({ attribution: 'x' }))).toBe('registry');
  });
});

describe('dirtyEntriesOf', () => {
  const none = { obs: [], forecast: [], reference: [], class: [], warning: [], gauge_zero: [] };
  const series = new Map([[1, { station: 'nl.a.x', audience: 'owner' as const }]]);
  const stations = new Map([
    ['nl.pub.x', 'public' as const],
    ['be.own.y', 'owner' as const],
  ]);
  it("narrows a series touch to the series' audience and a station touch to the station's (review SEC-2)", () => {
    const entries = dirtyEntriesOf(
      'public',
      {
        ...none,
        obs: [{ series: 1, from: 0, to: 1 }],
        class: [
          { station: 'nl.pub.x', from: 5 },
          { station: 'be.own.y', from: 5 },
          { station: 'xx.unknown.z', from: 5 },
        ],
        warning: [{ from: null }],
      },
      series,
      stations,
    );
    expect(entries.map((e) => [e.kind, e.audience, e.stations])).toEqual([
      ['obs', 'owner', ['nl.a.x']],
      ['class', 'public', ['nl.pub.x']],
      ['class', 'owner', ['be.own.y']],
      ['class', 'off', ['xx.unknown.z']],
      ['warning', 'public', []],
    ]);
    expect(entries[4]).toMatchObject({ from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY });
    // An owner payload never widens: its public station still dirties the owner family only.
    expect(
      dirtyEntriesOf('owner', { ...none, class: [{ station: 'nl.pub.x', from: 5 }] }, series, stations)[0]?.audience,
    ).toBe('owner');
  });
});
