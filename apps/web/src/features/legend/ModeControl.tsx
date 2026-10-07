import type { Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './legend.module.css';

// The map mode (P10a T9): three native radios.

export interface ModeControlProps {
  locale: Locale;
  mode: Mode;
  onChange: (mode: Mode) => void;
}

/** The name of a mode in a language: the radio's label and the summary of the mode disclosure. */
export function modeLabel(mode: Mode, locale: Locale): string {
  const o = { locale };
  return mode === 'state' ? m.mode_state({}, o) : mode === 'delta' ? m.mode_delta({}, o) : m.mode_q({}, o);
}

export function ModeControl({ locale, mode, onChange }: ModeControlProps) {
  const o = { locale };
  const items: [Mode, string][] = (['state', 'delta', 'q'] as const).map((value) => [value, modeLabel(value, locale)]);
  return (
    <fieldset className={styles.mode}>
      <legend>{m.mode_label({}, o)}</legend>
      {items.map(([value, label]) => (
        <label key={value}>
          <input type="radio" name="map-mode" value={value} checked={mode === value} onChange={() => onChange(value)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
