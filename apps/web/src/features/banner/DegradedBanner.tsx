import { formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './banner.module.css';

/**
 * Shown when the data is not the live answer (P9a): the loader is behind (`meta.degraded`), the forecast of a future
 * time comes from the static file without states, or Caddy's stand-in for a dead API shows the newest values
 * (`standInAt`, the time they are for, in Europe/Amsterdam).
 */
export function DegradedBanner({
  locale,
  degraded,
  standInAt,
}: {
  locale: Locale;
  degraded: boolean;
  standInAt: number | undefined;
}) {
  if (!degraded && standInAt === undefined) return null;
  return (
    <p role="status" className={styles.banner}>
      {standInAt === undefined
        ? m.degraded_banner({}, { locale })
        : m.degraded_standin({ time: formatLocal(standInAt, locale) }, { locale })}
    </p>
  );
}
