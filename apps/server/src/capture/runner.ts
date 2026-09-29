import type { Logger } from 'pino';
import { keptHeaders, type ManifestLine, redactUrl } from '../archive/manifest.ts';
import { at, type Validity, type ValiditySpec, validate } from '../archive/validity.ts';
import { type Archive, sha256, utcDay } from '../archive/writer.ts';
import { type Client, METADATA_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from '../http/client.ts';
import type { Adapter, ErrorCode, Req, Row } from '../http/types.ts';
import { ADAPTERS } from './adapters.ts';
import { baseRequest, type LoadedSpec, type Window, windowFor } from './specs.ts';
import { newSpecState, type SpecState, type StateStore, type VariantState } from './state.ts';

// One capture run of one spec (A§7.1): build the requests from the registry,
// fetch them politely, assert validity, apply the change gate and dup_of, and
// archive. Every request gets exactly one manifest line; state changes only
// after that line. Counters feed the status files and the daily report.

export type Outcome = 'ok' | 'upstream_5xx' | 'timeouts' | 'other';
const TRANSIENT = new Set<string>(['network', 'timeout', 'backoff', 'breaker_open', 'dns']);

export type Day = {
  scheduled: number;
  ok: number;
  upstream_5xx: number;
  timeouts: number;
  other: number;
  bytes: Record<string, number>;
};
export type Alert = { spec: string; kind: string; at: string };

/** Per source per UTC day (3 days kept for the status file, 4 for the daily report). */
export class Counters {
  days: Record<string, Record<string, Day>> = {};
  alerts: Record<string, Alert[]> = {};

  private day(date: string, source: string): Day {
    const perSource = this.days[date] ?? {};
    this.days[date] = perSource;
    const d = perSource[source] ?? { scheduled: 0, ok: 0, upstream_5xx: 0, timeouts: 0, other: 0, bytes: {} };
    perSource[source] = d;
    return d;
  }

  record(date: string, source: string, outcome: Outcome): void {
    const d = this.day(date, source);
    d.scheduled += 1;
    d[outcome] += 1;
  }

  addBytes(date: string, source: string, spec: string, bytes: number): void {
    const d = this.day(date, source);
    d.bytes[spec] = (d.bytes[spec] ?? 0) + bytes;
  }

  alert(a: Alert): void {
    const date = a.at.slice(0, 10);
    this.alerts[date] = [...(this.alerts[date] ?? []), a];
  }

  prune(now: Date, keepDays = 4): void {
    const cutoff = utcDay(new Date(now.getTime() - (keepDays - 1) * 86_400_000));
    for (const d of Object.keys(this.days)) if (d < cutoff) delete this.days[d];
    for (const d of Object.keys(this.alerts)) if (d < cutoff) delete this.alerts[d];
  }

  static from(json: unknown): Counters {
    const c = new Counters();
    const j = json as Partial<Counters> | undefined;
    c.days = j?.days ?? {};
    c.alerts = j?.alerts ?? {};
    return c;
  }
}

export type RunDeps = {
  client: Client;
  archive: Archive;
  state: StateStore;
  counters: Counters;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  adapters?: Readonly<Record<string, Adapter>>;
};

export type RunOptions = {
  /** §0.1b harvest: marked in the manifest, kept out of the daily counters, lists followed. */
  seed?: boolean;
  rows?: Row[];
  window?: { from: Date; to: Date };
  /** Pause between two requests (seeds; LU-2 staggering), overriding the spec's. */
  spaceMs?: number;
  /** Epoch ms after which no new request starts. */
  deadline?: number;
  /** Cap on stage-2 requests (default: the spec's max_expand). */
  maxExpand?: number;
  /** Variant keys to skip (a resumed seed). */
  skip?: ReadonlySet<string>;
};

export type RunSummary = {
  requests: number;
  ok: number;
  stored: number;
  storedBytes: number;
  transient: boolean;
  firstFailure: number | string | null;
  coverage: { from: string; to: string } | null;
  doneVariants: string[];
  /** The stage-2 cap cut the run short (a seed then resumes next time). */
  capped: boolean;
};

const isoNoMs = (d: Date) => d.toISOString();

function outcomeOf(status: number | null, error: ErrorCode | null, valid: boolean): Outcome {
  if (error === 'timeout') return 'timeouts';
  if (error !== null) return 'other';
  if (status !== null && status >= 500) return 'upstream_5xx';
  if (status === 204 || status === 304) return 'ok';
  if (status !== null && status >= 200 && status < 300 && valid) return 'ok';
  return 'other';
}

function fieldKey(doc: unknown, paths: readonly string[]): string | null {
  for (const p of paths) {
    const v = at(doc, p);
    if (v !== undefined && v !== null && v !== '') return String(v).slice(0, 200);
  }
  return null;
}

function mergeCoverage(
  a: { from: string; to: string } | null,
  b: { from: string; to: string } | null,
): { from: string; to: string } | null {
  if (a === null) return b;
  if (b === null) return a;
  return { from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to };
}

/** Runs one spec once. Never throws for a provider problem: each request gets its manifest line. */
export async function runSpec(spec: LoadedSpec, deps: RunDeps, opts: RunOptions = {}): Promise<RunSummary> {
  const adapters = deps.adapters ?? ADAPTERS;
  const adapter = adapters[spec.source];
  const started = deps.now();
  const st = await deps.state.update<SpecState>(spec.id, (cur) => ({
    ...(cur ?? newSpecState(started)),
    last_attempt: started.toISOString(),
  }));
  const seen = new Set(st.seen);
  /** Page alerts raised by this run only (a ping may clear older ones meanwhile). */
  const pages = new Set<string>();
  /** Variants this run changed: only these are written back (a seed may run beside the schedule). */
  const touched: Record<string, VariantState> = {};
  const summary: RunSummary = {
    requests: 0,
    ok: 0,
    stored: 0,
    storedBytes: 0,
    transient: false,
    firstFailure: null,
    coverage: null,
    doneVariants: [],
    capped: false,
  };
  const timeoutMs = spec.timeout === 'metadata' ? METADATA_TIMEOUT_MS : TOTAL_TIMEOUT_MS;
  const spaceMs = opts.spaceMs ?? spec.variants?.space_ms ?? 0;
  const maxExpand = opts.maxExpand ?? spec.request.max_expand;

  /** `window` only on a root request (a registry row); stage-2 requests have none. */
  type Item = { req: Req; validity: ValiditySpec; expandable: boolean; root: boolean; window: Window | null };
  const queue: Item[] = [];
  for (const row of opts.rows ?? spec.rows) {
    let req = baseRequest(spec, row);
    if (opts.skip?.has(req.variant)) continue;
    const window = opts.window ?? windowFor(spec, started, st.variants[req.variant]?.last_success ?? st.last_success);
    if (spec.request.build && adapter?.build) {
      req = adapter.build({ req, row, now: started, window, params: spec.params });
    }
    queue.push({ req, validity: spec.validity, expandable: spec.request.expand, root: true, window });
  }
  let expanded = 0;
  /** Every URL this run has queued: a provider link that repeats one (a `next` loop) is not fetched again. */
  const queued = new Set(queue.map((q) => q.req.url));
  /** Roots of a walk (a spec that expands): their window moves only if the whole walk completed. */
  const walks = new Map<string, string>();
  const day = utcDay(started);

  /** Writes the variants, seen ids and new page alerts; `done` also sets last success/failure. */
  const persist = (done: boolean) =>
    deps.state.update<SpecState>(spec.id, (cur) => {
      const base = cur ?? st;
      const finished = deps.now();
      return {
        ...base,
        variants: { ...base.variants, ...touched },
        seen: [...new Set([...(base.seen ?? []), ...seen])].slice(-5000),
        pending_page: [...new Set([...(base.pending_page ?? []), ...pages])],
        ...(done && summary.ok > 0 && !summary.transient ? { last_success: finished.toISOString() } : {}),
        ...(done && summary.firstFailure !== null ? { last_failure_status: summary.firstFailure } : {}),
      };
    });

  for (let i = 0; i < queue.length; i += 1) {
    const { req, validity: vspec, expandable, root, window } = queue[i] as Item;
    if (i > 0 && spaceMs > 0) await deps.sleep(spaceMs);
    if (opts.deadline !== undefined && deps.now().getTime() > opts.deadline) {
      // Out of time: the remaining requests of this run are skipped, not queued.
      for (let j = i; j < queue.length; j += 1) if (!opts.seed) deps.counters.record(day, spec.source, 'other');
      summary.transient = true;
      break;
    }
    summary.requests += 1;
    const vs: VariantState = { ...(st.variants[req.variant] ?? {}) };
    const headers = { ...req.headers };
    // A seed sends no conditional header: a 304 would count its item as done without any data.
    const conditional = opts.seed ? 'none' : spec.conditional;
    if ((conditional === 'etag' || conditional === 'both') && vs.etag) headers['if-none-match'] = vs.etag;
    if ((conditional === 'last-modified' || conditional === 'both') && vs.last_modified) {
      headers['if-modified-since'] = vs.last_modified;
    }
    const start = deps.now();
    const result = await deps.client.fetch(
      spec.source,
      { ...req, headers },
      {
        maxBytes: spec.max_bytes,
        timeoutMs,
        ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }),
      },
    );
    const end = deps.now();
    const line: ManifestLine = {
      v: 1,
      source: spec.source,
      spec: spec.id,
      spec_version: spec.version,
      variant: req.variant,
      ...(opts.seed ? { seed: true as const } : {}),
      request: {
        method: req.method,
        url: redactUrl(req.url),
        ...(req.body !== undefined && req.body.length <= 8192 ? { body: req.body } : {}),
      },
      fetched_at: { start: isoNoMs(start), end: isoNoMs(end) },
      status: null,
      headers: {},
      sha256: null,
      bytes: null,
      stored_bytes: null,
      key: null,
      dup_of: null,
      gate: null,
      shape: null,
      shape_changed: false,
      validity: null,
      retention: spec.retention,
      error: null,
    };
    let v: Validity | null = null;
    let status: number | null = null;
    /** A new object on disk (the same content in the same second is one object). */
    let created = false;
    if (!result.ok) {
      line.error = result.error;
    } else {
      const { res } = result;
      status = res.status;
      line.status = res.status;
      line.headers = keptHeaders(res.headers);
      if (res.status >= 200 && res.status < 300 && res.status !== 204) {
        v = await validate(vspec, res.status, res.body);
        const hash = sha256(res.body);
        line.sha256 = hash;
        line.bytes = res.body.length;
        line.validity = { ok: v.ok, reason: v.reason, count: v.count };
        line.shape = v.shape;
        if (v.shape !== null && vs.shape !== undefined && v.shape !== vs.shape) {
          line.shape_changed = true;
          deps.counters.alert({ spec: spec.id, kind: 'shape_changed', at: end.toISOString() });
          deps.log.warn({ spec: spec.id, variant: req.variant, alert: 'shape_changed' }, 'shape fingerprint changed');
        }
        // The change gate: a gate that cannot read its field stores the body.
        let gateKey: string | null = null;
        if (v.ok && spec.gate.kind === 'field') gateKey = fieldKey(v.doc, spec.gate.paths);
        if (v.ok && spec.gate.kind === 'lastmod-runstart') gateKey = adapter?.gateKey?.(v.doc, res.headers) ?? null;
        const open = gateKey === null || gateKey !== vs.gate_key;
        line.gate = { kind: spec.gate.kind, key: gateKey, open };
        if (!open) {
          // Unchanged state: line only, no object.
        } else if (vs.sha === hash && vs.key !== undefined) {
          line.dup_of = vs.key;
        } else {
          const put = await deps.archive.put(spec.source, spec.id, end, res.body, hash);
          line.key = put.key;
          line.stored_bytes = put.stored;
          created = put.created;
        }
        if (!v.ok) {
          deps.counters.alert({ spec: spec.id, kind: 'invalid', at: end.toISOString() });
          deps.log.warn(
            { spec: spec.id, variant: req.variant, alert: 'invalid', reason: v.reason },
            'invalid payload archived',
          );
        }
      } else if (res.status === 404 && spec.alert?.page) {
        pages.add(`${spec.alert.kind}:404`);
        deps.log.warn({ spec: spec.id, variant: req.variant, alert: `${spec.alert.kind}:404` }, 'page alert');
      }
    }
    await deps.archive.append(line);

    // State, counters and alerts change only after the manifest line.
    const outcome = outcomeOf(status, line.error, v?.ok ?? true);
    if (!opts.seed) deps.counters.record(day, spec.source, outcome);
    if (created) {
      summary.stored += 1;
      summary.storedBytes += line.stored_bytes ?? 0;
      if (!opts.seed) deps.counters.addBytes(day, spec.source, spec.id, line.stored_bytes ?? 0);
    }
    const kept = line.key ?? line.dup_of;
    if (kept !== null && line.sha256 !== null) {
      vs.sha = line.sha256;
      vs.key = kept;
    }
    if (result.ok && (status === 200 || status === 203 || status === 206)) {
      if (result.res.headers.etag !== undefined) vs.etag = result.res.headers.etag;
      if (result.res.headers['last-modified'] !== undefined) vs.last_modified = result.res.headers['last-modified'];
    }
    if (line.gate?.key) vs.gate_key = line.gate.key;
    if (v?.shape) vs.shape = v.shape;
    if (outcome === 'ok') {
      summary.ok += 1;
      // The window anchor belongs to the schedule: a seed never moves it, and a walk moves it at its end.
      if (!opts.seed && root && spec.request.expand) walks.set(req.variant, (window?.to ?? end).toISOString());
      else if (!opts.seed) vs.last_success = end.toISOString();
      summary.doneVariants.push(req.variant);
      if (req.seen_id !== undefined) seen.add(req.seen_id);
      if (v?.ok) {
        const utc = (t: string) => new Date(t).toISOString();
        const times = v.times === undefined ? null : { from: utc(v.times.min), to: utc(v.times.max) };
        summary.coverage = mergeCoverage(summary.coverage, adapter?.coverage?.(v.doc) ?? times);
      }
      // Watched values (LU-4 thresholds, NL-4 file names): a change is an alert.
      if (v?.ok && spec.alert !== undefined) {
        const key =
          spec.alert.paths.length > 0 ? fieldKeyAll(v.doc, spec.alert.paths) : (adapter?.alertKey?.(v.doc) ?? null);
        const changed = (key === null && spec.alert.page) || (vs.alert_key !== undefined && key !== vs.alert_key);
        if (changed) {
          const kind = spec.alert.kind;
          if (spec.alert.page) pages.add(kind);
          else deps.counters.alert({ spec: spec.id, kind, at: end.toISOString() });
          deps.log.warn({ spec: spec.id, variant: req.variant, alert: kind }, 'watched value changed');
        }
        if (key !== null) vs.alert_key = key;
      }
    } else {
      if (status !== null && status >= 500) summary.transient = true;
      if (status === 429 || (line.error !== null && TRANSIENT.has(line.error))) summary.transient = true;
      summary.firstFailure ??= line.error ?? (v !== null && !v.ok ? 'invalid' : status);
    }
    st.variants[req.variant] = vs;
    touched[req.variant] = vs;
    // A long run (a seed) persists as it goes, so a restart resumes instead of starting over.
    if (summary.requests % 20 === 0) await persist(false);

    // Stage-2 requests: FR-4 stations, FR-5 sections, LU-5 new files, Hub'Eau pages.
    if (expandable && v?.ok && adapter?.expand) {
      const more = adapter.expand({
        req,
        doc: v.doc,
        now: end,
        seen,
        seed: opts.seed === true,
        checkUrl: (raw) => {
          const u = deps.client.checkUrl(spec.source, raw);
          return typeof u === 'string' ? null : u.href;
        },
      });
      for (const r of more.reqs) {
        if (queued.has(r.url)) continue;
        if (expanded >= maxExpand) {
          summary.capped = true;
          deps.log.warn({ spec: spec.id, cap: maxExpand }, 'expansion cap reached');
          break;
        }
        expanded += 1;
        queued.add(r.url);
        const list = r.variant === 'list' || /#\d+$/.test(r.variant);
        queue.push({
          req: r,
          validity: list ? spec.validity : (spec.request.expand_validity ?? spec.validity),
          expandable: list,
          root: false,
          window: null,
        });
      }
    }
  }

  // A capped, cut or transiently failed walk asks again from the same point next time (C4).
  if (!summary.capped && !summary.transient) {
    for (const [variant, at] of walks) {
      const vs: VariantState = { ...st.variants[variant], last_success: at };
      st.variants[variant] = vs;
      touched[variant] = vs;
    }
  }
  await persist(true);
  deps.log.info(
    { spec: spec.id, seed: opts.seed === true, requests: summary.requests, ok: summary.ok, stored: summary.stored },
    'run done',
  );
  return summary;
}

/** Joined values of several paths (LU-4: levelsMax + newVigilanceList), null when none can be read. */
function fieldKeyAll(doc: unknown, paths: readonly string[]): string | null {
  const parts = paths.map((p) => at(doc, p));
  if (parts.every((p) => p === undefined)) return null;
  return JSON.stringify(parts).slice(0, 4000);
}
