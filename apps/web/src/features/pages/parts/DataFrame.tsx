import type { ReactNode } from 'react';
import { useAudienceQuery } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import tableStyles from '../../table/table.module.css';
import styles from './pages.module.css';

// What the data parts of the Sources, Status and Method pages share (P10b): the notice while a file is on its way or
// has failed, and a table in a keyboard-reachable, scrollable frame.

/** "Loading…" while the file is on its way, and an alert once it has failed, or the site's audience could not be read. */
export function Pending({ locale, error }: { locale: Locale; error: boolean }) {
  const audienceFailed = useAudienceQuery().isError;
  return error || audienceFailed ? (
    <p role="alert">{m.data_unavailable({}, { locale })}</p>
  ) : (
    <p role="status">{m.loading({}, { locale })}</p>
  );
}

/**
 * A captioned table in a scrollable region. The region is focusable (and named like the table), so that a wide table
 * can be scrolled by keyboard on a phone; the header stays in view while a tall one scrolls.
 */
export function TableFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1)
    <section className={`${tableStyles.wrap} ${styles.frame}`} aria-label={label} tabIndex={0}>
      <table className={tableStyles.table}>
        <caption>{label}</caption>
        {children}
      </table>
    </section>
  );
}
