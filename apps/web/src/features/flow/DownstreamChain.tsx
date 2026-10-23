import type { ApiStation } from '@rws/contracts';
import { useMemo } from 'react';
import { useMouths, useReachGraph, useRivers, useWaterbodies } from '../../lib/data/api.ts';
import type { WebRiver, WebWaterbody } from '../../lib/data/chain.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import type { WebForecast } from '../../lib/data/static.ts';
import { riverName } from '../../lib/labels/labels.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { lakeGauges, lakeLevels } from '../../lib/water.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { LADDER } from '../legend/palette.ts';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { stateWord } from '../station/state.ts';
import styles from './chain.module.css';
import { type Branch, type Downstream, downstream, type Exit } from './downstream.ts';
import { chainRows, type StationRow } from './rows.ts';

// "Stroomafwaarts / Downstream" (P19b T3, issue #67): the downstream chain of the open station, after the upstream
// one; a lazy chunk of StationPanel. It reads the graph, the rivers, the water bodies and the mouths itself
// (useReachGraph, useRivers, useWaterbodies, useMouths) and walks them with downstream.ts. Rows reuse the upstream
// chain's row texts (rows.ts) without the travel text: downstream the map gives the order, never a time. Every name
// (stations, rivers, water bodies) is a React text node; the bodies' names come from the reaches file, never `via`.

export interface DownstreamChainProps {
  locale: Locale;
  station: ApiStation;
  /** The visible stations of the page (after `?hide=`): names, series and the `known` set of the walk. */
  stations: readonly ApiStation[];
  /** The feature-state record of every station at t. */
  states: ReadonlyMap<string, StationState>;
  values: ReadonlyMap<number, PlayedValue>;
  /** After now: the forecasts at t by series (a lake's state word through lakeLevels); undefined up to now. */
  forecasts: ReadonlyMap<number, WebForecast> | undefined;
  /** Owner-audience source ids (empty on the public site). */
  ownerSources: ReadonlySet<string>;
  /** Open another station. */
  onOpen: (id: string) => void;
  /** The values are played-back hourly frames. */
  played: boolean;
}

const NO_TRAVEL = { travel_times: [] };

interface Names {
  river: (id: string) => string;
  body: (id: string) => string;
  /** The state word of a lake's reference gauge, or undefined. */
  level: (id: string) => string | undefined;
}

function Row({ row, locale, onOpen }: { row: StationRow; locale: Locale; onOpen: (id: string) => void }) {
  return (
    <li className={styles.station}>
      <button type="button" className={styles.select} onClick={() => onOpen(row.id)}>
        <span>{row.name}</span>
        <span className={styles.muted}>{row.river}</span>
      </button>
      <div className={styles.meta}>
        <span>
          {row.state ?? m.legend_no_value({}, { locale })}
          {row.owner && (
            <>
              {' '}
              <OwnerBadge locale={locale} />
            </>
          )}
        </span>
      </div>
    </li>
  );
}

/** "IJssel → Ketelmeer", "Ketelmeer → IJsselmeer", ...: one line per step. */
function Exits({ exit, names, locale }: { exit: Exit; names: Names; locale: Locale }) {
  const line = (key: string, from: string, to: string, state: string | undefined) => (
    <li key={key} className={styles.gap}>
      {m.downstream_into({ from, to }, { locale })}
      {state !== undefined && ` (${state})`}
    </li>
  );
  const first = exit.mouth.waterbody_id;
  return (
    <>
      {line(exit.mouth.id, names.river(exit.mouth.river_id), names.body(first), names.level(first))}
      {exit.outflows.map((o) => line(`${o.from}>${o.to}`, names.body(o.from), names.body(o.to), names.level(o.to)))}
    </>
  );
}

function BranchView({
  branch,
  names,
  rows,
  locale,
  onOpen,
}: {
  branch: Branch;
  names: Names;
  rows: (b: Branch) => StationRow[];
  locale: Locale;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className={styles.list}>
      {rows(branch).map((row) => (
        <Row key={row.key} row={row} locale={locale} onOpen={onOpen} />
      ))}
      {branch.end.kind === 'mouth' && <Exits exit={branch.end} names={names} locale={locale} />}
      {branch.end.kind === 'end' && <li className={styles.gap}>{m.downstream_end({}, { locale })}</li>}
      {branch.children.map((c) => (
        <li key={`${c.riverId}@${c.at}@${c.rows[0]?.ids[0] ?? ''}`}>
          <details className={styles.group}>
            <summary>
              {m.downstream_branch({ river: names.river(c.riverId), count: String(c.rows.length) }, { locale })}
            </summary>
            <BranchView branch={c} names={names} rows={rows} locale={locale} onOpen={onOpen} />
          </details>
        </li>
      ))}
    </ul>
  );
}

export function DownstreamChain({
  locale,
  station,
  stations,
  states,
  values,
  forecasts,
  ownerSources,
  onOpen,
  played,
}: DownstreamChainProps) {
  const graph = useReachGraph().data;
  const rivers: readonly WebRiver[] | undefined = useRivers().data?.rivers;
  const bodiesData: readonly WebWaterbody[] | undefined = useWaterbodies().data;
  const mouths = useMouths().data;
  const walk: Downstream | undefined = useMemo(
    () =>
      graph === undefined
        ? undefined
        : downstream(graph, mouths ?? [], bodiesData ?? [], station.id, new Set(stations.map((s) => s.id))),
    [graph, mouths, bodiesData, station.id, stations],
  );
  const levels = useMemo(
    () => lakeLevels(bodiesData ?? [], lakeGauges(stations, values, forecasts)),
    [bodiesData, stations, values, forecasts],
  );
  if (walk === undefined || walk.branches.length === 0) return null;
  const riverById = new Map((rivers ?? []).map((r) => [r.id, r]));
  const bodyById = new Map((bodiesData ?? []).map((b) => [b.id, b]));
  const names: Names = {
    river: (id) => {
      const r = riverById.get(id);
      return riverName(id, locale) ?? (r === undefined ? id : locale === 'nl' ? r.name_nl : r.name_en);
    },
    body: (id) => {
      const b = bodyById.get(id);
      return b === undefined ? id : locale === 'nl' ? b.name_nl : b.name_en;
    },
    level: (id) => {
      const level = levels.get(id)?.level;
      return level == null ? undefined : stateWord(LADDER[level] ?? 'no_ref', locale);
    },
  };
  const ctx = {
    locale,
    targetId: station.id,
    stations: new Map(stations.map((s) => [s.id, s])),
    rivers: riverById,
    states,
    values,
    ownerSources,
    travel: NO_TRAVEL,
    played,
  };
  // The branch's rows are all station rows (no gaps or groups in a downstream walk).
  const rows = (b: Branch) => chainRows(b.rows, ctx).filter((r): r is StationRow => r.kind === 'station');
  const headingId = `${station.id}-downstream`;
  return (
    <section className={styles.chain} aria-labelledby={headingId}>
      <h3 id={headingId}>{m.downstream_heading({}, { locale })}</h3>
      {walk.branches.map((b) => (
        <BranchView key={b.riverId} branch={b} names={names} rows={rows} locale={locale} onOpen={onOpen} />
      ))}
      {walk.exits.length > 0 && (
        <>
          <p className={styles.note}>{m.downstream_delta({}, { locale })}</p>
          <ul className={styles.list}>
            {walk.exits.map((e) => (
              <Exits key={e.mouth.id} exit={e} names={names} locale={locale} />
            ))}
          </ul>
        </>
      )}
      <p className={styles.note}>{m.downstream_note({}, { locale })}</p>
    </section>
  );
}
