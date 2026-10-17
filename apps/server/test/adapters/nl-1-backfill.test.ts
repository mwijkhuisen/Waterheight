import { describe, expect, it } from 'vitest';
import { adapter, buildCheck } from '../../src/adapters/nl-1/capture.ts';
import { baseRequest } from '../../src/capture/specs.ts';
import type { Row } from '../../src/http/types.ts';
import { fixture, spec } from '../capture/helpers.ts';

// P14a additions to the NL-1 capture adapter: the optional Q Hoedanigheid (backfill only) and the probe body.

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const build = (row: Row, params: Record<string, string>, from: Date, to: Date) => {
  const req = { url: 'https://x.invalid/', method: 'POST' as const, headers: {}, variant: 'v' };
  return (adapter.build as NonNullable<typeof adapter.build>)({
    req,
    row,
    now: new Date(),
    window: { from, to },
    params,
  }).body;
};

describe('Q Hoedanigheid', () => {
  const from = new Date('2026-05-01T00:00:00Z');
  const to = new Date('2026-06-10T00:00:00Z');

  it('live bodies are byte-identical to what they were: every row of every NL-1 observation spec', () => {
    // Roadmap 1's three observation specs; the P16a ones (sea, wide, slow, tide) carry their own rows and bodies.
    const specs = ['nl-1-obs-key', 'nl-1-obs-other', 'nl-1-obs-twin'].map((id) => spec(id));
    for (const s of specs) {
      expect(s.params.hoedanigheid === undefined || s.params.hoedanigheid === 'TAW', s.id).toBe(true);
      for (const row of s.rows) {
        const req = baseRequest(s, row);
        const got = (adapter.build as NonNullable<typeof adapter.build>)({
          req,
          row,
          now: new Date(),
          window: { from, to },
          params: s.params,
        }).body;
        // The layout the adapter had before P14a, written out key by key.
        const aquo =
          row.quantity === 'Q'
            ? '{"Grootheid":{"Code":"Q"},"ProcesType":"meting"}'
            : `{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"},"Hoedanigheid":{"Code":"${s.params.hoedanigheid === 'TAW' ? 'TAW' : 'NAP'}"},"ProcesType":"meting"}`;
        expect(got, `${s.id} ${row.code}`).toBe(
          `{"Locatie":{"Code":"${row.code}"},"AquoPlusWaarnemingMetadata":{"AquoMetadata":${aquo}},"Periode":{"Begindatumtijd":"${utc(from)}","Einddatumtijd":"${utc(to)}"}}`,
        );
      }
    }
  });

  it('Q names its Hoedanigheid only when the params give one', () => {
    const row = { code: 'lobith.bovenrijn.tolkamer', quantity: 'Q' };
    expect(
      JSON.parse(build(row, { proces: 'meting' }, from, to) ?? '').AquoPlusWaarnemingMetadata.AquoMetadata,
    ).toEqual({
      Grootheid: { Code: 'Q' },
      ProcesType: 'meting',
    });
    const body = build(row, { proces: 'meting', hoedanigheid: 'NVT' }, from, to) ?? '';
    expect(JSON.parse(body).AquoPlusWaarnemingMetadata.AquoMetadata).toEqual({
      Grootheid: { Code: 'Q' },
      Hoedanigheid: { Code: 'NVT' },
      ProcesType: 'meting',
    });
    expect(body).toContain('"Grootheid":{"Code":"Q"},"Hoedanigheid":{"Code":"NVT"},"ProcesType":"meting"');
  });

  it('H keeps asking NAP when the params say NAP', () => {
    const body =
      build(
        { code: 'lobith.bovenrijn.tolkamer', quantity: 'H' },
        { proces: 'meting', hoedanigheid: 'NAP' },
        from,
        to,
      ) ?? '';
    expect(JSON.parse(body).AquoPlusWaarnemingMetadata.AquoMetadata.Hoedanigheid).toEqual({ Code: 'NAP' });
  });
});

describe('buildCheck', () => {
  const from = new Date('1995-01-01T00:00:00Z');
  const to = new Date('1996-01-01T00:00:00Z');

  it('is the CheckWaarnemingenAanwezig body with the series method', () => {
    expect(
      JSON.parse(
        buildCheck({ code: 'lobith.bovenrijn.tolkamer', quantity: 'H', hoedanigheid: 'NAP' }, from, to, 'other:F007'),
      ),
    ).toEqual({
      LocatieLijst: [{ Code: 'lobith.bovenrijn.tolkamer' }],
      AquoMetadataLijst: [
        {
          Compartiment: { Code: 'OW' },
          Grootheid: { Code: 'WATHTE' },
          Hoedanigheid: { Code: 'NAP' },
          ProcesType: 'meting',
          WaardeBepalingsMethode: { Code: 'other:F007' },
        },
      ],
      Periode: { Begindatumtijd: '1995-01-01T00:00:00Z', Einddatumtijd: '1996-01-01T00:00:00Z' },
    });
  });

  it('Q defaults to NVT, H to NAP, and no method means no WaardeBepalingsMethode', () => {
    const q = JSON.parse(buildCheck({ code: 'x', quantity: 'Q' }, from, to)).AquoMetadataLijst[0];
    expect(q).toEqual({
      Compartiment: { Code: 'OW' },
      Grootheid: { Code: 'Q' },
      Hoedanigheid: { Code: 'NVT' },
      ProcesType: 'meting',
    });
    expect(JSON.parse(buildCheck({ code: 'x', quantity: 'H' }, from, to)).AquoMetadataLijst[0].Hoedanigheid).toEqual({
      Code: 'NAP',
    });
  });
});

// P16a: roadmap 1's remaining request bodies stay byte-identical (forecast H and Q, backfill Q with NVT), and the new
// row fields and params build the new bodies; anything outside the enums throws.
describe('P16a request bodies', () => {
  const req = { url: 'https://x.invalid/', method: 'POST' as const, headers: {}, variant: 'v' };
  const now = new Date('2026-10-17T12:34:56Z');
  const b = (row: Row, params: Record<string, string>, window: { from: Date; to: Date } | null = null) =>
    (adapter.build as NonNullable<typeof adapter.build>)({ req, row, now, window, params }).body ?? '';
  const per = (code: string, aquo: string, from: string, to: string) =>
    `{"Locatie":{"Code":"${code}"},"AquoPlusWaarnemingMetadata":{"AquoMetadata":${aquo}},"Periode":{"Begindatumtijd":"${from}","Einddatumtijd":"${to}"}}`;
  const win = { from: new Date('2026-10-17T09:00:30Z'), to: new Date('2026-10-17T12:00:00Z') };

  it('forecast H and Q, as they were', () => {
    const h =
      '{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"},"Hoedanigheid":{"Code":"NAP"},"ProcesType":"verwachting"}';
    const q = '{"Grootheid":{"Code":"Q"},"ProcesType":"verwachting"}';
    expect(b({ code: 'a', quantity: 'H' }, { proces: 'verwachting' })).toBe(
      per('a', h, '2026-10-17T12:24:00Z', '2026-10-19T12:34:00Z'),
    );
    expect(b({ code: 'a', quantity: 'Q' }, { proces: 'verwachting' })).toBe(
      per('a', q, '2026-10-17T12:24:00Z', '2026-10-19T12:34:00Z'),
    );
    for (const id of ['nl-1-fc-1h', 'nl-1-fc-3h-0']) {
      const s = spec(id);
      for (const row of s.rows)
        expect(b(row, s.params), `${id} ${row.code}`).toBe(
          per(row.code as string, row.quantity === 'Q' ? q : h, '2026-10-17T12:24:00Z', '2026-10-19T12:34:00Z'),
        );
    }
  });

  it('the backfill Q body (params NVT, a row with no hoedanigheid) is unchanged', () => {
    expect(b({ code: 'a', quantity: 'Q' }, { proces: 'meting', hoedanigheid: 'NVT' }, win)).toBe(
      per(
        'a',
        '{"Grootheid":{"Code":"Q"},"Hoedanigheid":{"Code":"NVT"},"ProcesType":"meting"}',
        '2026-10-17T09:00:00Z',
        '2026-10-17T12:00:00Z',
      ),
    );
    // An empty seed field is no field.
    expect(b({ code: 'a', quantity: 'Q', hoedanigheid: '' }, { proces: 'meting' }, win)).toBe(
      per('a', '{"Grootheid":{"Code":"Q"},"ProcesType":"meting"}', '2026-10-17T09:00:00Z', '2026-10-17T12:00:00Z'),
    );
  });

  it('the row names its Hoedanigheid, grouping and method', () => {
    const p = { proces: 'meting' };
    expect(b({ code: 'a', quantity: 'H', hoedanigheid: 'MSL' }, p, win)).toContain(
      '"Hoedanigheid":{"Code":"MSL"},"ProcesType":"meting"}',
    );
    expect(b({ code: 'a', quantity: 'H', hoedanigheid: 'TAW' }, p, win)).toContain('"Hoedanigheid":{"Code":"TAW"}');
    expect(b({ code: 'a', quantity: 'Q', hoedanigheid: 'NVT' }, p, win)).toContain('"Hoedanigheid":{"Code":"NVT"}');
    expect(
      JSON.parse(b({ code: 'a', quantity: 'H', hoedanigheid: 'NAP', groepering: 'GETETM2' }, p, win))
        .AquoPlusWaarnemingMetadata.AquoMetadata,
    ).toEqual({
      Compartiment: { Code: 'OW' },
      Grootheid: { Code: 'WATHTE' },
      Groepering: { Code: 'GETETM2' },
      Hoedanigheid: { Code: 'NAP' },
      ProcesType: 'meting',
    });
    expect(
      JSON.parse(
        b(
          { code: 'a', quantity: 'H', hoedanigheid: 'NAP', method: 'other:F012' },
          { proces: 'astronomisch', ahead: 'P400D' },
        ),
      ).AquoPlusWaarnemingMetadata.AquoMetadata,
    ).toEqual({
      Compartiment: { Code: 'OW' },
      Grootheid: { Code: 'WATHTE' },
      Hoedanigheid: { Code: 'NAP' },
      ProcesType: 'astronomisch',
      WaardeBepalingsMethode: { Code: 'other:F012' },
    });
  });

  it('ahead is a forward window from the minute: 400 days is 57,600 values', () => {
    const body = JSON.parse(
      b({ code: 'a', quantity: 'H', hoedanigheid: 'NAP' }, { proces: 'astronomisch', ahead: 'P400D' }),
    );
    expect(body.Periode).toEqual({ Begindatumtijd: '2026-10-17T12:34:00Z', Einddatumtijd: '2027-11-21T12:34:00Z' });
    expect(() => b({ code: 'a', quantity: 'H' }, { proces: 'astronomisch', ahead: 'P1200D' })).toThrow(/160000/);
    expect(() => b({ code: 'a', quantity: 'H' }, { proces: 'astronomisch', ahead: 'tomorrow' })).toThrow();
  });

  it('fails closed on anything outside the enums', () => {
    const row = { code: 'a', quantity: 'H' };
    expect(() => b(row, { proces: 'forecast' }, win)).toThrow(/proces/);
    expect(() => b({ ...row, hoedanigheid: 'NVT' }, { proces: 'meting' }, win)).toThrow(/hoedanigheid/);
    expect(() => b({ code: 'a', quantity: 'Q', hoedanigheid: 'NAP' }, { proces: 'meting' }, win)).toThrow(
      /hoedanigheid/,
    );
    expect(() => b({ ...row, groepering: 'GETETX' }, { proces: 'meting' }, win)).toThrow(/groepering/);
    expect(() => b({ ...row, method: 'other:F12' }, { proces: 'meting' }, win)).toThrow(/method/);
  });

  it('a Q row cannot name a grouping or a method, and ahead needs astronomisch (CR-6)', () => {
    const q = { code: 'a', quantity: 'Q' };
    expect(() => b({ ...q, groepering: 'GETETM2' }, { proces: 'meting' }, win)).toThrow(/Q row/);
    expect(() => b({ ...q, method: 'other:F012' }, { proces: 'meting' }, win)).toThrow(/Q row/);
    expect(() => b({ code: 'a', quantity: 'H' }, { proces: 'meting', ahead: 'P2D' })).toThrow(/ahead/);
    expect(() => b({ code: 'a', quantity: 'H' }, { ahead: 'P2D' })).toThrow(/ahead/);
    expect(() => b(q, { proces: 'verwachting', ahead: 'P2D' })).toThrow(/ahead/);
  });

  // The request fields come back in the recorded answers (smoke recordings of 2026-10-17, trimmed copies).
  it.each([
    ['nl-1-astro-vlissingen-nap', 'NAP', ''],
    ['nl-1-hwlw-astro-goeree-lichteiland-msl', 'MSL', 'GETETBRKDMSL2'],
  ])('%s states ProcesType astronomisch, its Hoedanigheid and Groepering', (name, hoedanigheid, groepering) => {
    const doc = JSON.parse(fixture('NL-1', name).body.toString('utf8')) as {
      WaarnemingenLijst: {
        AquoMetadata: { ProcesType: string; Hoedanigheid: { Code: string }; Groepering: { Code: string } };
      }[];
    };
    expect(doc.WaarnemingenLijst).toHaveLength(1);
    const aquo = doc.WaarnemingenLijst[0]?.AquoMetadata;
    expect(aquo?.ProcesType).toBe('astronomisch');
    expect(aquo?.Hoedanigheid?.Code).toBe(hoedanigheid);
    expect(aquo?.Groepering?.Code).toBe(groepering);
  });
});
