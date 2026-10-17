import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STALE_SERIES } from '../apps/server/src/adapters/nl-1/normalise.ts';
import { H_DESCRIPTION, Q_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import {
  PublicStation,
  SourcesFile,
  StationsFile,
  validateStations,
  validateTwins,
} from '../packages/contracts/src/index.ts';
import { evident, generate, type Inputs, OUTPUT, readInputs, WATERS } from '../scripts/gen-nl1-stations.ts';
import { locations } from '../scripts/rws-inventory.ts';
import { repoRoot } from './catalogue.ts';

// registry/stations/nl-1.yaml is generated (scripts/gen-nl1-stations.ts) from the NL-1 seed, the recorded
// RWS catalogue, the recorded NL-2 WFS snapshot, the forecast locations and the NL-4 classes: the committed
// file is exactly the generator's output, and it declares each captured series with its one live method.

const committed = readFileSync(OUTPUT, 'utf8');
const inputs = readInputs();
const run = (change: Partial<Inputs> = {}) => generate({ ...inputs, ...change });
const sources = SourcesFile.parse(parse(readFileSync(`${repoRoot}registry/sources.yaml`, 'utf8'))).sources;
const twinsDoc = parse(readFileSync(`${repoRoot}registry/twins.yaml`, 'utf8')) as {
  twins: { a: { source: string; provider_key: string }; b: { source: string; provider_key: string } }[];
};

const all = StationsFile.parse(parse(committed)).stations.filter((s): s is PublicStation => s.audience !== 'owner');
// The roadmap-1 rows (P2b, P5a): the series of the seed tiers key, other and twin. P16b adds the sea, wide and slow
// tiers and the structure-internal off rows; their tests are at the end of the file.
const ROADMAP_SERIES = new Set(
  inputs.seed.filter((r) => ['key', 'other', 'twin'].includes(r.tier ?? '')).map((r) => `${r.code}/${r.quantity}`),
);
const rows = all.filter(
  (r) =>
    r.audience === 'public' &&
    ROADMAP_SERIES.has(`${r.provider_code}/${r.quantity}`) &&
    (r.role === 'primary' || r.provider_code === 'eijsden.grens'),
);
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
// P5a: antwerpen (the tidal Scheldt, a seed row on Belgian soil) joins the six Dutch sea and estuary gauges.
const TIDAL = [
  'antwerpen',
  'delfzijl',
  'hansweert',
  'nieuwestatenzijl.dollard',
  'rilland.bath',
  'terneuzen',
  'vlissingen',
];
// P5a: the 7 RWS points on Belgian soil of catalogue §0.6 (9 series), the seed rows noted `be`: registered as ordinary
// tier-2 primary rows with country BE (A§7.2 exception until a Belgian source is public, P13).
const BELGIAN = [
  'antwerpen',
  'herenlaak',
  'kanne',
  'lanaken',
  'lixhebiefaval',
  'maaseik',
  'smeermaas.zuidwillemsvaart',
];

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

  it('holds 85 rows at 72 stations (68 H, 1 TAW twin, 16 Q), all public and open, NL but for the Belgian points', () => {
    // P5a: 76 rows at 65 stations (62 H, 1 twin, 13 Q) plus the 9 Belgian series (6 H, 3 Q) at 7 stations.
    expect(stationIds(rows).size).toBe(72);
    expect(rows).toHaveLength(85);
    expect(rows.filter((r) => r.quantity === 'H' && r.role === 'primary')).toHaveLength(68);
    expect(rows.filter((r) => r.role === 'twin')).toHaveLength(1);
    expect(rows.filter((r) => r.quantity === 'Q')).toHaveLength(16);
    for (const r of rows) {
      expect(r).toMatchObject({
        id: `nl.rws.${r.provider_code}`,
        source: 'NL-1',
        country: BELGIAN.includes(r.provider_code) ? 'BE' : 'NL',
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
    // Tier 2: 34 H stations of the earlier files, and the 7 Belgian stations (6 H, 3 Q rows) of P5a.
    const tier2 = rows.filter((r) => r.tier === 2);
    expect(stationIds(tier2).size).toBe(41);
    expect(tier2).toHaveLength(43);
    expect(tier2.every((r) => !r.first_release && r.role === 'primary')).toBe(true);
    expect(tier2.filter((r) => r.quantity === 'Q').map((r) => r.provider_code)).toEqual([
      'kanne',
      'maaseik',
      'smeermaas.zuidwillemsvaart',
    ]);
  });

  it('gives every tier-1 row every field of the station registry', () => {
    const fields = Object.keys(PublicStation.shape);
    for (const r of rows.filter((x) => x.tier === 1)) {
      const record = r as Record<string, unknown>;
      expect(fields.filter((f) => record[f] === undefined)).toEqual([]);
    }
  });

  it('flags the seven sea and estuary gauges tidal (tier 2), the tier-1 river gauges not tidal, the rest unknown', () => {
    // P16b: four more roadmap-1 gauges are tidal by their water type (rws-inventory TABLE: delta); no other flag moved.
    const tidalNow = [...TIDAL, 'heesbeen', 'hoekvanholland', 'moerdijk', 'werkendam.nieuwemerwede'].sort();
    expect(codes(rows.filter((r) => r.flags.tidal === true))).toEqual(tidalNow);
    expect(rows.filter((r) => TIDAL.includes(r.provider_code)).every((r) => r.tier === 2)).toBe(true);
    for (const r of rows) {
      const want = tidalNow.includes(r.provider_code) ? true : r.tier === 1 ? false : null;
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
    // The NL-1 pair validates against the NL-1 rows (P5b added pairs of other sources: test/registry-precedence.test.ts).
    const nl1 = { twins: twinsDoc.twins.filter((t) => t.a.source === 'NL-1' && t.b.source === 'NL-1') };
    expect(validateTwins(nl1, rows).problems).toEqual([]);
    const twinKeys = nl1.twins.flatMap((t) => [t.a.provider_key, t.b.provider_key]).sort();
    expect(twinKeys).toEqual(['eijsden.grens/WATHTE/NAP/other:F007', 'eijsden.grens/WATHTE/TAW/other:F007']);
    for (const key of twinKeys) expect(rows.filter((r) => r.provider_key === key)).toHaveLength(1);
  });

  it('registers the 7 Belgian points (9 series) of §0.6 as primary tier-2 rows, country BE; no stale series, no Pannerden weir gauge, no Hedel', () => {
    // Before P5a these 9 seed rows were skipped; now each is an ordinary `other` row (method from the WFS snapshot).
    const seeded = inputs.seed.filter((r) => r.note === 'be');
    expect(seeded).toHaveLength(9);
    expect([...new Set(seeded.map((r) => r.code))].sort()).toEqual(BELGIAN);
    const be = rows.filter((r) => r.country === 'BE');
    expect(be.map((r) => `${r.provider_code}/${r.quantity}`).sort()).toEqual(
      seeded.map((r) => `${r.code}/${r.quantity}`).sort(),
    );
    expect(be).toHaveLength(9);
    for (const r of be) {
      expect([r.id, r.role, r.tier, r.first_release, r.audience]).toEqual([r.id, 'primary', 2, false, 'public']);
    }
    // kanne keeps no river: the water body is unverified (catalogue §10 R9), and no NL-1 row has a river anyway.
    expect(find('kanne', 'Q')).toMatchObject({ river: null, water_name: null, tier: 2 });
    // sasvangent is on Dutch soil and not in the seed: not registered.
    expect(rows.filter((r) => r.provider_code === 'sasvangent')).toEqual([]);
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

  it('declares the live method of each Q series, per station (maaseik F006, kanne and smeermaas F103: P5a)', () => {
    expect(Object.fromEntries(rows.filter((r) => r.quantity === 'Q').map((r) => [r.provider_code, method(r)]))).toEqual(
      {
        'eijsden.grens': 'other:F216',
        'hagestein.boven': 'other:F103',
        kanne: 'other:F103',
        'lobith.bovenrijn.tolkamer': 'other:F230',
        maaseik: 'other:F006',
        'maastricht.borgharen.maas.beneden': 'other:F006',
        'maastricht.sintpieter': 'other:F103',
        'megen.maas': 'other:F103',
        millingenaanderijn: 'other:F230',
        olst: 'other:F006',
        'ommen.vecht': 'other:F103',
        'pannerden.pannerdenschkanaal': 'other:F230',
        'smeermaas.zuidwillemsvaart': 'other:F103',
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
    // P5a: the 9 Belgian series are `other` rows (every 30 min): 49 + 9 stale after 90 min.
    expect([count('PT1H'), count('PT90M'), count('PT2H')]).toEqual([26, 58, 1]);
  });

  it('names NL-4 as the threshold source of 61 of 68 H and 13 of 16 Q series, never of the twin', () => {
    const without = (quantity: 'H' | 'Q') =>
      codes(
        rows.filter((r) => r.quantity === quantity && r.role === 'primary' && r.expected_threshold_source === null),
      );
    // P5a: the Belgian rows add antwerpen, herenlaak and lixhebiefaval (no NL-4 class) and kanne Q; lanaken, maaseik
    // and smeermaas have classes, which is also why the converter's 702 NL-4 reference rows grow.
    expect(without('H')).toEqual([
      'antwerpen',
      'herenlaak',
      'holtheme.vecht',
      'lith.beneden',
      'lixhebiefaval',
      'millingenaanderijn.pannerdensekop',
      'rhenen.grebbeberg',
    ]);
    expect(without('Q')).toEqual(['hagestein.boven', 'kanne', 'millingenaanderijn']);
    expect(rows.filter((r) => r.expected_threshold_source === 'NL-4')).toHaveLength(74);
    expect(new Set(rows.map((r) => r.expected_threshold_source))).toEqual(new Set(['NL-4', null]));
  });

  it('names NL-1 as the forecast source of the series on the forecast list (61 H, 10 Q), never of the twin', () => {
    const forecast = new Set(inputs.forecast.map((r) => `${r.code}/${r.quantity}`));
    for (const r of rows) {
      const want = r.role === 'primary' && forecast.has(`${r.provider_code}/${r.quantity}`) ? 'NL-1' : null;
      expect([r.id, r.quantity, r.expected_forecast_source]).toEqual([r.id, r.quantity, want]);
    }
    const withForecast = (quantity: 'H' | 'Q') =>
      rows.filter((r) => r.quantity === quantity && r.expected_forecast_source === 'NL-1').length;
    // P5a: + antwerpen H, maaseik H, lanaken H and maaseik Q.
    expect([withForecast('H'), withForecast('Q')]).toEqual([61, 10]);
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

describe('registry/stations/nl-1.yaml, the P16b rows (sea, wide and slow tiers, structure-internal off rows)', () => {
  const catalogue = inputs.catalogue as { LocatieLijst: { Code: string; Naam: string }[] };
  const nameOf = new Map(catalogue.LocatieLijst.map((l) => [l.Code, l.Naam]));
  const places = locations(inputs.catalogue, inputs.wfs);
  const typeOf = (code: string) => places.get(code)?.row.type;
  const structure = [...places].filter(([, l]) => l.row.type === 'structure');
  const off = all.filter((r) => r.audience === 'off');
  const pub = all.filter((r) => r.audience === 'public');
  const added = pub.filter((r) => !rows.includes(r));
  const findAny = (code: string) => {
    const row = pub.find((r) => r.provider_code === code && r.quantity === 'H' && r.role === 'primary');
    if (row === undefined) throw new Error(`no NL-1 row ${code}`);
    return row;
  };
  const seedTier = (code: string, quantity: string) =>
    inputs.seed.filter((r) => r.code === code && r.quantity === quantity).map((r) => r.tier);

  it('holds 429 rows at 391 stations: 411 public rows at 373 stations and 18 off rows', () => {
    expect(all).toHaveLength(429);
    expect(stationIds(all).size).toBe(391);
    expect(pub).toHaveLength(411);
    expect(stationIds(pub).size).toBe(373);
    expect(off).toHaveLength(18);
    // 414 seed rows less the three the registry cannot hold (driel.boven Q and arnhem.nederrijn Q are stale, hedel H not live).
    expect(inputs.seed).toHaveLength(414);
    expect(added).toHaveLength(411 - rows.length);
    expect(added.filter((r) => r.role === 'twin').map((r) => r.provider_key)).toEqual([
      'elsloo.maas/WATHTE/TAW/other:F007',
    ]);
    const by = (f: (r: PublicStation) => string) => {
      const m: Record<string, number> = {};
      for (const r of pub) m[f(r)] = (m[f(r)] ?? 0) + 1;
      return m;
    };
    expect(by((r) => `${r.datum}`)).toEqual({ NAP: 300, MSL: 12, TAW: 2, null: 97 });
    expect(by((r) => `${r.quantity}/${r.role}`)).toEqual({ 'H/primary': 312, 'H/twin': 2, 'Q/primary': 97 });
  });

  it('registers every seed row once, but the three the registry leaves out', () => {
    const left = ['driel.boven/Q', 'arnhem.nederrijn/Q', 'hedel/H'];
    const key = (code: string | undefined, quantity: string | undefined, role: string) => `${code}/${quantity}/${role}`;
    const seeded = inputs.seed.map((r) =>
      key(r.code, r.quantity, r.tier === 'twin' || r.hoedanigheid === 'TAW' ? 'twin' : 'primary'),
    );
    const registered = new Set(pub.map((r) => key(r.provider_code, r.quantity, r.role)));
    expect(registered.size).toBe(pub.length);
    const missing = seeded.filter((k) => !registered.has(k)).map((k) => k.slice(0, k.lastIndexOf('/')));
    expect(missing.sort()).toEqual([...left].sort());
  });

  it('declares one Hoedanigheid per seed row: NAP, NVT for Q, TAW as a twin, MSL for the offshore platforms only', () => {
    for (const r of added) {
      expect(r.provider_key.split('/')[2], r.provider_key).toBe(r.quantity === 'Q' ? 'NVT' : r.datum);
      expect(['NAP', 'MSL', 'TAW', null], r.provider_key).toContain(r.datum);
      expect(r.native_step, r.provider_key).toBe('PT10M');
      expect(r.first_release, r.provider_key).toBe(r.tier === 1 && r.role === 'primary');
    }
    // MSL: every MSL row is an offshore location, and every offshore H row is MSL.
    const msl = pub.filter((r) => r.datum === 'MSL');
    expect(msl).toHaveLength(12);
    for (const r of msl) expect([r.id, typeOf(r.provider_code)]).toEqual([r.id, 'offshore']);
    const offshoreH = pub.filter((r) => r.quantity === 'H' && typeOf(r.provider_code) === 'offshore');
    expect(offshoreH.map((r) => r.id)).toEqual(msl.map((r) => r.id));
    for (const r of msl) expect([r.expected_threshold_source, r.expected_forecast_source]).toEqual([null, null]);
  });

  it('keeps the Elsloo TAW series a twin with no pair in registry/twins.yaml', () => {
    expect(pub.find((r) => r.provider_code === 'elsloo.maas' && r.role === 'twin')).toMatchObject({
      datum: 'TAW',
      tier: 2,
      expected_forecast_source: null,
    });
    expect(twinsDoc.twins.filter((t) => JSON.stringify(t).includes('elsloo'))).toEqual([]);
  });

  it('sets the staleness limit by tier: sea 1 h, wide 90 min, slow 3 h', () => {
    for (const r of added) {
      const tiers = seedTier(r.provider_code, r.quantity);
      const want = tiers.includes('sea') ? 'PT1H' : tiers.includes('wide') ? 'PT90M' : 'PT3H';
      expect([r.provider_key, r.staleness_limit]).toEqual([r.provider_key, want]);
    }
  });

  it('puts every station with a sea row in tier 1, and no new row in the first release', () => {
    const seaCodes = new Set(inputs.seed.filter((r) => r.tier === 'sea').map((r) => r.code));
    expect(seaCodes.size).toBe(29);
    const tier1Codes = new Set(pub.filter((r) => r.tier === 1).map((r) => r.provider_code));
    expect([...tier1Codes].sort()).toEqual([...new Set([...TIER1, ...seaCodes])].sort());
    // first_release is public, primary and tier 1: the 41 roadmap-1 rows, 29 sea rows and the Q row of epen.
    expect(pub.filter((r) => r.first_release)).toHaveLength(71);
    expect(pub.every((r) => r.first_release === (r.tier === 1 && r.role === 'primary'))).toBe(true);
    // The two lake references are tier 1 and not tidal.
    for (const code of ['krabbersgat.ijsselmeer', 'markermeer.midden']) {
      expect(findAny(code)).toMatchObject({ tier: 1, flags: { tidal: false, lake: true }, first_release: true });
    }
  });

  it('flags tidal by the water type of rws-inventory and lake for the lakes; only four roadmap-1 rows moved', () => {
    for (const r of pub) {
      const t = typeOf(r.provider_code);
      const tidal = TIDAL.includes(r.provider_code) || ['coast', 'scheldt', 'delta', 'offshore'].includes(t ?? '');
      expect([r.id, r.flags.tidal === true]).toEqual([r.id, tidal]);
      expect([r.id, r.flags.lake === true]).toEqual([r.id, t === 'lake']);
      expect(r.flags.lake === undefined || r.flags.lake === true).toBe(true);
    }
    const moved = rows.filter((r) => r.flags.tidal === true && !TIDAL.includes(r.provider_code));
    expect(codes(moved)).toEqual(['heesbeen', 'hoekvanholland', 'moerdijk', 'werkendam.nieuwemerwede']);
  });

  it('names a water only where the RWS code or the catalogue name contains it, and leaves the roadmap-1 rows null', () => {
    expect(WATERS.size).toBe(44);
    for (const [code, water] of WATERS) {
      expect(evident(water, code, nameOf.get(code) ?? ''), `${code} ${water}`).toBe(true);
      expect(
        rows.some((r) => r.provider_code === code),
        code,
      ).toBe(false);
    }
    for (const r of all) {
      expect([r.id, r.water_name]).toEqual([r.id, WATERS.get(r.provider_code) ?? null]);
      expect([r.id, r.km, r.river]).toEqual([r.id, null, null]);
    }
    expect(findAny('denoever.waddenzee.voorhaven').water_name).toBe('Waddenzee');
    expect(findAny('krabbersgat.markermeer').water_name).toBe('Markermeer');
    expect(findAny('scheveningen').water_name).toBeNull();
    expect(findAny('dordrecht.oudemaas.benedenmerwede').water_name).toBeNull();
  });

  it('registers the 18 structure-internal locations as off rows with their reason in the header, none in a seed', () => {
    expect(structure).toHaveLength(18);
    expect(off.map((r) => r.provider_code).sort()).toEqual(structure.map(([c]) => c).sort());
    expect(off.filter((r) => r.quantity === 'H')).toHaveLength(6);
    expect(off.filter((r) => r.quantity === 'Q')).toHaveLength(12);
    const flat = committed.slice(0, committed.indexOf('\nstations:')).replace(/\n#\s+/g, ' ');
    for (const [code, place] of structure) {
      expect(place.row.reason, code).toBeTruthy();
      expect(flat, code).toContain(`${code} (${place.row.reason})`);
      expect(
        inputs.seed.some((r) => r.code === code),
        code,
      ).toBe(false);
      expect(
        inputs.forecast.some((r) => r.code === code),
        code,
      ).toBe(false);
    }
    for (const r of off) {
      expect([r.id, r.audience, r.first_release, r.expected_threshold_source, r.expected_forecast_source]).toEqual([
        r.id,
        'off',
        false,
        null,
        null,
      ]);
    }
  });

  it('names NL-4 and NL-1 for the new NAP and NVT series that the NL-4 file and the forecast list have', () => {
    const classed = new Set(inputs.thresholds.map((t) => `${t.description}\n${t.code}`));
    const forecast = new Set(inputs.forecast.map((r) => `${r.code}/${r.quantity}`));
    for (const r of added.filter((x) => x.role === 'primary' && x.datum !== 'MSL')) {
      const description = r.quantity === 'H' ? H_DESCRIPTION : Q_DESCRIPTION;
      expect([r.id, r.quantity, r.expected_forecast_source]).toEqual([
        r.id,
        r.quantity,
        forecast.has(`${r.provider_code}/${r.quantity}`) ? 'NL-1' : null,
      ]);
      expect([r.id, r.expected_threshold_source]).toEqual([
        r.id,
        classed.has(`${description}\n${r.provider_code}`) ? 'NL-4' : null,
      ]);
    }
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
    // The inventory table is read first: a live code it lacks is refused before the NOT_LIVE check.
    expect(hedel).toThrow(/live location hedel has no TABLE row/);
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

  it('on an unknown Hoedanigheid of a seed row, and on a structure-internal code in the seed', () => {
    const seed = inputs.seed.map((r) => (r.code === 'a12' ? { ...r, hoedanigheid: 'XYZ' } : r));
    expect(() => run({ seed })).toThrow(/a12 H\/wide: unknown hoedanigheid "XYZ"/);
    const lock = { code: 'beekendonk.sluis6.kolk', quantity: 'Q', tier: 'slow', note: '', hoedanigheid: 'NVT' };
    expect(() => run({ seed: [...inputs.seed, lock] })).toThrow(/beekendonk\.sluis6\.kolk is in the seed/);
  });

  it('but takes an exact duplicate feature as one', () => {
    const duplicated = withWfs((fs) => {
      fs.push(structuredClone(feature(fs, 'lobith.bovenrijn.tolkamer', 'Q', 'NVT')));
    });
    expect(duplicated()).toBe(committed);
  });
});
