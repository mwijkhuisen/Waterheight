import { describe, expect, it } from 'vitest';
import { adapter, buildCheck } from '../../src/adapters/nl-1/capture.ts';
import { baseRequest } from '../../src/capture/specs.ts';
import type { Row } from '../../src/http/types.ts';
import { registry } from '../capture/helpers.ts';

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
    const specs = registry.specs.filter((s) => s.source === 'NL-1' && s.id.startsWith('nl-1-obs'));
    expect(specs.length).toBeGreaterThanOrEqual(3);
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
