import { useId, useSyncExternalStore } from 'react';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './toggle.module.css';

// The pause control of the flow animation (P11a, WCAG 2.2.2): "Stroming animeren / Animate flow", a button with
// aria-pressed beside the mode and view disclosures (P10e). Off and inert under prefers-reduced-motion. No URL key.

export interface FlowToggleProps {
  locale: Locale;
  on: boolean;
  onChange: (on: boolean) => void;
}

const REDUCED = '(prefers-reduced-motion: reduce)';
const subscribe = (notify: () => void) => {
  const query = matchMedia(REDUCED);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

export function FlowToggle({ locale, on, onChange }: FlowToggleProps) {
  const reduced = useSyncExternalStore(subscribe, () => matchMedia(REDUCED).matches);
  const note = useId();
  const o = { locale };
  return (
    <span className={styles.row}>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={reduced ? false : on}
        aria-describedby={reduced ? note : undefined}
        disabled={reduced}
        onClick={() => onChange(!on)}
      >
        {m.flow_toggle({}, o)}
      </button>
      {reduced && (
        <span id={note} className={styles.note}>
          {m.flow_reduced({}, o)}
        </span>
      )}
    </span>
  );
}
