import { readFileSync } from 'node:fs';
import type { ApiStation, Snapshot } from '@rws/contracts';
import { TREND_BAND } from '@rws/core/trend';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type EndValue,
  endValues,
  Q_WIDTH,
  type ReachPaint,
  reachColour,
  reachPaints,
} from '../src/features/flow/reaches/colour.ts';
import { type FeatureSpan, spansOf } from '../src/features/flow/reaches/spans.ts';
import { DH_COLOUR, LADDER, Q_COLOUR, qSize, STATE_COLOUR } from '../src/features/legend/palette.ts';
import type { Change } from '../src/lib/data/change.ts';
import { ReachGraphFile } from '../src/lib/data/contracts.ts';

// The colour of one reach (P11b, issue #26): the rules in their order, on the committed river release.

type Value = Snapshot['values'][number];

const graph = ReachGraphFile.parse(
  JSON.parse(readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8')),
);
const spans = spansOf(graph, new Set(graph.stations.map((s) => s.id)));
const reach = (id: string): FeatureSpan => {
  const fs = spans.get(id);
  if (fs === undefined) throw new Error(id);
  return fs;
};
const ev = (v: number, ageS = 0, limitS = 3600): EndValue => ({ v, ageS, limitS });
const ids = (from: string, a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `${from}.${a + i}`);

const TIDAL = [...ids('scheldt', 9, 13), ...ids('ems', 23, 33), ...ids('lek', 4, 6), 'meuse.55'];
const MODES = ['state', 'delta', 'q'] as const;
const colourOf = (p: ReachPaint) => (p.k === 'v' ? p.colour : p.k);

describe('the tidal reaches', () => {
  it('exist in the fixture and are tidal', () => {
    for (const id of TIDAL) expect(reach(id).tidal, id).toBe(true);
  });

  it('always give tidal, and no reach of a span that holds one is ever interpolated', () => {
    const inTidalSpan = [...spans].filter(([, fs]) => fs.span?.tidal === true);
    expect(inTidalSpan.length).toBeGreaterThan(TIDAL.length - 5);
    const endArb = fc.option(
      fc.record({ v: fc.double({ min: -300, max: 300, noNaN: true }), ageS: fc.nat(10_000), limitS: fc.nat(10_000) }),
      { nil: undefined },
    );
    fc.assert(
      fc.property(fc.constantFrom(...MODES), endArb, endArb, (mode, a, b) => {
        for (const id of TIDAL) expect(reachColour(reach(id), [a, b], mode).k, id).toBe('tidal');
        for (const [id, fs] of inTidalSpan) {
          const k = reachColour(fs, [a, b], mode).k;
          expect(k === 'v', id).toBe(false);
        }
      }),
    );
  });

  it('turns the rest of a span with a tidal reach to no data (scheldt.8 shares the Maulde to Antwerpen span)', () => {
    expect(reachColour(reach('scheldt.8'), [ev(2), ev(3)], 'q')).toEqual({ k: 'nodata' });
  });
});

describe('no data', () => {
  const meuse28 = reach('meuse.28'); // 8 km, ordinary, pos 0.5
  const meuse20 = reach('meuse.20');

  it('is stale, missing or without a reference', () => {
    for (const mode of MODES) {
      expect(reachColour(meuse28, [ev(2), undefined], mode)).toEqual({ k: 'nodata' });
      expect(reachColour(meuse28, [undefined, ev(2)], mode)).toEqual({ k: 'nodata' });
      expect(reachColour(meuse28, [ev(2, 3601), ev(2)], mode)).toEqual({ k: 'nodata' });
      expect(reachColour(meuse28, [ev(2), ev(2, 3601)], mode)).toEqual({ k: 'nodata' });
      expect(reachColour(meuse28, [ev(2, 3600), ev(2, 3600)], mode).k).toBe('v'); // the limit itself is fresh
    }
    expect(reachColour(meuse28, [ev(0), ev(3)], 'state')).toEqual({ k: 'nodata' });
    expect(reachColour(meuse28, [ev(3), ev(0)], 'state')).toEqual({ k: 'nodata' });
  });

  it('is an open span, a river head and a tributary tail', () => {
    const open = [...spans].filter(([, fs]) => fs.span === null && fs.tidal !== true);
    expect(open.length).toBeGreaterThan(100);
    for (const [id, fs] of open) expect(reachColour(fs, [ev(2), ev(2)], 'state'), id).toEqual({ k: 'nodata' });
  });

  it('is a span of unknown length or position, never interpolated', () => {
    const unknown: FeatureSpan = {
      ...meuse28,
      span: { ...(meuse28.span as NonNullable<FeatureSpan['span']>), lengthKm: null, pos: null },
    };
    expect(reachColour(unknown, [ev(2), ev(3)], 'q')).toEqual({ k: 'nodata' });
    expect(meuse20.span?.lengthKm).toBeLessThan(120);
  });

  it('is the 139 km Chooz to Eijsden gap on the public file, while meuse.23 is coloured', () => {
    for (const id of ['meuse.24', 'meuse.25', 'meuse.26'])
      for (const mode of MODES)
        expect(reachColour(reach(id), [ev(2), ev(3)], mode), `${id} ${mode}`).toEqual({ k: 'nodata' });
    expect(reachColour(reach('meuse.23'), [ev(2), ev(3)], 'state').k).toBe('v');
    expect(reachColour(reach('meuse.23'), [ev(2), ev(3)], 'q').k).toBe('v');
    expect(reach('scheldt.8').span?.lengthKm).toBeGreaterThan(120);
  });

  it('is isolated per tributary: no tail before a confluence is coloured by the main stem', () => {
    const rivers = new Map(graph.reaches.map((r) => [r.id, r.river_id]));
    const known = new Set(graph.stations.map((s) => s.id));
    for (const r of graph.reaches) {
      if (r.downstream.length === 0 || !r.downstream.every((d) => rivers.get(d) !== r.river_id)) continue;
      if (r.down_station_id !== null && known.has(r.down_station_id)) continue;
      expect(reachColour(reach(r.id), [ev(2), ev(3)], 'state'), r.id).toEqual({ k: 'nodata' });
    }
  });
});

describe('impounded reaches', () => {
  it('are neutral in the change mode, and coloured in the others (the server class, the discharge)', () => {
    for (const id of ids('meuse', 23, 23)) {
      expect(reach(id).impounded).toBe(true);
      expect(reachColour(reach(id), [ev(40), ev(-40)], 'delta')).toEqual({ k: 'impounded' });
      expect(reachColour(reach(id), [ev(2), ev(2)], 'state').k).toBe('v');
      expect(reachColour(reach(id), [ev(2), ev(2)], 'q').k).toBe('v');
    }
    // even with missing ends: "gestuwd" needs no data
    expect(reachColour(reach('meuse.23'), [undefined, undefined], 'delta')).toEqual({ k: 'impounded' });
  });
});

describe('the modes', () => {
  const r = reach('meuse.28'); // pos 0.5
  const r20 = reach('meuse.20'); // pos about 0.94

  it('state: the level is rounded from the ends and stays within them', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), (a, b) => {
        for (const fs of [r, r20, reach('meuse.21'), reach('rhine.4')]) {
          const p = reachColour(fs, [ev(a), ev(b)], 'state');
          if (fs.span === null || fs.span.pos === null) continue;
          expect(p.k).toBe('v');
          const allowed = LADDER.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => STATE_COLOUR[s]);
          expect(allowed).toContain(colourOf(p));
        }
      }),
    );
    expect(reachColour(r, [ev(1), ev(4)], 'state')).toEqual({
      k: 'v',
      colour: STATE_COLOUR[LADDER[3] as 'high'],
      width: 1,
    });
    expect(colourOf(reachColour(r20, [ev(1), ev(4)], 'state'))).toBe(STATE_COLOUR[LADDER[4] as 'high']);
  });

  it('delta: lerps the cm change and applies core dead band exactly (|dh| at the band is steady)', () => {
    const dh = (x: number) => colourOf(reachColour(r, [ev(x), ev(x)], 'delta'));
    expect(dh(TREND_BAND.cm)).toBe(DH_COLOUR[0]);
    expect(dh(-TREND_BAND.cm)).toBe(DH_COLOUR[0]);
    expect(dh(TREND_BAND.cm + 0.001)).toBe(DH_COLOUR[1]);
    expect(dh(-TREND_BAND.cm - 0.001)).toBe(DH_COLOUR[-1]);
    expect(dh(10.5)).toBe(DH_COLOUR[2]);
    expect(dh(-60)).toBe(DH_COLOUR[-3]);
    expect(colourOf(reachColour(r, [ev(-20), ev(20)], 'delta'))).toBe(DH_COLOUR[0]); // 0 at the middle
    expect(reachColour(r, [ev(0), ev(120)], 'delta')).toEqual({ k: 'v', colour: DH_COLOUR[3], width: 1 });
  });

  it('q: needs both ends, colours with the one hue and widens with the size', () => {
    expect(reachColour(r, [ev(50), undefined], 'q')).toEqual({ k: 'nodata' });
    expect(reachColour(r, [undefined, ev(50)], 'q')).toEqual({ k: 'nodata' });
    const w = [5, 50, 500, 5000].map((q) => {
      const p = reachColour(r, [ev(q), ev(q)], 'q');
      expect(p).toMatchObject({ k: 'v', colour: Q_COLOUR });
      return (p as Extract<ReachPaint, { k: 'v' }>).width;
    });
    expect(w).toEqual([Q_WIDTH[1], Q_WIDTH[2], Q_WIDTH[3], Q_WIDTH[4]]);
    expect(w[1]).toBe(1);
    expect([...w].sort((a, b) => a - b)).toEqual(w);
    expect(new Set(w).size).toBe(4);
    expect(qSize(50)).toBe(2);
  });
});

describe('endValues', () => {
  const grp = reach('meuse.23'); // up B720000001 + B720000004, down B720000002
  let n = 1;
  const station = (id: string, ...series: ['H' | 'Q', number][]) =>
    ({
      id,
      series: series.map(([quantity, limit]) => ({ id: n++, quantity, stalenessLimitSeconds: limit })),
    }) as unknown as ApiStation;
  const val = (series: number, value: number, state: Value['state'] = 'normal', ageSeconds = 60): Value =>
    ({ series, value, state, ageSeconds }) as unknown as Value;

  const up1 = station('fr.sandre.B720000001', ['Q', 111]);
  const up2 = station('fr.sandre.B720000004', ['Q', 222], ['H', 333]);
  const down = station('fr.sandre.B720000002', ['H', 444]);
  const stations = new Map([up1, up2, down].map((s) => [s.id, s]));
  const [q1] = up1.series;
  const [q2, h2] = up2.series;
  const [h3] = down.series;
  const values = new Map<number, Value>([
    [(q1 as { id: number }).id, val((q1 as { id: number }).id, 11)],
    [(q2 as { id: number }).id, val((q2 as { id: number }).id, 22)],
    [(h2 as { id: number }).id, val((h2 as { id: number }).id, 5, 'high', 120)],
    [(h3 as { id: number }).id, val((h3 as { id: number }).id, 6, 'low', 30)],
  ]);
  const hId = (h2 as { id: number }).id;
  const changes = new Map<number, Change>([
    [hId, { dh: 7, trend: 'rising' }],
    [(h3 as { id: number }).id, null],
  ]);

  it('takes, per end, the first station with a series of the quantity that has a value', () => {
    expect(endValues(grp, 'q', values, undefined, stations)).toEqual([
      { v: 11, ageS: 60, limitS: 111 },
      undefined, // the down end has an H series only
    ]);
    expect(endValues(grp, 'state', values, undefined, stations)).toEqual([
      { v: LADDER.indexOf('high'), ageS: 120, limitS: 333 }, // the first station has no H series
      { v: LADDER.indexOf('low'), ageS: 30, limitS: 444 },
    ]);
  });

  it('reads the change in the change mode, a null change being no end', () => {
    expect(endValues(grp, 'delta', values, changes, stations)).toEqual([{ v: 7, ageS: 120, limitS: 333 }, undefined]);
    expect(endValues(grp, 'delta', values, undefined, stations)).toEqual([undefined, undefined]);
  });

  it('has no ends on an open span, and paints every reach', () => {
    const open = [...spans.values()].find((fs) => fs.span === null) as FeatureSpan;
    expect(endValues(open, 'q', values, changes, stations)).toEqual([undefined, undefined]);
    const paints = reachPaints(spans, 'state', values, changes, stations);
    expect(paints.size).toBe(spans.size);
    expect(paints.get('scheldt.10')).toEqual({ k: 'tidal' });
  });
});
