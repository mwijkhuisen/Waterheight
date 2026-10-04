import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { requestFor } from '../apps/server/src/capture/adapters.ts';
import { captureUserAgent } from '../apps/server/src/capture/env.ts';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { testClient } from '../apps/server/test/helpers.ts';
import { SchemaDrift } from '../packages/core/src/errors.ts';
import { check, LINE_SOURCE, type Report, ROW, reportLines, SPECS } from '../scripts/contract-check.ts';
import { repoRoot } from './catalogue.ts';
import { server } from './msw.setup.ts';
import { zip } from './zip.ts';

// scripts/contract-check.ts and .github/workflows/contract-check.yml (issue #17; A§7.1; P8b: eleven specs). The
// recorded fixtures stand in for the live providers; nothing here reaches the network.

type Spec = (typeof SPECS)[number];

const DOMAIN = 'rivieren.example.org';
const EMAIL = 'beheer@rivieren.example.org';
const UA = captureUserAgent({ domain: DOMAIN, contactEmail: EMAIL });
const LINE = new RegExp(LINE_SOURCE);
/** A workflow expression, spelled so that the source holds no template-like string. */
const EXPR_OPEN = '$'.concat('{{');
const expr = (inner: string) => `${EXPR_OPEN} ${inner} }}`;

const fixtureDir = (source: string) => join(repoRoot, 'apps/server/src/adapters', source, 'fixtures');
const BODY: Record<Spec, Buffer> = {
  'de-1-basin': readFileSync(join(fixtureDir('de-1'), 'de-1-basin.raw')),
  'nl-1-obs-key': readFileSync(join(fixtureDir('nl-1'), 'nl-1-obs-key.raw')),
  'nl-1-fc-1h': readFileSync(join(fixtureDir('nl-1'), 'nl-1-fc-1h.raw')),
  'nl-2-wfs': readFileSync(join(fixtureDir('nl-2'), 'nl-2-wfs.raw')),
  'fr-1-obs': readFileSync(join(fixtureDir('fr-1'), 'fr-1-obs.raw')),
  'ch-1-lindas': readFileSync(join(fixtureDir('ch-1'), 'ch-1-lindas.raw')),
  'ch-2-pq': readFileSync(join(fixtureDir('ch-2'), 'ch-2-pq.raw')),
  'de-7-messwerte': readFileSync(join(fixtureDir('de-7'), 'de-7-messwerte.raw')),
  'lu-1-csv': readFileSync(join(fixtureDir('lu-1'), 'lu-1-csv.raw')),
  'ch-4-forecast': readFileSync(join(fixtureDir('ch-4'), 'ch-4-forecast.raw')),
  'fr-4': readFileSync(join(fixtureDir('fr-4'), 'fr-4.raw')),
};
/** The fixtures were recorded together on 2026-09-29: a minute later, no value is old or in the future. */
const recordedAt = (source: string, spec: string) =>
  Date.parse(JSON.parse(readFileSync(join(fixtureDir(source), `${spec}.meta.json`), 'utf8')).recorded_at as string);
const NOW = new Date(
  Math.max(
    recordedAt('de-1', 'de-1-basin'),
    recordedAt('nl-1', 'nl-1-obs-key'),
    recordedAt('nl-1', 'nl-1-fc-1h'),
    recordedAt('nl-2', 'nl-2-wfs'),
    recordedAt('fr-1', 'fr-1-obs'),
    recordedAt('ch-1', 'ch-1-lindas'),
    recordedAt('ch-2', 'ch-2-pq'),
    recordedAt('de-7', 'de-7-messwerte'),
    recordedAt('lu-1', 'lu-1-csv'),
    recordedAt('ch-4', 'ch-4-forecast'),
    recordedAt('fr-4', 'fr-4'),
  ) + 60_000,
);

const capture = loadRegistry();
const targets = SPECS.map((id) => {
  const spec = capture.specs.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`no spec ${id}`);
  // The request the check sends: the spec's first row, or the row `ROW` names (the CH-4 URL names its station).
  const want = Object.hasOwn(ROW, id) ? ROW[id] : undefined;
  const row =
    want === undefined ? spec.rows[0] : spec.rows.find((r) => Object.entries(want).every(([k, v]) => r[k] === v));
  if (row === undefined) throw new Error(`no row of ${id}`);
  const url = new URL(requestFor(spec, row, NOW).url);
  return {
    id,
    source: spec.source,
    rawUrl: spec.request.url,
    method: spec.request.method,
    host: url.host,
    path: url.pathname,
    pattern: `${url.origin}${url.pathname}`,
  };
});

type Answer = () => Response;
const answer =
  (body: Buffer | string, status = 200, type = 'application/json'): Answer =>
  () =>
    new HttpResponse(body, { status, headers: { 'content-type': type } });
const GOOD: Record<Spec, Answer> = {
  'de-1-basin': answer(BODY['de-1-basin']),
  'nl-1-obs-key': answer(BODY['nl-1-obs-key']),
  'nl-1-fc-1h': answer(BODY['nl-1-fc-1h']),
  'nl-2-wfs': answer(BODY['nl-2-wfs']),
  'fr-1-obs': answer(BODY['fr-1-obs']),
  'ch-1-lindas': answer(BODY['ch-1-lindas'], 200, 'text/csv;charset=UTF-8'),
  'ch-2-pq': answer(BODY['ch-2-pq'], 200, 'application/octet-stream'),
  'de-7-messwerte': answer(BODY['de-7-messwerte'], 200, 'application/zip'),
  'lu-1-csv': answer(BODY['lu-1-csv'], 200, 'text/csv'),
  'ch-4-forecast': answer(BODY['ch-4-forecast']),
  'fr-4': answer(BODY['fr-4'], 200, 'application/json;charset=UTF-8'),
};

type Seen = { method: string; host: string; path: string; userAgent: string | null; apiKey: boolean };

/** Runs the check against msw with the real client; every spec answers with its fixture unless overridden. */
async function run(answers: Partial<Record<Spec, Answer>> = {}, now = NOW) {
  const seen: Seen[] = [];
  /** The request bodies in order (the NL-1 POSTs name their location and ProcesType in theirs). */
  const bodies: string[] = [];
  /** The query string of each request in order (the FR-4 list is asked for its national root only). */
  const queries: string[] = [];
  const groups = Map.groupBy(targets, (t) => `${t.method} ${t.pattern}`);
  server.use(
    ...[...groups.values()].map((group) => {
      const first = group[0] as (typeof targets)[number];
      return http[first.method === 'POST' ? 'post' : 'get'](first.pattern, async ({ request }) => {
        const url = new URL(request.url);
        queries.push(url.search);
        seen.push({
          method: request.method,
          host: url.host,
          path: url.pathname,
          userAgent: request.headers.get('user-agent'),
          apiKey: request.headers.has('x-api-key'),
        });
        const body = request.method === 'POST' ? await request.clone().text() : '';
        bodies.push(body);
        // The forecast spec of NL-1 asks for ProcesType verwachting, the observation specs for meting.
        const forecast = body.includes('"ProcesType":"verwachting"');
        const t = group.find((x) => x.id.includes('-fc-') === forecast) ?? first;
        return (answers[t.id as Spec] ?? GOOD[t.id as Spec])();
      });
    }),
  );
  const client = testClient(Object.fromEntries(capture.hosts), { userAgent: UA });
  const report = await check({ fetch: (source, req, opts) => client.fetch(source, req, opts), now });
  return {
    report,
    seen,
    bodies,
    queries,
    codes: Object.fromEntries(report.results.map((r) => [r.spec, r.code])) as Record<Spec, string>,
  };
}

/** The NL-1 fixture with a change to its parsed JSON. */
const nl1 = (change: (doc: { WaarnemingenLijst: Record<string, unknown>[] }) => void): Answer => {
  const doc = JSON.parse(BODY['nl-1-obs-key'].toString('utf8'));
  change(doc);
  return answer(JSON.stringify(doc));
};

// Each run parses the whole registry (about 2,000 series since P5b) and eleven payloads: seconds on a CI runner.
describe('the live check on the recorded payloads', { timeout: 30_000 }, () => {
  it('passes DE-1, NL-1 (observations and forecasts), NL-2, FR-1, CH-1, CH-2, DE-7, LU-1, the CH-4 figure and the FR-4 list through the loader parse: all eleven ok', async () => {
    const { codes, report } = await run();
    expect(codes).toEqual({
      'de-1-basin': 'ok',
      'nl-1-obs-key': 'ok',
      'nl-1-fc-1h': 'ok',
      'nl-2-wfs': 'ok',
      'fr-1-obs': 'ok',
      'ch-1-lindas': 'ok',
      'ch-2-pq': 'ok',
      'de-7-messwerte': 'ok',
      'lu-1-csv': 'ok',
      'ch-4-forecast': 'ok',
      'fr-4': 'ok',
    });
    expect(report.at).toBe(NOW.toISOString());
    expect(reportLines(report)).toBe(
      'de-1-basin ok\nnl-1-obs-key ok\nnl-1-fc-1h ok\nnl-2-wfs ok\nfr-1-obs ok\nch-1-lindas ok\nch-2-pq ok\nde-7-messwerte ok\nlu-1-csv ok\nch-4-forecast ok\nfr-4 ok',
    );
  });

  it('sends exactly the eleven registry targets, with the contact User-Agent and no API key', async () => {
    const { seen } = await run();
    expect(seen).toEqual(
      targets.map((t) => ({ method: t.method, host: t.host, path: t.path, userAgent: UA, apiKey: false })),
    );
    expect(targets.map((t) => `${t.method} ${t.host}${t.path}`)).toEqual([
      'GET www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json',
      'POST ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
      'POST ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
      'GET geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs',
      'GET hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr',
      'POST ld.admin.ch/query',
      'GET www.hydrodaten.admin.ch/web-hydro-maps/hydro_sensor_pq.geojson',
      'GET www.hochwasserportal.nrw/data/downloads/messwerte.zip',
      'GET inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv',
      'GET www.hydrodaten.admin.ch/plots/q_forecast/2091_q_forecast_de.json',
      'GET www.vigicrues.gouv.fr/services/v1.1/prevision.json',
    ]);
    expect(targets).toHaveLength(11);
    expect(seen).toHaveLength(11);
  });

  it('asks inondations.public.lu without a query string (its robots.txt says Disallow: /*?*)', () => {
    const age = targets.filter((t) => t.host === 'inondations.public.lu');
    expect(age.map((t) => t.id)).toEqual(['lu-1-csv']);
    for (const t of age) {
      expect(t.rawUrl, t.id).not.toContain('?');
      expect(new URL(t.rawUrl).search, t.id).toBe('');
    }
    // The check never adds one: the request that goes out is the registry URL, whatever the spec.
    expect(targets.filter((t) => t.source === 'LU-1')).toHaveLength(1);
  });

  it('checks the first FR-1 page only: a `next` link in the payload is never followed', async () => {
    const doc = JSON.parse(BODY['fr-1-obs'].toString('utf8'));
    doc.next = `${doc.first}&page=2`;
    const { codes, seen } = await run({ 'fr-1-obs': answer(JSON.stringify(doc)) });
    expect(codes['fr-1-obs']).toBe('ok');
    expect(seen.filter((r) => r.host === 'hubeau.eaufrance.fr')).toHaveLength(1);
    expect(seen).toHaveLength(11);
  });
});

/** The NL-1 forecast fixture with a change to its parsed JSON. */
const forecast = (change: (doc: { WaarnemingenLijst: Record<string, unknown>[] }) => void): Answer => {
  const doc = JSON.parse(BODY['nl-1-fc-1h'].toString('utf8'));
  change(doc);
  return answer(JSON.stringify(doc));
};

describe('the NL-1 forecast probe (P8a)', { timeout: 90_000 }, () => {
  it('asks the registered row lobith.bovenrijn.tolkamer/Q, not the first (stale) row of the seed', async () => {
    // The POST bodies, in the order of the specs: nl-1-obs-key, then nl-1-fc-1h.
    const bodies = (await run()).bodies.filter((b) => b !== '');
    const spec = capture.specs.find((x) => x.id === 'nl-1-fc-1h');
    // The seed's first 1h row is arnhem.nederrijn/Q, which RWS serves as gaps.
    expect(spec?.rows[0]).toMatchObject({ code: 'arnhem.nederrijn', quantity: 'Q', tier: '1h' });
    const sent = JSON.parse(bodies[1] ?? '{}') as {
      Locatie: { Code: string };
      AquoPlusWaarnemingMetadata: { AquoMetadata: { Grootheid: { Code: string }; ProcesType: string } };
    };
    expect(sent.Locatie.Code).toBe('lobith.bovenrijn.tolkamer');
    expect(sent.AquoPlusWaarnemingMetadata.AquoMetadata).toMatchObject({
      Grootheid: { Code: 'Q' },
      ProcesType: 'verwachting',
    });
    // The observation spec before it still asks its own first row.
    expect(JSON.parse(bodies[0] ?? '{}').AquoPlusWaarnemingMetadata.AquoMetadata.ProcesType).toBe('meting');
  });

  it('counts the forecast points as rows: every value a gap leaves nothing, so no_rows', async () => {
    const { codes } = await run({
      'nl-1-fc-1h': forecast((doc) => {
        for (const list of doc.WaarnemingenLijst)
          for (const m of list.MetingenLijst as { WaarnemingMetadata: { Kwaliteitswaardecode: string } }[])
            m.WaarnemingMetadata.Kwaliteitswaardecode = '99';
      }),
    });
    expect(codes['nl-1-fc-1h']).toBe('no_rows');
    expect(codes['nl-1-obs-key']).toBe('ok');
  });

  it('a method other than the series’ declared one is unregistered_method; a process type that is not verwachting is drift', async () => {
    const method = await run({
      'nl-1-fc-1h': forecast((doc) => {
        for (const list of doc.WaarnemingenLijst)
          (list.AquoMetadata as { WaardeBepalingsMethode: { Code: string } }).WaardeBepalingsMethode.Code = 'RWSM-F999';
      }),
    });
    expect(method.codes['nl-1-fc-1h']).toBe('unregistered_method');
    const process = await run({
      'nl-1-fc-1h': forecast((doc) => {
        for (const list of doc.WaarnemingenLijst) (list.AquoMetadata as { ProcesType: string }).ProcesType = 'meting';
      }),
    });
    expect(process.codes['nl-1-fc-1h']).toBe('forecast_process');
  });

  it('a location the registry does not hold is unknown_series; a unit other than the declared one is unit_mismatch', async () => {
    const nowhere = await run({
      'nl-1-fc-1h': forecast((doc) => {
        for (const list of doc.WaarnemingenLijst) (list.Locatie as { Code: string }).Code = 'nowhere.at.all';
      }),
    });
    expect(nowhere.codes['nl-1-fc-1h']).toBe('unknown_series');
    const unit = await run({
      'nl-1-fc-1h': forecast((doc) => {
        for (const list of doc.WaarnemingenLijst)
          (list.AquoMetadata as { Eenheid: { Code: string } }).Eenheid.Code = 'cm';
      }),
    });
    expect(unit.codes['nl-1-fc-1h']).toBe('unit_mismatch');
  });

  it('a value past the horizon is beyond_horizon: the pipeline’s run checks apply to the probe', async () => {
    const far = await run({
      'nl-1-fc-1h': forecast((doc) => {
        const list = doc.WaarnemingenLijst[0] as { MetingenLijst: { Tijdstip: string }[] };
        (list.MetingenLijst.at(-1) as { Tijdstip: string }).Tijdstip = '2026-10-04T12:00:00.000+01:00';
      }),
    });
    expect(far.codes['nl-1-fc-1h']).toBe('beyond_horizon');
  });
});

/** The CH-4 smoke recording (station 2091) with a change to its parsed JSON. */
const figure = (change: (doc: { plot: { data: { name: string; x: unknown[]; y: unknown[] }[] } }) => void): Answer => {
  const doc = JSON.parse(BODY['ch-4-forecast'].toString('utf8'));
  change(doc);
  return answer(JSON.stringify(doc));
};

describe('the CH-4 and FR-4 probes (P8b)', { timeout: 90_000 }, () => {
  it('asks the registered station 2091, not the first seed row (2004, a lake whose figure answers 404)', async () => {
    const spec = capture.specs.find((x) => x.id === 'ch-4-forecast');
    expect(spec?.rows[0]).toMatchObject({ id: '2004' });
    expect(spec?.rows.some((r) => r.id === '2091')).toBe(true);
    expect(ROW['ch-4-forecast']).toEqual({ id: '2091' });
    const { seen, codes } = await run();
    expect(seen.map((r) => r.path)).toContain('/plots/q_forecast/2091_q_forecast_de.json');
    expect(seen.filter((r) => r.path.includes('q_forecast'))).toHaveLength(1);
    expect(codes['ch-4-forecast']).toBe('ok');
  });

  it('asks the FR-4 national list once and follows no station of it', async () => {
    const list = JSON.parse(BODY['fr-4'].toString('utf8')) as { ListEntVigiCru: unknown[] };
    expect(list.ListEntVigiCru.length).toBeGreaterThan(0);
    const { seen, queries, codes } = await run();
    expect(seen.filter((r) => r.host === 'www.vigicrues.gouv.fr')).toEqual([
      {
        method: 'GET',
        host: 'www.vigicrues.gouv.fr',
        path: '/services/v1.1/prevision.json',
        userAgent: UA,
        apiKey: false,
      },
    ]);
    expect(queries.at(-1)).toBe('?FormatDate=iso&GrdSimul=H');
    expect(queries.join('\n')).not.toContain('CdEntVigiCru');
    expect(codes['fr-4']).toBe('ok');
  });

  it('a figure with a renamed or reordered trace is ch4_layout, a new key in the document is unrecognized_keys', async () => {
    const renamed = await run({
      'ch-4-forecast': figure((doc) => {
        (doc.plot.data[3] as { name: string }).name = 'Mediana';
      }),
    });
    expect(renamed.codes['ch-4-forecast']).toBe('ch4_layout at data.3');
    const swapped = await run({
      'ch-4-forecast': figure((doc) => {
        doc.plot.data = [0, 1, 3, 2, 4].map((i) => doc.plot.data[i] as (typeof doc.plot.data)[number]);
      }),
    });
    expect(swapped.codes['ch-4-forecast']).toMatch(/^ch4_layout at data\.\d$/);
    const extra = await run({
      'ch-4-forecast': figure((doc) => {
        (doc as Record<string, unknown>).EVIL_PROVIDER_KEY = 1;
      }),
    });
    expect(extra.codes['ch-4-forecast']).toMatch(/^unrecognized_keys/);
    expect(JSON.stringify(extra.report)).not.toContain('EVIL_PROVIDER_KEY');
    expect(extra.codes['fr-4']).toBe('ok');
  });

  it('a figure with an empty median yields no run: no_rows (CH-4 has no registry of its own to say so)', async () => {
    const { codes } = await run({
      'ch-4-forecast': figure((doc) => {
        for (const t of doc.plot.data) {
          t.x = [];
          t.y = [];
        }
      }),
    });
    expect(codes['ch-4-forecast']).toBe('no_rows');
  });

  it('a run past the 120 h horizon of CH-4 is beyond_horizon: the pipeline’s run checks apply to the probe', async () => {
    const far = await run({
      'ch-4-forecast': figure((doc) => {
        for (const i of [0, 1, 3]) {
          const t = doc.plot.data[i] as { x: string[] };
          t.x[t.x.length - 1] = '2026-10-20T00:00:00.000+02:00';
        }
        // The band polygon repeats the median's x values (forward, then back, then the first again).
        const band = doc.plot.data[2] as { x: string[] };
        const n = (doc.plot.data[3] as { x: string[] }).x.length;
        band.x[n - 1] = '2026-10-20T00:00:00.000+02:00';
        band.x[n] = '2026-10-20T00:00:00.000+02:00';
      }),
    });
    expect(far.codes['ch-4-forecast']).toBe('beyond_horizon');
  });

  it('an extra key in a listed FR-4 station, or an HTTP-200 error body, is a fixed code and carries no provider text', async () => {
    const doc = JSON.parse(BODY['fr-4'].toString('utf8'));
    doc.ListEntVigiCru[0].EVIL_PROVIDER_KEY = 1;
    const drift = await run({ 'fr-4': answer(JSON.stringify(doc)) });
    expect(drift.codes['fr-4']).toMatch(/^unrecognized_keys at /);
    expect(JSON.stringify(drift.report)).not.toContain('EVIL_PROVIDER_KEY');
    const error = await run({ 'fr-4': answer('{"error_msg":"PROVIDER-SECRET-TEXT","code":400}') });
    expect(error.codes['fr-4']).toMatch(/^invalid_[a-z_]+$/);
    expect(JSON.stringify(error.report)).not.toContain('PROVIDER-SECRET-TEXT');
    expect(error.codes['ch-4-forecast']).toBe('ok');
  });
});

describe('what a drifted provider turns into', { timeout: 30_000 }, () => {
  it('an extra key in an NL-1 payload is unrecognized_keys at a schema path', async () => {
    const { codes } = await run({
      'nl-1-obs-key': nl1((doc) => {
        (doc.WaarnemingenLijst[0]?.Locatie as Record<string, unknown>).EVIL_PROVIDER_KEY = 1;
      }),
    });
    expect(codes['nl-1-obs-key']).toBe('unrecognized_keys at WaarnemingenLijst.0.Locatie');
    expect(codes['de-1-basin']).toBe('ok');
  });

  it('a method code that is not the registered one is unregistered_method', async () => {
    const body = BODY['nl-1-obs-key'].toString('utf8').replaceAll('"other:F007"', '"other:F999"');
    expect(body).not.toBe(BODY['nl-1-obs-key'].toString('utf8'));
    const { codes } = await run({ 'nl-1-obs-key': answer(body) });
    expect(codes['nl-1-obs-key']).toBe('unregistered_method');
  });

  it('a series the registry does not know is unknown_series (NL-1 only)', async () => {
    const { codes } = await run({
      'nl-1-obs-key': nl1((doc) => {
        for (const list of doc.WaarnemingenLijst) (list.Locatie as { Code: string }).Code = 'nowhere.at.all';
      }),
    });
    expect(codes['nl-1-obs-key']).toBe('unknown_series');
  });

  it('a registered series under another ProcesType is registered_dropped (review F3)', async () => {
    const { codes } = await run({
      'nl-1-obs-key': nl1((doc) => {
        for (const list of doc.WaarnemingenLijst)
          (list.AquoMetadata as { ProcesType: string }).ProcesType = 'verwachting';
      }),
    });
    expect(codes['nl-1-obs-key']).toBe('registered_dropped');
  });

  it('a payload that parses but yields no row is no_rows', async () => {
    const { codes } = await run({
      'nl-1-obs-key': nl1((doc) => {
        // Every value a gap (quality code 99): dropped one by one, none withheld.
        for (const list of doc.WaarnemingenLijst)
          for (const m of list.MetingenLijst as { WaarnemingMetadata: { Kwaliteitswaardecode: string } }[])
            m.WaarnemingMetadata.Kwaliteitswaardecode = '99';
      }),
    });
    expect(codes['nl-1-obs-key']).toBe('no_rows');
  });

  it('a CH-1 CSV with another header is csv_header, and carries none of the payload', async () => {
    const body = BODY['ch-1-lindas'].toString('utf8');
    const drifted = body.replace(
      'id,name,water,time,q,w,t,dl,wkt',
      'id,name,water,time,q,w,t,dl,PROVIDER-SECRET-COLUMN',
    );
    expect(drifted).not.toBe(body);
    const { codes, report } = await run({ 'ch-1-lindas': answer(drifted, 200, 'text/csv') });
    expect(codes['ch-1-lindas']).toBe('csv_header');
    expect(JSON.stringify(report)).not.toContain('PROVIDER-SECRET-COLUMN');
    expect(codes['fr-1-obs']).toBe('ok');
    expect(codes['ch-2-pq']).toBe('ok');
  });

  it('a CH-1 CSV that lost a column the validity needs is invalid_required, a shifted row is a csv code', async () => {
    const body = BODY['ch-1-lindas'].toString('utf8');
    const noDl = body.replace(',dl,', ',danger,');
    expect(noDl).not.toBe(body);
    expect((await run({ 'ch-1-lindas': answer(noDl, 200, 'text/csv') })).codes['ch-1-lindas']).toBe('invalid_required');
    const lines = body.split('\n');
    lines[1] = `${lines[1]},extra`;
    const { codes } = await run({ 'ch-1-lindas': answer(lines.join('\n'), 200, 'text/csv') });
    expect(codes['ch-1-lindas']).toMatch(/^csv_[a-z_]+$/);
  });

  it('an extra key in an FR-1 observation is unrecognized_keys at a schema path', async () => {
    const doc = JSON.parse(BODY['fr-1-obs'].toString('utf8'));
    doc.data[0].EVIL_PROVIDER_KEY = 1;
    const { codes, report } = await run({ 'fr-1-obs': answer(JSON.stringify(doc)) });
    expect(codes['fr-1-obs']).toMatch(/^unrecognized_keys at /);
    expect(JSON.stringify(report)).not.toContain('EVIL_PROVIDER_KEY');
    expect(codes['ch-1-lindas']).toBe('ok');
  });

  it('a CH-2 feature with a new key is unrecognized_keys at a schema path', async () => {
    const doc = JSON.parse(BODY['ch-2-pq'].toString('utf8'));
    doc.features[0].properties.EVIL_PROVIDER_KEY = 1;
    const { codes, report } = await run({ 'ch-2-pq': answer(JSON.stringify(doc)) });
    expect(codes['ch-2-pq']).toMatch(/^unrecognized_keys at /);
    expect(JSON.stringify(report)).not.toContain('EVIL_PROVIDER_KEY');
  });

  // A messwerte.zip of our own: the real header and 10,050 rows (the validity wants 10,000 lines).
  const STATIONS = ['2768898001', '2829100000100', '2869500000200', '9286455000200', '2847500000100'];
  const messwerte = (rows: string[] = [], header = 'station_no;time;value(cm)', member = 'messwerte.txt') =>
    zip({
      [member]: Buffer.from(
        [
          header,
          // Five stations, one row every 5 minutes for 7 days each (a real member: 252 stations and 2,016 times,
          // within the parser's caps of 1,000 and 4,000), a varying value: repeated rows would trip the ZIP ratio guard.
          ...Array.from({ length: 10_050 }, (_, i) => {
            const at = new Date(Date.UTC(2026, 8, 22, 13, 0, 0) + (i % 2_010) * 300_000 + 3_600_000).toISOString();
            const no = STATIONS[Math.floor(i / 2_010)];
            return `${no};${at.slice(0, 19)}.000+01:00;${(((i * 7919) % 19_000) / 100).toFixed(2)}`;
          }),
          ...rows,
          '2768898001;',
          '',
        ].join('\r\n'),
      ),
    });

  it('a DE-7 ZIP of the right shape passes, one with another header, member or value is a fixed code', async () => {
    const zipped = (body: Buffer) => answer(body, 200, 'application/zip');
    // The synthetic ZIP is the real shape: unregistered ids are only counted, so a registered station is needed
    // for a row; here only the validity and the strict parse are under test.
    expect((await run({ 'de-7-messwerte': zipped(messwerte()) })).codes['de-7-messwerte']).toBe('ok');
    const header = await run({ 'de-7-messwerte': zipped(messwerte([], 'station_no;time;value(m)')) });
    expect(header.codes['de-7-messwerte']).toMatch(/^invalid_[a-z_]+$/);
    const member = await run({ 'de-7-messwerte': zipped(messwerte([], 'station_no;time;value(cm)', 'other.txt')) });
    expect(member.codes['de-7-messwerte']).toMatch(/^invalid_[a-z_]+$/);
    const value = await run({ 'de-7-messwerte': zipped(messwerte(['2768898001;2026-09-29T12:59:00.000+01:00;EVIL'])) });
    expect(value.codes['de-7-messwerte']).toMatch(/^[a-z0-9_]+ at line\.\d+$/);
    expect(JSON.stringify(value.report)).not.toContain('EVIL');
    // The other ten specs are untouched.
    expect(value.codes['lu-1-csv']).toBe('ok');
    expect(value.codes['ch-2-pq']).toBe('ok');
  });

  it('a DE-7 payload that is not a ZIP, or an LU-1 file that is HTML, is the validity code', async () => {
    const html = '<html><body>Service unavailable: PROVIDER-SECRET-TEXT</body></html>';
    const { codes, report } = await run({
      'de-7-messwerte': answer(html, 200, 'text/html'),
      'lu-1-csv': answer(html, 200, 'text/html'),
    });
    expect(codes['de-7-messwerte']).toMatch(/^invalid_[a-z_]+$/);
    expect(codes['lu-1-csv']).toMatch(/^invalid_[a-z_]+$/);
    expect(JSON.stringify(report)).not.toContain('PROVIDER-SECRET-TEXT');
  });

  it('an LU-1 CSV that lost a column the validity needs is invalid_required; a drifted label or cell is a code', async () => {
    const body = BODY['lu-1-csv'].toString('utf8');
    const noUnit = body.replace('"Unit"', '"Einheit"');
    expect(noUnit).not.toBe(body);
    expect((await run({ 'lu-1-csv': answer(noUnit, 200, 'text/csv') })).codes['lu-1-csv']).toBe('invalid_required');
    // A label that is no "dd.mm.yyyy HH:MM" instant.
    const label = body.replace('"24.09.2026 15:45"', '"24.09.2026 PROVIDER-SECRET-LABEL"');
    expect(label).not.toBe(body);
    const labelled = await run({ 'lu-1-csv': answer(label, 200, 'text/csv') });
    expect(labelled.codes['lu-1-csv']).toMatch(/^[a-z0-9_]+( at [A-Za-z0-9_.]+)?$/);
    expect(labelled.codes['lu-1-csv']).not.toBe('ok');
    expect(JSON.stringify(labelled.report)).not.toContain('PROVIDER-SECRET-LABEL');
    // A cell that is no number.
    const lines = body.split('\n');
    lines[1] = (lines[1] ?? '').replace(/,"?-?\d+(?:\.\d+)?"?(?=,|$)/, ',"PROVIDER-SECRET-VALUE"');
    const cell = await run({ 'lu-1-csv': answer(lines.join('\n'), 200, 'text/csv') });
    expect(cell.codes['lu-1-csv']).not.toBe('ok');
    expect(JSON.stringify(cell.report)).not.toContain('PROVIDER-SECRET-VALUE');
    expect(cell.codes['de-7-messwerte']).toBe('ok');
  });

  it('NL-1 answering 204 (no data) is ok and is not parsed', async () => {
    const { codes } = await run({ 'nl-1-obs-key': () => new HttpResponse(null, { status: 204 }) });
    expect(codes['nl-1-obs-key']).toBe('ok');
  });

  it('a 500 is http_500, a 404 http_404, a 304 http_304', async () => {
    for (const status of [500, 404, 304]) {
      const { codes } = await run({ 'nl-2-wfs': answer(status === 304 ? '' : '{"error":"x"}', status) });
      expect(codes['nl-2-wfs']).toBe(`http_${status}`);
    }
  });

  it('a 204 where the spec does not allow it is an empty answer, not ok', async () => {
    const { codes } = await run({ 'de-1-basin': () => new HttpResponse(null, { status: 204 }) });
    expect(codes['de-1-basin']).toBe('invalid_empty');
  });

  it('an HTML error page with status 200 is the validity failure code', async () => {
    const page = '<html><body>Service unavailable: PROVIDER-SECRET-TEXT</body></html>';
    const { codes, report } = await run({ 'nl-1-obs-key': answer(page, 200, 'text/html') });
    expect(codes['nl-1-obs-key']).toBe('invalid_json');
    expect(JSON.stringify(report)).not.toContain('PROVIDER-SECRET-TEXT');
  });

  it('a required key that vanished is invalid_required', async () => {
    const { codes } = await run({ 'nl-2-wfs': answer('{"type":"FeatureCollection"}') });
    expect(codes['nl-2-wfs']).toBe('invalid_required');
  });

  it('a transport error is fetch_<code>', async () => {
    const { codes } = await run({ 'nl-2-wfs': () => HttpResponse.error() });
    expect(codes['nl-2-wfs']).toBe('fetch_network');
    expect(codes['de-1-basin']).toBe('ok');
  });

  it('a field of the wrong type in DE-1 is its SchemaDrift code', async () => {
    const doc = JSON.parse(BODY['de-1-basin'].toString('utf8'));
    doc[0].longitude = 'seven';
    const { codes } = await run({ 'de-1-basin': answer(JSON.stringify(doc)) });
    expect(codes['de-1-basin']).toBe('invalid_type at 0.longitude');
  });

  it('a fetch that throws, or an error of its own, is check_error and carries no message', async () => {
    const report = await check({
      fetch: async () => {
        throw new Error(`boom https://x.example/?key=SECRET ${UA}`);
      },
      now: NOW,
    });
    expect(report.results.map((r) => r.code)).toEqual(Array(SPECS.length).fill('check_error'));
    expect(JSON.stringify(report)).not.toMatch(/SECRET|boom|example/);
  });

  it('a fetch error code that is not a fixed-looking code is fetch_failed', async () => {
    const report = await check({
      fetch: async () => ({ ok: false, error: 'Bad Error! https://x' as never }),
      now: NOW,
    });
    expect(report.results.map((r) => r.code)).toEqual(Array(SPECS.length).fill('fetch_failed'));
  });
});

describe('the report is a list of fixed lines and nothing else', { timeout: 90_000 }, () => {
  const hostile = [
    'ok\n@everyone',
    '`code`',
    'https://evil.example/x',
    'a'.repeat(500),
    `unrecognized_keys at ${'x'.repeat(500)}`,
    'code at <img src=x onerror=1>',
    'code at @someone',
    'code # heading',
    'two words',
    '',
    'Upper',
  ];

  it('turns anything outside LINE into `<spec> unreportable`, one line per result, whatever the code', () => {
    const report: Report = {
      at: NOW.toISOString(),
      results: [...hostile.map((code) => ({ spec: 'de-1-basin', code })), { spec: 'Bad Spec\n@x', code: 'ok' }],
    };
    const lines = reportLines(report).split('\n');
    expect(lines).toHaveLength(hostile.length + 1);
    for (const line of lines) expect(line).toMatch(LINE);
    expect(lines.slice(0, hostile.length)).toEqual(hostile.map(() => 'de-1-basin unreportable'));
    expect(lines.at(-1)).toBe('unknown unreportable');
  });

  it('a SchemaDrift with a hostile code or path never reaches a line outside LINE', () => {
    const drifts = [
      new SchemaDrift('code`with`ticks', 'a.b'),
      new SchemaDrift('invalid_type', 'a`b@c\nd<e>f:g/h#i'),
      new SchemaDrift('invalid_type', 'p'.repeat(500)),
    ];
    const report: Report = {
      at: NOW.toISOString(),
      results: drifts.map((d) => ({ spec: 'nl-2-wfs', code: d.message })),
    };
    const lines = reportLines(report).split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(LINE);
    expect(lines[0]).toBe('nl-2-wfs unreportable');
    expect(lines[1]).toBe('nl-2-wfs invalid_type at a?b?c?d?e?f?g?h?i');
    expect(lines[2]).toBe(`nl-2-wfs invalid_type at ${'p'.repeat(120)}`);
    for (const c of ['`', '@', '#', '<', '>', ':', '/']) expect(lines.join('\n')).not.toContain(c);
  });

  it('holds neither the User-Agent, the domain, the address, a URL nor a byte of a provider payload', async () => {
    const stationNames = [
      (JSON.parse(BODY['de-1-basin'].toString('utf8')) as { longname: string }[])[0]?.longname,
      (JSON.parse(BODY['nl-1-obs-key'].toString('utf8')) as { WaarnemingenLijst: { Locatie: { Naam: string } }[] })
        .WaarnemingenLijst[0]?.Locatie.Naam,
      (JSON.parse(BODY['nl-2-wfs'].toString('utf8')) as { features: { properties: { NAAM: string } }[] }).features[0]
        ?.properties.NAAM,
    ];
    for (const name of stationNames) expect(name).toMatch(/\w{4}/);
    const nasty = answer('<html>PROVIDER-SECRET-TEXT https://leak.example/?k=v</html>', 200, 'text/html');
    const runs = [
      await run(),
      await run({
        'nl-1-obs-key': nasty,
        'nl-1-fc-1h': nasty,
        'nl-2-wfs': nasty,
        'de-1-basin': nasty,
        'fr-1-obs': nasty,
        'ch-1-lindas': nasty,
        'ch-2-pq': nasty,
        'de-7-messwerte': nasty,
        'lu-1-csv': nasty,
        'ch-4-forecast': nasty,
        'fr-4': nasty,
      }),
      await run({
        'nl-2-wfs': () => HttpResponse.error(),
        'nl-1-obs-key': answer('x', 500),
        'fr-1-obs': answer('x', 503),
        'ch-1-lindas': () => HttpResponse.error(),
      }),
    ];
    for (const { report } of runs) {
      const text = `${JSON.stringify(report)}\n${reportLines(report)}`;
      for (const secret of [
        UA,
        DOMAIN,
        EMAIL,
        'https:',
        'http:',
        '://',
        'PROVIDER-SECRET-TEXT',
        'rijkswaterstaat',
        'pegelonline',
        'eaufrance',
        'ld.admin',
        'hydrodaten',
        'hochwasserportal',
        'inondations',
        'vigicrues',
        'q_forecast',
      ])
        expect(text).not.toContain(secret);
      for (const name of stationNames) expect(text).not.toContain(name as string);
      for (const line of reportLines(report).split('\n')) expect(line).toMatch(LINE);
    }
  });

  it('the LINE pattern reads the same in JavaScript and in `grep -E -x` (the workflow filters with grep)', () => {
    const corpus = [
      'de-1-basin ok',
      'nl-1-obs-key unrecognized_keys at WaarnemingenLijst.0.Locatie',
      'nl-2-wfs invalid_type at features.3.properties[0]-x?',
      'nl-2-wfs no_adapter',
      'nl-2-wfs unreportable',
      'x y',
      `s ${'c'.repeat(40)}`,
      `s ${'c'.repeat(41)}`,
      `s c at ${'p'.repeat(120)}`,
      `s c at ${'p'.repeat(121)}`,
      's c at',
      's c at ',
      's  c',
      ' s c',
      's c ',
      's-  c',
      '-s c',
      'S c',
      's C',
      's c at a`b',
      's c at a@b',
      's c at a#b',
      's c at a<b',
      's c at a:b',
      's c at a/b',
      's c at a b',
      's c at a\\b',
      's c at a"b',
      's c at a]b[',
      's c at [0]',
      '',
    ];
    const viaGrep = spawnSync('grep', ['-E', '-x', LINE_SOURCE], { input: `${corpus.join('\n')}\n`, encoding: 'utf8' });
    expect(viaGrep.status).toBe(0);
    expect(viaGrep.stdout.split('\n').filter((l) => l !== '')).toEqual(corpus.filter((l) => LINE.test(l) && l !== ''));
    expect(corpus.filter((l) => LINE.test(l)).length).toBeGreaterThan(8);
  });
});

describe('the command line', { timeout: 30_000 }, () => {
  const env = { PATH: process.env.PATH ?? '' };
  const cli = (args: string[], vars: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/contract-check.ts', ...args], {
      cwd: repoRoot,
      env: { ...env, ...vars },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('exits 78 without the contact variables, before any request, and prints one line', () => {
    const r = cli([]);
    expect(r.status).toBe(78);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/^contract-check: RWS_DOMAIN is missing/);
  });

  it('exits 78 for a malformed address, and echoes neither value', () => {
    const r = cli([], { RWS_DOMAIN: DOMAIN, RWS_CONTACT_EMAIL: 'not an address SECRET' });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/RWS_CONTACT_EMAIL is missing or not an e-mail address/);
    expect(r.stderr).not.toContain('SECRET');
    expect(r.stdout).toBe('');
  });

  it('takes no argument that names a target: usage error 64 for anything but --out <file>', () => {
    for (const args of [
      ['--url', 'https://evil.example/'],
      ['--host', 'evil.example'],
      ['--out'],
      ['--out', 'a', 'b'],
      ['x'],
    ]) {
      const r = cli(args, { RWS_DOMAIN: DOMAIN, RWS_CONTACT_EMAIL: EMAIL });
      expect(r.status).toBe(64);
      expect(r.stdout).toBe('');
    }
  });
});

describe('the workflow', () => {
  const path = '.github/workflows/contract-check.yml';
  const text = readFileSync(join(repoRoot, path), 'utf8');
  type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
  type Job = { permissions?: Record<string, string>; needs?: string; if?: string; steps: Step[] };
  const wf = parse(text) as {
    on: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, Job>;
  };
  const steps = Object.entries(wf.jobs).flatMap(([name, job]) => job.steps.map((step) => ({ ...step, job: name })));
  const code = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  it('starts only on the schedule (one nightly cron) and by hand, and holds no permission at the top', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.on.schedule).toEqual([{ cron: expect.stringMatching(/^\d{1,2} \d{1,2} \* \* \*$/) }]);
    expect(wf.permissions).toEqual({});
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text).not.toMatch(/pull_request|workflow_run|issue_comment/);
    expect(Object.keys(wf.jobs)).toEqual(['check', 'report']);
  });

  it('runs at minute 29, 5 minutes from every CH-1 fetch of the recorder (BAFU: at most one download per 10 minutes)', () => {
    const [cron] = wf.on.schedule as { cron: string }[];
    expect(cron?.cron).toBe('29 3 * * *');
    const minute = Number(cron?.cron.split(' ')[0]);
    const recorder = capture.specs.find((x) => x.id === 'ch-1-lindas')?.cron ?? '';
    const m = /^(\d{1,2})-59\/10 \* \* \* \*$/.exec(recorder);
    expect(m, recorder).not.toBeNull();
    const fetches = Array.from({ length: 6 }, (_, i) => Number(m?.[1]) + 10 * i);
    for (const f of fetches)
      expect(Math.min(Math.abs(minute - f), 60 - Math.abs(minute - f))).toBeGreaterThanOrEqual(5);
  });

  it('says eleven requests, never three, six, eight or nine', () => {
    expect(text).toContain('Eleven live requests');
    expect(text).not.toMatch(/\b(three|six|eight|nine)\b/i);
    expect(SPECS).toHaveLength(11);
  });

  it('writes issues in the report job only, and that job has no contents permission and no checkout', () => {
    const writes = Object.entries(wf.jobs).flatMap(([name, job]) =>
      Object.entries(job.permissions ?? {})
        .filter(([, level]) => level === 'write')
        .map(([scope]) => `${name}:${scope}`),
    );
    expect(writes).toEqual(['report:issues']);
    expect(code.match(/issues: write/g)).toHaveLength(1);
    expect(wf.jobs.report?.permissions).toEqual({ issues: 'write' });
    expect(wf.jobs.check?.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.report?.steps.some((s) => s.uses?.startsWith('actions/checkout'))).toBe(false);
    expect(wf.jobs.report?.steps.some((s) => s.uses?.startsWith('actions/setup-node'))).toBe(false);
    for (const s of wf.jobs.report?.steps ?? []) expect(s.run ?? '').not.toMatch(/\bnode\b|\bpnpm\b|scripts\//);
  });

  it('runs the report job when the check failed, although its dependency did', () => {
    expect(wf.jobs.report?.needs).toBe('check');
    expect(wf.jobs.report?.if).toBe(expr("always() && needs.check.result == 'failure'"));
  });

  it('uses no secret, and the contact values come from Actions variables', () => {
    expect(text).not.toContain('secrets.');
    const env = steps.find((s) => s.job === 'check' && s.env?.RWS_DOMAIN !== undefined)?.env;
    expect(env).toMatchObject({
      RWS_DOMAIN: expr('vars.RWS_DOMAIN'),
      RWS_CONTACT_EMAIL: expr('vars.RWS_CONTACT_EMAIL'),
    });
    expect(wf.jobs.report?.steps.at(-1)?.env).toMatchObject({
      GH_TOKEN: expr('github.token'),
      GH_REPO: expr('github.repository'),
    });
    expect(code).not.toMatch(/x-api-key|RWS_API|api_key/i);
  });

  it('has no expression inside a run: block; the report travels through env', () => {
    const runs = steps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const s of runs) expect(s.run).not.toContain(EXPR_OPEN);
    const report = wf.jobs.report?.steps.at(-1);
    expect(report?.env?.REPORT).toBe(expr('needs.check.outputs.report'));
    expect(report?.run).toContain(`printf '%s\\n' "$REPORT" | grep -Ex "$LINE"`);
    expect(report?.run).toContain('--body-file');
    expect(report?.run).toMatch(/\[\[ \$number =~ \^\[0-9\]\+\$ \]\]/);
    expect(report?.run).not.toMatch(/--body[ =]/);
  });

  it('pins every action to a commit SHA', () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => u !== undefined);
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const u of uses) expect(u).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+@[0-9a-f]{40}$/);
    // The same pins as ci.yml, comments included.
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    for (const line of text.split('\n').filter((l) => /^\s*- uses:/.test(l)))
      expect(ci).toContain(line.trim().slice(2));
    for (const s of wf.jobs.check?.steps.filter((x) => x.uses?.startsWith('actions/checkout')) ?? [])
      expect(s.with).toEqual({ 'persist-credentials': false });
    for (const job of Object.values(wf.jobs)) expect(job.steps[0]?.uses).toMatch(/^step-security\/harden-runner@/);
  });

  it('filters with the script’s own LINE pattern in both jobs', () => {
    const patterns = steps.map((s) => s.env?.LINE).filter((p): p is string => p !== undefined);
    expect(patterns).toHaveLength(2);
    for (const p of patterns) expect(p).toBe(LINE_SOURCE);
    // The check job hands over only what LINE accepts, behind a delimiter drawn after the script has exited.
    const run = wf.jobs.check?.steps.find((s) => s.env?.LINE !== undefined)?.run ?? '';
    expect(run).toContain('grep -qvEx "$LINE"');
    expect(run.indexOf('node scripts/contract-check.ts')).toBeLessThan(run.indexOf('openssl rand'));
    expect(run.trimEnd().endsWith('exit "$status"')).toBe(true);
  });
});
