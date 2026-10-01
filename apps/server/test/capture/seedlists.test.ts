import { describe, expect, it } from 'vitest';
import { REGISTRY_DIR, readSeed } from '../../src/capture/specs.ts';
import { fixture } from './helpers.ts';

// Station lists trace to recorded payloads, never invented (issue #16 build
// item 4), plus criterion "[CI] A registry test shows that the NL-1 specs
// include the 7 RWS Belgian points and that the FR-1 request covers all 18
// NL-bound Belgian partner-station codes of §0.6".

const seed = (name: string) => readSeed(REGISTRY_DIR, name);
const json = <T>(source: string, name: string) => JSON.parse(fixture(source, name).body.toString('utf8')) as T;

type Catalogue = {
  AquoMetadataLijst: {
    AquoMetadata_MessageID: number;
    Grootheid?: { Code: string };
    Hoedanigheid?: { Code: string };
    ProcesType?: string;
  }[];
  LocatieLijst: { Locatie_MessageID: number; Code: string }[];
  AquoMetadataLocatieLijst: { AquoMetaData_MessageID: number; Locatie_MessageID: number }[];
};

function rwsSets() {
  const c = json<Catalogue>('NL-1', 'nl-1-catalogue');
  const loc = new Map(c.LocatieLijst.map((l) => [l.Locatie_MessageID, l.Code]));
  const set = (pred: (a: Catalogue['AquoMetadataLijst'][number]) => boolean) => {
    const ids = new Set(c.AquoMetadataLijst.filter(pred).map((a) => a.AquoMetadata_MessageID));
    return new Set(
      c.AquoMetadataLocatieLijst.filter((l) => ids.has(l.AquoMetaData_MessageID)).map((l) =>
        loc.get(l.Locatie_MessageID),
      ),
    );
  };
  return {
    obsH: set((a) => a.Grootheid?.Code === 'WATHTE' && a.Hoedanigheid?.Code === 'NAP' && a.ProcesType === 'meting'),
    obsQ: set((a) => a.Grootheid?.Code === 'Q' && a.ProcesType === 'meting'),
    fcH: set((a) => a.Grootheid?.Code === 'WATHTE' && a.ProcesType === 'verwachting'),
    fcQ: set((a) => a.Grootheid?.Code === 'Q' && a.ProcesType === 'verwachting'),
  };
}

describe('RWS (NL-1) seed lists against the recorded OphalenCatalogus', () => {
  const s = rwsSets();

  it('every observation code exists with the requested quantity; Q only where Q meting exists', () => {
    const rows = seed('nl-1');
    expect(rows.filter((r) => r.tier === 'key' && r.quantity === 'H').length).toBeGreaterThanOrEqual(20);
    expect(rows.filter((r) => r.tier === 'other').length).toBeGreaterThanOrEqual(40);
    for (const r of rows)
      expect((r.quantity === 'Q' ? s.obsQ : s.obsH).has(r.code), `${r.code}/${r.quantity}`).toBe(true);
    expect(rows.filter((r) => r.tier === 'key').every((r) => r.quantity === 'H')).toBe(true);
  });

  it('the only twin row is the Eijsden-grens TAW series, which the recorded WFS snapshot shows live', () => {
    expect(seed('nl-1').filter((r) => r.tier === 'twin')).toEqual([
      { code: 'eijsden.grens', quantity: 'H', tier: 'twin', note: 'taw' },
    ]);
    type Wfs = { features: { properties: { CODE: string; GROOTHEIDCODE: string; HOEDANIGHEIDCODE: string } }[] };
    const taw = json<Wfs>('NL-2', 'nl-2-wfs').features.filter(
      (f) => f.properties.GROOTHEIDCODE === 'WATHTE' && f.properties.HOEDANIGHEIDCODE === 'TAW',
    );
    expect(taw.map((f) => f.properties.CODE)).toContain('eijsden.grens');
  });

  it('the forecast list is exactly every verwachting location (183 WATHTE, 13 Q)', () => {
    const rows = seed('nl-1-forecast');
    expect(new Set(rows.filter((r) => r.quantity === 'H').map((r) => r.code))).toEqual(s.fcH);
    expect(new Set(rows.filter((r) => r.quantity === 'Q').map((r) => r.code))).toEqual(s.fcQ);
    expect(s.fcH.size).toBe(183);
    expect(s.fcQ.size).toBe(13);
  });

  it('includes the 7 RWS points on Belgian soil with their live series and forecasts (§0.6)', () => {
    const obs = new Set(seed('nl-1').map((r) => `${r.code}/${r.quantity}`));
    for (const k of [
      'antwerpen/H',
      'lixhebiefaval/H',
      'maaseik/H',
      'maaseik/Q',
      'herenlaak/H',
      'lanaken/H',
      'kanne/Q',
      'smeermaas.zuidwillemsvaart/H',
      'smeermaas.zuidwillemsvaart/Q',
    ]) {
      expect(obs.has(k), k).toBe(true);
    }
    const fc = new Set(seed('nl-1-forecast').map((r) => `${r.code}/${r.quantity}`));
    for (const k of ['antwerpen/H', 'maaseik/H', 'maaseik/Q', 'lanaken/H']) expect(fc.has(k), k).toBe(true);
    expect(seed('nl-1').some((r) => r.code === 'sasvangent' && r.note === 'be')).toBe(false);
  });
});

describe('FR-1: the 18 NL-bound Belgian partner stations (§0.6)', () => {
  const ref = new Map<string, { code_commune_station: string | number }>();
  for (const p of ['', '-B', '-D', '-E1', '-E2', '-E3']) {
    for (const st of json<{ data: { code_station: string; code_commune_station: string }[] }>('FR-1', `fr-1-ref${p}`)
      .data) {
      ref.set(st.code_station, st);
    }
  }
  const rows = seed('fr-1-be');

  it('are 18 recorded stations with the Belgian commune code 99131', () => {
    expect(rows).toHaveLength(18);
    for (const r of rows)
      expect(String(ref.get(r.code_station ?? '')?.code_commune_station), r.code_station).toBe('99131');
  });

  it('are all covered by the FR-1 request (a code_entite prefix or an explicit code)', () => {
    const url = new URL(
      'https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=A*,B*,D*,E1*,E2*,E3*',
    );
    const entries = (url.searchParams.get('code_entite') ?? '').split(',');
    const explicit = rows.filter((r) => r.explicit === 'yes').map((r) => r.code_station);
    for (const r of rows) {
      const covered = entries.some((e) =>
        e.endsWith('*') ? r.code_station?.startsWith(e.slice(0, -1)) : e === r.code_station,
      );
      expect(covered || explicit.includes(r.code_station), r.code_station).toBe(true);
    }
  });

  it('leave out Tournai, Solre-Erquelinnes and the Yser at Roesbrugge', () => {
    const codes = rows.map((r) => r.code_station);
    expect(codes).not.toContain('E240041201');
    expect(codes).not.toContain('D021000101');
    expect(rows.some((r) => /roesbrugge|yser/i.test(r.name ?? ''))).toBe(false);
  });

  it('the FR-3 key stations are recorded Hub’Eau stations', () => {
    for (const r of seed('fr-3')) expect(ref.has(r.code ?? ''), r.code).toBe(true);
  });
});

describe('PEGELONLINE and BAFU lists', () => {
  it('DE-1 series are recorded W/Q series of recorded stations', () => {
    const meta = new Map(
      json<{ uuid: string; timeseries: { shortname: string }[] }[]>('DE-1', 'de-1-meta').map((s) => [s.uuid, s]),
    );
    const rows = seed('de-1');
    expect(rows.length).toBeGreaterThanOrEqual(55);
    for (const r of rows) {
      expect(
        meta.get(r.uuid ?? '')?.timeseries.some((t) => t.shortname === r.ts),
        `${r.name} ${r.ts}`,
      ).toBe(true);
    }
  });

  it('DE-2 lists the 7 Rhine stations that carry a WV series', () => {
    const wv = json<{ uuid: string; water: { shortname: string }; timeseries: { shortname: string }[] }[]>(
      'DE-1',
      'de-1-wv-stations',
    );
    const rhine = wv
      .filter((s) => s.water.shortname === 'RHEIN' && s.timeseries.some((t) => t.shortname === 'WV'))
      .map((s) => s.uuid);
    expect(
      seed('de-2')
        .map((r) => r.uuid)
        .sort(),
    ).toEqual(rhine.sort());
    expect(rhine).toHaveLength(7);
  });

  it('CH-3 ids are recorded hydrodaten stations; CH-4 ids are exactly the recorded forecast stations', () => {
    const pq = new Set(
      json<{ features: { properties: { key: string } }[] }>('CH-2', 'ch-2-pq').features.map((f) => f.properties.key),
    );
    const ch3 = seed('ch-3').map((r) => r.id);
    expect(ch3).toHaveLength(11);
    for (const id of ch3) expect(pq.has(id ?? ''), id).toBe(true);
    const fc = json<{ features: { properties: { key: string } }[] }>('CH-4', 'ch-4-stations').features.map(
      (f) => f.properties.key,
    );
    expect(
      seed('ch-4')
        .map((r) => r.id)
        .sort(),
    ).toEqual(fc.sort());
  });
});

describe('AGE lists (owner audience: identification only)', () => {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[\s/_-]+/g, '-');

  it('LU-2 files are LU-1 station names (the CC0 file), without SN_Remich, Bollendorf and Gemünd_Our', () => {
    const lu1 = fixture('LU-1', 'lu-1-csv').body.toString('utf8');
    const names = new Set(
      lu1
        .split('\n')
        .slice(1)
        .map((l) => /^"([^"]*)"/.exec(l)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(norm),
    );
    const files = seed('lu-2').map((r) => r.file ?? '');
    expect(files).toHaveLength(39);
    for (const f of files) expect(names.has(norm(f).replace(/^roodt-sur-syre$/, 'roodt-sur-syre')), f).toBe(true);
    for (const f of ['SN_Remich', 'Bollendorf', 'Gemünd_Our']) expect(files).not.toContain(f);
  });

  it('LU-3 slugs and LU-4 page paths are well formed and skip the LfU RLP gauges', () => {
    for (const r of seed('lu-3')) expect(r.slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    const pages = seed('lu-4').map((r) => r.path ?? '');
    expect(pages).toHaveLength(40);
    for (const p of pages) expect(p).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/);
    expect(pages.some((p) => /bollendorf|gemund/.test(p))).toBe(false);
  });

  it('DE-3 lists only Rhine BfG files', () => {
    for (const r of seed('de-3'))
      expect(r.path).toMatch(
        /^(?:14-Tage-Vorhersage\/[A-Za-z-]+_Quantile_\d+|6-Wochen-Vorhersage\/Rhein-[A-Za-z-]+_6Wochen_[A-Za-z]+_[A-Za-z]+)\.csv$/,
      );
  });
});
