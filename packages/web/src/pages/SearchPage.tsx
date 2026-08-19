/**
 * Search results -- the registry's browse surface.
 *
 * All state lives in the query string (?q, ?grootheid, ?compartiment, ?sort)
 * so any result set is a shareable URL, and the back button walks filters
 * rather than dumping you back at the home page.
 */

import { useMemo } from 'react';
import type { Location } from '@rws/shared';
import { useCatalogue, useDocumentTitle, useLocations } from '../hooks.js';
import { formatCount, plural } from '../format.js';
import { Link, searchPath, useQueryParams, useSetQueryParams } from '../router.js';
import { LocationRow, quantityLabels } from '../components/LocationRow.js';
import { Notice, Skeleton } from '../components/ui.js';

/** Enough rows to scan without an endless page; the map holds the whole set. */
const PAGE_SIZE = 25;

type SortId = 'optimal' | 'recent' | 'types' | 'name';

const SORTS: { id: SortId; label: string; hint: string }[] = [
  { id: 'optimal', label: 'Optimal', hint: 'Reporting stations first, then by name' },
  { id: 'recent', label: 'Recently updated', hint: 'Most recent measurement first' },
  { id: 'types', label: 'Most measured', hint: 'Widest range of measurement types' },
  { id: 'name', label: 'Name', hint: 'Alphabetical' },
];

function sortLocations(locations: Location[], sort: SortId): Location[] {
  const byName = (a: Location, b: Location) => a.name.localeCompare(b.name, 'nl');
  const seen = (l: Location) => (l.lastSeenAt ? Date.parse(l.lastSeenAt) : 0);

  const copy = [...locations];
  switch (sort) {
    case 'recent':
      return copy.sort((a, b) => seen(b) - seen(a));
    case 'types':
      return copy.sort((a, b) => b.quantities.length - a.quantities.length || byName(a, b));
    case 'name':
      return copy.sort(byName);
    case 'optimal':
    default:
      // The API already returns matches in relevance order for a text query;
      // "optimal" only lifts stations that are actually keeping up, so a stale
      // station never outranks a live one at the same relevance.
      return copy.sort((a, b) => (seen(b) > 0 ? 1 : 0) - (seen(a) > 0 ? 1 : 0));
  }
}

export function SearchPage() {
  const params = useQueryParams();
  const setParams = useSetQueryParams();

  const q = params.get('q') ?? '';
  const grootheid = params.get('grootheid');
  const compartiment = params.get('compartiment');
  const sort = (params.get('sort') as SortId | null) ?? 'optimal';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const catalogue = useCatalogue();
  const { data, loading, error } = useLocations({
    q: q.trim() || undefined,
    grootheid: grootheid ?? undefined,
    compartiment: compartiment ?? undefined,
  });

  useDocumentTitle(q ? `${q} - rws search` : 'Search locations - rws');

  const labels = useMemo(
    () => quantityLabels(catalogue.data?.quantities ?? []),
    [catalogue.data],
  );

  const sorted = useMemo(() => sortLocations(data ?? [], sort), [data, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount);
  const visible = sorted.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  function update(key: string, value: string | null): void {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any change to the result set invalidates the page cursor.
    if (key !== 'page') next.delete('page');
    setParams(next, key === 'page' ? 'push' : 'replace');
  }

  const hasFilters = Boolean(q || grootheid || compartiment);

  return (
    <div className="page page--split">
      <div className="page__main">
        <h1 className="search__summary">
          {loading && !data
            ? 'Searching…'
            : error
              ? 'Search unavailable'
              : `${formatCount(sorted.length)} location${sorted.length === 1 ? '' : 's'} found`}
          {q && !error && <> for <span className="search__term">{q}</span></>}
        </h1>

        {hasFilters && (
          <p className="search__active">
            {grootheid && (
              <FilterTag label={labels.get(grootheid) ?? grootheid} onRemove={() => update('grootheid', null)} />
            )}
            {compartiment && (
              <FilterTag label={compartimentLabel(catalogue, compartiment)} onRemove={() => update('compartiment', null)} />
            )}
            <Link className="search__clear" to="/search">Clear all</Link>
          </p>
        )}

        {error && <Notice tone="error" role="alert">{error}</Notice>}

        {loading && !data && (
          <div className="search__results">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="block" />)}
          </div>
        )}

        {!error && data && sorted.length === 0 && (
          <Notice>
            No locations match this search. Try a shorter term, or{' '}
            <Link to="/search">browse every location</Link>.
          </Notice>
        )}

        {!error && visible.length > 0 && (
          <div className={`search__results${loading ? ' search__results--stale' : ''}`}>
            {visible.map((location) => (
              <LocationRow key={location.code} location={location} labels={labels} />
            ))}
          </div>
        )}

        {pageCount > 1 && (
          <nav className="pager" aria-label="Pagination">
            <button
              type="button"
              className="pager__button"
              disabled={clampedPage <= 1}
              onClick={() => update('page', String(clampedPage - 1))}
            >
              ← Previous
            </button>
            <span className="pager__status">Page {clampedPage} of {formatCount(pageCount)}</span>
            <button
              type="button"
              className="pager__button"
              disabled={clampedPage >= pageCount}
              onClick={() => update('page', String(clampedPage + 1))}
            >
              Next →
            </button>
          </nav>
        )}
      </div>

      <aside className="page__aside" aria-label="Refine results">
        <div className="facet">
          <h2 className="facet__title">Sort locations</h2>
          <ul className="facet__list">
            {SORTS.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className={`facet__option${option.id === sort ? ' facet__option--active' : ''}`}
                  aria-pressed={option.id === sort}
                  onClick={() => update('sort', option.id === 'optimal' ? null : option.id)}
                >
                  <span className="facet__label">{option.label}</span>
                  <span className="facet__hint">{option.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="facet">
          <h2 className="facet__title">Measurement type</h2>
          <ul className="facet__list facet__list--scroll">
            <li>
              <button
                type="button"
                className={`facet__option${!grootheid ? ' facet__option--active' : ''}`}
                onClick={() => update('grootheid', null)}
              >
                <span className="facet__label">All types</span>
              </button>
            </li>
            {(catalogue.data?.quantities ?? []).map((quantity) => (
              <li key={quantity.code}>
                <button
                  type="button"
                  className={`facet__option${quantity.code === grootheid ? ' facet__option--active' : ''}`}
                  onClick={() => update('grootheid', quantity.code)}
                >
                  <span className="facet__label">{quantity.label ?? quantity.code}</span>
                  <span className="facet__count">{formatCount(quantity.activeLocations)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="facet">
          <h2 className="facet__title">Compartment</h2>
          <ul className="facet__list">
            <li>
              <button
                type="button"
                className={`facet__option${!compartiment ? ' facet__option--active' : ''}`}
                onClick={() => update('compartiment', null)}
              >
                <span className="facet__label">All compartments</span>
              </button>
            </li>
            {(catalogue.data?.compartments ?? []).map((entry) => (
              <li key={entry.code}>
                <button
                  type="button"
                  className={`facet__option${entry.code === compartiment ? ' facet__option--active' : ''}`}
                  onClick={() => update('compartiment', entry.code)}
                >
                  <span className="facet__label">{entry.label ?? entry.code}</span>
                  <span className="facet__count">{formatCount(entry.activeLocations)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {data && (
          <p className="facet__note">
            Showing {plural(visible.length, 'location')} of {formatCount(sorted.length)}.
            The <Link to="/map">map</Link> plots all of them at once.
          </p>
        )}
      </aside>
    </div>
  );
}

function FilterTag({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="filter-tag">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label} filter`}>×</button>
    </span>
  );
}

function compartimentLabel(
  catalogue: ReturnType<typeof useCatalogue>,
  code: string,
): string {
  return catalogue.data?.compartments.find((c) => c.code === code)?.label ?? code;
}
