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

export function ModeControl({ locale, mode, onChange }: ModeControlProps) {
  const o = { locale };
  const items: [Mode, string][] = [
    ['state', m.mode_state({}, o)],
    ['delta', m.mode_delta({}, o)],
    ['q', m.mode_q({}, o)],
  ];
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
