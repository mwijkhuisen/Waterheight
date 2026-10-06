import type { WebSource } from '../../lib/data/contracts.ts';
import { httpsHref } from '../../lib/href.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

// The persistent owner banner (T12, C14): not dismissible; provider and registry text only as text nodes.

export interface OwnerBannerProps {
  locale: Locale;
  /** sources.json entries of owner audience (useSources, filtered); undefined while it loads. */
  sources: readonly WebSource[] | undefined;
}

export function OwnerBanner({ locale, sources }: OwnerBannerProps) {
  const o = { locale };
  return (
    <section aria-label={m.owner_banner_label({}, o)}>
      <p>
        <strong>{m.owner_banner({}, o)}</strong>
      </p>
      <details>
        <summary>{m.owner_terms_summary({}, o)}</summary>
        <ul>
          {(sources ?? []).map((s) => {
            const b = s.privateBasis;
            const href = b == null ? undefined : httpsHref(b.url);
            return (
              <li key={s.id}>
                {s.id} {s.name}
                {b != null && (
                  <>
                    {': '}
                    {b.clause}{' '}
                    {href === undefined ? (
                      b.url
                    ) : (
                      <a href={href} rel="noopener noreferrer">
                        {m.owner_terms_link({}, o)}
                      </a>
                    )}{' '}
                    ({m.owner_retrieved({ date: b.retrieved }, o)})
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
