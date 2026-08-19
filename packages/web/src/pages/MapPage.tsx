/**
 * The map view.
 *
 * Kept as a full-bleed page rather than the shell of the site: it is the right
 * tool for "what is near here", while search is the right tool for "where is
 * X". Selecting a marker opens a card that links into the location page, so
 * the map feeds the same detail pages as every other route.
 */

import { useMemo, useState } from 'react';
import type { Location } from '@rws/shared';
import { useCatalogue, useDocumentTitle, useLocations } from '../hooks.js';
import { FRESHNESS_COLOR, FRESHNESS_LABEL, formatAge, freshnessOf } from '../freshness.js';
import { formatCount, plural } from '../format.js';
import { Link, locationPath, useQueryParams, useSetQueryParams } from '../router.js';
import { LazyMapView } from '../components/LazyMap.js';
import { Notice } from '../components/ui.js';

export function MapPage() {
  const params = useQueryParams();
  const setParams = useSetQueryParams();

  const grootheid = params.get('grootheid');
  const compartiment = params.get('compartiment');

  const catalogue = useCatalogue();
  const { data, loading, error } = useLocations({
    grootheid: grootheid ?? undefined,
    compartiment: compartiment ?? undefined,
  });

  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  useDocumentTitle('Map - rws');

  const locations = useMemo(() => data ?? [], [data]);
  const selected = useMemo(
    () => locations.find((l) => l.code === selectedCode) ?? null,
    [locations, selectedCode],
  );

  function update(key: string, value: string | null): void {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
    setSelectedCode(null);
  }

  return (
    <div className="mappage">
      <div className="mappage__bar">
        <div className="mappage__filters">
          <label className="mappage__field">
            <span>Measurement type</span>
            <select
              className="field__input"
              value={grootheid ?? ''}
              onChange={(event) => update('grootheid', event.target.value || null)}
            >
              <option value="">All types</option>
              {(catalogue.data?.quantities ?? []).map((quantity) => (
                <option key={quantity.code} value={quantity.code}>
                  {quantity.label ?? quantity.code} ({formatCount(quantity.activeLocations)})
                </option>
              ))}
            </select>
          </label>

          <label className="mappage__field">
            <span>Compartment</span>
            <select
              className="field__input"
              value={compartiment ?? ''}
              onChange={(event) => update('compartiment', event.target.value || null)}
            >
              <option value="">All compartments</option>
              {(catalogue.data?.compartments ?? []).map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label ?? entry.code} ({formatCount(entry.activeLocations)})
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="mappage__count" aria-live="polite">
          {loading && !data ? 'Loading…' : plural(locations.length, 'location')}
        </p>

        <ul className="mappage__legend">
          {(['fresh', 'delayed'] as const).map((state) => (
            <li key={state}>
              <span
                className="freshness__dot"
                style={{ background: FRESHNESS_COLOR[state] }}
                aria-hidden="true"
              />
              {FRESHNESS_LABEL[state]}
            </li>
          ))}
        </ul>
      </div>

      <div className="mappage__canvas">
        {error ? (
          <div className="mappage__error"><Notice tone="error" role="alert">{error}</Notice></div>
        ) : (
          <LazyMapView
            locations={locations}
            selectedCode={selectedCode}
            onSelect={setSelectedCode}
            flyTo={null}
          />
        )}

        {selected && <SelectionCard location={selected} onClose={() => setSelectedCode(null)} />}
      </div>
    </div>
  );
}

function SelectionCard({ location, onClose }: { location: Location; onClose: () => void }) {
  const state = freshnessOf(location.lastSeenAt);

  return (
    <article className="mapcard">
      <button type="button" className="mapcard__close" onClick={onClose} aria-label="Close">×</button>
      <h2 className="mapcard__name">{location.name}</h2>
      <p className="mapcard__code">{location.code}</p>
      <p className="mapcard__meta">
        <span className="freshness__dot" style={{ background: FRESHNESS_COLOR[state] }} aria-hidden="true" />
        published {formatAge(location.lastSeenAt)}
        <span className="row__sep" aria-hidden="true">·</span>
        {plural(location.quantities.length, 'type')}
      </p>
      <Link className="mapcard__link" to={locationPath(location.code)}>
        View location →
      </Link>
    </article>
  );
}
