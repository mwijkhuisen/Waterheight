import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { matchStations, type Searchable } from '../../lib/stationSearch.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './search.module.css';

// The station search (P10e D6): a magnifier in the top bar that opens a field; an ARIA 1.2 combobox with a
// listbox (arrows, Enter, Escape). The typed text only filters the list in memory: it never reaches the URL, a
// request or an HTML sink, and a station's name is a text node. Only the chosen registry id leaves through `onPick`.

export interface StationSearchProps<T extends Searchable> {
  locale: Locale;
  stations: readonly T[];
  onPick: (id: string) => void;
  /** The magnifier: the focus returns to it when the field closes by Escape, or a panel closes without an opener. */
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function StationSearch<T extends Searchable>({ locale, stations, onPick, buttonRef }: StationSearchProps<T>) {
  const o = { locale };
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => matchStations(stations, query), [stations, query]);
  const current = results[Math.min(active, results.length - 1)];
  // The field exists once it is open: the focus goes into it.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const optionId = (stationId: string) => `${id}-o-${stationId}`;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    if (restoreFocus) buttonRef.current?.focus();
  };
  const pick = (stationId: string) => {
    close(false);
    onPick(stationId);
  };
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    }
  };
  const inputKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (Math.min(a, results.length - 1) + step + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current !== undefined) pick(current.id);
    }
  };
  // Focus leaving the whole control (a click elsewhere, Tab past it) closes it without moving the focus again.
  const leave = (e: FocusEvent<HTMLElement>) => {
    if (open && !e.currentTarget.contains(e.relatedTarget)) close(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the control closes it
    <div className={styles.root} onKeyDown={keys} onBlur={leave}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.button}
        aria-label={m.search_open({}, o)}
        aria-expanded={open}
        aria-controls={open ? `${id}-p` : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M13 13l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div id={`${id}-p`} className={styles.panel}>
          <input
            ref={input}
            type="text"
            role="combobox"
            className={styles.input}
            aria-label={m.search_open({}, o)}
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={results.length > 0 ? `${id}-l` : undefined}
            aria-activedescendant={current === undefined ? undefined : optionId(current.id)}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={inputKeys}
          />
          {results.length > 0 && (
            <div id={`${id}-l`} role="listbox" aria-label={m.search_open({}, o)} className={styles.list}>
              {results.map((st) => (
                // The options are never focused (the input keeps the focus and names the active one), so the
                // key handler only mirrors the click.
                <div
                  key={st.id}
                  id={optionId(st.id)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={st.id === current?.id}
                  className={st.id === current?.id ? `${styles.option} ${styles.active}` : styles.option}
                  // Keep the input focused through the click, or its blur would close the list before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(st.id)}
                  onKeyDown={(e) => e.key === 'Enter' && pick(st.id)}
                >
                  {st.waterName === null ? st.name : `${st.name} (${st.waterName})`}
                </div>
              ))}
            </div>
          )}
          {/* The result count (or its absence) is said, not only shown. */}
          <p role="status" className={styles.hidden}>
            {results.length > 0 ? m.search_count({ count: results.length }, o) : ''}
          </p>
          {query.trim() !== '' && results.length === 0 && (
            <p role="status" className={styles.none}>
              {m.search_none({}, o)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
