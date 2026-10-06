import type { WebRiver } from '../../lib/data/chain.ts';
import { riverName } from '../../lib/labels/labels.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './legend.module.css';

// The river highlight chip (P10a C17): the name as a text node and a clear button.

export interface RiverChipProps {
  locale: Locale;
  /** The chosen river id; `river` is its entry of the reaches file, undefined while that file loads. */
  id: string;
  river: WebRiver | undefined;
  onClear: () => void;
}

export function RiverChip({ locale, id, river, onClear }: RiverChipProps) {
  const name = riverName(id, locale) ?? (locale === 'nl' ? river?.name_nl : river?.name_en) ?? id;
  return (
    <span className={styles.chip}>
      {m.river_chip({ name }, { locale })}
      <button type="button" aria-label={m.river_clear({}, { locale })} onClick={onClear}>
        {/* An icon, not a lone glyph: axe cannot judge the contrast of one character (P4b review round 2). */}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </button>
    </span>
  );
}
