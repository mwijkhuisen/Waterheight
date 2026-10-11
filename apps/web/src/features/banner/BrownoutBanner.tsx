import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './banner.module.css';

/** Shown while the server is in brownout (P12a, meta.json `brownout`): charts reach back 30 days at most, no raw. */
export function BrownoutBanner({ locale, brownout }: { locale: Locale; brownout: boolean }) {
  if (!brownout) return null;
  return (
    <p role="status" className={styles.banner}>
      {m.brownout_banner({}, { locale })}
    </p>
  );
}
