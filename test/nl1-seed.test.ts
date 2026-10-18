import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadRegistry, REGISTRY_DIR, readSeed } from '../apps/server/src/capture/specs.ts';
import { LOAD_ADAPTERS } from '../apps/server/src/load/adapters.ts';
import { StationsFile } from '../packages/contracts/src/index.ts';
import { CATALOGUE, locations, WFS } from '../scripts/rws-inventory.ts';
import { repoRoot } from './catalogue.ts';

// P16a (issue #64): the sea, wide and slow rows of registry/seed/nl-1.csv and registry/seed/nl-1-tide.csv are the
// live RWS locations of catalogue §2.1 (scripts/rws-inventory.ts), less the roadmap-1 rows and the structure-internal
// codes; nothing is invented, and no structure-internal code is ever asked for.

const read = (p: string) => JSON.parse(readFileSync(`${repoRoot}${p}`, 'utf8')) as unknown;
const locs = locations(read(CATALOGUE), read(WFS));
const nl1 = readSeed(REGISTRY_DIR, 'nl-1');
const tide = readSeed(REGISTRY_DIR, 'nl-1-tide');
const forecast = readSeed(REGISTRY_DIR, 'nl-1-forecast');

const ROADMAP = ['key', 'other', 'twin'];
const roadmap = nl1.filter((r) => ROADMAP.includes(r.tier ?? ''));
const added = nl1.filter((r) => !ROADMAP.includes(r.tier ?? ''));
const typeOf = (code: string | undefined) => locs.get(code ?? '')?.row.type;
const structure = [...locs].filter(([, l]) => l.row.type === 'structure').map(([c]) => c);

describe('registry/seed/nl-1.csv, the P16a tiers', () => {
  it('keeps the 88 roadmap-1 rows, in place, with no hoedanigheid; the new rows come after them', () => {
    expect(roadmap).toHaveLength(88);
    expect(nl1.slice(0, 88)).toEqual(roadmap);
    expect(roadmap.every((r) => r.hoedanigheid === '')).toBe(true);
    expect(roadmap.filter((r) => r.tier === 'key')).toHaveLength(25);
    expect(roadmap.filter((r) => r.tier === 'other')).toHaveLength(62);
    expect(roadmap.filter((r) => r.tier === 'twin')).toHaveLength(1);
    expect(added.every((r) => ['sea', 'wide', 'slow'].includes(r.tier ?? ''))).toBe(true);
    expect(added.every((r) => r.note === '')).toBe(true);
  });

  it('the new rows are the live non-structure series less the roadmap-1 rows, with the live Hoedanigheid', () => {
    const have = new Set(roadmap.map((r) => `${r.code}/${r.quantity}`));
    const want = [...locs]
      .filter(([, l]) => l.row.type !== 'structure')
      .flatMap(([c, l]) =>
        l.series.filter((s) => !have.has(`${c}/${s.quantity}`)).map((s) => `${c}/${s.quantity}/${s.hoedanigheid}`),
      )
      .sort();
    expect(added.map((r) => `${r.code}/${r.quantity}/${r.hoedanigheid}`).sort()).toEqual(want);
    for (const r of added) {
      if (r.quantity === 'Q') expect(r.hoedanigheid, `${r.code}/Q`).toBe('NVT');
      if (typeOf(r.code) === 'offshore') expect(r.hoedanigheid, r.code).toBe('MSL');
      expect(['NAP', 'NVT', 'MSL', 'TAW'], `${r.code}/${r.quantity}`).toContain(r.hoedanigheid);
    }
  });

  it('the tier follows the water type: sea only H of coast, Scheldt and delta; lake and canal slow; the rest wide', () => {
    for (const r of added) {
      const t = typeOf(r.code);
      const at = `${r.code}/${r.quantity} ${r.tier}`;
      if (r.tier === 'sea') {
        // P16b (Q3): the two lake references krabbersgat.ijsselmeer and markermeer.midden are sea-tier rows.
        const lakeReference = ['krabbersgat.ijsselmeer', 'markermeer.midden'].includes(r.code ?? '');
        expect(lakeReference ? ['lake'] : ['coast', 'scheldt', 'delta'], at).toContain(t);
        expect(r.quantity, at).toBe('H');
      } else if (t === 'lake' || t === 'canal') expect(r.tier, at).toBe('slow');
      else expect(r.tier, at).toBe('wide');
    }
    // About 30 key coastal and delta gauges in all: the new sea rows and the roadmap-1 key rows on those waters.
    const sea = added.filter((r) => r.tier === 'sea').length;
    const key = roadmap.filter(
      (r) => r.tier === 'key' && ['coast', 'scheldt', 'delta'].includes(typeOf(r.code) ?? ''),
    ).length;
    expect(sea + key).toBeGreaterThanOrEqual(28);
    expect(sea + key).toBeLessThanOrEqual(32);
  });

  it('has no duplicate (code, quantity, hoedanigheid) beyond the roadmap-1 Eijsden twin', () => {
    const keys = nl1.map((r) => `${r.code}/${r.quantity}/${r.hoedanigheid}`);
    // The twin asks TAW through its tier, not through the column: its (code, quantity) is the key row's.
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup).toEqual(['eijsden.grens/H/']);
    expect(new Set(added.map((r) => `${r.code}/${r.quantity}/${r.hoedanigheid}`)).size).toBe(added.length);
  });
});

describe('registry/seed/nl-1-tide.csv', () => {
  const SERIES = { astro: 'astronomical', hwlw: 'hwlwMeasured', 'hwlw-astro': 'hwlwAstronomical' } as const;

  it('equals the catalogue combinations of the live non-structure locations', () => {
    const want = [...locs]
      .filter(([, l]) => l.row.type !== 'structure')
      .flatMap(([code, l]) =>
        (Object.keys(SERIES) as (keyof typeof SERIES)[]).flatMap((series) =>
          // P16b: only combinations of a Hoedanigheid the location has a live H series in (Goeree lichteiland is
          // MSL only: its catalogue NAP high and low water has no registered series to attach to).
          l.combos[SERIES[series]]
            .filter((c) => l.series.some((x) => x.quantity === 'H' && x.hoedanigheid === c.hoedanigheid))
            .map((c) =>
              [
                code,
                series,
                c.hoedanigheid,
                series === 'astro' ? '' : c.groepering,
                series === 'astro' ? c.method : '',
              ].join(','),
            ),
        ),
      );
    // The hwlw requests carry no method, so combinations that differ only in method are one row.
    expect(tide.map((r) => [r.code, r.series, r.hoedanigheid, r.groepering, r.method].join(',')).sort()).toEqual(
      [...new Set(want)].sort(),
    );
  });

  it('pairs the groepering with the Hoedanigheid and the method with the series', () => {
    const GROUPING = {
      hwlw: { NAP: 'GETETM2', MSL: 'GETETMSL2' },
      'hwlw-astro': { NAP: 'GETETBRKD2', MSL: 'GETETBRKDMSL2' },
    } as const;
    for (const r of tide) {
      const at = `${r.code}/${r.series}`;
      expect(['NAP', 'MSL'], at).toContain(r.hoedanigheid);
      if (r.series === 'astro') {
        expect(r.groepering, at).toBe('');
        expect(r.method, at).toMatch(/^other:F\d{3}$/);
      } else {
        expect(r.method, at).toBe('');
        expect(r.groepering, at).toBe(GROUPING[r.series as keyof typeof GROUPING][r.hoedanigheid as 'NAP' | 'MSL']);
      }
    }
  });

  it('maps every row to exactly one registered same-datum primary H series', () => {
    const registered = StationsFile.parse(
      parse(readFileSync(`${repoRoot}registry/stations/nl-1.yaml`, 'utf8')),
    ).stations;
    for (const r of tide) {
      const hits = registered.filter(
        (s) =>
          s.provider_code === r.code &&
          s.quantity === 'H' &&
          s.role === 'primary' &&
          s.audience === 'public' &&
          'datum' in s &&
          s.datum === r.hoedanigheid,
      );
      expect(hits, `${r.code}/${r.series}/${r.hoedanigheid}`).toHaveLength(1);
    }
  });

  it('has no duplicate (code, series, hoedanigheid)', () => {
    const keys = tide.map((r) => `${r.code}/${r.series}/${r.hoedanigheid}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

describe('no structure-internal code is ever asked for', () => {
  const asked = (rows: Record<string, string>[]) => rows.map((r) => r.code ?? '');

  it('there are 18 structure-internal codes, and none is in an NL-1 seed file', () => {
    expect(structure).toHaveLength(18);
    for (const rows of [nl1, forecast, tide]) {
      for (const c of asked(rows)) expect(structure, c).not.toContain(c);
    }
  });

  it('none is in a row of any NL-1 spec of the capture registry', () => {
    const specs = loadRegistry().specs.filter((s) => s.source === 'NL-1');
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      for (const row of s.rows) {
        for (const v of Object.values(row)) {
          const code = String(v).split('/')[0] ?? '';
          expect(structure, `${s.id} ${v}`).not.toContain(code);
        }
      }
    }
  });
});

describe('invariant 1: the P16a specs ask only what the seeds say', () => {
  const ROADMAP_1 = [
    'nl-1-obs-key',
    'nl-1-obs-other',
    'nl-1-obs-twin',
    'nl-1-fc-1h',
    'nl-1-fc-3h-0',
    'nl-1-fc-3h-1',
    'nl-1-fc-3h-2',
    'nl-1-catalogue',
  ];
  const specs = loadRegistry().specs.filter((s) => s.source === 'NL-1' && !ROADMAP_1.includes(s.id));
  // P16b: the three catch-up specs (seed specs of the same rows) come with the loader.
  const CATCH_UP = ['nl-1-obs-sea-catchup', 'nl-1-obs-wide-catchup', 'nl-1-obs-slow-catchup'];

  it('the six specs exist: three observation tiers and three tide series', () => {
    expect(
      specs
        .filter((s) => !CATCH_UP.includes(s.id))
        .map((s) => s.id)
        .sort(),
    ).toEqual(['nl-1-astro', 'nl-1-hwlw', 'nl-1-hwlw-astro', 'nl-1-obs-sea', 'nl-1-obs-slow', 'nl-1-obs-wide']);
  });

  // P16b (replaces the P16a tripwire, SR-4): the six live specs and the three catch-up specs have a loader entry.
  it('each of the six live specs and the three catch-up specs has a loader entry', () => {
    const loaded = Object.keys(LOAD_ADAPTERS['NL-1']?.specs ?? {});
    for (const id of [
      'nl-1-obs-sea',
      'nl-1-obs-wide',
      'nl-1-obs-slow',
      'nl-1-hwlw',
      'nl-1-hwlw-astro',
      'nl-1-astro',
      ...CATCH_UP,
    ]) {
      expect(loaded, id).toContain(id);
    }
  });

  it('each is built by the adapter from a fixed URL and takes its rows from a seed through its where', () => {
    for (const s of specs) {
      expect(s.request.build, s.id).toBe(true);
      expect(s.request.url, s.id).not.toMatch(/\{[^}]*\}/);
      expect(['nl-1', 'nl-1-tide'], s.id).toContain(s.variants?.seed);
      const where = Object.entries(s.variants?.where ?? {});
      expect(where.length, s.id).toBeGreaterThan(0);
      let want = readSeed(REGISTRY_DIR, s.variants?.seed as string).filter((r) => where.every(([k, v]) => r[k] === v));
      expect(want.length, s.id).toBeGreaterThan(0);
      for (const [field, values] of Object.entries(s.variants?.each ?? {})) {
        want = want.flatMap((r) => values.map((x) => ({ ...r, [field]: x })));
      }
      expect(s.rows, s.id).toEqual(want);
    }
  });

  it('nl-1-hwlw-astro asks the type series of each location (#174) right before its heights: 158 rows', () => {
    const s = specs.find((x) => x.id === 'nl-1-hwlw-astro');
    expect(s?.variants?.each).toEqual({ typering: ['GETETTPE', 'NVT'] });
    expect(s?.variants?.key).toEqual(['code', 'hoedanigheid', 'typering']);
    expect(s?.rows).toHaveLength(158);
    s?.rows.forEach((r, i) => {
      expect(r.typering).toBe(i % 2 === 0 ? 'GETETTPE' : 'NVT');
      if (i % 2 === 1) expect(r.code).toBe(s.rows[i - 1]?.code);
    });
  });
});
