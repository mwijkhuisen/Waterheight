import { describe, expect, it } from 'vitest';
import { attributionOf, bodySources, historyCapMs } from '../../src/api/answer.ts';
import type { AttributionRow, SourceDate } from '../../src/attribution.ts';
import { FILLED_BY } from '../../src/load/adapters.ts';

// The attribution of an API answer is a pure rule over the body (P9b): which sources a body names, with which
// dates, and for how long a body with history-limited values may be kept.

const ms = (iso: string) => Date.parse(iso);
const obj = (m: Map<string, number | null>) => Object.fromEntries(m);
const SERIES: Record<number, string> = { 1: 'FR-1', 2: 'CH-1', 3: 'NL-1', 4: 'DE-1' };
const sourceOf = (id: number) => SERIES[id];

describe('bodySources', () => {
  it('the fill sources follow the registry (FR-3 fills FR-1, CH-3 fills CH-1)', () => {
    expect(FILLED_BY.get('FR-1')).toContain('FR-3');
    expect(FILLED_BY.get('CH-1')).toContain('CH-3');
  });

  it('snapshot: every value names its series source; a qc 512 value on FR-1 names FR-3; bases name theirs', () => {
    const body = {
      values: [
        { series: 1, ts: '2026-10-01T10:00:00Z', qc: 512, basis: { source: 'NL-4' } },
        { series: 1, ts: '2026-10-01T09:00:00Z', qc: 0, basis: null },
        {
          series: 4,
          ts: '2026-10-01T10:10:00Z',
          qc: 0,
          basis: null,
          area: { basis: { source: 'DE-6' } },
        },
        { series: 3, ts: '2026-10-01T10:20:00Z', qc: 1, basis: undefined },
      ],
    };
    expect(obj(bodySources('snapshot', body, sourceOf))).toEqual({
      'FR-1': ms('2026-10-01T10:00:00Z'),
      'FR-3': ms('2026-10-01T10:00:00Z'),
      'NL-4': null,
      'DE-1': ms('2026-10-01T10:10:00Z'),
      'DE-6': null,
      'NL-1': ms('2026-10-01T10:20:00Z'),
    });
  });

  it('snapshot: a value without bit 512 names no fill source', () => {
    const body = { values: [{ series: 1, ts: '2026-10-01T10:00:00Z', qc: 511, basis: null }] };
    expect(obj(bodySources('snapshot', body, sourceOf))).toEqual({ 'FR-1': ms('2026-10-01T10:00:00Z') });
  });

  it('snapshot: forecasts name their series source, their own source and their basis; no `forecasts` key is fine', () => {
    const body = {
      values: [],
      forecasts: [
        { series: 2, source: 'CH-4', issuedAt: '2026-10-01T06:00:00Z', basis: { source: 'CH-5' } },
        { series: 2, source: 'CH-4', issuedAt: '2026-10-01T08:00:00Z', basis: null },
      ],
    };
    expect(obj(bodySources('snapshot', body, sourceOf))).toEqual({
      'CH-1': null,
      'CH-4': ms('2026-10-01T08:00:00Z'),
      'CH-5': null,
    });
    expect(obj(bodySources('snapshot', { values: [] }, sourceOf))).toEqual({});
  });

  it('series raw: names the series source at its newest point, and CH-3 for a qc 512 point', () => {
    const body = {
      id: 2,
      points: [
        { ts: '2026-10-01T10:00:00Z', qc: 512 },
        { ts: '2026-10-01T11:00:00Z', qc: 0 },
      ],
    };
    expect(obj(bodySources('series', body, sourceOf))).toEqual({
      'CH-1': ms('2026-10-01T11:00:00Z'),
      'CH-3': ms('2026-10-01T10:00:00Z'),
    });
  });

  it('series 1h: reads buckets and qcOr', () => {
    const body = {
      id: 2,
      points: [
        { bucket: '2026-10-01T10:00:00Z', qcOr: 512 },
        { bucket: '2026-10-01T12:00:00Z', qcOr: 513 },
        { bucket: '2026-10-01T11:00:00Z', qcOr: 0 },
      ],
    };
    expect(obj(bodySources('series', body, sourceOf))).toEqual({
      'CH-1': ms('2026-10-01T12:00:00Z'),
      'CH-3': ms('2026-10-01T12:00:00Z'),
    });
  });

  it('series with no points names its series source without a date', () => {
    expect(obj(bodySources('series', { id: 3, points: [] }, sourceOf))).toEqual({ 'NL-1': null });
  });

  it('forecast: the series source and, with a run, the run source at its issue time', () => {
    const run = { source: 'CH-4', issuedAt: '2026-10-01T06:00:00Z' };
    expect(obj(bodySources('forecast', { series: 2, run }, sourceOf))).toEqual({
      'CH-1': null,
      'CH-4': ms('2026-10-01T06:00:00Z'),
    });
    expect(obj(bodySources('forecast', { series: 2, run: null }, sourceOf))).toEqual({ 'CH-1': null });
  });

  it('stations: every series of every station names its source', () => {
    const body = {
      stations: [
        { series: [{ source: 'NL-1' }, { source: 'DE-1' }] },
        { series: [{ source: 'NL-1' }] },
        { series: [] },
      ],
    };
    expect(obj(bodySources('stations', body, sourceOf))).toEqual({ 'NL-1': null, 'DE-1': null });
  });

  it('meta: its sources and its forecast horizons', () => {
    const body = {
      sources: [{ id: 'NL-1' }, { id: 'DE-1' }],
      forecastHorizons: [{ source: 'CH-4' }, { source: 'NL-1' }],
    };
    expect(obj(bodySources('meta', body, sourceOf))).toEqual({ 'NL-1': null, 'DE-1': null, 'CH-4': null });
    expect(obj(bodySources('meta', { sources: [], forecastHorizons: [] }, sourceOf))).toEqual({});
  });

  it('healthSources: its sources and its quarantined batches', () => {
    const body = {
      sources: [{ id: 'NL-1' }],
      quarantined_batches: [{ source: 'FR-1' }, { source: 'NL-1' }],
    };
    expect(obj(bodySources('healthSources', body, sourceOf))).toEqual({ 'NL-1': null, 'FR-1': null });
  });

  it.each([
    ['snapshot', { values: [{ series: 99, ts: '2026-10-01T10:00:00Z', qc: 0, basis: null }] }],
    ['snapshot', { values: [], forecasts: [{ series: 99, source: 'CH-4', issuedAt: '2026-10-01T10:00:00Z' }] }],
    ['series', { id: 99, points: [] }],
    ['forecast', { series: 99, run: null }],
  ] as const)('an unknown series id (%s) throws attribution_missing', (kind, body) => {
    expect(() => bodySources(kind, body, sourceOf)).toThrow(expect.objectContaining({ code: 'attribution_missing' }));
  });
});

describe('attributionOf', () => {
  const row = (source_id: string, over: Partial<AttributionRow> = {}): AttributionRow => ({
    source_id,
    lang: 'nl',
    text: `text ${source_id}`,
    url: `https://example.org/${source_id}`,
    required: true,
    date_kind: null,
    ...over,
  });
  const st = (
    sources: string[],
    attribution: AttributionRow[],
    dates: [string, SourceDate][] = [],
  ): Parameters<typeof attributionOf>[0] => ({
    sources: new Set(sources),
    attribution,
    dates: new Map(dates),
  });
  const NOW = ms('2026-10-05T12:00:00Z');

  it('a named source outside the family throws attribution_missing', () => {
    const named = new Map([['OWNER-X', null]]);
    expect(() => attributionOf(st(['NL-1'], [row('NL-1')]), named, { live: true, at: NOW })).toThrow(
      expect.objectContaining({ code: 'attribution_missing' }),
    );
    // Even when a row for it exists and another named source is fine.
    expect(() =>
      attributionOf(
        st(['NL-1'], [row('NL-1'), row('OWNER-X')]),
        new Map([
          ['NL-1', null],
          ['OWNER-X', null],
        ]),
        {
          live: false,
          at: NOW,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'attribution_missing' }));
  });

  it('a source in the family with no rows gives no entry; unnamed sources give none either', () => {
    const named = new Map([
      ['LU-3', null],
      ['NL-1', null],
    ]);
    const out = attributionOf(st(['LU-3', 'NL-1', 'DE-1'], [row('NL-1'), row('DE-1')]), named, {
      live: false,
      at: NOW,
    });
    expect(out.map((e) => e.source)).toEqual(['NL-1']);
  });

  it('returns the rows verbatim, in row order, several languages included', () => {
    const rows = [
      row('DE-1', { lang: 'de', text: 'Daten: WSV' }),
      row('DE-1', { lang: 'en', text: 'Data: WSV', url: null, required: false }),
      row('NL-1'),
    ];
    const out = attributionOf(
      st(['DE-1', 'NL-1'], rows),
      new Map([
        ['NL-1', null],
        ['DE-1', null],
      ]),
      {
        live: false,
        at: NOW,
      },
    );
    expect(out).toEqual([
      {
        source: 'DE-1',
        lang: 'de',
        text: 'Daten: WSV',
        url: 'https://example.org/DE-1',
        required: true,
        dateKind: null,
        date: null,
        dateText: null,
      },
      {
        source: 'DE-1',
        lang: 'en',
        text: 'Data: WSV',
        url: null,
        required: false,
        dateKind: null,
        date: null,
        dateText: null,
      },
      {
        source: 'NL-1',
        lang: 'nl',
        text: 'text NL-1',
        url: 'https://example.org/NL-1',
        required: true,
        dateKind: null,
        date: null,
        dateText: null,
      },
    ]);
  });

  it('live: the date comes from the loader (dates)', () => {
    const rows = [row('NL-1', { date_kind: 'retrieval' })];
    const out = attributionOf(
      st(['NL-1'], rows, [['NL-1', { date: '2026-10-05T11:50:00.000Z', dateText: null }]]),
      new Map([['NL-1', ms('2026-10-01T10:00:00Z')]]),
      { live: true, at: NOW },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ dateKind: 'retrieval', date: '2026-10-05T11:50:00.000Z', dateText: null });
  });

  it('live without a usable loader date falls back to the body instant, else to `at`', () => {
    const rows = [row('NL-1', { date_kind: 'update' }), row('DE-1', { date_kind: 'update' })];
    const dates: [string, SourceDate][] = [['NL-1', { date: null, dateText: null }]];
    const out = attributionOf(
      st(['NL-1', 'DE-1'], rows, dates),
      new Map([
        ['NL-1', ms('2026-10-01T10:00:00Z')],
        ['DE-1', null],
      ]),
      { live: true, at: ms('2026-10-02T00:00:00Z') },
    );
    expect(out.find((e) => e.source === 'NL-1')?.date).toBe('2026-10-01T10:00:00.000Z');
    expect(out.find((e) => e.source === 'DE-1')?.date).toBe('2026-10-02T00:00:00.000Z');
  });

  it('historical: never the loader date, the body instant, else `at`', () => {
    const rows = [row('NL-1', { date_kind: 'update' }), row('DE-1', { date_kind: 'update' })];
    const dates: [string, SourceDate][] = [
      ['NL-1', { date: '2026-10-05T11:50:00.000Z', dateText: null }],
      ['DE-1', { date: '2026-10-05T11:50:00.000Z', dateText: null }],
    ];
    const out = attributionOf(
      st(['NL-1', 'DE-1'], rows, dates),
      new Map([
        ['NL-1', ms('2026-10-01T10:00:00Z')],
        ['DE-1', null],
      ]),
      { live: false, at: ms('2026-10-02T00:00:00Z') },
    );
    expect(out.find((e) => e.source === 'NL-1')?.date).toBe('2026-10-01T10:00:00.000Z');
    expect(out.find((e) => e.source === 'DE-1')?.date).toBe('2026-10-02T00:00:00.000Z');
  });

  it('DE-6 gets dateText "Stand: ..." in Europe/Berlin, from the instant it falls back to', () => {
    const rows = [row('DE-6', { date_kind: 'update', lang: 'de' })];
    // 10:00Z is 12:00 in Berlin on 2026-10-01 (CEST).
    const hist = attributionOf(st(['DE-6'], rows), new Map([['DE-6', ms('2026-10-01T10:00:00Z')]]), {
      live: false,
      at: NOW,
    });
    expect(hist[0]).toMatchObject({ date: '2026-10-01T10:00:00.000Z', dateText: 'Stand: 01.10.2026 12:00' });
    // After the clocks go back (CET, 2026-10-26): 10:00Z is 11:00.
    const winter = attributionOf(st(['DE-6'], rows), new Map([['DE-6', null]]), {
      live: true,
      at: ms('2026-10-26T10:00:00Z'),
    });
    expect(winter[0]).toMatchObject({ dateText: 'Stand: 26.10.2026 11:00' });
  });

  it('DE-6 live: the loader date and its dateText are used as they are', () => {
    const rows = [row('DE-6', { date_kind: 'update', lang: 'de' })];
    const out = attributionOf(
      st(['DE-6'], rows, [['DE-6', { date: '2026-10-04T07:00:00.000Z', dateText: 'Stand: 04.10.2026 09:00' }]]),
      new Map([['DE-6', null]]),
      { live: true, at: NOW },
    );
    expect(out[0]).toMatchObject({ date: '2026-10-04T07:00:00.000Z', dateText: 'Stand: 04.10.2026 09:00' });
  });

  it('a row with no date kind gets no date, whatever the dates hold', () => {
    const rows = [row('NL-1', { date_kind: null })];
    const out = attributionOf(
      st(['NL-1'], rows, [['NL-1', { date: '2026-10-05T11:50:00.000Z', dateText: 'x' }]]),
      new Map([['NL-1', ms('2026-10-01T10:00:00Z')]]),
      { live: true, at: NOW },
    );
    expect(out[0]).toMatchObject({ dateKind: null, date: null, dateText: null });
  });

  it('is a pure function of the body for a historical answer', () => {
    const rows = [row('NL-1', { date_kind: 'update' })];
    const named = new Map([['NL-1', ms('2026-10-01T10:00:00Z')]]);
    const a = attributionOf(st(['NL-1'], rows), named, { live: false, at: ms('2026-10-02T00:00:00Z') });
    const b = attributionOf(
      st(['NL-1'], rows, [['NL-1', { date: '2027-01-01T00:00:00.000Z', dateText: null }]]),
      named,
      { live: false, at: ms('2026-10-02T00:00:00Z') },
    );
    expect(a).toEqual(b);
  });
});

describe('historyCapMs', () => {
  const NOW = ms('2026-10-05T12:00:00Z');
  const H = 3_600_000;
  const history = new Map([[1, 24 * H]]);

  it('is Infinity without history entries, whatever the body holds', () => {
    const body = { values: [{ series: 1, ts: '2026-09-01T00:00:00Z' }] };
    expect(historyCapMs('snapshot', body, new Map(), NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('snapshot: window - (now - ts) of the oldest value of a capped series', () => {
    const body = {
      values: [
        { series: 1, ts: '2026-10-05T10:00:00Z' }, // 2 h old: 22 h left
        { series: 1, ts: '2026-10-05T00:00:00Z' }, // 12 h old: 12 h left
        { series: 2, ts: '2026-01-01T00:00:00Z' }, // not capped
      ],
    };
    expect(historyCapMs('snapshot', body, history, NOW)).toBe(12 * H);
  });

  it('snapshot: the smallest cap over several capped series', () => {
    const two = new Map([
      [1, 24 * H],
      [2, 3 * H],
    ]);
    const body = {
      values: [
        { series: 1, ts: '2026-10-05T11:00:00Z' }, // 23 h left
        { series: 2, ts: '2026-10-05T10:00:00Z' }, // 1 h left
      ],
    };
    expect(historyCapMs('snapshot', body, two, NOW)).toBe(1 * H);
  });

  it('is Infinity when no value of the body is of a capped series', () => {
    const body = { values: [{ series: 2, ts: '2026-10-05T10:00:00Z' }] };
    expect(historyCapMs('snapshot', body, history, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(historyCapMs('snapshot', { values: [] }, history, NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is never below 0: a value already out of the window gives 0', () => {
    const body = { values: [{ series: 1, ts: '2026-10-03T00:00:00Z' }] }; // 60 h old, window 24 h
    expect(historyCapMs('snapshot', body, history, NOW)).toBe(0);
  });

  it('a value exactly at the window edge gives 0', () => {
    const body = { values: [{ series: 1, ts: '2026-10-04T12:00:00Z' }] };
    expect(historyCapMs('snapshot', body, history, NOW)).toBe(0);
  });

  it('series: reads ts and bucket; the series id is the body id', () => {
    const raw = {
      id: 1,
      points: [{ ts: '2026-10-05T06:00:00Z' }, { ts: '2026-10-05T11:00:00Z' }],
    };
    expect(historyCapMs('series', raw, history, NOW)).toBe(18 * H);
    const hourly = { id: 1, points: [{ bucket: '2026-10-05T09:00:00Z' }] };
    expect(historyCapMs('series', hourly, history, NOW)).toBe(21 * H);
    expect(historyCapMs('series', { ...raw, id: 2 }, history, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(historyCapMs('series', { id: 1, points: [] }, history, NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('other kinds are not capped', () => {
    for (const kind of ['meta', 'stations', 'forecast', 'healthSources'] as const)
      expect(historyCapMs(kind, { series: 1 }, history, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});
