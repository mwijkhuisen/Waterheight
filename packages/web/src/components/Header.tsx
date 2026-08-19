/**
 * The masthead: brand mark, global search, primary nav.
 *
 * Search lives in the header on every page rather than in a per-page sidebar,
 * because the site is search-first: the fastest path to any location is to
 * type its name from wherever you happen to be.
 */

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Location } from '@rws/shared';
import { fetchLocations } from '../api.js';
import { useDebounced } from '../hooks.js';
import { formatAge } from '../freshness.js';
import { Link, locationPath, navigate, searchPath, useQueryParams, useRoute } from '../router.js';

const SUGGEST_DEBOUNCE_MS = 180;
const MAX_SUGGESTIONS = 7;

export function Header() {
  const route = useRoute();
  const params = useQueryParams();
  const urlQuery = params.get('q') ?? '';

  const [query, setQuery] = useState(urlQuery);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [suggestions, setSuggestions] = useState<Location[]>([]);
  const debounced = useDebounced(query, SUGGEST_DEBOUNCE_MS);
  const listId = useId();
  const formRef = useRef<HTMLFormElement | null>(null);

  // Follow the URL when navigation changes it (back button, a chip link, a
  // fresh search page), but never fight the user mid-keystroke.
  useEffect(() => { setQuery(urlQuery); }, [urlQuery, route.path]);

  useEffect(() => {
    const term = debounced.trim();
    if (term.length < 2) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    fetchLocations({ q: term }, controller.signal)
      .then((results) => {
        if (controller.signal.aborted) return;
        setSuggestions(results.slice(0, MAX_SUGGESTIONS));
        setHighlight(-1);
      })
      // A failed suggestion lookup is silent: the form still submits, and the
      // search page will surface the real error.
      .catch(() => { if (!controller.signal.aborted) setSuggestions([]); });

    return () => controller.abort();
  }, [debounced]);

  // Close the dropdown on an outside click, the way a native combobox would.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setOpen(false);
    const chosen = highlight >= 0 ? suggestions[highlight] : null;
    if (chosen) navigate(locationPath(chosen.code));
    else navigate(searchPath({ q: query.trim() || null }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (suggestions.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((current) => {
        const next = current + step;
        if (next < -1) return suggestions.length - 1;
        if (next >= suggestions.length) return -1;
        return next;
      });
    }
  }

  const showList = open && suggestions.length > 0;

  return (
    <header className="masthead">
      <div className="masthead__inner">
        <Link className="masthead__brand" to="/" aria-label="rws home">
          <span className="masthead__mark" aria-hidden="true">rws</span>
          <span className="masthead__wordmark">monitoring</span>
        </Link>

        <form className="searchbar" role="search" onSubmit={submit} ref={formRef}>
          <input
            className="searchbar__input"
            type="text"
            name="q"
            value={query}
            placeholder="Search measurement locations"
            aria-label="Search measurement locations"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <button className="searchbar__submit" type="submit">Search</button>

          {showList && (
            <ul className="suggestions" id={listId} role="listbox" aria-label="Matching locations">
              {suggestions.map((location, index) => (
                <li key={location.code} role="presentation">
                  <Link
                    className={`suggestions__item${index === highlight ? ' suggestions__item--active' : ''}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                    to={locationPath(location.code)}
                    onClick={() => setOpen(false)}
                    onMouseEnter={() => setHighlight(index)}
                  >
                    <span className="suggestions__name">{location.name}</span>
                    <span className="suggestions__meta">
                      {location.code} · {formatAge(location.lastSeenAt)}
                    </span>
                  </Link>
                </li>
              ))}
              <li role="presentation">
                <Link
                  className="suggestions__all"
                  to={searchPath({ q: query.trim() || null })}
                  onClick={() => setOpen(false)}
                >
                  See all results for “{query.trim()}”
                </Link>
              </li>
            </ul>
          )}
        </form>

        <nav className="masthead__nav" aria-label="Primary">
          <Link className={navClass(route.path, '/map')} to="/map">Map</Link>
          <Link className={navClass(route.path, '/docs')} to="/docs">Docs</Link>
          <a
            className="masthead__link"
            href="https://waterinfo.rws.nl/"
            target="_blank"
            rel="noreferrer noopener"
          >
            Waterinfo ↗
          </a>
        </nav>
      </div>
    </header>
  );
}

function navClass(current: string, target: string): string {
  return `masthead__link${current === target ? ' masthead__link--active' : ''}`;
}
