import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestLine } from '../../src/archive/manifest.ts';
import { Archive } from '../../src/archive/writer.ts';
import type { GuardVerdict, Job, JobStatus, JobStore, NewJob } from '../../src/backfill/job.ts';
import type { LoadedBackfill } from '../../src/backfill/spec.ts';
import { loadBackfill } from '../../src/backfill/spec.ts';
import { loadRegistry } from '../../src/capture/specs.ts';
import type { ErrorCode, FetchResult, Req } from '../../src/http/types.ts';

// Shared by the backfill unit tests: the real registry, a fake clock, a fake transport that serves existing NL-1
// fixture bodies, and an in-memory job store. Nothing here touches the network or a database.

export const registry = loadRegistry();
export const config = loadBackfill(registry.hosts);
export const SPEC = 'nl-1-backfill-obs';
export const LOBITH_H = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
export const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';

/** The config narrowed to some series of the one spec. */
export function narrowed(keys: readonly string[]): LoadedBackfill {
  const spec = config.specs.find((s) => s.id === SPEC);
  if (spec === undefined) throw new Error('no spec');
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
  async advance(id: number, a: { cursor_ts: Date; data_from?: Date; chunk: boolean }) {
    const j = this.row(id);
    if (a.cursor_ts > j.range_to || a.cursor_ts < j.range_from) throw new Error('cursor outside the range');
    j.cursor_ts = a.cursor_ts;
    if (a.data_from !== undefined) j.data_from = a.data_from;
    if (a.chunk) j.chunks_done += 1;
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
}

export async function newJob(
  store: MemoryJobStore,
  o: { series?: string; from?: string; to?: string; budget?: number } = {},
): Promise<number> {
  const spec = config.specs.find((s) => s.id === SPEC);
  const { id } = await store.insert({
    spec_id: SPEC,
    source_id: 'NL-1',
    series_key: o.series ?? LOBITH_H,
    range_from: new Date(`${o.from ?? '2026-05-01'}T00:00:00Z`),
    range_to: new Date(`${o.to ?? '2026-08-01'}T00:00:00Z`),
    chunk_ms: spec?.chunk_ms ?? 0,
    request_budget: o.budget ?? 50,
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
