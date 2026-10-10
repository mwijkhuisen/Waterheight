import { readdirSync, readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  capTimes,
  isIsoOffset,
  isoMs,
  shiftAlertId,
  shiftCap,
  shiftEpoch,
  shiftIso,
  shiftStamp,
  shiftWall,
  wallMs,
} from '../scripts/lib/shift.ts';
import {
  anchorCap,
  anchorDe2,
  anchorDe6,
  anchorDe6Events,
  CIARAN_DE,
  CIARAN_IT,
  ciaranToDe,
  mapStrings,
  shiftCh4,
  shiftDe2,
  shiftDe6,
  shiftFr5,
  shiftLu5,
  shiftLu5Url,
  waybackMs,
} from '../scripts/lib/shift-sources.ts';

// The time shifters of the flood drill (scripts/lib/shift*.ts): shifting by d and then by -d gives the input back, and
// every timestamp moves by exactly d, in every notation the drill's payloads use.

const MS = { min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) };
const DELTA = fc.integer({ min: -4 * 365 * 86_400_000, max: 4 * 365 * 86_400_000 });
const WHOLE_SECONDS = DELTA.map((d) => Math.round(d / 1000) * 1000);
const BERLIN = 'Europe/Berlin';
const render = (ms: number, zone: string, digits: 0 | 3): string => {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  const p = (n: number) => String(n).padStart(2, '0');
  const frac = digits === 0 ? '' : `.${String(z.millisecond).padStart(3, '0')}`;
  return `${z.year}-${p(z.month)}-${p(z.day)}T${p(z.hour)}:${p(z.minute)}:${p(z.second)}${frac}${z.offset}`;
};
const ADAPTERS = new URL('../apps/server/src/adapters/', import.meta.url);
const fixture = (source: string, name: string) =>
  readFileSync(new URL(`${source.toLowerCase()}/fixtures/${name}.raw`, ADAPTERS));
const json = (b: Uint8Array) => JSON.parse(Buffer.from(b).toString('utf8')) as unknown;

describe('shiftIso', () => {
  it('moves the instant by exactly the delta and keeps the offset text, so that -delta gives the input back', () => {
    fc.assert(
      fc.property(
        fc.integer(MS),
        fc.constantFrom('Z', '+01:00', '+02:00', '-05:00', '+05:30'),
        fc.constantFrom<0 | 3>(0, 3),
        DELTA,
        (ms, offset, digits, d0) => {
          // Without fraction digits the text holds whole seconds: so do the input and the delta.
          const d = digits === 0 ? Math.round(d0 / 1000) * 1000 + 0 : d0;
          const at = digits === 0 ? Math.floor(ms / 1000) * 1000 : ms;
          const input = render(at, offset === 'Z' ? 'UTC' : offset, digits).replace(
            /\+00:00$/,
            offset === 'Z' ? 'Z' : '+00:00',
          );
          const out = shiftIso(input, d);
          expect(isoMs(out) - isoMs(input)).toBe(d);
          expect(out.endsWith(offset)).toBe(true);
          expect(shiftIso(out, -d)).toBe(input);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('with a zone renders the local time of the new instant, and -delta gives the zone-canonical input back', () => {
    fc.assert(
      fc.property(fc.integer(MS), fc.constantFrom<0 | 3>(0, 3), DELTA, (ms, digits, d0) => {
        const d = digits === 0 ? Math.round(d0 / 1000) * 1000 + 0 : d0;
        const at = digits === 0 ? Math.floor(ms / 1000) * 1000 : ms;
        const input = render(at, BERLIN, digits);
        const out = shiftIso(input, d, BERLIN);
        expect(isoMs(out)).toBe(at + d);
        expect(out).toBe(render(at + d, BERLIN, digits));
        expect(shiftIso(out, -d, BERLIN)).toBe(input);
      }),
      { numRuns: 300 },
    );
  });

  it('crosses the clock change: +01:00 in winter, +02:00 in summer, the instant exact', () => {
    expect(shiftIso('2023-11-02T03:00:00.000+01:00', 365 * 86_400_000, BERLIN)).toBe('2024-11-01T03:00:00.000+01:00');
    expect(shiftIso('2023-11-02T03:00:00.000+01:00', 150 * 86_400_000, BERLIN)).toBe('2024-03-31T04:00:00.000+02:00');
    expect(shiftIso('2023-11-02T03:00:00.000+01:00', 200 * 86_400_000, BERLIN)).toBe('2024-05-20T04:00:00.000+02:00');
    expect(shiftIso('2026-10-03T09:42:47+01:00', 86_400_000)).toBe('2026-10-04T09:42:47+01:00');
  });

  it('refuses what is not an ISO date-time with an offset', () => {
    for (const bad of ['2026-10-03 09:42:47', '2026-10-03T09:42:47', '2026-10-03T09:42:47.1234+01:00', 'now', ''])
      expect(() => shiftIso(bad, 1000)).toThrow();
    expect(isIsoOffset('2026-10-03T09:42:47Z')).toBe(true);
    expect(isIsoOffset('2026-10-03T09:42:47')).toBe(false);
  });
});

describe('shiftWall', () => {
  it('is the local time of the shifted instant, in both notations; -delta gives the input back (outside the repeated hour)', () => {
    for (const [shape, zone] of [
      ['space', BERLIN],
      ['slash', 'Europe/Paris'],
    ] as const)
      fc.assert(
        fc.property(fc.integer(MS), WHOLE_SECONDS, (ms, d) => {
          const at = Math.floor(ms / 1000) * 1000;
          const z = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
          const p = (n: number) => String(n).padStart(2, '0');
          const sep = shape === 'space' ? '-' : '/';
          const tail = shape === 'slash' ? '.000' : '';
          const input = `${z.year}${sep}${p(z.month)}${sep}${p(z.day)} ${p(z.hour)}:${p(z.minute)}:${p(z.second)}${tail}`;
          // A wall time in the repeated hour reads as its later occurrence: not an input this property is about.
          fc.pre(wallMs(input, shape, zone) === at);
          const out = shiftWall(input, d, zone, shape);
          expect(wallMs(out, shape, zone)).toBe(at + d);
          expect(shiftWall(out, -d, zone, shape)).toBe(input);
        }),
        { numRuns: 300 },
      );
  });

  it('refuses another notation', () => {
    expect(() => shiftWall('2024-01-25T15:00:00', 1, BERLIN, 'space')).toThrow();
    expect(() => shiftWall('2021/08/17 15:00:00', 1, BERLIN, 'slash')).toThrow();
  });
});

describe('epochs and stamps', () => {
  it('shiftEpoch moves seconds and milliseconds, and refuses a fraction of a second', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000 }), WHOLE_SECONDS, (s, d) => {
        expect(shiftEpoch(shiftEpoch(s, d, 's'), -d, 's')).toBe(s);
        expect(shiftEpoch(s * 1000, d, 'ms')).toBe(s * 1000 + d);
        expect(shiftEpoch(s, d, 's')).toBe(s + d / 1000);
      }),
    );
    expect(() => shiftEpoch(1, 1500, 's')).toThrow();
  });

  it('shiftStamp (a data.public.lu folder) and shiftLu5Url move the time they name', () => {
    expect(shiftStamp('20250908-212002', 3600_000)).toBe('20250908-222002');
    fc.assert(
      fc.property(fc.integer(MS), WHOLE_SECONDS, (ms, d) => {
        const s = new Date(Math.floor(ms / 1000) * 1000)
          .toISOString()
          .replace(/[-:]/g, '')
          .replace('T', '-')
          .slice(0, 15);
        expect(shiftStamp(shiftStamp(s, d), -d)).toBe(s);
      }),
    );
    const url =
      'https://download.data.public.lu/resources/alertes-du-systeme-lu-alert/20250908-212002/dump-alert.1757366102.xml';
    const moved = shiftLu5Url(url, 3600_000);
    expect(moved).toBe(
      'https://download.data.public.lu/resources/alertes-du-systeme-lu-alert/20250908-222002/dump-alert.1757369702.xml',
    );
    expect(shiftLu5Url(moved, -3600_000)).toBe(url);
    expect(shiftLu5Url('https://example.org/x', 5000)).toBe('https://example.org/x');
  });

  it('shiftAlertId moves the epoch of an LU-Alert identifier and leaves any other name', () => {
    expect(shiftAlertId('LU-Alert.1757366107.4026.0', 60_000)).toBe('LU-Alert.1757366167.4026.0');
    expect(shiftAlertId('other.1757366107.4026.0', 60_000)).toBe('other.1757366107.4026.0');
  });
});

describe('CAP (LU-5)', () => {
  const real = readdirSync(new URL('lu-5/fixtures/', ADAPTERS))
    .filter((f) => /^lu-5-cap-\d{8}-\d{6}-.*\.raw$/.test(f))
    .map((f) => f.slice(0, -4));

  it('every recorded message: -delta gives it back byte for byte, and every time element moved by exactly delta', () => {
    expect(real.length).toBeGreaterThan(20);
    for (const name of real) {
      const xml = fixture('LU-5', name).toString('utf8');
      for (const d of [3600_000, -86_400_000 * 400, 9 * 3600_000 + 1000]) {
        const out = shiftCap(xml, d, 'Europe/Luxembourg');
        expect(
          capTimes(out).map((t, i) => t - (capTimes(xml)[i] as number)),
          name,
        ).toEqual(capTimes(xml).map(() => d));
        expect(shiftCap(out, -d, 'Europe/Luxembourg'), name).toBe(xml);
      }
    }
  });

  it("the Cancel's <references> name the alert it closes exactly as the shifted alert states itself", () => {
    const alert = fixture('LU-5', 'lu-5-cap-20250908-231507-alert-lvl2').toString('utf8');
    const cancel = fixture('LU-5', 'lu-5-cap-20250909-080450-cancel').toString('utf8');
    const d = 9555 * 3600_000 + 15 * 60_000;
    const a = shiftCap(alert, d, 'Europe/Luxembourg');
    const c = shiftCap(cancel, d, 'Europe/Luxembourg');
    const id = /<identifier>([^<]*)<\/identifier>/.exec(a)?.[1];
    const sent = /<sent>([^<]*)<\/sent>/.exec(a)?.[1];
    expect(id).not.toBe('LU-Alert.1757366107.4026.0');
    expect(/<references>([^<]*)<\/references>/.exec(c)?.[1]).toBe(`[AGE],${id},${sent}`);
    // The Cancel is as long after the alert as it was.
    expect(anchorCap(Buffer.from(c)) - anchorCap(Buffer.from(a))).toBe(
      anchorCap(Buffer.from(cancel)) - anchorCap(Buffer.from(alert)),
    );
  });

  it('refuses a reference that is not sender,identifier,sent', () => {
    expect(() => shiftCap('<references>[AGE],x</references>', 1000)).toThrow();
    expect(() => shiftCap('<sent>soon</sent>', 1000)).toThrow();
  });

  it('shiftLu5 keeps the bytes outside the time elements and the identifier', () => {
    const xml = fixture('LU-5', 'lu-5-cap-20250908-231502-alert-lvl1').toString('utf8');
    const out = shiftLu5(Buffer.from(xml), 7_200_000).toString('utf8');
    const strip = (s: string) =>
      s
        .replace(/<(sent|effective|onset|expires|identifier)>[^<]*<\/\1>/g, '')
        .replace(/<references>[^<]*<\/references>/g, '');
    expect(strip(out)).toBe(strip(xml));
    expect(out).not.toBe(xml);
  });
});

describe('DE-6', () => {
  const stations = fixture('DE-6', 'de-6-stations-test');
  const alerts = fixture('DE-6', 'de-6-alerts-test');
  const instants = (doc: unknown): number[] => {
    const d = doc as { updated: string; lastModified: string; features: { properties: { timestamp?: string } }[] };
    return [
      isoMs(d.updated),
      isoMs(d.lastModified),
      ...d.features.flatMap((f) =>
        f.properties.timestamp === undefined ? [] : [wallMs(f.properties.timestamp, 'space', BERLIN)],
      ),
    ];
  };

  it('moves updated, lastModified and every feature timestamp by exactly delta; the rest is untouched', () => {
    for (const body of [stations, alerts]) {
      const d = 217 * 3600_000 + 1000;
      const out = shiftDe6(body, d);
      expect(instants(json(out))).toEqual(instants(json(body)).map((t) => t + d));
      // Nothing but those keys changed.
      const clean = (b: Uint8Array) => {
        const doc = json(b) as {
          updated?: string;
          lastModified?: string;
          features: { properties: Record<string, unknown> }[];
        };
        doc.updated = '';
        doc.lastModified = '';
        for (const f of doc.features) f.properties.timestamp = '';
        return doc;
      };
      expect(clean(out)).toEqual(clean(body));
    }
  });

  it('a payload with two clocks (the test server): the answer moves by one offset, the features by another', () => {
    const d = 100 * 86_400_000;
    const r = 3 * 86_400_000 + 5000;
    const out = json(shiftDe6(stations, d, r));
    const before = json(stations);
    expect(instants(out).slice(0, 2)).toEqual(
      instants(before)
        .slice(0, 2)
        .map((t) => t + r),
    );
    expect(instants(out).slice(2)).toEqual(
      instants(before)
        .slice(2)
        .map((t) => t + d),
    );
    // The event clock's anchor is the newest feature (the flood of 2024-01-25, 16:25 local).
    expect(anchorDe6Events(stations)).toBe(Date.parse('2024-01-25T15:25:00Z'));
    expect(() => anchorDe6Events(alerts)).toThrow();
  });

  it('-delta gives the document back (the recorded feature times are outside the repeated hour)', () => {
    const d = 217 * 3600_000;
    expect(json(shiftDe6(shiftDe6(stations, d), -d))).toEqual(json(stations));
    expect(json(shiftDe6(shiftDe6(alerts, -d), d))).toEqual(json(alerts));
  });

  it('the anchor is updated; a document without it is refused', () => {
    expect(anchorDe6(stations)).toBe(Date.parse('2026-10-03T08:42:47Z'));
    expect(() => anchorDe6(Buffer.from('{}'))).toThrow();
    expect(() => anchorDe6(Buffer.from('[]'))).toThrow();
  });
});

describe('FR-5', () => {
  it('moves the section dates (Europe/Paris wall time) and the map time when it has one', () => {
    const body = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        DtHrInfoVigiCru: '2026-10-03T07:55:24+00:00',
        features: [
          {
            type: 'Feature',
            properties: { DhCEntCru: '2021/08/17 15:00:00.000', dhmentcru: '2006/07/05 09:00:00.000', NivInfViCr: 1 },
          },
          { type: 'Feature', properties: { NivInfViCr: 2, LbEntCru: '2021/08/17 15:00:00.000' } },
        ],
      }),
    );
    const out = json(shiftFr5(body, 86_400_000)) as {
      DtHrInfoVigiCru: string;
      features: { properties: Record<string, unknown> }[];
    };
    expect(out.DtHrInfoVigiCru).toBe('2026-10-04T07:55:24+00:00');
    expect(out.features[0]?.properties).toEqual({
      DhCEntCru: '2021/08/18 15:00:00.000',
      dhmentcru: '2006/07/06 09:00:00.000',
      NivInfViCr: 1,
    });
    // A label that merely looks like a date is not a time key.
    expect(out.features[1]?.properties.LbEntCru).toBe('2021/08/17 15:00:00.000');
    expect(waybackMs('https://web.archive.org/web/20231211164225id_/https://www.vigicrues.gouv.fr/x')).toBe(
      Date.parse('2023-12-11T16:42:25Z'),
    );
    expect(() => waybackMs('https://example.org/')).toThrow();
  });
});

describe('CH-4 (the storm-Ciaran figure)', () => {
  const recorded = fixture('CH-4', 'ch-4-forecast-ciaran-it');

  it('the Italian trace names become the German layout of production, nothing else changes', () => {
    const out = json(ciaranToDe(recorded)) as { plot: { data: { name: string }[] } };
    expect(out.plot.data.map((t) => t.name)).toEqual([...CIARAN_DE]);
    expect((json(recorded) as typeof out).plot.data.map((t) => t.name)).toEqual([...CIARAN_IT]);
    const rename = (b: Uint8Array) => {
      const doc = json(b) as typeof out;
      for (const t of doc.plot.data) t.name = '';
      return doc;
    };
    expect(rename(ciaranToDe(recorded))).toEqual(rename(recorded));
    expect(() => ciaranToDe(ciaranToDe(recorded))).toThrow();
    expect(() => ciaranToDe(Buffer.from('{}'))).toThrow();
  });

  it('moves every ISO time of the figure by exactly delta, in Berlin local time, and back', () => {
    const times = (b: Uint8Array) => {
      const found: string[] = [];
      mapStrings(json(b) as never, (s) => {
        if (isIsoOffset(s)) found.push(s);
        return s;
      });
      return found;
    };
    const d = 25_799 * 3600_000 + 1000;
    const out = shiftCh4(recorded, d);
    const before = times(recorded);
    const after = times(out);
    expect(before.length).toBeGreaterThan(500);
    expect(after.map(isoMs)).toEqual(before.map((s) => isoMs(s) + d));
    // BAFU's local labels: the offset is the zone's at the new instant (25,799 hours on from November: October, +02:00).
    for (const s of after) expect(s).toBe(render(isoMs(s), BERLIN, 3));
    expect(json(shiftCh4(out, -d))).toEqual(json(recorded));
  });
});

describe('DE-2', () => {
  const recorded = fixture('DE-2', 'de-2-wv-truncated.synthetic');

  it('moves initialized and timestamp of every point by exactly delta; the values stay', () => {
    const d = 4 * 3600_000 + 50 * 60_000;
    const out = json(shiftDe2(recorded, d)) as { initialized: string; timestamp: string; value: number }[];
    const before = json(recorded) as typeof out;
    expect(out.map((p) => isoMs(p.timestamp))).toEqual(before.map((p) => isoMs(p.timestamp) + d));
    expect(out.every((p) => isoMs(p.initialized) === isoMs(before[0]?.initialized as string) + d)).toBe(true);
    expect(out.map((p) => p.value)).toEqual(before.map((p) => p.value));
    expect(json(shiftDe2(shiftDe2(recorded, d), -d))).toEqual(before);
    expect(anchorDe2(recorded)).toBe(Date.parse('2026-10-12T05:00:00Z'));
    expect(() => anchorDe2(Buffer.from('{}'))).toThrow();
  });
});
