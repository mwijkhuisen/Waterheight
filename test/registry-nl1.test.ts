import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STALE_SERIES } from '../apps/server/src/adapters/nl-1/normalise.ts';
import {
  PublicStation,
  SourcesFile,
  StationsFile,
  validateStations,
  validateTwins,
} from '../packages/contracts/src/index.ts';
import { generate, type Inputs, OUTPUT, readInputs } from '../scripts/gen-nl1-stations.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/nl-1.yaml is generated (scripts/gen-nl1-stations.ts) from the NL-1 seed, the recorded
// RWS catalogue, the recorded NL-2 WFS snapshot, the forecast locations and the NL-4 classes: the committed
// file is exactly the generator's output, and it declares each captured series with its one live method.

const committed = readFileSync(OUTPUT, 'utf8');
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const twinsDoc = parse(readFileSync(`${repoRoot}registry/twins.yaml`, 'utf8')) as {
  twins: { a: { provider_key: string }; b: { provider_key: string } }[];
};

const rows = StationsFile.parse(parse(committed)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
const stationIds = (of: PublicStation[]) => new Set(of.map((r) => r.id));
const codes = (of: PublicStation[]) => [...new Set(of.map((r) => r.provider_code))].sort();
const method = (r: PublicStation) => r.provider_key.split('/')[3];
const find = (code: string, quantity: 'H' | 'Q' = 'H', role: PublicStation['role'] = 'primary') => {
  const row = rows.find((r) => r.provider_code === code && r.quantity === quantity && r.role === role);
  if (row === undefined) throw new Error(`no NL-1 row ${code} ${quantity} ${role}`);
  return row;
};

const TIER1 = [
  'amerongen.boven',
  'dalfsen.vechterweerd',
  'deventer',
  'doesburg.ijssel',
  'driel.boven',
  'eijsden.grens',
  'epen.geul.cottessen',
  'grave.boven',
  'hagestein.boven',
  'holtheme.vecht',
  'kampen.ijssel',
  'lith.boven',
  'lobith.bovenrijn.tolkamer',
  'maastricht.borgharen.maas.beneden',
  'maastricht.sintpieter',
  'megen.maas',
  'millingenaanderijn',
  'millingenaanderijn.pannerdensekop',
  'nijmegen.waal',
  'olst',
  'ommen.vecht',
  'pannerden.pannerdenschkanaal',
  'roermond.boven',
  'stevensweert',
  'tiel.waal',
  'venlo',
  'westervoort.1',
  'westervoort.ijsselkop',
  'zaltbommel',
  'zutphen.ijssel',
  'zwolle.ijssel',
];
const TIDAL = ['delfzijl', 'hansweert', 'nieuwestatenzijl.dollard', 'rilland.bath', 'terneuzen', 'vlissingen'];

describe('registry/stations/nl-1.yaml', () => {
  it('is exactly what the generator writes from its inputs', () => {
    expect(committed).toBe(run());
  });

  it('is deterministic: the same input gives the same bytes and no timestamp', () => {
    expect(run()).toBe(run());
    expect(committed.slice(committed.indexOf('\nstations:'))).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is unchanged by a YAML 1.1 reader', () => {
    expect(parse(committed, { version: '1.1' })).toEqual(parse(committed));
  });

  it('validates against the real sources with no problem', () => {
    expect(validateStations(parse(committed), sources).problems).toEqual([]);
  });

  it('holds 76 rows at 65 stations (62 H, 1 TAW twin, 13 Q), all public, open and NL', () => {
    expect(stationIds(rows).size).toBe(65);
    expect(rows).toHaveLength(76);
    expect(rows.filter((r) => r.quantity === 'H' && r.role === 'primary')).toHaveLength(62);
    expect(rows.filter((r) => r.role === 'twin')).toHaveLength(1);
    expect(rows.filter((r) => r.quantity === 'Q')).toHaveLength(13);
    for (const r of rows) {
      expect(r).toMatchObject({
        id: `nl.rws.${r.provider_code}`,
        source: 'NL-1',
        country: 'NL',
        water_name: null,
        river: null,
        km: null,
        to_canonical: 1,
        native_step: 'PT10M',
        expected_step: 'PT10M',
        licence_gate: 'open',
        audience: 'public',
        gauge_zero: [],
      });
      expect(r.flags.impounded).toBeNull();
      const h = r.quantity === 'H';
      expect([r.id, r.native_unit, r.value_kind]).toEqual([r.id, h ? 'cm' : 'm³/s', h ? 'level' : null]);
      expect([r.id, r.datum]).toEqual([r.id, h ? (r.role === 'twin' ? 'TAW' : 'NAP') : null]);
      expect(r.provider_key).toBe(`${r.provider_code}/${h ? 'WATHTE' : 'Q'}/${r.datum ?? 'NVT'}/${method(r)}`);
      expect(r.provider_key.length).toBeLessThanOrEqual(120);
    }
  });

  it('is ordered by code (code units), then H before Q, then primary before twin', () => {
    const keys = rows.map((r) => `${r.provider_code}\0${r.quantity}${r.role === 'twin' ? 1 : 0}`);
    expect(keys).toEqual([...keys].sort());
    expect(rows.filter((r) => r.provider_code === 'eijsden.grens').map((r) => `${r.quantity} ${r.role}`)).toEqual([
      'H primary',
      'H twin',
      'Q primary',
    ]);
  });

  it('marks exactly the 31 key stations (42 rows) as tier 1, and every primary row of them first_release', () => {
    const tier1 = rows.filter((r) => r.tier === 1);
    expect(codes(tier1)).toEqual(TIER1);
    expect(tier1).toHaveLength(42);
    expect(tier1.filter((r) => r.quantity === 'H')).toHaveLength(29);
    expect(tier1.filter((r) => r.quantity === 'Q')).toHaveLength(13);
    expect(tier1.filter((r) => r.first_release)).toHaveLength(41);
    expect(tier1.every((r) => r.first_release === (r.role === 'primary'))).toBe(true);
    const tier2 = rows.filter((r) => r.tier === 2);
    expect(stationIds(tier2).size).toBe(34);
    expect(tier2.every((r) => !r.first_release && r.role === 'primary' && r.quantity === 'H')).toBe(true);
  });

  it('gives every tier-1 row every field of the station registry', () => {
    const fields = Object.keys(PublicStation.shape);
    for (const r of rows.filter((x) => x.tier === 1)) {
      const record = r as Record<string, unknown>;
      expect(fields.filter((f) => record[f] === undefined)).toEqual([]);
    }
  });

  it('flags the six sea and estuary gauges tidal (tier 2), the tier-1 river gauges not tidal, the rest unknown', () => {
    expect(codes(rows.filter((r) => r.flags.tidal === true))).toEqual(TIDAL);
    expect(rows.filter((r) => TIDAL.includes(r.provider_code)).every((r) => r.tier === 2)).toBe(true);
    for (const r of rows) {
      const want = TIDAL.includes(r.provider_code) ? true : r.tier === 1 ? false : null;
      expect([r.id, r.flags.tidal]).toEqual([r.id, want]);
    }
  });

  it('holds the Eijsden-grens TAW twin, and registry/twins.yaml validates against the file', () => {
    expect(find('eijsden.grens', 'H', 'twin')).toMatchObject({
      provider_key: 'eijsden.grens/WATHTE/TAW/other:F007',
      datum: 'TAW',
      tier: 1,
      first_release: false,
      staleness_limit: 'PT1H',
      expected_threshold_source: null,
      expected_forecast_source: null,
    });
    expect(find('eijsden.grens').provider_key).toBe('eijsden.grens/WATHTE/NAP/other:F007');
    expect(validateTwins(twinsDoc, rows).problems).toEqual([]);
    const twinKeys = twinsDoc.twins.flatMap((t) => [t.a.provider_key, t.b.provider_key]).sort();
    expect(twinKeys).toEqual(['eijsden.grens/WATHTE/NAP/other:F007', 'eijsden.grens/WATHTE/TAW/other:F007']);
    for (const key of twinKeys) expect(rows.filter((r) => r.provider_key === key)).toHaveLength(1);
  });

  it('registers no Belgian point, no stale series, no Pannerden weir gauge and no Hedel', () => {
    const belgian = inputs.seed.filter((r) => r.note === 'be').map((r) => r.code);
    expect(belgian).toHaveLength(9);
    expect(rows.filter((r) => belgian.includes(r.provider_code))).toEqual([]);
    const stale = (key: string) => STALE_SERIES.some((s) => key === s || key.startsWith(`${s}/`));
    expect(rows.filter((r) => stale(r.provider_key))).toEqual([]);
    expect(rows.filter((r) => r.provider_code === 'arnhem.nederrijn')).toEqual([]);
    expect(rows.filter((r) => r.provider_code === 'driel.boven').map((r) => r.quantity)).toEqual(['H']);
    expect(rows.filter((r) => r.provider_code.startsWith('pannerden.regelwerk.'))).toEqual([]);
    expect(rows.filter((r) => r.provider_code === 'hedel')).toEqual([]);
  });

  it('declares F007 for every H series but the two Vecht gauges (F155)', () => {
    const h = rows.filter((r) => r.quantity === 'H');
    expect(codes(h.filter((r) => method(r) !== 'other:F007'))).toEqual(['holtheme.vecht', 'ommen.vecht']);
    expect(new Set(h.filter((r) => method(r) !== 'other:F007').map(method))).toEqual(new Set(['other:F155']));
  });

  it('declares the live method of each Q series, per station', () => {
    expect(Object.fromEntries(rows.filter((r) => r.quantity === 'Q').map((r) => [r.provider_code, method(r)]))).toEqual(
      {
        'eijsden.grens': 'other:F216',
        'hagestein.boven': 'other:F103',
        'lobith.bovenrijn.tolkamer': 'other:F230',
        'maastricht.borgharen.maas.beneden': 'other:F006',
        'maastricht.sintpieter': 'other:F103',
        'megen.maas': 'other:F103',
        millingenaanderijn: 'other:F230',
        olst: 'other:F006',
        'ommen.vecht': 'other:F103',
        'pannerden.pannerdenschkanaal': 'other:F230',
        'tiel.waal': 'other:F006',
        venlo: 'other:F103',
        'westervoort.1': 'other:F006',
      },
    );
  });

  it('is stale after 1 h for key and twin series, 90 min for the others, 2 h for Eijsden Q', () => {
    const key = new Set(inputs.seed.filter((r) => r.tier === 'key').map((r) => `${r.code}/${r.quantity}`));
    for (const r of rows) {
      const want =
        r.role === 'twin' || key.has(`${r.provider_code}/${r.quantity}`)
          ? 'PT1H'
          : r.provider_key.startsWith('eijsden.grens/Q/')
            ? 'PT2H'
            : 'PT90M';
      expect([r.id, r.quantity, r.staleness_limit]).toEqual([r.id, r.quantity, want]);
    }
    const count = (limit: string) => rows.filter((r) => r.staleness_limit === limit).length;
    expect([count('PT1H'), count('PT90M'), count('PT2H')]).toEqual([26, 49, 1]);
  });

  it('names NL-4 as the threshold source of 58 of 62 H and 11 of 13 Q series, never of the twin', () => {
    const without = (quantity: 'H' | 'Q') =>
      codes(
        rows.filter((r) => r.quantity === quantity && r.role === 'primary' && r.expected_threshold_source === null),
      );
    expect(without('H')).toEqual([
      'holtheme.vecht',
      'lith.beneden',
      'millingenaanderijn.pannerdensekop',
      'rhenen.grebbeberg',
    ]);
    expect(without('Q')).toEqual(['hagestein.boven', 'millingenaanderijn']);
    expect(rows.filter((r) => r.expected_threshold_source === 'NL-4')).toHaveLength(69);
    expect(new Set(rows.map((r) => r.expected_threshold_source))).toEqual(new Set(['NL-4', null]));
  });

  it('names NL-1 as the forecast source of the series on the forecast list (58 H, 9 Q), never of the twin', () => {
    const forecast = new Set(inputs.forecast.map((r) => `${r.code}/${r.quantity}`));
    for (const r of rows) {
      const want = r.role === 'primary' && forecast.has(`${r.provider_code}/${r.quantity}`) ? 'NL-1' : null;
      expect([r.id, r.quantity, r.expected_forecast_source]).toEqual([r.id, r.quantity, want]);
    }
    const withForecast = (quantity: 'H' | 'Q') =>
      rows.filter((r) => r.quantity === quantity && r.expected_forecast_source === 'NL-1').length;
    expect([withForecast('H'), withForecast('Q')]).toEqual([58, 9]);
  });

  it('takes every code, name and coordinate from the recorded catalogue, the same on every row of a station', () => {
    const catalogue = inputs.catalogue as { LocatieLijst: { Code: string; Naam: string; Lon: number; Lat: number }[] };
    const byCode = new Map(catalogue.LocatieLijst.map((l) => [l.Code, l]));
    for (const r of rows) {
      const l = byCode.get(r.provider_code);
      expect([r.id, r.name, r.lon, r.lat]).toEqual([r.id, l?.Naam, l?.Lon, l?.Lat]);
    }
    for (const id of stationIds(rows)) {
      const of = rows.filter((r) => r.id === id);
      expect(new Set(of.map((r) => JSON.stringify([r.name, r.lon, r.lat, r.tier, r.flags]))).size).toBe(1);
    }
    expect(find('maastricht.sintpieter').name).toBe('Sint Pieter Noord');
    expect(find('lobith.bovenrijn.tolkamer')).toMatchObject({ name: 'Lobith, Bovenrijn, Tolkamer', tier: 1 });
  });
});

describe('scripts/gen-nl1-stations.ts fails loudly', () => {
  type Feature = { properties: Record<string, string>; geometry: { coordinates: number[] } };
  const withWfs = (change: (features: Feature[]) => void) => {
    const wfs = structuredClone(inputs.wfs) as { features: Feature[] };
    change(wfs.features);
    return () => run({ wfs });
  };
  const feature = (features: Feature[], code: string, grootheid: 'WATHTE' | 'Q', hoedanigheid = 'NAP') => {
    const found = features.find(
      (f) =>
        f.properties.CODE === code &&
        f.properties.GROOTHEIDCODE === grootheid &&
        f.properties.HOEDANIGHEIDCODE === hoedanigheid,
    );
    if (found === undefined) throw new Error(`no WFS feature ${code} ${grootheid}`);
    return found;
  };

  it('on a tier-1 station missing from the seed', () => {
    expect(() => run({ seed: inputs.seed.filter((r) => r.code !== 'tiel.waal') })).toThrow(
      /tier-1 station tiel\.waal is not in the seed/,
    );
  });

  it('on a series with two live methods', () => {
    const second = withWfs((fs) => {
      const lobith = structuredClone(feature(fs, 'lobith.bovenrijn.tolkamer', 'WATHTE'));
      lobith.properties.WAARDEBEPALINGSMETHODECODE = 'other:F001';
      fs.push(lobith);
    });
    expect(second).toThrow(/lobith\.bovenrijn\.tolkamer\/WATHTE\/NAP: 2 live methods \(other:F007, other:F001\)/);
  });

  it('on a NOT_LIVE series that is live', () => {
    const hedel = withWfs((fs) => {
      const copy = structuredClone(feature(fs, 'lith.boven', 'WATHTE'));
      copy.properties.CODE = 'hedel';
      fs.push(copy);
    });
    expect(hedel).toThrow(/hedel\/WATHTE\/NAP is in NOT_LIVE but the WFS shows it live/);
  });

  it('on a series with no live feature, a WFS unit or coordinate that disagrees', () => {
    const gone = withWfs((fs) => {
      fs.splice(fs.indexOf(feature(fs, 'venlo', 'Q', 'NVT')), 1);
    });
    expect(gone).toThrow(/venlo\/Q\/NVT: no live feature/);
    expect(withWfs((fs) => (feature(fs, 'venlo', 'Q', 'NVT').properties.EENHEIDCODE = 'm3/d'))).toThrow(
      /venlo\/Q\/NVT: unit "m3\/d"/,
    );
    expect(
      withWfs((fs) => {
        const coordinates = feature(fs, 'venlo', 'WATHTE').geometry.coordinates;
        coordinates[0] = (coordinates[0] ?? 0) + 0.001;
      }),
    ).toThrow(/venlo\/WATHTE\/NAP: WFS coordinates .* disagree with the catalogue/);
  });

  it('but takes an exact duplicate feature as one', () => {
    const duplicated = withWfs((fs) => {
      fs.push(structuredClone(feature(fs, 'lobith.bovenrijn.tolkamer', 'Q', 'NVT')));
    });
    expect(duplicated()).toBe(committed);
  });
});
