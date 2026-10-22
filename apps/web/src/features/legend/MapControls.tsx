import { type KeyboardEvent, useRef } from 'react';
import { type Group, LAYER_GROUPS, type Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './legend.module.css';
import { ModeControl, modeLabel } from './ModeControl.tsx';

// The mode and the view (P10e D5): two collapsed disclosures over the top-left corner of the view, styled as the
// legend. The summary says the current choice; inside are the native radios of the mode (name "map-mode") and the
// Kaart/Tabel buttons. A choice closes its disclosure and returns the focus to the summary, except a choice made
// with the arrow keys, which only moves through the radios (the disclosure closes on Enter, Space or a click).
// P19a (O-3): the mode disclosure also holds the layer checkboxes (rivers, lakes, coast and sea; `?hide=`). They sit
// there, not in the view disclosure, because they are a map choice like the mode and exist only on the map (the
// view disclosure appears where WebGL runs, and the fieldset only while the map is the view). A tick never closes the
// disclosure: the choices are several, and the map behind it shows the effect.

export type View = 'map' | 'table';

export interface MapControlsProps {
  locale: Locale;
  mode: Mode;
  onMode: (mode: Mode) => void;
  view: View;
  onView: (view: View) => void;
  /** The view choice exists only where the map can run. */
  canMap: boolean;
  /** P19a (O-3): the hidden layer groups (`?hide=`). */
  hide: readonly Group[];
  /** P19a: a layer checkbox changed: the new hidden groups (written to `?hide=`). */
  onHide: (next: readonly Group[]) => void;
}

const layerWord = { rivers: m.layer_rivers, lakes: m.layer_lakes, coast: m.layer_coast } as const;

export function MapControls({ locale, mode, onMode, view, onView, canMap, hide, onHide }: MapControlsProps) {
  const o = { locale };
  const modeBox = useRef<HTMLDetailsElement>(null);
  const viewBox = useRef<HTMLDetailsElement>(null);
  const arrowed = useRef(false);
  const done = (box: HTMLDetailsElement | null) => {
    if (box === null || arrowed.current) return;
    box.open = false;
    box.querySelector('summary')?.focus();
  };
  const track = (e: KeyboardEvent<HTMLElement>) => {
    arrowed.current = e.key.startsWith('Arrow');
  };
  // Escape closes an open disclosure and the focus goes back to its summary.
  const closeOnEscape = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key !== 'Escape' || !e.currentTarget.open) return;
    e.preventDefault();
    e.currentTarget.open = false;
    e.currentTarget.querySelector('summary')?.focus();
  };
  const common = {
    onKeyDown: (e: KeyboardEvent<HTMLDetailsElement>) => {
      track(e);
      closeOnEscape(e);
    },
    onPointerDown: () => {
      arrowed.current = false;
    },
  };
  return (
    <div className={styles.controlRow}>
      <details
        ref={modeBox}
        className={styles.control}
        {...common}
        onToggle={(e) => e.currentTarget.open && viewBox.current?.removeAttribute('open')}
      >
        <summary>{m.mode_summary({ mode: modeLabel(mode, locale) }, o)}</summary>
        <div className={styles.menu}>
          <ModeControl
            locale={locale}
            mode={mode}
            onChange={(next) => {
              onMode(next);
              done(modeBox.current);
            }}
          />
          {canMap && view === 'map' && (
            <fieldset className={styles.layers}>
              <legend>{m.layer_legend({}, o)}</legend>
              {LAYER_GROUPS.map((g) => (
                <label key={g}>
                  <input
                    type="checkbox"
                    checked={!hide.includes(g)}
                    onChange={(e) => {
                      const visible = e.currentTarget.checked;
                      onHide(LAYER_GROUPS.filter((x) => (x === g ? !visible : hide.includes(x))));
                    }}
                  />
                  {layerWord[g]({}, o)}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </details>
      {canMap && (
        <details
          ref={viewBox}
          className={styles.control}
          {...common}
          onToggle={(e) => e.currentTarget.open && modeBox.current?.removeAttribute('open')}
        >
          <summary>{m.view_summary({ view: view === 'map' ? m.view_map({}, o) : m.view_table({}, o) }, o)}</summary>
          <div className={styles.menu}>
            <fieldset className={styles.view}>
              <legend>{m.view_label({}, o)}</legend>
              {(['map', 'table'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => {
                    onView(v);
                    done(viewBox.current);
                  }}
                >
                  {v === 'map' ? m.view_map({}, o) : m.view_table({}, o)}
                </button>
              ))}
            </fieldset>
          </div>
        </details>
      )}
    </div>
  );
}
