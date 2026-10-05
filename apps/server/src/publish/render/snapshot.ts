import type { Snapshot, SnapshotFile, StateBasis } from '@rws/contracts';
import { valueSources } from '../../api/answer.ts';
import { publicSnapshot } from '../../api/data.ts';
import { readStates, snapshotValues } from '../../api/states.ts';
import { attributionFor } from '../../attribution.ts';
import type { RenderCtx } from '../cycle.ts';
import { historyExcluded } from '../plan.ts';
import { readFacts, type SeriesFacts } from './series.ts';

// P9a: a recent/ or settled/ bucket file (the same function: a settled file is a pure function of the data at t, no
// generation time, no dates in the attribution) and the columnar form latest.json shares.

export type Columns = Omit<SnapshotFile, 'schemaVersion' | 'attribution'>;

const basisKey = (b: StateBasis) => JSON.stringify([b.source, b.kind, b.measure, b.ref, b.label]);

/** The columns of the API's snapshot values (kept in the order given): bases deduplicated, `basis` an index into them. */
export function columns(t: string, values: Snapshot['values']): Columns {
  const bases: StateBasis[] = [];
  const index = new Map<string, number>();
  const at = (b: StateBasis): number => {
    const k = basisKey(b);
    let i = index.get(k);
    if (i === undefined) {
      i = bases.push(b) - 1;
      index.set(k, i);
    }
    return i;
  };
  return {
    t,
    series: values.map((v) => v.series),
    ageSeconds: values.map((v) => v.ageSeconds),
    value: values.map((v) => v.value),
    qc: values.map((v) => v.qc),
    state: values.map((v) => v.state),
    basis: values.map((v) => (v.basis === null ? null : at(v.basis))),
    bases,
    section: values.map((v) => v.section),
    area: values.map((v) => (v.area === undefined ? null : { state: v.area.state, basis: at(v.area.basis) })),
    nap: values.map((v) => v.nap ?? null),
    zero: values.map((v) => v.zero ?? null),
  };
}

/** The sources a body names: its series' and every basis. */
export const sourcesOf = (c: Columns, facts: ReadonlyMap<number, SeriesFacts>): Set<string> =>
  new Set([
    ...c.series.flatMap((s, i) => {
      const source = facts.get(s)?.source;
      return source === undefined ? [] : valueSources(source, c.qc[i] ?? 0);
    }),
    ...c.bases.map((b) => b.source),
  ]);

/** The values of the bucket at `t` as the API's /snapshot gives them (the public family keeps the owner-basis check). */
export async function readValues(c: RenderCtx, t: number, current: boolean): Promise<Snapshot['values']> {
  const read = await readStates(c.db, c.family, t, { now: c.now, current, sections: c.sections, cache: c.cache });
  return c.family === 'public' ? publicSnapshot(read).values : snapshotValues(read);
}

export async function renderSnapshot(c: RenderCtx, t: number): Promise<SnapshotFile> {
  const facts = await readFacts(c.db, c.family);
  const values = (await readValues(c, t, false)).filter((v) => {
    const f = facts.get(v.series);
    return f !== undefined && !historyExcluded(f, 'other');
  });
  const cols = columns(new Date(t).toISOString(), values);
  return { schemaVersion: 1, ...cols, attribution: attributionFor(c.attribution, sourcesOf(cols, facts)) };
}
