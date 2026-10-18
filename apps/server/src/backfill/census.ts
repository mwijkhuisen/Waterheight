import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isFuture, parseInstant, type Registry } from '@rws/core';
import { GAP, INSTANTANEOUS, KNOWN_QUALITY, TIME } from '../adapters/nl-1/normalise.ts';
import { parseWaarnemingen, type Waarnemingen } from '../adapters/nl-1/parse.ts';
import { ArchiveError, type ArchiveReader } from '../archive/reader.ts';
import { errorCode } from '../db/pool.ts';
import { LOAD_ADAPTERS, loadNl1Backfill, NL1_BACKFILL_FLOOR } from '../load/adapters.ts';
import { DATA_EPOCH } from '../load/dirty.ts';
import { backfillWindow, parseLine } from '../load/pipeline.ts';
import { declarationsOf, type RegistryInput } from '../load/registry-sync.ts';
import type { LoadedBackfill } from './spec.ts';

// `backfill census --spec <id>` (#184, KG-342): what the archived NL-1 backfill lines hold, per list of
// `<code>/<Grootheid>/<Hoedanigheid>/<method>/<WaardeBewerkingsMethode>`, and what a replay of them would change now
// that a processed list (the daily mean GEM24H) no longer merges into the instantaneous series. Read-only: the archive
// and the registry, no database, no request, no file written. It walks the manifest as `replay` does and parses each
// payload as the loader does (loadNl1Backfill), once as it stands and once as the code before #184 read it
// (`beforeFix`), so the difference is exactly what the replay will write. Provider strings are untrusted: a code is
// printed only when it matches its pattern ("?" otherwise), and no free text (Omschrijving, names) is ever printed.

export type CensusArgs = { cmd: 'census'; spec: string };

/** A code as printed: the pattern of each field, or "?" (and the census groups by the printed form). */
const SAFE = {
  code: /^[a-z0-9.]{1,80}$/,
  quantity: /^(?:WATHTE|Q)$/,
  hoedanigheid: /^[A-Z]{2,8}$/,
  method: /^(?:other:F|RWSM-F)\d{3}$/,
  bewerking: /^[A-Z0-9]{2,8}$/,
  unit: /^[a-z0-9/]{1,8}$/,
} as const;
const safe = (field: keyof typeof SAFE, v: string) => (SAFE[field].test(v) ? v : '?');

const STATUSES = ['Ongecontroleerd', 'Gecontroleerd', 'Definitief'] as const;
const EPOCH_MS = Date.parse(DATA_EPOCH);
const FLOOR_MS = Date.parse(NL1_BACKFILL_FLOOR);

/** The lists as the code before #184 read them: every processed list as if it were instantaneous. */
export const beforeFix = (lists: readonly Waarnemingen[]): Waarnemingen[] =>
  lists.map((l) =>
    l.aquo.WaardeBewerkingsMethode.Code === INSTANTANEOUS
      ? l
      : {
          ...l,
          aquo: { ...l.aquo, WaardeBewerkingsMethode: { ...l.aquo.WaardeBewerkingsMethode, Code: INSTANTANEOUS } },
        },
  );

/** The gap between two instants as an ISO 8601 duration (whole days, hours, minutes, else seconds). */
export function isoStep(ms: number): string {
  if (ms % 86_400_000 === 0) return `P${ms / 86_400_000}D`;
  if (ms % 3_600_000 === 0) return `PT${ms / 3_600_000}H`;
  if (ms % 60_000 === 0) return `PT${ms / 60_000}M`;
  return `PT${Math.round(ms / 1000)}S`;
}

type Group = {
  code: string;
  quantity: string;
  hoedanigheid: string;
  method: string;
  bewerking: string;
  unit: string;
  role: string | null;
  audience: string | null;
  lists: number;
  values: number;
  ok_values: number;
  gap: number;
  unknown_quality: number;
  statuses: Record<(typeof STATUSES)[number], number>;
  first: number | null;
  last: number | null;
  steps: Map<number, number>;
};

const instant = (raw: string): number | null => {
  try {
    return parseInstant(TIME, raw);
  } catch {
    return null;
  }
};

/**
 * The census of one NL-1 backfill spec. `print` gets the output lines (orphans as they are found, then the groups, the
 * series and the totals); `log` a usage or failure text. Exit codes as the other backfill commands.
 */
export async function census(
  args: CensusArgs,
  deps: { config: LoadedBackfill; registry: RegistryInput; reader: ArchiveReader },
  print: (o: unknown) => void,
  log: (line: string) => void,
): Promise<number> {
  const loader = LOAD_ADAPTERS['NL-1']?.specs[args.spec];
  if (deps.config.specs.find((s) => s.id === args.spec)?.source !== 'NL-1' || loader?.backfill !== true) {
    log('backfill census: --spec is not an NL-1 backfill spec of registry/backfill.yaml');
    return 64;
  }
  try {
    await realpath(deps.reader.root);
  } catch {
    log('backfill census: the archive root is not readable (RWS_RAW_DIR)');
    return 1;
  }
  const registry: Registry = declarationsOf(deps.registry.stations, 'NL-1');
  const rows = new Map(
    deps.registry.stations.filter((s) => s.source === 'NL-1').map((s) => [s.provider_key, s] as const),
  );
  const sourceAudience = deps.registry.sources.find((s) => s.id === 'NL-1')?.audience;
  // The loader stores nothing for an `off` series and counts none of a narrowed one (store.ts upsertObs).
  const counted = (key: string) => rows.get(key)?.audience === sourceAudience;

  const t = {
    lines: 0,
    objects: 0,
    duplicate_lines: 0,
    duplicate_lines_differing: 0,
    failed_validity: 0,
    missing: 0,
    bad_object: 0,
    unreadable: 0,
    unparsed: 0,
    excluded_lists: 0,
    withheld_lists: 0,
    values: 0,
    processed_values: 0,
    restorable: 0,
    requalified: 0,
    orphan: 0,
  };
  let first: string | null = null;
  let last: string | null = null;
  const groups = new Map<string, Group>();
  const perSeries = new Map<string, { restorable: number; requalified: number; orphan: number }>();
  const seriesOf = (key: string) => {
    const s = perSeries.get(key) ?? { restorable: 0, requalified: 0, orphan: 0 };
    perSeries.set(key, s);
    return s;
  };
  // A chunk counts once: the same bytes (a refetch, or a recovered line beside the runner's own), or the payload's own
  // code/G/H set with its line's chunk start (NL-1 lines carry no variant, a re-planned job has a new id).
  // ponytail: two jobs whose chunks of one series start on other days would count twice; none exist before the
  // KG-355 re-plans.
  const seenBodies = new Set<string>();
  const seenChunks = new Set<string>();

  try {
    for (const { file } of await deps.reader.manifests()) {
      let offset = 0;
      for (;;) {
        const chunk = await deps.reader.lines(file, offset);
        if (chunk.length === 0) break;
        offset = (chunk.at(-1) as { end: number }).end;
        for (const raw of chunk) {
          const line = parseLine(raw.text);
          if (line === null || line.source !== 'NL-1' || line.spec !== args.spec || line.key === null) continue;
          if (line.error !== null || (line.status !== null && line.status >= 400)) continue;
          t.lines += 1;
          const day = file.slice(0, 10);
          first ??= day;
          last = day;
          if (line.validity !== null && !line.validity.ok) {
            t.failed_validity += 1;
            continue;
          }
          let body: Buffer;
          try {
            body = await deps.reader.readObject(line.key, loader.maxBytes);
          } catch (err) {
            if (!(err instanceof ArchiveError)) throw err;
            if (err.code === 'missing') t.missing += 1;
            else if (err.code === 'unreadable') t.unreadable += 1;
            else t.bad_object += 1;
            continue;
          }
          if (line.sha256 !== null && createHash('sha256').update(body).digest('hex') !== line.sha256) {
            t.bad_object += 1;
            continue;
          }
          const fetchedAt = Date.parse(line.fetched_at.end ?? line.fetched_at.start);
          const window = backfillWindow(line, EPOCH_MS);
          const ctx = { registry, fetchedAt, backfill: window };
          let lists: Waarnemingen[];
          let now: ReturnType<typeof loadNl1Backfill>;
          let before: ReturnType<typeof loadNl1Backfill>;
          try {
            lists = parseWaarnemingen(body);
          } catch {
            // The loader quarantines such a payload (drift or adapter_error); its values are counted nowhere here.
            t.unparsed += 1;
            continue;
          }
          const where = [
            ...new Set(lists.map((l) => `${l.locatie.Code}/${l.aquo.Grootheid.Code}/${l.aquo.Hoedanigheid.Code}`)),
          ]
            .sort()
            .join('\n');
          const chunkKey = line.backfill === undefined || where === '' ? null : `${where}\n\n${line.backfill.from}`;
          const sameBody = line.sha256 !== null && seenBodies.has(line.sha256);
          if (sameBody || (chunkKey !== null && seenChunks.has(chunkKey))) {
            // A changed answer of a chunk seen before: the replay keeps the newest fetch, the census the first.
            t.duplicate_lines += 1;
            if (!sameBody) t.duplicate_lines_differing += 1;
            continue;
          }
          try {
            now = loadNl1Backfill(lists, ctx);
            // Without a processed list both readings are the same, and so is what a replay writes.
            before = lists.some((l) => l.aquo.WaardeBewerkingsMethode.Code !== INSTANTANEOUS)
              ? loadNl1Backfill(beforeFix(lists), ctx)
              : now;
          } catch {
            t.unparsed += 1;
            continue;
          }
          if (line.sha256 !== null) seenBodies.add(line.sha256);
          if (chunkKey !== null) seenChunks.add(chunkKey);
          t.objects += 1;

          const lo = Math.max(FLOOR_MS, window.from);
          for (const l of lists) {
            const a = l.aquo;
            if (a.ProcesType !== 'meting' || a.Compartiment.Code !== 'OW' || a.Groepering.Code !== '') {
              t.excluded_lists += 1;
              continue;
            }
            const raw4 = `${l.locatie.Code}/${a.Grootheid.Code}/${a.Hoedanigheid.Code}/${a.WaardeBepalingsMethode.Code}`;
            const row = rows.get(raw4);
            // A registered series of another audience than the source's (off, or narrowed) is not described: the
            // output is attached to a public issue (invariant 8). Counted only.
            if (row !== undefined && row.audience !== sourceAudience) {
              t.withheld_lists += 1;
              continue;
            }
            const g = {
              code: safe('code', l.locatie.Code),
              quantity: safe('quantity', a.Grootheid.Code),
              hoedanigheid: safe('hoedanigheid', a.Hoedanigheid.Code),
              method: safe('method', a.WaardeBepalingsMethode.Code),
              bewerking: safe('bewerking', a.WaardeBewerkingsMethode.Code),
              unit: safe('unit', a.Eenheid.Code),
            };
            const key = Object.values(g).join('/');
            let group = groups.get(key);
            if (group === undefined) {
              group = {
                ...g,
                role: row?.role ?? null,
                audience: row?.audience ?? null,
                lists: 0,
                values: 0,
                ok_values: 0,
                gap: 0,
                unknown_quality: 0,
                statuses: { Ongecontroleerd: 0, Gecontroleerd: 0, Definitief: 0 },
                first: null,
                last: null,
                steps: new Map(),
              };
              groups.set(key, group);
            }
            group.lists += 1;
            group.values += l.metingen.length;
            t.values += l.metingen.length;
            if (a.WaardeBewerkingsMethode.Code !== INSTANTANEOUS) t.processed_values += l.metingen.length;
            const instants: number[] = [];
            for (const m of l.metingen) {
              group.statuses[m.WaarnemingMetadata.Statuswaarde] += 1;
              const ts = instant(m.Tijdstip);
              if (ts !== null) instants.push(ts);
              const q = m.WaarnemingMetadata.Kwaliteitswaardecode;
              if (q === GAP) group.gap += 1;
              else if (!KNOWN_QUALITY.has(q)) group.unknown_quality += 1;
              else if (ts !== null && ts >= lo && ts < window.to && !isFuture(ts, fetchedAt)) {
                group.ok_values += 1;
                if (group.first === null || ts < group.first) group.first = ts;
                if (group.last === null || ts > group.last) group.last = ts;
              }
            }
            instants.sort((x, y) => x - y);
            for (let i = 1; i < instants.length; i += 1) {
              const d = (instants[i] as number) - (instants[i - 1] as number);
              if (d > 0) group.steps.set(d, (group.steps.get(d) ?? 0) + 1);
            }
          }

          // What the replay writes: rows only the fix stores (restorable), rows it stores otherwise (requalified;
          // both count as the replay's n_new, a backfill row being one with qc bit 512), and rows only the old code
          // stored (orphans: a replay never deletes, so they stay).
          if (before === now) continue;
          const old = new Map<string, { series: string; ts: string; value: number; qc: number }>();
          for (const r of before.obs) if (counted(r.series)) old.set(`${r.series}\n${r.ts}`, r);
          for (const r of now.obs) {
            if (!counted(r.series)) continue;
            const k = `${r.series}\n${r.ts}`;
            const o = old.get(k);
            if (o === undefined) {
              t.restorable += 1;
              seriesOf(r.series).restorable += 1;
            } else {
              old.delete(k);
              if (o.value !== r.value || o.qc !== r.qc) {
                t.requalified += 1;
                seriesOf(r.series).requalified += 1;
              }
            }
          }
          for (const o of old.values()) {
            t.orphan += 1;
            seriesOf(o.series).orphan += 1;
            print({ orphan: { series: o.series, ts: o.ts, value: o.value } });
          }
        }
      }
    }
  } catch (err) {
    // A file-system code (EACCES, EIO, …) is the archive; `unknown` is the census's own failure. What was printed
    // before has no totals line, and is no census.
    log(`backfill census: failed (${errorCode(err)})`);
    return 1;
  }
  if (t.lines === 0) {
    log('backfill census: no line of the spec in the archive (RWS_RAW_DIR?)');
    return 1;
  }

  for (const key of [...groups.keys()].sort()) {
    const { steps, first: f, last: l, ...g } = groups.get(key) as Group;
    // The modal gap; a tie goes to the shorter one.
    const step = [...steps].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0];
    print({
      group: {
        ...g,
        first: f === null ? null : new Date(f).toISOString(),
        last: l === null ? null : new Date(l).toISOString(),
        step: step === undefined ? null : isoStep(step),
      },
    });
  }
  for (const key of [...perSeries.keys()].sort()) print({ series: { key, ...perSeries.get(key) } });
  print({
    totals: {
      spec: args.spec,
      manifest_from: first,
      manifest_to: last,
      ...t,
      groups: groups.size,
      expect: {
        lines: t.lines,
        n_new: t.restorable + t.requalified,
        n_changed: 0,
        quarantined: t.bad_object + t.unparsed,
        skipped: t.failed_validity + t.missing,
      },
    },
  });
  return 0;
}
