import { OwnerStatusFile, StatusFile } from '@rws/contracts/status';
import { describe, expect, it } from 'vitest';
import { OWNER_CONTRACTS } from '../src/features/owner/contracts.ts';
import { METHOD_CLASSES, METHOD_REFERENCES } from '../src/features/pages/method.gen.ts';
import { classRows, datumRows, reachRows, referenceRows } from '../src/features/pages/parts/method.ts';
import { fractionText, percentText } from '../src/features/pages/parts/numbers.ts';
import { attributionRows, licenceLabel, licenceLine } from '../src/features/pages/parts/sources.ts';
import { classMatrix, forecastMatrix, lagText, statusRows } from '../src/features/pages/parts/status.ts';
import { travelRows } from '../src/features/pages/parts/travel.ts';
import { type Fetcher, loadReachTravel, loadStatusPage } from '../src/lib/data/chain.ts';
import { PUBLIC_CONTRACTS, type WebSource } from '../src/lib/data/contracts.ts';

// P10b, the data parts of the Sources, Status and Method pages: the loose status.json and reaches readers (against
// bodies that the server's own strict schemas accept), the attribution rows with their dates, the licence switch, and
// the pure row builders of the tables. No JSX and no network.

const AT = '2026-10-26T12:00:00.000Z';

const share = (stations: number, classed: number) => ({
  stations,
  classed,
  by_section: 0,
  ratio: stations === 0 ? null : classed / stations,
});
const classCoverage = (tier1: [number, number], first: [number, number]) => ({
  t: AT,
  mode: 'state' as const,
  tier1: share(...tier1),
  first_release: share(...first),
  countries: [
    { country: 'NL' as const, tier1: share(6, 6), first_release: share(4, 4) },
    { country: 'CH' as const, tier1: share(4, 2), first_release: share(2, 1) },
  ],
});
const cover = (stations: number, covered: number) => ({ stations, covered });
const reach = (id: string, name: string, c: ReturnType<typeof cover>, sources: string[], extra = {}) => ({
  id,
  names: { nl: `${name} (nl)`, en: name },
  ...c,
  sources,
  no_official_forecast: sources.length === 0,
  after_permission: [] as string[],
  none_publishes: [] as string[],
  ...extra,
});
const forecastCoverage = {
  t: AT,
  total: cover(15, 13),
  countries: [
    { country: 'NL' as const, ...cover(10, 8) },
    { country: 'CH' as const, ...cover(5, 5) },
  ],
  reaches: [
    reach('dutch-rhine', 'Dutch Rhine branches', cover(10, 8), ['NL-1']),
    reach('swiss-rhine-aare', 'Swiss Rhine and Aare', cover(5, 5), ['CH-4']),
    reach('upper-rhine', 'Upper Rhine', cover(0, 0), [], {
      after_permission: ['LUBW', 'LfU RLP'],
      none_publishes: ['SPW'],
    }),
  ],
  other: cover(0, 0),
};
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'ok',
  lastFetchOk: AT,
  newestTs: AT,
  lagP95S: 34,
  coverage: 0.97,
  forecast: null,
  ...over,
});
const common = {
  schemaVersion: 1 as const,
  generatedAt: AT,
  twins: { ok: 3, failing: 1 },
  ops: null,
  loader: { lastCommit: AT, lagP95S: 34, backlogAgeS: null },
  publisher: { cycleAt: AT, cycleSeconds: 3, lastDayRender: null, pendingDays: 0, settledBytes: 0 },
  capture: null,
  attribution: [],
};
const publicFile = {
  ...common,
  sources: [
    row('NL-1', { forecast: { issuedAt: AT, runAgeS: 600, series: 3, current: 2, late: '2026-10-25' } }),
    row('FR-1', { status: 'degraded', lastFetchOk: null, newestTs: null, lagP95S: null, coverage: null }),
  ],
  classification: classCoverage([10, 8], [6, 5]),
  forecastCoverage,
  ownerSources: { healthy: 5, total: 6 },
};
const ownerFile = {
  ...common,
  sources: [row('BE-3', { status: 'down' }), row('CANARY-OWNER')],
  classification: { public: classCoverage([10, 8], [6, 5]), owner: classCoverage([12, 11], [8, 7]) },
  forecastCoverage: { public: forecastCoverage, owner: null },
};

describe('the fixtures are what the server writes', () => {
  it('passes the strict status schemas (so the readers below are tested against real shapes)', () => {
    expect(StatusFile.safeParse(publicFile).success).toBe(true);
    expect(OwnerStatusFile.safeParse(ownerFile).success).toBe(true);
  });
});

describe('the status.json reader of the public site', () => {
  it('reads the rows, the two counts of owner sources and a public-only coverage', () => {
    const page = PUBLIC_CONTRACTS.StatusPage.parse(publicFile);
    expect(page.sources.map((s) => [s.id, s.status])).toEqual([
      ['NL-1', 'ok'],
      ['FR-1', 'degraded'],
    ]);
    expect(page.ownerLine).toEqual({ healthy: 5, total: 6 });
    expect(page.twins).toEqual({ ok: 3, failing: 1 });
    expect(page.classification.owner).toBeUndefined();
    expect(page.forecastCoverage.public?.reaches).toHaveLength(3);
    expect(page.forecastCoverage.owner).toBeUndefined();
  });

  it('drops a canary row and a bad id one by one, keeps a row whose status it does not know as unknown, and keeps the file', () => {
    const page = PUBLIC_CONTRACTS.StatusPage.parse({
      ...publicFile,
      sources: [
        row('NL-1'),
        row('CANARY-OWNER'),
        row('DE-1', { status: 'fine' }),
        row('XX-1'),
        row('NL-01'),
        { id: 'CH-1' },
        'text',
        row('CH-1'),
      ],
    });
    // Review round 1: an unknown status keeps its row (as "unknown"); a missing row would read as "fine".
    expect(page.sources.map((s) => [s.id, s.status])).toEqual([
      ['NL-1', 'ok'],
      ['DE-1', 'unknown'],
      ['CH-1', 'ok'],
    ]);
  });

  it('turns a coverage block that does not parse, or a missing count, into null instead of failing the file', () => {
    const page = PUBLIC_CONTRACTS.StatusPage.parse({
      ...publicFile,
      classification: { tier1: 'x' },
      forecastCoverage: { ...forecastCoverage, reaches: 'x' },
      ownerSources: undefined,
    });
    expect(page.classification.public).toBeNull();
    expect(page.forecastCoverage.public).toBeNull();
    expect(page.ownerLine).toBeNull();
    expect(page.sources).toHaveLength(2);
  });

  it('fails on a file that is no status file, or whose list is out of bounds', () => {
    expect(() => PUBLIC_CONTRACTS.StatusPage.parse({ ...publicFile, sources: 'x' })).toThrow();
    expect(() => PUBLIC_CONTRACTS.StatusPage.parse({ ...publicFile, generatedAt: 'yesterday' })).toThrow();
    expect(() =>
      PUBLIC_CONTRACTS.StatusPage.parse({ ...publicFile, sources: Array.from({ length: 201 }, () => row('NL-1')) }),
    ).toThrow();
    expect(() => PUBLIC_CONTRACTS.StatusPage.parse(null)).toThrow();
  });
});

describe('the status.json reader of the owner site', () => {
  it('reads the owner file: its sources (the canary dropped), the pairs of coverage, no count of owner sources', () => {
    const page = OWNER_CONTRACTS.StatusPage.parse(ownerFile);
    expect(page.sources.map((s) => [s.id, s.status])).toEqual([['BE-3', 'down']]);
    expect(page.ownerLine).toBeNull();
    expect(page.classification.public?.tier1).toMatchObject({ stations: 10, classed: 8 });
    expect(page.classification.owner?.tier1).toMatchObject({ stations: 12, classed: 11 });
    expect(page.forecastCoverage.public?.total).toMatchObject({ stations: 15, covered: 13 });
    expect(page.forecastCoverage.owner).toBeNull();
  });

  it('reads a pair that does not parse as a pair of nulls', () => {
    const page = OWNER_CONTRACTS.StatusPage.parse({ ...ownerFile, classification: 'x', forecastCoverage: [] });
    expect(page.classification).toEqual({ public: null, owner: null });
    expect(page.forecastCoverage).toEqual({ public: null, owner: null });
  });
});

function fake(table: Record<string, unknown>): Fetcher {
  return async (path) =>
    path in table ? new Response(JSON.stringify(table[path]), { status: 200 }) : new Response('', { status: 404 });
}

describe('the loaders', () => {
  it('loadStatusPage reads /data/v1/status.json and drops what the site hides', async () => {
    const f = fake({ '/data/v1/status.json': publicFile });
    expect((await loadStatusPage(f)).sources).toHaveLength(2);
    const hiding = { ...PUBLIC_CONTRACTS, hidden: (s: string) => s === 'FR-1' };
    expect((await loadStatusPage(f, undefined, hiding)).sources.map((s) => s.id)).toEqual(['NL-1']);
    await expect(loadStatusPage(fake({}))).rejects.toThrow();
  });

  it('loadReachTravel finds the reaches file through the manifest and keeps only the valid pairs', async () => {
    const entry = (name: string, ver: string) => ({ file: name.replace('V', ver), sha256: 'a'.repeat(64), bytes: 1 });
    const manifest = {
      schema_version: 1,
      current: {
        version: '20261101',
        tag: 'geo-2026-11-01',
        installed_at: '2026-11-05T05:40:12Z',
        tiles: entry('rivers-V.pmtiles', '20261101'),
        reaches: entry('reaches-V.json', '20261101'),
        download: entry('rivers-V.geojson.gz', '20261101'),
      },
      previous: null,
    };
    const pair = (over: Record<string, unknown> = {}) => ({
      from_station_id: 'de.wsv.2790020',
      to_station_id: 'nl.rws.lobith.bovenrijn.tolkamer',
      h: [1, 8],
      basis: 'flood peak',
      source: 'RWS note',
      source_url: 'https://open.rijkswaterstaat.nl/x',
      ...over,
    });
    const f = fake({
      '/data/v1/rivers/manifest.json': manifest,
      '/data/v1/rivers/reaches-20261101.json': {
        schema_version: 1,
        rivers: [],
        travel_times: [
          pair(),
          pair({ h: [8, 1] }),
          pair({ h: [5, 5] }),
          pair({ to_station_id: 'x' }),
          pair({ h: [2] }),
          pair({ h: undefined, d: [4, 5], derived: true }),
          pair({ h: 5, label: { nl: 'a', en: 'b' } }),
          pair({ h: 5 }),
          pair({ d: 2, label: { nl: 'a', en: 'b' } }),
        ],
      },
    });
    const travel = await loadReachTravel(f);
    expect(travel.travel_times.map((t) => t.h ?? t.d)).toEqual([[1, 8], [4, 5], 5]);
    await expect(loadReachTravel(fake({ '/data/v1/rivers/manifest.json': manifest }))).rejects.toThrow();
  });
});

const source = (over: Partial<WebSource> = {}): WebSource => ({
  id: 'FR-3',
  name: 'Vigicrues',
  provider: 'SCHAPI',
  licence: { kind: 'etalab-2.0', url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence' },
  attribution: [],
  dateKind: null,
  date: null,
  dateText: null,
  ...over,
});
const credit = (text: string, over: Partial<WebSource['attribution'][number]> = {}) => ({
  lang: null,
  text,
  url: null,
  required: true,
  ...over,
});

describe('the attribution rows of the Sources page', () => {
  it('puts the date in the placeholder of FR-3, appends it to FR-1 and writes BAFU’s “Bezugsdatum: …”', () => {
    // 23:30Z on 25 October is 26 October in Amsterdam.
    const date = '2026-10-25T23:30:00.000Z';
    const fr3 = source({
      dateKind: 'update',
      date,
      attribution: [
        credit('Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0', {
          lang: 'fr',
        }),
      ],
    });
    expect(attributionRows(fr3, 'nl')[0]).toMatchObject({
      lang: 'fr',
      text: 'Source : © VIGICRUES – www.vigicrues.gouv.fr, 26 oktober 2026, Licence Ouverte Etalab 2.0',
    });
    const fr1 = source({ dateKind: 'update', date, attribution: [credit("Données hydrométriques : Hub'Eau / SCV")] });
    expect(attributionRows(fr1, 'en')[0]?.text).toBe("Données hydrométriques : Hub'Eau / SCV (26 October 2026)");
    const ch = source({
      dateKind: 'reference',
      date,
      attribution: [
        credit('Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum)', {
          lang: 'de',
        }),
      ],
    });
    expect(attributionRows(ch, 'nl')[0]?.text).toBe(
      'Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum: 26 oktober 2026)',
    );
  });

  it('takes the provider’s own date text (DE-6 “Stand”) and links an https credit', () => {
    const de6 = source({
      dateKind: 'stand',
      date: '2026-10-26T10:00:00.000Z',
      dateText: 'Stand: 26.10.2026 11:15',
      attribution: [
        credit('Datenquelle: www.hochwasserzentralen.de', { lang: 'de', url: 'https://www.hochwasserzentralen.de' }),
        credit('Datenquelle: www.hochwasserzentralen.de (en)', {
          lang: 'en',
          url: 'http://insecure.example',
          required: false,
        }),
      ],
    });
    const rows = attributionRows(de6, 'en');
    expect(rows[0]).toEqual({
      lang: 'de',
      text: 'Datenquelle: www.hochwasserzentralen.de (Stand: 26.10.2026 11:15)',
      href: 'https://www.hochwasserzentralen.de',
      required: true,
    });
    // Only an https URL becomes a link (invariant 3); every row is kept, in every language.
    expect(rows[1]).toMatchObject({ lang: 'en', href: undefined, required: false });
  });

  it('says “date unknown” where a source needs a date and has none, and leaves a text with no duty alone', () => {
    const needs = source({ dateKind: 'update', attribution: [credit('Source X')] });
    expect(attributionRows(needs, 'en')[0]?.text).toBe('Source X (date unknown)');
    expect(attributionRows(needs, 'nl')[0]?.text).toBe('Source X (datum onbekend)');
    expect(attributionRows(source({ attribution: [credit('Bron <datum>')] }), 'nl')[0]?.text).toBe('Bron <datum>');
    expect(attributionRows(source(), 'nl')).toEqual([]);
  });
});

describe('the licence line', () => {
  it('maps the kinds of the public sources to words and shows any other kind as the registry spells it', () => {
    for (const kind of ['cc0', 'dl-de-zero-2.0', 'etalab-2.0', 'cc-by', 'cc-by-sa-4.0', 'ch-open-use'])
      for (const locale of ['nl', 'en'] as const) expect(licenceLabel(kind, locale)).not.toBe(kind);
    expect(licenceLabel('cc0', 'en')).toBe('CC0 (Creative Commons Zero)');
    expect(licenceLabel('some-future-kind', 'nl')).toBe('some-future-kind');
    expect(licenceLabel('__proto__', 'en')).toBe('__proto__');
  });

  it('links the terms page only over https, and names it by its host when the kind is unknown', () => {
    expect(licenceLine({ kind: 'cc0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }, 'en')).toEqual({
      text: 'CC0 (Creative Commons Zero)',
      href: 'https://creativecommons.org/publicdomain/zero/1.0/',
    });
    expect(licenceLine({ kind: null, url: 'https://example.org/terms' }, 'en')).toEqual({
      text: 'example.org',
      href: 'https://example.org/terms',
    });
    expect(licenceLine({ kind: 'cc0', url: 'javascript:alert(1)' }, 'en').href).toBeUndefined();
    expect(licenceLine({ kind: null, url: null }, 'en')).toEqual({ text: undefined, href: undefined });
  });
});

describe('the status rows and coverage tables', () => {
  it('cuts a percentage down and gives a fraction with its share', () => {
    expect(percentText(0.9996, 'en')).toBe('99.9%');
    expect(percentText(0.29, 'en')).toBe('29%');
    expect(fractionText(8, 10, 'en')).toBe('8/10 (80%)');
    expect(fractionText(0, 0, 'nl')).toBe('0/0');
    expect(lagText(null, 'en')).toBe('n/a');
    expect(lagText(34, 'en')).toContain('34');
    expect(lagText(600, 'en')).toContain('10');
  });

  it('builds a row per source with n/a for what is missing and the day a forecast run is late', () => {
    const page = PUBLIC_CONTRACTS.StatusPage.parse(publicFile);
    const [nl1, fr1] = statusRows(page.sources, 'en');
    expect(nl1).toMatchObject({ id: 'NL-1', status: 'ok', coverage: '97%' });
    expect(nl1?.forecast).toContain('25 October 2026');
    expect(fr1).toMatchObject({
      id: 'FR-1',
      status: 'degraded',
      lastFetch: 'n/a',
      newest: 'n/a',
      lag: 'n/a',
      coverage: 'n/a',
      forecast: 'n/a',
    });
    expect(statusRows(page.sources, 'nl')[1]?.status).toBe('verminderd');
  });

  it('builds the class coverage per country with a total row: one family on the public site, two on the owner site', () => {
    const pub = classMatrix(PUBLIC_CONTRACTS.StatusPage.parse(publicFile).classification, 'en');
    expect(pub.families).toEqual(['public']);
    expect(pub.rows.map((r) => r.country)).toEqual(['NL', 'CH', null]);
    expect(pub.rows[1]?.cells).toEqual(['2/4 (50%)', '1/2 (50%)']);
    expect(pub.rows[2]?.cells).toEqual(['8/10 (80%)', '5/6 (83.3%)']);
    const own = classMatrix(
      OWNER_CONTRACTS.StatusPage.parse({
        ...ownerFile,
        classification: { public: classCoverage([10, 8], [6, 5]), owner: null },
      }).classification,
      'en',
    );
    expect(own.families).toEqual(['public', 'owner']);
    expect(own.rows[0]?.cells).toEqual(['6/6 (100%)', '4/4 (100%)', 'n/a', 'n/a']);
  });

  it('builds the forecast coverage per country', () => {
    const m1 = forecastMatrix(PUBLIC_CONTRACTS.StatusPage.parse(publicFile).forecastCoverage, 'en');
    expect(m1.rows.map((r) => [r.country, r.cells])).toEqual([
      ['NL', ['8/10 (80%)']],
      ['CH', ['5/5 (100%)']],
      [null, ['13/15 (86.6%)']],
    ]);
    const page = OWNER_CONTRACTS.StatusPage.parse(ownerFile);
    expect(forecastMatrix(page.forecastCoverage, 'en').rows[2]?.cells).toEqual(['13/15 (86.6%)', 'n/a']);
  });
});

describe('the Method tables', () => {
  it('lists every generated class and reference, with words from the messages and "n/a" for none', () => {
    const classes = classRows('en');
    expect(classes).toHaveLength(METHOD_CLASSES.length);
    expect(new Set(classes.map((r) => r.key)).size).toBe(classes.length);
    expect(classes.find((r) => r.source === 'CH-1' && r.code === '1')).toMatchObject({
      agency: 'BAFU',
      level: 'normal',
      measure: 'discharge',
      note: 'no flood: only “not elevated”',
    });
    expect(classes.find((r) => r.source === 'DE-6' && r.code === '-1')?.level).toBe('no reference');
    // The Waterinfo display classes carry their "not an official warning" disclaimer.
    expect(classes.find((r) => r.source === 'NL-4')?.group).toBe('RWS Waterinfo legend, not an official warning');
    const refs = referenceRows('nl');
    expect(refs).toHaveLength(METHOD_REFERENCES.length);
    expect(new Set(refs.map((r) => r.key)).size).toBe(refs.length);
    expect(refs.find((r) => r.source === 'DE-1' && r.short === 'MW')).toMatchObject({
      rule: 'getoond, classificeert nooit',
      level: 'n.v.t.',
      group: 'n.v.t.',
    });
    expect(refs.find((r) => r.source === 'DE-1' && r.short === 'MHW')).toMatchObject({
      rule: 'op of boven',
      level: 'verhoogd',
      group: 'statistische referentie',
    });
  });

  it('lists the datums with their offset to NAP, and no number for a datum that is not converted', () => {
    const rows = datumRows('en');
    expect(rows.map((r) => r.datum)).toEqual([
      'NAP',
      'TAW',
      'DNG',
      'NHN',
      'NN',
      'LN02',
      'NG95',
      'IGN69',
      'NGF1884',
      'LOCAL',
      'MSL',
    ]);
    expect(rows.find((r) => r.datum === 'TAW')).toMatchObject({
      offset: '-2.33',
      uncertainty: '± 0.02',
      converted: 'converted',
    });
    expect(rows.find((r) => r.datum === 'NAP')?.offset).toBe('0.00');
    for (const d of ['IGN69', 'NGF1884', 'LOCAL', 'MSL'])
      expect(rows.find((r) => r.datum === d)).toEqual({
        datum: d,
        offset: undefined,
        uncertainty: undefined,
        converted: 'not converted',
      });
    expect(datumRows('nl').find((r) => r.datum === 'IGN69')?.converted).toBe('niet omgerekend');
  });

  it('names a reach in the page language and says what is, or could be, published', () => {
    const fc = PUBLIC_CONTRACTS.StatusPage.parse(publicFile).forecastCoverage.public;
    if (fc === null) throw new Error('fixture');
    const rows = reachRows(fc, 'nl');
    expect(rows.map((r) => r.name)).toEqual([
      'Dutch Rhine branches (nl)',
      'Swiss Rhine and Aare (nl)',
      'Upper Rhine (nl)',
    ]);
    expect(rows[0]).toMatchObject({ cover: '8/10 (80%)', notes: ['officiële verwachting beschikbaar'] });
    expect(reachRows(fc, 'en')[2]?.notes).toEqual([
      'no official forecast',
      'after permission from LUBW and LfU RLP',
      'no forecast from SPW, or none we may use',
    ]);
  });
});

describe('the travel times', () => {
  it('shows each pair as an indicative range, with names where the stations are known and ids where not', () => {
    const travel = {
      travel_times: [
        {
          from_station_id: 'de.wsv.2790020',
          to_station_id: 'nl.rws.lobith.bovenrijn.tolkamer',
          h: [1, 8] as [number, number],
          basis: 'flood peak, Q Lobith > 5000 m³/s',
          source: 'RWS note GWIO 85.006',
          source_url: 'https://open.rijkswaterstaat.nl/@87627/looptijden-hoogwatergolven-rijn/',
        },
        {
          from_station_id: 'de.wsv.2770040',
          to_station_id: 'nl.rws.lobith.bovenrijn.tolkamer',
          h: [6, 19] as [number, number],
          basis: 'flood peak',
          source: 'a note',
          source_url: 'http://not-https.example/x',
        },
      ],
    };
    const names = new Map([['de.wsv.2790020', 'Emmerich']]);
    const [a, b] = travelRows(travel, names, 'en');
    expect(a).toMatchObject({ from: 'Emmerich', to: 'nl.rws.lobith.bovenrijn.tolkamer', range: 'indicative: 1–8 h' });
    expect(a?.href).toBe('https://open.rijkswaterstaat.nl/@87627/looptijden-hoogwatergolven-rijn/');
    expect(b).toMatchObject({ from: 'de.wsv.2770040', range: 'indicative: 6–19 h', href: undefined });
    expect(travelRows(travel, names, 'nl')[1]?.range).toBe('indicatief: 6–19 u');
  });
});
