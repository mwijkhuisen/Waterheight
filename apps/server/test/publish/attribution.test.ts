import { describe, expect, it } from 'vitest';
import { type AttributionRow, attributionFor, standText } from '../../src/attribution.ts';

// P9a (§4.2): a file's attribution lists exactly the sources its body names; a licence's date only where it asks.

const row = (source_id: string, text: string, date_kind: AttributionRow['date_kind'] = null): AttributionRow => ({
  source_id,
  lang: null,
  text,
  url: null,
  required: true,
  date_kind,
});

describe('attributionFor', () => {
  it('keeps the rows of the named sources in row order, with dates only for dated licences', () => {
    const rows = [row('DE-1', 'a'), row('DE-6', 'b', 'update'), row('FR-1', 'c', 'retrieval'), row('NL-1', 'd')];
    const dates = new Map([
      ['DE-6', { date: '2026-10-04T10:00:00.000Z', dateText: 'Stand: 04.10.2026 12:00' }],
      ['NL-1', { date: '2026-10-04T10:00:00.000Z', dateText: null }],
    ]);
    expect(attributionFor(rows, ['NL-1', 'DE-6', 'XX-9'], dates)).toEqual([
      {
        source: 'DE-6',
        lang: null,
        text: 'b',
        url: null,
        required: true,
        dateKind: 'update',
        date: '2026-10-04T10:00:00.000Z',
        dateText: 'Stand: 04.10.2026 12:00',
      },
      { source: 'NL-1', lang: null, text: 'd', url: null, required: true, dateKind: null, date: null, dateText: null },
    ]);
    expect(attributionFor(rows, ['FR-1'])[0]).toMatchObject({ dateKind: 'retrieval', date: null });
  });
});

describe('standText', () => {
  it('writes the LHP Stand in Europe/Berlin, summer and winter time', () => {
    expect(standText(Date.parse('2026-10-04T10:05:00Z'))).toBe('Stand: 04.10.2026 12:05');
    expect(standText(Date.parse('2026-12-31T23:30:00Z'))).toBe('Stand: 01.01.2027 00:30');
  });
});
