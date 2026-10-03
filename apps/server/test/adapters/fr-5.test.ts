import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { LEVEL_NORM, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  driftReport,
  floodKind,
  MIN_SHARE,
  normaliseLinks,
  normaliseStation,
  normaliseVigilance,
} from '../../src/adapters/fr-5/normalise.ts';
import { MAX_FEATURES, parseStation, parseTron, parseVigilance } from '../../src/adapters/fr-5/parse.ts';
import { vigicruesSectionCodes, vigicruesSections, vigicruesSectionTable } from '../../src/load/tables.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// FR-5 Vigicrues: the vigilance map, TronEntVigiCru/territory documents and station.json. Parse + normalise of real
// recorded payloads equal the committed golden files (invariant 9); `UPDATE_GOLDEN=1` rewrites them and a golden
// change is reviewed like code. A warning's geometry is stored in a golden as its sha256 and length only (the
// polygons are real and large); the tests below read the geometry itself.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SECTIONS = vigicruesSectionCodes();
const fetchedAt = (name: string) => Date.parse(rawFixture('FR-5', name).meta.recorded_at);
const body = (name: string) => rawFixture('FR-5', name).body;
const text = (o: unknown) => Buffer.from(JSON.stringify(o));

/** A Normalised with each warning geometry replaced by `sha256:<hex>:<length>`. */
function digest(n: Normalised): unknown {
  return {
    ...n,
    warnings: n.warnings && {
      ...n.warnings,
      rows: n.warnings.rows.map((r) => ({
        ...r,
        geometry: r.geometry === null ? null : `sha256:${sha(r.geometry)}:${r.geometry.length}`,
      })),
    },
  };
}

function golden(name: string, actual: unknown): unknown {
  const url = goldenUrl('FR-5', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const vigilance = (name: string, sections: ReadonlySet<string> = SECTIONS) =>
  normaliseVigilance(parseVigilance(body(name)), { fetchedAt: fetchedAt(name), sections });
const rowsOf = (n: Normalised) => n.warnings?.rows ?? [];
const atOf = (n: Normalised) => (n.warnings?.mode === 'snapshot' ? n.warnings.at : undefined);

describe('golden files (real payloads): the vigilance map', () => {
  it('the archive map (2026-10-03, the 56 sections of territories 2, 3 and 29): every section is ours, all at level 1', () => {
    const out = vigilance('fr-5-vigilance-archive');
    expect(digest(out)).toEqual(golden('fr-5-vigilance-archive', digest(out)));
    expect(out.dropped).toEqual({});
    expect(out.warnings?.mode).toBe('snapshot');
    // DtHrInfoVigiCru "2026-10-03T07:55:24+00:00"
    expect(atOf(out)).toBe('2026-10-03T07:55:24.000Z');
    const rows = rowsOf(out);
    expect(rows).toHaveLength(56);
    expect(new Set(rows.map((r) => r.area_key)).size).toBe(56);
    expect(new Set(rows.map((r) => r.area_key))).toEqual(SECTIONS);
    // NivInfViCr 1 (vert) is level_norm 2 (normal); the provider's number is kept as published.
    expect(rows.every((r) => r.level === LEVEL_NORM.normal && r.level_raw === '1')).toBe(true);
    expect(rows.every((r) => r.valid_from === '2026-10-03T07:55:24.000Z' && r.valid_to === null)).toBe(true);
    const nieds = rows.find((r) => r.area_key === 'LO12');
    expect(nieds).toMatchObject({ name: 'Nieds', label_raw: null, issued_at: null });
    // The geometry is the feature's own WGS84 GeoJSON.
    const geometry = JSON.parse(nieds?.geometry ?? 'null');
    expect(geometry.type).toBe('MultiLineString');
    expect(geometry.coordinates[0][0]).toEqual([6.619740999996782, 49.04271199999825]);
  });

  it('the all-France map of 2026-09-29: only the sections of our table are kept, the rest is out_of_scope', () => {
    const doc = parseVigilance(body('fr-5-vigilance'));
    const out = vigilance('fr-5-vigilance');
    expect(digest(out)).toEqual(golden('fr-5-vigilance', digest(out)));
    expect(doc.sections).toHaveLength(140);
    expect(atOf(out)).toBe('2026-09-29T07:52:49.000Z');
    const kept = rowsOf(out).length;
    expect(kept).toBeGreaterThan(0);
    expect(out.dropped.out_of_scope).toBe(140 - kept);
    expect(rowsOf(out).every((r) => SECTIONS.has(r.area_key))).toBe(true);
    // Level 2 (jaune) was on the map that day: level_norm 3, raw "2".
    expect(doc.sections.some((s) => s.level === 2)).toBe(true);
  });

  it('the 2023 Wayback capture (old key casing, no DtHrInfoVigiCru): the fetch time is the map time', () => {
    const doc = parseVigilance(body('fr-5-vigilance-wayback'));
    expect(doc.at).toBeNull();
    expect(doc.sections).toHaveLength(37);
    // A table that holds its sections (the real table has only the ones of the three territories).
    const all = new Set(doc.sections.map((s) => s.code));
    const out = vigilance('fr-5-vigilance-wayback', all);
    expect(digest(out)).toEqual(golden('fr-5-vigilance-wayback', digest(out)));
    expect(atOf(out)).toBe('2026-10-03T08:42:50.000Z');
    expect(rowsOf(out)).toHaveLength(37);
    // Levels 1, 2 and 3 as published (2023-12-11).
    expect(new Set(rowsOf(out).map((r) => r.level_raw))).toEqual(new Set(['1', '2', '3']));
    expect(rowsOf(out).find((r) => r.area_key === 'AD1')).toMatchObject({ name: 'Adour amont - Echez', level: 2 });
    // Against the real table the cut-off capture lists none of our sections: not a whole map (review SR-6).
    expect(() => vigilance('fr-5-vigilance-wayback')).toThrowError(expect.objectContaining({ code: 'too_few_areas' }));
  });

  it('the old and the current key casing give the same warning rows', () => {
    const wayback = JSON.parse(body('fr-5-vigilance-wayback').toString('utf8')) as {
      features: { properties: Record<string, unknown> }[];
    };
    const keep = new Set(['CdEntCru', 'CdTCC', 'NivInfViCr']);
    const current = {
      ...wayback,
      // The same instant as the fetch time that the Wayback body falls back to.
      DtHrInfoVigiCru: '2026-10-03T08:42:50+00:00',
      features: wayback.features.map((f) => ({
        ...f,
        properties: Object.fromEntries(
          Object.entries(f.properties).map(([k, v]) => [keep.has(k) ? k : k.toLowerCase(), v]),
        ),
      })),
    };
    expect(Object.keys(current.features[0]?.properties ?? {})).toContain('lbentcru');
    const codes = new Set(parseVigilance(body('fr-5-vigilance-wayback')).sections.map((s) => s.code));
    const ctx = { fetchedAt: fetchedAt('fr-5-vigilance-wayback'), sections: codes };
    expect(normaliseVigilance(parseVigilance(text(current)), ctx)).toEqual(
      normaliseVigilance(parseVigilance(body('fr-5-vigilance-wayback')), ctx),
    );
    // Any mix of upper and lower case is read as the same key.
    const mixed = {
      ...current,
      features: current.features.map((f, i) => ({
        ...f,
        properties: Object.fromEntries(
          Object.entries(f.properties).map(([k, v]) => [i % 2 === 0 ? k.toUpperCase() : k, v]),
        ),
      })),
    };
    expect(normaliseVigilance(parseVigilance(text(mixed)), ctx)).toEqual(
      normaliseVigilance(parseVigilance(text(current)), ctx),
    );
  });
});

describe('the vigilance map: rules', () => {
  // biome-ignore lint/suspicious/noExplicitAny: a plain JSON fixture edited in place
  const archive = () => JSON.parse(body('fr-5-vigilance-archive').toString('utf8')) as Record<string, any>;
  const ctx = { fetchedAt: fetchedAt('fr-5-vigilance-archive'), sections: SECTIONS };
  const run = (doc: unknown) => normaliseVigilance(parseVigilance(text(doc)), ctx);
  const drift = (doc: unknown) => {
    try {
      parseVigilance(text(doc));
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDrift);
      return (err as SchemaDrift).code;
    }
    return 'no drift';
  };

  it('levels 1-4 map to the common scale; another number is dropped unmapped; the provider number is kept', () => {
    const doc = archive();
    [1, 2, 3, 4, 7].forEach((level, i) => {
      doc.features[i].properties.NivInfViCr = level;
    });
    const out = run(doc);
    const byKey = new Map(rowsOf(out).map((r) => [r.area_key, r]));
    // biome-ignore lint/suspicious/noExplicitAny: a plain JSON fixture edited in place
    const keys = doc.features.slice(0, 5).map((f: any) => f.properties.CdEntCru);
    expect(keys.slice(0, 4).map((k: string) => byKey.get(k)?.level)).toEqual([2, 3, 4, 5]);
    expect(keys.slice(0, 4).map((k: string) => byKey.get(k)?.level_raw)).toEqual(['1', '2', '3', '4']);
    expect(byKey.has(keys[4])).toBe(false);
    expect(out.dropped).toEqual({ unmapped_class: 1 });
  });

  it('a section listed twice is withheld (conflict); a section outside our table is out_of_scope', () => {
    const doc = archive();
    doc.features.push(structuredClone(doc.features[0]));
    doc.features[3].properties.CdEntCru = 'ZZ9';
    const out = run(doc);
    expect(out.dropped).toEqual({ conflict: 2, out_of_scope: 1 });
    expect(rowsOf(out)).toHaveLength(56 - 1 - 1);
    // The map lists it: its stored range stays as it is (review CR-5).
    expect(out.warnings?.mode === 'snapshot' && out.warnings.kept).toEqual([doc.features[0].properties.CdEntCru]);
  });

  it('a map that lists fewer than MIN_SHARE of our sections is drift too_few_areas, an empty one too (review SR-6)', () => {
    const doc = archive();
    const need = Math.ceil(MIN_SHARE * SECTIONS.size);
    doc.features = doc.features.slice(0, need);
    expect(rowsOf(run(doc))).toHaveLength(need);
    doc.features = doc.features.slice(0, need - 1);
    expect(() => run(doc)).toThrowError(expect.objectContaining({ code: 'too_few_areas' }));
    doc.features = [];
    expect(() => run(doc)).toThrowError(expect.objectContaining({ code: 'too_few_areas' }));
  });

  it('a geometry that is not a LineString or MultiLineString of finite WGS84 positions is drift (review SR-3)', () => {
    const geometryDrift = (g: unknown) => {
      const doc = archive();
      doc.features[0].geometry = g;
      return drift(doc);
    };
    const [p, q] = [
      [6.6, 49],
      [6.7, 49.1],
    ];
    const line = (coordinates: unknown) => ({ type: 'LineString', coordinates });
    const multi = (coordinates: unknown) => ({ type: 'MultiLineString', coordinates });
    expect(geometryDrift(line([p, q]))).toBe('no drift');
    expect(geometryDrift(multi([[p, q]]))).toBe('no drift');
    const bad = [
      multi([]),
      multi([[p]]),
      multi([p, q]),
      line([[p, q]]),
      line([[181, 49], q]),
      line([[6.6, 91], q]),
      line([[6.6, 49, 100], q]),
      line([['6.6', 49], q]),
    ];
    for (const g of bad) expect([g, geometryDrift(g)]).toEqual([g, 'bad_geometry']);
    // A number past the double range parses to Infinity: not finite.
    const doc = archive();
    const raw = text(doc)
      .toString('utf8')
      .replace(/"coordinates":\[\[\[[-0-9.]+/, '"coordinates":[[[1e400');
    expect(() => parseVigilance(Buffer.from(raw))).toThrowError(expect.objectContaining({ code: 'bad_geometry' }));
    expect(geometryDrift({ type: 'Polygon', coordinates: [] })).toBe('invalid_value');
  });

  it('the map time: absent means the fetch time, a future one (more than 15 minutes ahead) and a bad one are drift', () => {
    const doc = archive();
    delete doc.DtHrInfoVigiCru;
    expect(atOf(run(doc))).toBe(new Date(ctx.fetchedAt).toISOString());
    doc.DtHrInfoVigiCru = new Date(ctx.fetchedAt + 20 * 60_000).toISOString().replace('Z', '+00:00');
    expect(() => run(doc)).toThrowError(expect.objectContaining({ code: 'future_time' }));
    doc.DtHrInfoVigiCru = '2026-10-03 07:55:24';
    expect(() => run(doc)).toThrowError(expect.objectContaining({ code: 'bad_time' }));
    // A time 10 minutes ahead is clock skew, not drift.
    doc.DtHrInfoVigiCru = new Date(ctx.fetchedAt + 10 * 60_000).toISOString().replace('Z', '+00:00');
    expect(run(doc).warnings?.rows).toHaveLength(56);
  });

  it('an unknown key, a key twice in another casing, a missing or wrong-typed field and another shape are drift', () => {
    let doc = archive();
    doc.features[0].properties.newkey = 'x';
    expect(drift(doc)).toBe('unknown_key');
    doc = archive();
    doc.features[0].properties.CDENTCRU = 'LO12';
    expect(drift(doc)).toBe('duplicate_key');
    doc = archive();
    delete doc.features[0].properties.NivInfViCr;
    expect(drift(doc)).toBe('invalid_type');
    doc = archive();
    doc.features[0].properties.NivInfViCr = '1';
    expect(drift(doc)).toBe('invalid_type');
    doc = archive();
    doc.features[0].geometry = { type: 'Point', coordinates: [1, 2] };
    expect(drift(doc)).toBe('invalid_value');
    doc = archive();
    doc.extra = 1;
    expect(drift(doc)).toBe('unrecognized_keys');
    doc = archive();
    doc.features = new Array(MAX_FEATURES + 1).fill(null);
    expect(drift(doc)).toBe('too_big');
    expect(() => parseVigilance(Buffer.from('{"type":'))).toThrowError(expect.objectContaining({ code: 'not_json' }));
  });

  it('a feature without a geometry keeps its row with a null geometry', () => {
    const doc = archive();
    doc.features[0].geometry = null;
    expect(rowsOf(run(doc)).find((r) => r.area_key === doc.features[0].properties.CdEntCru)?.geometry).toBeNull();
  });
});

describe('golden files (real payloads): station.json', () => {
  const stations = (name: string) => normaliseStation(parseStation(body(name)));

  it('Charleville-Mézières: three historical floods, m → cm, kinds from the sha256 of the label', () => {
    const out = stations('fr-5-stations-charleville');
    expect(out).toEqual(golden('fr-5-stations-charleville', out));
    expect(out.refScope).toEqual([{ target: 'FR-1', series: 'B540001001/H' }]);
    expect(out.references).toEqual([
      expect.objectContaining({
        series: 'B540001001/H',
        target: 'FR-1',
        value: 547,
        unit: 'cm',
        basis_label: 'Crue de janvier 1991',
      }),
      expect.objectContaining({ value: 472, basis_label: 'Crue de février 2002' }),
      expect.objectContaining({ value: 405, basis_label: 'Crue de mars 2007' }),
    ]);
    for (const r of out.references ?? []) {
      expect(r).toMatchObject({
        semantics: 'historical',
        convention: null,
        period: null,
        season_from_md: 101,
        season_to_md: 1231,
        priority: 0,
        valid_from: null,
      });
      expect(r.kind).toMatch(/^CRUE_[0-9A-F]{8}$/);
    }
    // The kind is CRUE_ and the first 8 hex digits, upper case, of the SHA-256 of the label.
    expect(floodKind('Crue de janvier 1991')).toBe(`CRUE_${sha('Crue de janvier 1991').slice(0, 8).toUpperCase()}`);
    expect(new Set(out.references?.map((r) => r.kind)).size).toBe(3);
    expect(out.obs).toEqual([]);
  });

  it('Stenay: two floods; the peak discharge (ValDebit) is not stored', () => {
    const out = stations('fr-5-stations-stenay');
    expect(out).toEqual(golden('fr-5-stations-stenay', out));
    expect(out.references?.map((r) => [r.series, r.value, r.basis_label])).toEqual([
      ['B315002001/H', 336, 'Crue de février 2002'],
      ['B315002001/H', 329, 'Crue de février 2013'],
    ]);
  });

  it('Chooz: an empty list states that there is none (the series is in scope, no row)', () => {
    const out = stations('fr-5-stations-chooz');
    expect(out).toEqual(golden('fr-5-stations-chooz', out));
    expect(out.references).toEqual([]);
    expect(out.refScope).toEqual([{ target: 'FR-1', series: 'B720000001/H' }]);
    expect(stations('fr-5-stations')).toEqual(out);
  });

  it('a list that is absent or null states nothing; a flood with no height is not stored; the same label twice is withheld', () => {
    const station = (list: unknown) =>
      normaliseStation(
        parseStation(
          text({ CdStationHydro: 'B540001001', VigilanceCrues: list === undefined ? {} : { CruesHistoriques: list } }),
        ),
      );
    expect(station(undefined)).toMatchObject({ references: [], refScope: [] });
    expect(station(null)).toMatchObject({ references: [], refScope: [] });
    const out = station([
      { LbUsuel: 'A', ValHauteur: 0, ValDebit: 0 },
      { LbUsuel: 'B', ValHauteur: null },
      { LbUsuel: 'C', ValHauteur: 1.234, ValDebit: 12 },
      { LbUsuel: 'D', ValHauteur: 2 },
      { LbUsuel: 'D', ValHauteur: 3 },
    ]);
    expect(out.dropped).toEqual({ no_value: 2, conflict: 2 });
    expect(out.references?.map((r) => [r.basis_label, r.value])).toEqual([['C', 123.4]]);
    expect(normaliseStation(parseStation(text({ CdStationHydro: 'B540001001', VigilanceCrues: null })))).toMatchObject({
      refScope: [],
    });
  });

  it('a station.json of another shape is drift; keys we do not read are tolerated', () => {
    const code = (o: unknown) => {
      try {
        parseStation(text(o));
      } catch (err) {
        return (err as SchemaDrift).code;
      }
      return 'ok';
    };
    expect(code({ CdStationHydro: 'B540001001', Other: { x: [1, 2] }, VigilanceCrues: { Photo: 't' } })).toBe('ok');
    expect(code({ CdStationHydro: 'b5', VigilanceCrues: {} })).toBe('invalid_format');
    expect(
      code({ CdStationHydro: 'B540001001', VigilanceCrues: { CruesHistoriques: [{ LbUsuel: 'x', ValHauteur: 'a' }] } }),
    ).toBe('invalid_type');
    expect(
      code({
        CdStationHydro: 'B540001001',
        VigilanceCrues: { CruesHistoriques: [{ LbUsuel: 'x', ValHauteur: 1, Z: 1 }] },
      }),
    ).toBe('unrecognized_keys');
    expect(code({ CdStationHydro: 'B540001001', VigilanceCrues: { CruesHistoriques: new Array(101).fill(1) } })).toBe(
      'too_big',
    );
  });
});

describe('golden files (real payloads): TronEntVigiCru and territory documents', () => {
  const links = (name: string) => parseTron(body(name));
  const out = (name: string) => ({ links: links(name), drift: driftReport(links(name), vigicruesSectionTable()) });

  it('LO18 (Meuse frontalière - Semoy, 2026-09-29): 15 stations, no drift against the table', () => {
    const o = out('fr-5-tron');
    expect(o).toEqual(golden('fr-5-tron', o));
    expect(o.links).toMatchObject({ kind: 'section', code: 'LO18', territory: '2' });
    expect(o.links.kind === 'section' && o.links.stations).toHaveLength(15);
    expect(o.links.kind === 'section' && o.links.stations).toContain('B720000001');
    expect(o.drift).toEqual({ unregistered: [], vanished: [], changed: [] });
    expect(normaliseLinks(o.links)).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });

  it('SA16 and AP1 (2026-10-02)', () => {
    for (const [name, code, territory] of [
      ['fr-5-tron-sa16', 'SA16', '3'],
      ['fr-5-tron-ap1', 'AP1', '29'],
    ] as const) {
      const o = out(name);
      expect(o).toEqual(golden(name, o));
      expect(o.links).toMatchObject({ kind: 'section', code, territory });
      expect(o.drift).toEqual({ unregistered: [], vanished: [], changed: [] });
    }
  });

  it('the territory document of 2: its 17 sections, no drift', () => {
    const o = out('fr-5-sections');
    expect(o).toEqual(golden('fr-5-sections', o));
    expect(o.links).toMatchObject({ kind: 'territory', code: '2' });
    expect(o.links.kind === 'territory' && o.links.sections).toHaveLength(17);
    expect(o.drift).toEqual({ unregistered: [], vanished: [], changed: [] });
  });

  it('the drift report names the stations or sections that are new or gone, by code only', () => {
    const tron = JSON.parse(body('fr-5-tron').toString('utf8'));
    tron.ListEntVigiCru[0].aNMoinsUn.pop();
    tron.ListEntVigiCru[0].aNMoinsUn.push({
      CdEntVigiCruInferieur: 'B999999999',
      TypEntVigiCruInferieur: '7',
      LbEntVigiCruInferieur: 'Nouveau',
      Link: 'x',
    });
    const gone = (parseTron(body('fr-5-tron')) as { stations: string[] }).stations.at(-1);
    expect(driftReport(parseTron(text(tron)), vigicruesSectionTable())).toEqual({
      unregistered: ['B999999999'],
      vanished: [gone],
      changed: [],
    });
    // A section the table lacks: all its stations are unregistered; a territory: sections new or gone.
    const table = new Map(vigicruesSectionTable());
    table.delete('LO18');
    expect(driftReport(parseTron(body('fr-5-tron')), table).unregistered).toHaveLength(15);
    const terr = JSON.parse(body('fr-5-sections').toString('utf8'));
    terr.ListEntVigiCru[0].aNMoinsUn.shift();
    const d = driftReport(parseTron(text(terr)), vigicruesSectionTable());
    expect(d.unregistered).toEqual([]);
    expect(d.vanished).toEqual(['LO12']);
  });

  it('a document of the wrong shape is drift', () => {
    const code = (o: unknown) => {
      try {
        parseTron(text(o));
      } catch (err) {
        return (err as SchemaDrift).code;
      }
      return 'ok';
    };
    const doc = () => JSON.parse(body('fr-5-tron').toString('utf8'));
    expect(code(doc())).toBe('ok');
    let d = doc();
    d.ListEntVigiCru.push(d.ListEntVigiCru[0]);
    expect(code(d)).toBe('too_big');
    d = doc();
    d.ListEntVigiCru[0].aNMoinsUn[0].TypEntVigiCruInferieur = '8';
    expect(code(d)).toBe('bad_child_type');
    d = doc();
    d.ListEntVigiCru[0].extra = 1;
    expect(code(d)).toBe('unrecognized_keys');
    d = doc();
    d.Scenario.CodeScenario = 5;
    expect(code(d)).toBe('invalid_type');
    d = doc();
    d.ListEntVigiCru[0].aNMoinsUn = new Array(501).fill(1);
    expect(code(d)).toBe('too_big');
  });
});

describe('a section level reaches every station of that section', () => {
  const file = parse(
    readFileSync(new URL('../../../../registry/vigicrues-sections.yaml', import.meta.url), 'utf8'),
  ) as {
    sections: { section: string; stations: { vigicrues: string; station: string | null }[] }[];
  };

  it('a section at level 3 (orange) maps each of its FR-1 stations to its one warning area', () => {
    const doc = JSON.parse(body('fr-5-vigilance-archive').toString('utf8'));
    for (const f of doc.features) f.properties.NivInfViCr = f.properties.CdEntCru === 'LO18' ? 3 : 1;
    const out = normaliseVigilance(parseVigilance(text(doc)), {
      fetchedAt: fetchedAt('fr-5-vigilance-archive'),
      sections: SECTIONS,
    });
    const area = new Map(rowsOf(out).map((r) => [r.area_key, r]));
    const members = (file.sections.find((s) => s.section === 'LO18')?.stations ?? []).flatMap((m) =>
      m.station === null ? [] : [m.station],
    );
    expect(members.length).toBeGreaterThanOrEqual(10);
    for (const station of members) {
      const section = vigicruesSections().get(station);
      expect(section).toBe('LO18');
      expect(area.get(section ?? '')).toMatchObject({ level: LEVEL_NORM.high, level_raw: '3' });
    }
    // The stations of another section stay at level 1 (normal).
    const other = file.sections.find((s) => s.section === 'LO17')?.stations.find((m) => m.station !== null)?.station;
    expect(area.get(vigicruesSections().get(other ?? '') ?? '')?.level).toBe(LEVEL_NORM.normal);
  });
});

describe('property: a parser meets any document with a SchemaDrift or a result, never another error', () => {
  const only = (parse: (b: Uint8Array) => unknown) => (value: unknown) => {
    try {
      parse(Buffer.from(JSON.stringify(value)));
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDrift);
    }
  };

  it('any JSON value', () => {
    fc.assert(fc.property(fc.jsonValue(), only(parseVigilance)), { numRuns: 300 });
    fc.assert(fc.property(fc.jsonValue(), only(parseTron)), { numRuns: 300 });
    fc.assert(fc.property(fc.jsonValue(), only(parseStation)), { numRuns: 300 });
  });

  it('a valid map with any mutated property keys, values and array sizes', () => {
    const doc = JSON.parse(body('fr-5-vigilance-archive').toString('utf8'));
    const feature = doc.features[0];
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue(), { maxKeys: 6 }),
        fc.boolean(),
        (props, merge) => {
          const f = { ...feature, properties: merge ? { ...feature.properties, ...props } : props };
          only(parseVigilance)({ ...doc, features: [f] });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('any casing of the known property keys reads the same section', () => {
    const doc = JSON.parse(body('fr-5-vigilance-archive').toString('utf8'));
    const feature = doc.features[0];
    const keys = Object.keys(feature.properties);
    const expected = parseVigilance(text({ ...doc, features: [feature] }));
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: keys.length, maxLength: keys.length }), (flips) => {
        const properties = Object.fromEntries(
          keys.map((k, i) => [flips[i] ? k.toUpperCase() : k.toLowerCase(), feature.properties[k]]),
        );
        expect(parseVigilance(text({ ...doc, features: [{ ...feature, properties }] }))).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});
