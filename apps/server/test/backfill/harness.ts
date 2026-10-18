import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpHandler, HttpResponse, http } from 'msw';
import { ManifestLine } from '../../src/archive/manifest.ts';
import { Archive } from '../../src/archive/writer.ts';
import type { GuardVerdict, Job, JobStatus, JobStore, NewJob } from '../../src/backfill/job.ts';
import { jobBudget, planChunks, probeYears, requestBudget } from '../../src/backfill/plan.ts';
import type { LoadedBackfill, LoadedBackfillSpec } from '../../src/backfill/spec.ts';
import { loadBackfill } from '../../src/backfill/spec.ts';
import { loadRegistry } from '../../src/capture/specs.ts';
import { Client } from '../../src/http/client.ts';
import type { ErrorCode, FetchResult, Req } from '../../src/http/types.ts';
import { fakeResolver, mswTransport } from '../helpers.ts';

// Shared by the backfill unit tests: the real registry, a fake clock, a fake transport that serves existing NL-1
// fixture bodies, and an in-memory job store. Nothing here touches the network or a database.

export const registry = loadRegistry();
export const config = loadBackfill(registry.hosts);
export const SPEC = 'nl-1-backfill-obs';
export const LOBITH_H = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
export const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';

export type Nl1Loaded = Extract<LoadedBackfillSpec, { source: 'NL-1' }>;
/** The NL-1 spec of the real registry. */
export function nl1Spec(): Nl1Loaded {
  const spec = config.specs.find((s) => s.id === SPEC);
  if (spec?.source !== 'NL-1') throw new Error('no spec');
  return spec;
}

/** The config narrowed to some series of the NL-1 spec. */
export function narrowed(keys: readonly string[]): LoadedBackfill {
  const spec = nl1Spec();
  const series = spec.series.filter((s) => keys.includes(s.series_key));
  if (series.length !== keys.length) throw new Error('series not selected by the spec');
  return { ...config, specs: [{ ...spec, series }] };
}

const FIXTURES = new URL('../../src/adapters/nl-1/fixtures/', import.meta.url);
export const fixtureText = (name: string): string => readFileSync(new URL(`${name}.raw`, FIXTURES), 'utf8');
export const fixtureBody = (name = 'nl-1-obs-key'): Buffer => Buffer.from(fixtureText(name));
export const CHECK = (present: boolean): Buffer =>
  Buffer.from(`{"Succesvol":true,"WaarnemingenAanwezig":"${present}"}`);

/** 2026-10-13 23:00 UTC: inside the 22:00–05:00 window. */
export const NIGHT = Date.parse('2026-10-13T23:00:00Z');

export class Clock {
  t: number;
  readonly slept: number[] = [];
  constructor(t = NIGHT) {
    this.t = t;
  }
  now = () => new Date(this.t);
  sleep = async (ms: number) => {
    this.slept.push(ms);
    this.t += ms;
  };
}

export type Answer = { status: number; body?: Buffer; headers?: Record<string, string> } | { error: ErrorCode };
export type Call = { url: string; body: string | undefined; at: number; check: boolean };

/** A Client stand-in: answers from a function, records every call, and takes 50 ms of fake time. */
export function fakeClient(clock: Clock, answer: (call: Call, n: number) => Answer) {
  const calls: Call[] = [];
  const client = {
    fetch: async (_source: string, req: Req): Promise<FetchResult> => {
      const call: Call = {
        url: req.url,
        body: req.body,
        at: clock.t,
        check: req.url.endsWith('CheckWaarnemingenAanwezig'),
      };
      calls.push(call);
      clock.t += 50;
      const a = answer(call, calls.length);
      if ('error' in a) return { ok: false, error: a.error };
      return {
        ok: true,
        res: {
          status: a.status,
          headers: { 'content-type': 'application/json', ...a.headers },
          body: a.body ?? Buffer.alloc(0),
          wireBytes: a.body?.length ?? 0,
          url: req.url,
        },
      };
    },
  };
  return { client, calls };
}

/** The job table in memory, with the same transitions as the SQL store. */
export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<number, Job>();
  /** Guard verdicts handed out in order; `ok` once they are used up. */
  verdicts: GuardVerdict[] = [];
  /** Host → holder of its lease (a lapse is a test deleting the entry). */
  readonly leases = new Map<string, string>();
  private next = 1;

  async insert(j: NewJob) {
    for (const o of this.jobs.values())
      if (
        o.spec_id === j.spec_id &&
        o.series_key === j.series_key &&
        o.range_from.getTime() === j.range_from.getTime() &&
        o.range_to.getTime() === j.range_to.getTime()
      )
        return { id: o.id, created: false };
    const id = this.next++;
    this.jobs.set(id, {
      ...j,
      id,
      data_from: null,
      cursor_ts: j.range_from,
      chunks_done: 0,
      chunks_with_data: 0,
      status: 'planned',
      attempts: 0,
      requests: 0,
      provider_values: 0,
      inserted: 0,
      revised: 0,
      skipped: 0,
      dropped: 0,
      unreconciled: 0,
      last_error: null,
    });
    return { id, created: true };
  }
  private row(id: number): Job {
    const j = this.jobs.get(id);
    if (j === undefined) throw new Error('no such job');
    return j;
  }
  async get(id: number) {
    const j = this.jobs.get(id);
    return j && { ...j };
  }
  async list() {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }
  async runnable() {
    return (await this.list()).filter((j) => j.status === 'planned' || j.status === 'running');
  }
  async start(id: number) {
    const j = this.row(id);
    if (j.status === 'planned' || j.status === 'running') j.status = 'running';
  }
  async addRequest(id: number) {
    this.row(id).requests += 1;
  }
  async failAttempt(id: number) {
    return ++this.row(id).attempts;
  }
  async advance(id: number, a: { cursor_ts: Date; data_from?: Date; chunk: boolean; data?: boolean }) {
    const j = this.row(id);
    if (a.cursor_ts > j.range_to || a.cursor_ts < j.range_from) throw new Error('cursor outside the range');
    j.cursor_ts = a.cursor_ts;
    if (a.data_from !== undefined) j.data_from = a.data_from;
    if (a.chunk) j.chunks_done += 1;
    if (a.chunk && a.data === true) j.chunks_with_data += 1;
    j.attempts = 0;
  }
  async setStatus(id: number, to: JobStatus, error: string | null, only: readonly JobStatus[]) {
    const j = this.row(id);
    if (!only.includes(j.status)) return false;
    j.status = to;
    j.last_error = error;
    if (to === 'planned') j.attempts = 0;
    return true;
  }
  async guard() {
    return this.verdicts.shift() ?? 'ok';
  }
  async lease(host: string, holder: string) {
    const by = this.leases.get(host);
    if (by !== undefined && by !== holder) return false;
    this.leases.set(host, holder);
    return true;
  }
  async release(host: string, holder: string) {
    if (this.leases.get(host) === holder) this.leases.delete(host);
  }
}

export async function newJob(
  store: MemoryJobStore,
  o: { series?: string; from?: string; to?: string; budget?: number } = {},
): Promise<number> {
  const spec = config.specs.find((s) => s.id === SPEC);
  const from = new Date(`${o.from ?? '2026-05-01'}T00:00:00Z`);
  const to = new Date(`${o.to ?? '2026-08-01'}T00:00:00Z`);
  const chunkMs = spec?.chunk_ms ?? 0;
  const { id } = await store.insert({
    spec_id: SPEC,
    source_id: 'NL-1',
    series_key: o.series ?? LOBITH_H,
    range_from: from,
    range_to: to,
    chunk_ms: chunkMs,
    // The most the runner accepts for the range (review S2): the plan's budget.
    request_budget: o.budget ?? requestBudget(planChunks(from, to, chunkMs).length, probeYears(from, to)),
  });
  return id;
}

/** A real Archive in a temp dir, and the manifest lines it holds (all days, in file order). */
export function tempArchive() {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  const archive = new Archive(dir);
  const lines = (): ManifestLine[] => {
    const root = join(dir, '_manifest');
    const files = (() => {
      try {
        return readdirSync(root).sort();
      } catch {
        return [];
      }
    })();
    return files.flatMap((f) =>
      readFileSync(join(root, f), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => ManifestLine.parse(JSON.parse(l))),
    );
  };
  return { archive, dir, lines };
}

/** An archive that must not be reached: the test stops before a chunk commits. */
export const unusedArchive = {
  put: async (): Promise<never> => {
    throw new Error('archive not expected');
  },
  append: async (): Promise<never> => {
    throw new Error('archive not expected');
  },
};

/** The default answers: a check says yes, a chunk is the Lobith H fixture. */
export const normal = (c: { check: boolean }): Answer => ({ status: 200, body: c.check ? CHECK(true) : fixtureBody() });

/** The native step of the generated history. */
export const STEP_MS = 600_000;

/**
 * History as the provider would serve it for `[from, to)`: the Lobith H fixture's structure with its value list
 * generated, one value every 10 minutes, the first a gap (quality 99, which normalise drops). Test data, never a golden.
 * `kept` are the instants (epoch ms) that survive normalise.
 */
export function historyBody(from: Date, to: Date): { body: Buffer; kept: number[] } {
  const doc = JSON.parse(fixtureText('nl-1-obs-key'));
  const list = doc.WaarnemingenLijst[0];
  const template = list.MetingenLijst[0];
  const kept: number[] = [];
  const metingen: unknown[] = [];
  for (let t = Math.ceil(from.getTime() / STEP_MS) * STEP_MS; t < to.getTime(); t += STEP_MS) {
    const gap = metingen.length === 0;
    const value = gap ? 0 : 600 + ((t / STEP_MS) % 97);
    if (!gap) kept.push(t);
    metingen.push({
      ...template,
      Meetwaarde: { Waarde_Alfanumeriek: String(value), Waarde_Numeriek: value },
      // RWS answers in +01:00.
      Tijdstip: `${new Date(t + 3_600_000).toISOString().slice(0, 23)}+01:00`,
      WaarnemingMetadata: { ...template.WaarnemingMetadata, Kwaliteitswaardecode: gap ? '99' : '25' },
    });
  }
  doc.WaarnemingenLijst = [{ ...list, MetingenLijst: metingen }];
  return { body: Buffer.from(JSON.stringify(doc)), kept };
}

/** A probe says yes; a chunk is `historyBody` of the request's Periode. */
export const history = (c: Call): Answer => {
  if (c.check) return { status: 200, body: CHECK(true) };
  const p = JSON.parse(c.body ?? '{}').Periode;
  return { status: 200, body: historyBody(new Date(p.Begindatumtijd), new Date(p.Einddatumtijd)).body };
};

// ---------------------------------------------------- P14b: the open-archive scenarios of resume.int.test.ts
// One unit of each committed open-archive spec, answered by msw at the provider's real URL through the real Client
// (shared with crash-child.ts, which runs its own msw server). Bodies are the real fixture (DE-8) or generated in the
// provider's recorded format (FR-2, CH-9): test data, never a golden.

export type ArchiveName = 'de-8' | 'fr-2' | 'ch-9';
export type ArchiveScenario = {
  name: ArchiveName;
  spec: LoadedBackfillSpec;
  config: LoadedBackfill;
  unit: string;
  /** The source whose series the rows go to. */
  target: string;
  from: Date;
  to: Date;
  /** The most the runner accepts for the job (the plan's budget). */
  budget: number;
  answer: (url: URL) => { status: number; body: Uint8Array; headers: Record<string, string> };
};

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const fixtureOf = (id: string, name: string) =>
  readFileSync(new URL(`../../src/adapters/${id}/fixtures/${name}.raw`, import.meta.url));

/** The committed spec narrowed to one unit; `chunkMs` replaces its chunk (a test seam: see FR-2). */
function narrowedTo(id: string, unit: string, chunkMs?: number) {
  const spec = config.specs.find((s) => s.id === id);
  const units = (spec?.series as readonly { series_key: string }[] | undefined)?.filter((u) => u.series_key === unit);
  if (spec === undefined || units?.length !== 1) throw new Error(`${id}: no unit ${unit}`);
  const s = { ...spec, series: units, ...(chunkMs === undefined ? {} : { chunk_ms: chunkMs }) } as LoadedBackfillSpec;
  return { spec: s, config: { ...config, specs: [s] } };
}

/** DE-8: the recorded Rur 2020-2029 decade file (trimmed: Stah from 2026-04-01), whatever slice asks it. */
const RUR_2020 = 'Rureinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip';

/** FR-2: the last P400D chunk of the job (its first day); its full-length request is answered as a 206 page. */
export const FR2_TRUNCATED_FROM = '2024-10-22';
/** FR-2: a whole number of m³/s a day (l/s in the answer), so that a stored `real` reads back exactly. */
export const fr2Value = (d: string): number => (10 + ((Date.parse(`${d}T00:00:00Z`) / DAY) % 97)) * 1000;
function fr2Answer(url: URL) {
  const from = Date.parse(`${url.searchParams.get('date_debut_obs_elab')}T00:00:00Z`);
  const to = Date.parse(`${url.searchParams.get('date_fin_obs_elab')}T00:00:00Z`);
  const [template] = JSON.parse(fixtureOf('fr-2', 'fr-2-elab-uckange-qmnj-2026').toString('utf8')).data;
  const data: unknown[] = [];
  for (let t = from; t <= to; t += DAY)
    data.push({
      ...template,
      code_station: url.searchParams.get('code_entite'),
      grandeur_hydro_elab: url.searchParams.get('grandeur_hydro_elab'),
      date_obs_elab: isoDay(t),
      resultat_obs_elab: fr2Value(isoDay(t)),
      code_statut: 16,
      libelle_statut: 'Donnée validée',
      code_qualification: 20,
      libelle_qualification: 'Bonne',
    });
  const page = data.length > 200 && isoDay(from) >= FR2_TRUNCATED_FROM;
  const body = {
    count: data.length,
    first: url.href,
    prev: null,
    next: page ? `${url.href}&cursor=next` : null,
    api_version: '2.0.1',
    data: page ? data.slice(0, 3) : data,
  };
  return {
    status: page ? 206 : 200,
    body: Buffer.from(JSON.stringify(body)),
    headers: { 'content-type': 'application/json' },
  };
}

/** CH-9: the stage reading (cm above 240 m ü. M.) at a 5-minute instant; pegel is consistent with it. */
export const ch9Cm = (t: number): number => 400 + ((t / 300_000) % 17);
function ch9Answer(url: URL) {
  const m = /^timestamp >= '([^']+)' AND timestamp < '([^']+)'$/.exec(url.searchParams.get('where') ?? '');
  if (m === null || !url.pathname.endsWith('/100089/exports/json'))
    return { status: 400, body: new Uint8Array(), headers: {} };
  const records: unknown[] = [];
  for (let t = Date.parse(m[1] as string); t < Date.parse(m[2] as string); t += 300_000)
    records.push({
      timestamp: new Date(t).toISOString().replaceAll('.000Z', '+00:00'),
      abfluss: 800 + ((t / 300_000) % 13),
      pegelhoehe: ch9Cm(t),
      pegel: (24_000 + ch9Cm(t)) / 100,
    });
  return { status: 200, body: Buffer.from(JSON.stringify(records)), headers: { 'content-type': 'application/json' } };
}

export function archiveScenario(name: ArchiveName): ArchiveScenario {
  const of = (id: string, unit: string, target: string, from: string, to: string, chunkMs?: number) => {
    const n = narrowedTo(id, unit, chunkMs);
    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    return { name, ...n, unit, target, from: f, to: t, budget: jobBudget(f, t, n.spec.chunk_ms, false) };
  };
  switch (name) {
    case 'de-8':
      // Six P30D slices of the 2020s file, up to DATA_FLOOR; one fetch serves them all.
      return {
        ...of('de-8-backfill-w', 'Rureinzugsgebiet/2020', 'DE-7', '2026-03-03', '2026-08-01'),
        answer: (url) =>
          url.pathname.endsWith(`/${RUR_2020}`)
            ? {
                status: 200,
                body: fixtureOf('de-8', 'de-8-backfill-w-rur-2020'),
                headers: { 'content-type': 'application/zip' },
              }
            : { status: 404, body: new Uint8Array(), headers: {} },
      };
    case 'fr-2':
      // Twenty P400D chunks. The committed P7300D gives a job of at most 4 chunks and a budget of 5, which no halving
      // fits (a 206, then twice the chunks): the runner pauses such a job `budget`, to be re-planned. A shorter chunk
      // lets the job halve its last chunk within its budget.
      return {
        ...of(
          'fr-2-backfill-elab',
          'A850061001/QmnJ',
          'FR-1',
          '2004-01-01',
          isoDay(Date.UTC(2004, 0, 1) + 8000 * DAY),
          400 * DAY,
        ),
        answer: fr2Answer,
      };
    case 'ch-9':
      // Three P30D chunks of the Rhine at Basel (W and Q).
      return { ...of('ch-9-backfill-bs', '100089', 'CH-1', '2026-04-15', '2026-07-01'), answer: ch9Answer };
  }
}

/**
 * The real Client over msw at the providers' real URLs (the caller's msw server says onUnhandledFrame: 'error'): every
 * request is recorded and takes 50 ms of fake time; `onRequest` sees its number (1-based) before it is answered.
 */
export function archiveClient(clock: Clock, s: ArchiveScenario, onRequest?: (n: number) => void) {
  const calls: Call[] = [];
  const handlers: HttpHandler[] = [
    http.get(/^https:\/\/(?:www\.opengeodata\.nrw\.de|hubeau\.eaufrance\.fr|data\.bs\.ch)\//, ({ request }) => {
      calls.push({ url: request.url, body: undefined, at: clock.t, check: false });
      onRequest?.(calls.length);
      clock.t += 50;
      const a = s.answer(new URL(request.url));
      return new HttpResponse(a.body, { status: a.status, headers: a.headers });
    }),
  ];
  const client = new Client({
    hosts: registry.hosts,
    userAgent: 'rivierstanden/test (+https://example.invalid/over; test@example.invalid)',
    transport: mswTransport,
    resolver: fakeResolver(),
    now: () => clock.t,
    sleep: clock.sleep,
  });
  return { client, calls, handlers };
}
