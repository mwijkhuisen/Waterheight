/**
 * Landing page: one large search box, then routes into the catalogue.
 *
 * The registry pattern is that the home page sells the search and then gets
 * out of the way, so the only content below the hero is the two useful entry
 * points -- browse by what is measured, or jump to what just reported.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { useCatalogue, useDocumentTitle, useLocations } from '../hooks.js';
import { formatCompact, formatCount, plural } from '../format.js';
import { formatAge, freshnessOf } from '../freshness.js';
import { Link, locationPath, navigate, searchPath } from '../router.js';
import { FreshnessTag, Skeleton } from '../components/ui.js';

/** Enough tiles to show the range of the catalogue without a wall of cards. */
const BROWSE_LIMIT = 12;
const RECENT_LIMIT = 8;

export function HomePage() {
  const [query, setQuery] = useState('');
  const catalogue = useCatalogue();
  const { data: locations, loading } = useLocations({});

  useDocumentTitle('rws — Rijkswaterstaat monitoring locations');

  const topQuantities = useMemo(
    () => [...(catalogue.data?.quantities ?? [])]
      .sort((a, b) => b.activeLocations - a.activeLocations)
      .slice(0, BROWSE_LIMIT),
    [catalogue.data],
  );

  const recent = useMemo(
    () => [...(locations ?? [])]
      .filter((l) => l.lastSeenAt !== null)
      .sort((a, b) => Date.parse(b.lastSeenAt!) - Date.parse(a.lastSeenAt!))
      .slice(0, RECENT_LIMIT),
    [locations],
  );

  const totalSeries = useMemo(
    () => (catalogue.data?.quantities ?? []).reduce((sum, q) => sum + q.activeLocations, 0),
    [catalogue.data],
  );

  function submit(event: FormEvent): void {
    event.preventDefault();
    navigate(searchPath({ q: query.trim() || null }));
  }

  return (
    <>
      <section className="hero">
        <div className="hero__inner">
          <h1 className="hero__title">Every measurement, one search away</h1>
          <p className="hero__lede">
            Water levels, discharge, temperature and wind from every active Rijkswaterstaat
            station in the Netherlands — with the full stored history behind each one.
          </p>

          <form className="hero__search" role="search" onSubmit={submit}>
            <input
              className="hero__input"
              type="text"
              value={query}
              placeholder="Search measurement locations"
              aria-label="Search measurement locations"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="hero__submit" type="submit">Search</button>
          </form>

          <p className="hero__examples">
            Try{' '}
            <Link to={searchPath({ q: 'vlissingen' })}>Vlissingen</Link>,{' '}
            <Link to={searchPath({ q: 'hoek van holland' })}>Hoek van Holland</Link>, or{' '}
            <Link to={searchPath({ grootheid: 'WATHTE' })}>all water-level stations</Link>.
          </p>
        </div>
      </section>

      <div className="page">
        <dl className="stats">
          <div className="stats__item">
            <dt>Active locations</dt>
            <dd>{loading && !locations ? '—' : formatCount(locations?.length ?? 0)}</dd>
          </div>
          <div className="stats__item">
            <dt>Measurement types</dt>
            <dd>{catalogue.data ? formatCount(catalogue.data.quantities.length) : '—'}</dd>
          </div>
          <div className="stats__item">
            <dt>Compartments</dt>
            <dd>{catalogue.data ? formatCount(catalogue.data.compartments.length) : '—'}</dd>
          </div>
          <div className="stats__item">
            <dt>Station–type pairs</dt>
            <dd>{catalogue.data ? formatCompact(totalSeries) : '—'}</dd>
          </div>
        </dl>

        <section className="home__section">
          <h2 className="home__heading">
            Browse by measurement type
            <Link className="home__more" to="/search">All locations →</Link>
          </h2>

          {catalogue.loading && (
            <div className="cards">
              {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} variant="row" />)}
            </div>
          )}

          <div className="cards">
            {topQuantities.map((quantity) => (
              <Link key={quantity.code} className="card" to={searchPath({ grootheid: quantity.code })}>
                <span className="card__title">{quantity.label ?? quantity.code}</span>
                <span className="card__code">{quantity.code}</span>
                <span className="card__count">{plural(quantity.activeLocations, 'location')}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="home__section">
          <h2 className="home__heading">
            Recently published
            <Link className="home__more" to={searchPath({ sort: 'recent' })}>See more →</Link>
          </h2>

          {loading && !locations && (
            <div className="cards">
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="row" />)}
            </div>
          )}

          <ul className="recent">
            {recent.map((location) => (
              <li key={location.code}>
                <Link className="recent__item" to={locationPath(location.code)}>
                  <span className="recent__name">{location.name}</span>
                  <span className="recent__code">{location.code}</span>
                  <FreshnessTag
                    state={freshnessOf(location.lastSeenAt)}
                    label={formatAge(location.lastSeenAt)}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
