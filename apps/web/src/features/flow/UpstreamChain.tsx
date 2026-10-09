import type { ApiStation, Snapshot } from '@rws/contracts';
import { useMemo } from 'react';
import { useReachGraph, useReachTravel, useRivers } from '../../lib/data/api.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { coLocated } from '../station/neighbours.ts';
import styles from './chain.module.css';
import { chain } from './chain.ts';
import { type ChainRow, chainRows, type StationRow } from './rows.ts';

// "Stroomopwaarts / Upstream" (P11a, issue #26): the upstream chain of the open station in its panel, after the
// nearby stations. A lazy chunk of StationPanel. It reads the graph, the rivers and the travel times itself
// (useReachGraph, useRivers, useReachTravel). Names, rivers, bases and sources are provider text: React text nodes
// only, and a link only when the row carries an https href (rows.ts: httpsHref). A row is a select button with the
// state and the travel text beside it, never inside it, so no interactive content nests. A tributary is a native
// <details>, collapsed.

export interface UpstreamChainProps {
  locale: Locale;
  station: ApiStation;
  /** Every station of the site (stations.json, audience-filtered): names, series and the `known` set. */
  stations: readonly ApiStation[];
  /** The feature-state record of every station at t. */
  states: ReadonlyMap<string, StationState>;
  values: ReadonlyMap<number, Snapshot['values'][number]>;
  /** Owner-audience source ids (empty on the public site). */
  ownerSources: ReadonlySet<string>;
  /** Open another station. */
  onSelect: (id: string) => void;
}

const NO_TRAVEL = { travel_times: [] };

function Station({ row, locale, onSelect }: { row: StationRow; locale: Locale; onSelect: (id: string) => void }) {
  return (
    <li className={styles.station}>
      <button type="button" className={styles.select} onClick={() => onSelect(row.id)}>
        <span>{row.name}</span>
        <span className={styles.muted}>{row.river}</span>
      </button>
      <div className={styles.meta}>
        <span>
          {row.state ?? m.legend_no_value({}, { locale })}
          {row.section && ` ${m.section_marker({}, { locale })}`}
          {row.owner && (
            <>
              {' '}
              <OwnerBadge locale={locale} />
            </>
          )}
        </span>
        {row.basis !== null && <span className={styles.muted}>{row.basis}</span>}
        <span>{m.chain_travel({ text: row.travel }, { locale })}</span>
        {row.travelBasis !== null && <span className={styles.muted}>{row.travelBasis}</span>}
        {row.source !== null && (
          <span className={styles.muted}>
            {row.href === undefined ? (
              row.source
            ) : (
              <a href={row.href} rel="noopener noreferrer">
                {row.source}
              </a>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

function Rows({
  rows,
  locale,
  onSelect,
}: {
  rows: readonly ChainRow[];
  locale: Locale;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className={styles.list}>
      {rows.map((row) =>
        row.kind === 'station' ? (
          <Station key={row.key} row={row} locale={locale} onSelect={onSelect} />
        ) : row.kind === 'gap' ? (
          <li key={row.key} className={styles.gap}>
            {row.text}
          </li>
        ) : (
          <li key={row.key}>
            <details className={styles.group}>
              <summary>{row.summary}</summary>
              <Rows rows={row.children} locale={locale} onSelect={onSelect} />
            </details>
          </li>
        ),
      )}
    </ul>
  );
}

export function UpstreamChain({
  locale,
  station,
  stations,
  states,
  values,
  ownerSources,
  onSelect,
}: UpstreamChainProps) {
  const graph = useReachGraph().data;
  const rivers = useRivers().data?.rivers;
  const travel = useReachTravel().data;
  // The walk once per graph and station; the texts again when t moves (states, values).
  const walk = useMemo(() => {
    if (graph === undefined) return undefined;
    const target = graph.stations.find((s) => s.id === station.id);
    return {
      nodes: chain(graph, rivers ?? [], station.id, new Set(stations.map((s) => s.id))),
      targetIds: graph.stations.filter((s) => s.id === station.id || coLocated(target, s)).map((s) => s.id),
    };
  }, [graph, rivers, station.id, stations]);
  const rows = useMemo(
    () =>
      walk === undefined
        ? []
        : chainRows(walk.nodes, {
            locale,
            targetId: station.id,
            targetIds: walk.targetIds,
            stations: new Map(stations.map((s) => [s.id, s])),
            rivers: new Map((rivers ?? []).map((r) => [r.id, r])),
            states,
            values,
            ownerSources,
            travel: travel ?? NO_TRAVEL,
          }),
    [walk, rivers, travel, station.id, stations, states, values, ownerSources, locale],
  );
  if (rows.length === 0) return null;
  const headingId = `${station.id}-chain`;
  return (
    <section className={styles.chain} aria-labelledby={headingId}>
      <h3 id={headingId}>{m.chain_heading({}, { locale })}</h3>
      <Rows rows={rows} locale={locale} onSelect={onSelect} />
      <p className={styles.note}>{m.chain_note({}, { locale })}</p>
    </section>
  );
}
