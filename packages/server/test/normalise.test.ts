/**
 * Normaliser tests against fixtures recorded from the live service in Phase 1.
 * Nothing here touches the network.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildNaturalKey,
  normaliseCatalogue,
  normaliseLatest,
  normaliseLocationCode,
  normaliseObservations,
  normalisePoint,
  seriesIdentity,
  toUtcIso,
} from '../src/rws/normalise.js';
import {
  aggregateByLocation,
  isPlausibleCode,
  isPlausibleTimestamp,
  parsePointLatLon,
  parseWfsLatestCsv,
  parseWfsLatestRow,
  splitCsvLine,
} from '../src/rws/wfs.js';
import type { OphalenWaarnemingenResponse, OphalenCatalogusResponse } from '../src/rws/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/trimmed');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

describe('normaliseLocationCode', () => {
  it('lowercases, since codes were unified into dotted lowercase strings', () => {
    // HOEK, HVH25 and HOEKVHLD all became hoekvanholland upstream.
    expect(normaliseLocationCode('HOEKVANHOLLAND')).toBe('hoekvanholland');
    expect(normaliseLocationCode('  Ameland.Nes  ')).toBe('ameland.nes');
  });
});

describe('toUtcIso', () => {
  it('converts the fixed +01:00 offset the archive uses into UTC', () => {
    expect(toUtcIso('2026-07-01T01:00:00.000+01:00')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('handles a summer timestamp identically, because there is no DST switch', () => {
    // Verified live: March and October both return +01:00 throughout.
    expect(toUtcIso('2026-08-16T13:30:00.000+01:00')).toBe('2026-08-16T12:30:00.000Z');
  });

  it('throws rather than silently producing an Invalid Date', () => {
    expect(() => toUtcIso('not a timestamp')).toThrow(/Unparseable/);
  });
});

describe('normalisePoint', () => {
  it('keeps a normal reading intact', () => {
    const p = normalisePoint({
      Tijdstip: '2026-07-01T01:00:00.000+01:00',
      Meetwaarde: { Waarde_Alfanumeriek: '290', Waarde_Numeriek: 290 },
      WaarnemingMetadata: { Kwaliteitswaardecode: '00', Statuswaarde: 'Ongecontroleerd' },
    });
    expect(p).toEqual({
      t: '2026-07-01T00:00:00.000Z',
      value: 290,
      text: '290',
      qualityCode: '00',
      status: 'Ongecontroleerd',
    });
  });

  it('drops the 99999 sentinel on a gap but keeps the raw code and text', () => {
    // This is the whole reason value_numeric is nullable: real readings on this
    // series sit in the 90-420 range, so storing 99999 would poison min/max/mean.
    const p = normalisePoint({
      Tijdstip: '2026-07-07T12:30:00.000+01:00',
      Meetwaarde: { Waarde_Alfanumeriek: '99999', Waarde_Numeriek: 99999 },
      WaarnemingMetadata: { Kwaliteitswaardecode: '99' },
    });
    expect(p.value).toBeNull();
    expect(p.text).toBe('99999');
    expect(p.qualityCode).toBe('99');
  });

  it('treats a missing numeric value as null while keeping the text', () => {
    const p = normalisePoint({
      Tijdstip: '2026-07-01T01:00:00.000+01:00',
      Meetwaarde: { Waarde_Alfanumeriek: 'droogval' },
      WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
    });
    expect(p.value).toBeNull();
    expect(p.text).toBe('droogval');
  });
});

describe('seriesIdentity', () => {
  it('separates two series that differ only in sampling height', () => {
    // One (location, quantity) pair is NOT one series; a12 returns 50 series
    // from 19 quantity pairs. Collapsing them would lose data.
    const base = {
      Compartiment: { Code: 'OW' },
      Grootheid: { Code: 'WATHTE' },
      ProcesType: 'meting',
    };
    const a = seriesIdentity('vlissingen', base, { Bemonsteringshoogte: '0' });
    const b = seriesIdentity('vlissingen', base, { Bemonsteringshoogte: '-250' });
    expect(a.naturalKey).not.toBe(b.naturalKey);
  });

  it('separates two series that differ only in instrument', () => {
    const a = seriesIdentity('a12', {
      Compartiment: { Code: 'OW' }, Grootheid: { Code: 'Hm0' }, MeetApparaat: { Code: '10220' },
    }, {});
    const b = seriesIdentity('a12', {
      Compartiment: { Code: 'OW' }, Grootheid: { Code: 'Hm0' }, MeetApparaat: { Code: '10000' },
    }, {});
    expect(a.naturalKey).not.toBe(b.naturalKey);
  });

  it('gives the same key for the same metadata regardless of code casing', () => {
    const meta = { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } };
    expect(seriesIdentity('VLISSINGEN', meta, {}).naturalKey)
      .toBe(seriesIdentity('vlissingen', meta, {}).naturalKey);
  });

  it('treats empty-string dimensions as absent', () => {
    const withEmpty = seriesIdentity('x', {
      Compartiment: { Code: 'OW' }, Grootheid: { Code: 'T' }, Groepering: { Code: '' },
    }, {});
    const without = seriesIdentity('x', {
      Compartiment: { Code: 'OW' }, Grootheid: { Code: 'T' },
    }, {});
    expect(withEmpty.naturalKey).toBe(without.naturalKey);
  });

  it('defaults ProcesType to meting when absent', () => {
    expect(seriesIdentity('x', { Grootheid: { Code: 'WATHTE' } }, {}).procesType).toBe('meting');
  });
});

describe('buildNaturalKey', () => {
  it('renders nulls as empty so keys stay stable and aligned', () => {
    expect(buildNaturalKey(['a', null, 'c'])).toBe('a||c');
  });
});

describe('normaliseObservations against the recorded fixture', () => {
  const response = fixture<OphalenWaarnemingenResponse>('OphalenWaarnemingen.sample.json');

  it('normalises the real payload into at least one series with points', () => {
    const series = normaliseObservations(response);
    expect(series.length).toBeGreaterThan(0);
    const first = series[0]!;
    expect(first.location.code).toBe('a12');
    expect(first.identity.grootheid).toBe('Fp');
    expect(first.identity.procesType).toBe('meting');
    expect(first.points.length).toBeGreaterThan(0);
  });

  it('returns points sorted ascending in UTC', () => {
    const points = normaliseObservations(response)[0]!.points;
    const timestamps = points.map((p) => p.t);
    expect(timestamps).toEqual([...timestamps].sort());
    expect(timestamps.every((t) => t.endsWith('Z'))).toBe(true);
  });

  it('nulls the gap value while preserving its raw quality code', () => {
    const points = normaliseObservations(response).flatMap((s) => s.points);
    const gaps = points.filter((p) => p.qualityCode === '99');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((p) => p.value === null)).toBe(true);
    // The raw payload is kept so a consumer can still see what was sent.
    expect(gaps.every((p) => p.text === '99999')).toBe(true);
  });

  it('never emits the 99999 sentinel as a numeric value', () => {
    const values = normaliseObservations(response)
      .flatMap((s) => s.points)
      .map((p) => p.value)
      .filter((v): v is number => v !== null);
    expect(values).not.toContain(99999);
  });
});

describe('normaliseObservations merging behaviour', () => {
  it('merges one series split across several MetingenLijst entries', () => {
    // Upstream splits the same metadata over multiple entries; they must merge
    // rather than appear as two series.
    const split: OphalenWaarnemingenResponse = {
      WaarnemingenLijst: [
        {
          Locatie: { Code: 'vlissingen' },
          AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } },
          MetingenLijst: [{
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 1, Waarde_Alfanumeriek: '1' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          }],
        },
        {
          Locatie: { Code: 'vlissingen' },
          AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } },
          MetingenLijst: [{
            Tijdstip: '2026-07-01T02:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 2, Waarde_Alfanumeriek: '2' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          }],
        },
      ],
    };
    const series = normaliseObservations(split);
    expect(series).toHaveLength(1);
    expect(series[0]!.points.map((p) => p.value)).toEqual([1, 2]);
  });

  it('deduplicates a repeated timestamp within a series', () => {
    const dup: OphalenWaarnemingenResponse = {
      WaarnemingenLijst: [{
        Locatie: { Code: 'vlissingen' },
        AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } },
        MetingenLijst: [
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 1, Waarde_Alfanumeriek: '1' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          },
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 5, Waarde_Alfanumeriek: '5' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          },
        ],
      }],
    };
    const points = normaliseObservations(dup)[0]!.points;
    expect(points).toHaveLength(1);
    expect(points[0]!.value).toBe(5);
  });

  it('prefers a real reading over a gap at the same timestamp', () => {
    // A gap carries no information, so it must not overwrite a real value that
    // arrived for the same instant.
    const mixed: OphalenWaarnemingenResponse = {
      WaarnemingenLijst: [{
        Locatie: { Code: 'vlissingen' },
        AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } },
        MetingenLijst: [
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 123, Waarde_Alfanumeriek: '123' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          },
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 99999, Waarde_Alfanumeriek: '99999' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '99' },
          },
        ],
      }],
    };
    const points = normaliseObservations(mixed)[0]!.points;
    expect(points).toHaveLength(1);
    expect(points[0]!.value).toBe(123);
  });

  it('splits entries whose measurements differ in sampling height', () => {
    const twoHeights: OphalenWaarnemingenResponse = {
      WaarnemingenLijst: [{
        Locatie: { Code: 'a12' },
        AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'T' } },
        MetingenLijst: [
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 1, Waarde_Alfanumeriek: '1' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00', Bemonsteringshoogte: '0' },
          },
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 2, Waarde_Alfanumeriek: '2' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00', Bemonsteringshoogte: '-250' },
          },
        ],
      }],
    };
    expect(normaliseObservations(twoHeights)).toHaveLength(2);
  });

  it('skips a measurement with an unparseable timestamp without losing the series', () => {
    const bad: OphalenWaarnemingenResponse = {
      WaarnemingenLijst: [{
        Locatie: { Code: 'vlissingen' },
        AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } },
        MetingenLijst: [
          { Tijdstip: 'rubbish', Meetwaarde: { Waarde_Numeriek: 1 } },
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 2, Waarde_Alfanumeriek: '2' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          },
        ],
      }],
    };
    const series = normaliseObservations(bad);
    expect(series).toHaveLength(1);
    expect(series[0]!.points).toHaveLength(1);
  });

  it('ignores entries with no location code', () => {
    expect(normaliseObservations({ WaarnemingenLijst: [{ MetingenLijst: [] }] })).toEqual([]);
  });

  it('returns an empty array for an empty response', () => {
    expect(normaliseObservations({})).toEqual([]);
  });
});

describe('normaliseLatest', () => {
  it('collapses several rows for one series to the most recent point', () => {
    // OphalenLaatsteWaarnemingen may return several rows where one is expected.
    const response: OphalenWaarnemingenResponse = {
      WaarnemingenLijst: [{
        Locatie: { Code: 'vlissingen' },
        AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } },
        MetingenLijst: [
          {
            Tijdstip: '2026-07-01T01:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 1, Waarde_Alfanumeriek: '1' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          },
          {
            Tijdstip: '2026-07-01T03:00:00.000+01:00',
            Meetwaarde: { Waarde_Numeriek: 3, Waarde_Alfanumeriek: '3' },
            WaarnemingMetadata: { Kwaliteitswaardecode: '00' },
          },
        ],
      }],
    };
    const latest = normaliseLatest(response);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.point.value).toBe(3);
    expect(latest[0]!.point.t).toBe('2026-07-01T02:00:00.000Z');
  });
});

describe('normaliseCatalogue', () => {
  it('extracts distinct code lists from the real catalogue fixture', () => {
    const rows = normaliseCatalogue(fixture<OphalenCatalogusResponse>('OphalenCatalogus.json'));
    expect(rows.length).toBeGreaterThan(0);
    const domains = new Set(rows.map((r) => r.domain));
    expect(domains.has('grootheid')).toBe(true);
    expect(domains.has('compartiment')).toBe(true);
    // Deduplicated: no domain+code appears twice.
    const keys = rows.map((r) => `${r.domain} ${r.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('WFS CSV parsing', () => {
  const csv = readFileSync(join(FIXTURES, 'wfs-locatiesmetlaatstewaarneming.csv'), 'utf8');

  it('handles quoted fields containing commas', () => {
    expect(splitCsvLine('a,"Walcheren, 70 km",c')).toEqual(['a', 'Walcheren, 70 km', 'c']);
  });

  it('handles doubled quotes inside a quoted field', () => {
    expect(splitCsvLine('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
  });

  it('reads POINT as lat lon, which is the opposite order to GeoJSON', () => {
    // The CSV output of this WFS emits POINT (lat lon); GeoJSON emits [lon, lat].
    expect(parsePointLatLon('POINT (51.956135 2.677835)'))
      .toEqual({ lat: 51.956135, lon: 2.677835 });
  });

  it('returns nulls for missing geometry rather than NaN', () => {
    expect(parsePointLatLon(undefined)).toEqual({ lat: null, lon: null });
  });

  it('parses the recorded layer sample', () => {
    const rows = parseWfsLatestCsv(csv);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0]!;
    expect(first.code).toBe(first.code.toLowerCase());
    expect(first.lastSeenAt).toMatch(/Z$/);
    expect(first.lat).toBeGreaterThan(50);
    expect(first.lat).toBeLessThan(56);
  });

  it('drops rows without a usable code or timestamp', () => {
    const rows = parseWfsLatestCsv(
      'CODE,NAAM,TIJDSTIP_LAATSTE_METING,GEOMETRY\n' +
      ',Nameless,2026-01-01T00:00:00.000Z,POINT (52 4)\n' +
      'ok,Fine,not-a-date,POINT (52 4)\n' +
      'good,Good,2026-01-01T00:00:00.000Z,POINT (52 4)\n',
    );
    expect(rows.map((r) => r.code)).toEqual(['good']);
  });

  it('aggregates per-quantity rows into one record per location', () => {
    // The layer emits ~940k rows for ~2,600 locations, one per location+quantity.
    const rows = parseWfsLatestCsv(csv);
    const byLocation = aggregateByLocation(rows);
    expect(byLocation.size).toBeLessThan(rows.length);

    for (const location of byLocation.values()) {
      const own = rows.filter((r) => r.code === location.code);
      // Freshness is the newest observation across all of a location's series.
      const newest = own.map((r) => r.lastSeenAt).sort().at(-1);
      expect(location.lastSeenAt).toBe(newest);
    }
  });

  it('collects the distinct quantities a location reports', () => {
    const byLocation = aggregateByLocation(parseWfsLatestCsv(csv));
    const withQuantities = [...byLocation.values()].filter((l) => l.quantities.size > 0);
    expect(withQuantities.length).toBeGreaterThan(0);
  });
});

describe('WFS row guards', () => {
  // These exist because a real download degraded partway through and every
  // line after that point arrived field-shifted, producing rows like
  // code="20 km uit de kust", name="Terschelling", last_seen=year 9007.
  // Those were written to the database before the guards existed.

  it('rejects a field-shifted row whose code is really a name fragment', () => {
    expect(parseWfsLatestRow({
      CODE: '20 km uit de kust',
      NAAM: 'Terschelling',
      TIJDSTIP_LAATSTE_METING: '2026-01-01T00:00:00.000Z',
      GEOMETRY: 'POINT (53 5)',
    })).toBeNull();
  });

  it('rejects an implausible far-future timestamp', () => {
    // Date.parse accepts year 9007 happily; PostgreSQL then rejects the whole
    // batch with "time zone displacement out of range".
    expect(parseWfsLatestRow({
      CODE: 'terschelling.20kmuitdekust',
      NAAM: 'Terschelling',
      TIJDSTIP_LAATSTE_METING: '9007-01-01T00:00:00.000Z',
      GEOMETRY: 'POINT (53 5)',
    })).toBeNull();
  });

  it('rejects the year-13094 timestamp that broke a real ingest', () => {
    expect(isPlausibleTimestamp(Date.parse('+013094-05-01T00:00:00.000Z'))).toBe(false);
  });

  it('accepts a genuinely old but plausible timestamp', () => {
    // The layer holds a few hundred pre-2000 rows that are real.
    expect(isPlausibleTimestamp(Date.parse('1988-09-22T09:15:00.000Z'))).toBe(true);
  });

  it('rejects pre-1900 timestamps, which are the 313 known-bad rows', () => {
    expect(isPlausibleTimestamp(Date.parse('1739-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('accepts every code shape the live layer actually uses', () => {
    for (const code of ['vlissingen', 'ameland.nes', 'walcheren.70kmuitdekust', 'a12', 'ijgeul.1']) {
      expect(isPlausibleCode(code)).toBe(true);
    }
  });

  it('rejects codes containing whitespace', () => {
    expect(isPlausibleCode('20 km uit de kust')).toBe(false);
  });
});
