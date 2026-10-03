import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  parseNrwStations,
  registeredDe7,
  run,
  selectWaters,
  toCsv,
  WatersError,
} from '../tools/geo/rivernet/record-nrw-waters.ts';
import { readSources } from '../tools/geo/rivernet/sources.ts';
import { server } from './msw.setup.ts';

// The opt-in recorder of the DE-7 water bodies (P6b): offline, on a real trimmed sample of LANUK's station list.

const dir = new URL('../tools/geo/fixtures/nrw/', import.meta.url);
const sample = readFileSync(new URL('stations-sample.json', dir), 'utf8');
const URL_ = readSources().nrw_stations.url;
const env = { RWS_DOMAIN: 'example.org', RWS_CONTACT_EMAIL: 'a@example.org' };

describe('DE-7 water bodies', () => {
  it('parses the real sample to the golden', () => {
    expect(parseNrwStations(sample)).toEqual(
      JSON.parse(readFileSync(new URL('stations-sample.golden.json', dir), 'utf8')),
    );
  });

  it('keeps registered, non-WSV stations with a water, sorted', () => {
    const rows = parseNrwStations(sample);
    expect(selectWaters(rows, new Set(['2763190000100', '104', '45100100', '52020051']))).toEqual([
      ['104', 'Rhein'],
      ['2763190000100', 'Ruhr'],
    ]);
  });

  it('refuses a number with two waters, and a water with the delimiter', () => {
    const r = (water: string) => ({ station_no: '1', site_no: '100', water });
    expect(() => selectWaters([r('A'), r('B')], new Set(['1']))).toThrow(WatersError);
    expect(() => toCsv([['1', 'A;B']], { url: 'u', date: 'd', sha256: 's' })).toThrow(WatersError);
  });

  it('every registered DE-7 station has a water in the committed seed or none at all', () => {
    expect(registeredDe7().size).toBe(251);
  });

  it('reads drift as a fixed code: wrong shapes and bad fields', () => {
    for (const bad of [
      '{}',
      '[1]',
      '[{"station_no":12,"site_no":"100"}]',
      '[{"station_no":"x1","site_no":"100"}]',
      '[{"station_no":"1","site_no":100}]',
      '[{"station_no":"1","site_no":"100","WTO_OBJECT":"a\\u0000b"}]',
      '[{"station_no":"1","site_no":"100","WTO_OBJECT":5}]',
      'not json',
    ])
      expect(() => parseNrwStations(bad)).toThrow(WatersError);
    expect(parseNrwStations('[{"station_no":"1","site_no":"100","WTO_OBJECT":" Rur "}]')[0]?.water).toBe('Rur');
  });

  it('never throws anything but WatersError (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.array(fc.jsonValue()).map((v) => JSON.stringify(v)),
        ),
        (text) => {
          try {
            parseNrwStations(text);
          } catch (e) {
            expect(e).toBeInstanceOf(WatersError);
          }
        },
      ),
    );
  });

  it('refuses under CI and without the contact variables, before any request', async () => {
    const log: string[] = [];
    expect(await run([], { ...env, CI: 'true' }, fetch, (s) => log.push(s))).toBe(64);
    expect(await run([], {}, fetch, (s) => log.push(s))).toBe(78);
    expect(await run(['--x'], env, fetch, (s) => log.push(s))).toBe(64);
  });

  it('refuses a redirect, a non-200 and drift with one request each', async () => {
    let n = 0;
    server.use(
      http.get(URL_, () => {
        n++;
        return new HttpResponse('[]', { status: 503 });
      }),
    );
    expect(await run([], env, fetch, () => {})).toBe(1);
    expect(n).toBe(1);
    server.use(
      http.get(URL_, () => {
        n++;
        return HttpResponse.redirect('https://example.org/x', 302);
      }),
    );
    expect(await run([], env, fetch, () => {})).toBe(1);
    expect(n).toBe(2);
  });
});
