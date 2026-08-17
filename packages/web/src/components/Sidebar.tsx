/**
 * Filters and search.
 *
 * There is deliberately no "has data" toggle: every location on the map is
 * active by definition, so such a filter would be a no-op that implies the
 * map might be showing dead stations.
 */

import type { CompartmentInfo, Location, QuantityInfo } from '@rws/shared';
import { FRESHNESS_COLOR, FRESHNESS_LABEL, formatAge, freshnessOf } from '../freshness.js';

export interface SidebarProps {
  quantities: QuantityInfo[];
  compartments: CompartmentInfo[];
  selectedQuantity: string | null;
  selectedCompartment: string | null;
  search: string;
  locations: Location[];
  loading: boolean;
  error: string | null;
  onQuantityChange: (code: string | null) => void;
  onCompartmentChange: (code: string | null) => void;
  onSearchChange: (value: string) => void;
  onSelect: (location: Location) => void;
  selectedCode: string | null;
}

export function Sidebar(props: SidebarProps) {
  const {
    quantities, compartments, selectedQuantity, selectedCompartment,
    search, locations, loading, error, selectedCode,
  } = props;

  const filtered = selectedQuantity
    ? quantities.filter((q) => q.code === selectedQuantity)
    : quantities;

  // Only offer compartments that can still yield results under the current
  // quantity, so the two filters cannot be combined into an empty map.
  const availableCompartments = selectedQuantity
    ? compartments.filter((c) => filtered.some((q) => q.compartments.includes(c.code)))
    : compartments;

  return (
    <aside className="sidebar" aria-label="Filters and search">
      <header className="sidebar__header">
        <h1 className="sidebar__title">Rijkswaterstaat monitoring</h1>
        <p className="sidebar__subtitle">
          {loading
            ? 'Loading measurement locations…'
            : `${locations.length.toLocaleString('en-GB')} active location${locations.length === 1 ? '' : 's'}`}
        </p>
      </header>

      <div className="field">
        <label className="field__label" htmlFor="search">Search locations</label>
        <input
          id="search"
          className="field__input"
          type="search"
          placeholder="e.g. Vlissingen"
          value={search}
          autoComplete="off"
          onChange={(e) => props.onSearchChange(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="quantity">Measurement type</label>
        <select
          id="quantity"
          className="field__input"
          value={selectedQuantity ?? ''}
          onChange={(e) => props.onQuantityChange(e.target.value || null)}
        >
          <option value="">All measurement types</option>
          {quantities.map((q) => (
            <option key={q.code} value={q.code}>
              {q.label ?? q.code} ({q.activeLocations})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="compartment">Compartment</label>
        <select
          id="compartment"
          className="field__input"
          value={selectedCompartment ?? ''}
          onChange={(e) => props.onCompartmentChange(e.target.value || null)}
        >
          <option value="">All compartments</option>
          {availableCompartments.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label ?? c.code} ({c.activeLocations})
            </option>
          ))}
        </select>
      </div>

      {(selectedQuantity || selectedCompartment || search) && (
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            props.onQuantityChange(null);
            props.onCompartmentChange(null);
            props.onSearchChange('');
          }}
        >
          Clear filters
        </button>
      )}

      <Legend />

      <div className="results" aria-live="polite">
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        {loading && !error && <ResultsSkeleton />}

        {!loading && !error && locations.length === 0 && (
          <p className="notice">
            No locations match these filters. Try clearing the search or choosing
            a different measurement type.
          </p>
        )}

        {!loading && !error && locations.length > 0 && (
          <ul className="results__list">
            {locations.slice(0, 200).map((location) => {
              const state = freshnessOf(location.lastSeenAt);
              return (
                <li key={location.code}>
                  <button
                    type="button"
                    className={`result${location.code === selectedCode ? ' result--selected' : ''}`}
                    onClick={() => props.onSelect(location)}
                  >
                    <span
                      className="result__dot"
                      style={{ background: FRESHNESS_COLOR[state] }}
                      aria-hidden="true"
                    />
                    <span className="result__text">
                      <span className="result__name">{location.name}</span>
                      {/* The age is spelled out, so state never rests on colour. */}
                      <span className="result__meta">
                        {location.quantities.length} type
                        {location.quantities.length === 1 ? '' : 's'}
                        {' · '}
                        {formatAge(location.lastSeenAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {locations.length > 200 && (
              <li className="results__more">
                Showing the first 200 of {locations.length.toLocaleString('en-GB')}.
                All of them are on the map — zoom in or search to narrow it down.
              </li>
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}

function Legend() {
  return (
    <div className="legend">
      <h2 className="legend__title">Marker colour</h2>
      {/* Colour encodes freshness, not value: values across quantities share
          no scale, so colouring by value would imply a comparison that does
          not exist. */}
      <ul className="legend__list">
        {(['fresh', 'delayed'] as const).map((state) => (
          <li key={state} className="legend__item">
            <span
              className="legend__swatch"
              style={{ background: FRESHNESS_COLOR[state] }}
              aria-hidden="true"
            />
            {FRESHNESS_LABEL[state]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <ul className="results__list" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="skeleton skeleton--row" />
      ))}
    </ul>
  );
}
