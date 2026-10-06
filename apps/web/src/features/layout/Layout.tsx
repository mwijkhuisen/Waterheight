import type { Meta } from '@rws/contracts';
import { lazy, type ReactNode, Suspense, useEffect, useMemo } from 'react';
import { attributionText } from '../../lib/attribution.ts';
import { useAudience, useSources } from '../../lib/data/api.ts';
import { httpsHref } from '../../lib/href.ts';
import { PAGE_ROUTES, pathOf, type Route, type RouteId } from '../../lib/routes.ts';
import { formatDay, ZONE } from '../../lib/time/time.ts';
import { otherLanguageHref } from '../../lib/url/url.ts';
import { useUrlState } from '../../lib/url/useUrlState.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { MapCredits } from '../pages/parts/MapCredits.tsx';
import styles from './layout.module.css';

// The chrome of every view (P10b T2): the map, the information pages and the 404 page. A header with the site name
// (the map's h1; a link home elsewhere) and the language link to the same page, the beta banner with a link to the
// disclaimer, the owner banner on the owner site, the view in <main>, and the footer: the page links, the map's
// credits and, on the map, the attribution of the sources it shows.

// The owner chunk (P10a T12): fetched only on the owner site, never by the public page.
const OwnerBanner = lazy(() => import('../owner/index.ts').then((o) => ({ default: o.OwnerBanner })));

/** The page's name in a language (a switch: Paraglide's `m` is never indexed by a computed key). */
export function pageTitle(id: RouteId, locale: Locale): string {
  switch (id) {
    case 'home':
      return m.page_home_title({}, { locale });
    case 'about':
      return m.page_about_title({}, { locale });
    case 'sources':
      return m.page_sources_title({}, { locale });
    case 'method':
      return m.page_method_title({}, { locale });
    case 'disclaimer':
      return m.page_disclaimer_title({}, { locale });
    case 'colophon':
      return m.page_colophon_title({}, { locale });
    case 'privacy':
      return m.page_privacy_title({}, { locale });
    case 'status':
      return m.page_status_title({}, { locale });
    case 'accessibility':
      return m.page_accessibility_title({}, { locale });
  }
}

export function Layout({
  locale,
  route,
  meta,
  t,
  children,
}: {
  locale: Locale;
  /** null on the 404 page. */
  route: Route | null;
  /** The map's /meta and instant: the footer then credits the sources it shows. */
  meta?: Meta | undefined;
  t?: number | undefined;
  children: ReactNode;
}) {
  const owner = useAudience() === 'owner';
  const [url] = useUrlState();
  const id = route?.id;
  useEffect(() => {
    const site = m.site_title({}, { locale });
    document.title =
      id === 'home'
        ? site
        : `${id === undefined ? m.not_found_heading({}, { locale }) : pageTitle(id, locale)} · ${site}`;
  }, [id, locale]);
  const other = locale === 'nl' ? 'en' : 'nl';
  return (
    <>
      <header className={styles.header}>
        {id === 'home' ? (
          <h1>{m.heading({}, { locale })}</h1>
        ) : (
          <p className={styles.site}>
            <a href={pathOf('home', locale)}>{m.heading({}, { locale })}</a>
          </p>
        )}
        <a href={otherLanguageHref(locale, url, id)} hrefLang={other} lang={other}>
          {m.other_language({}, { locale })}
        </a>
      </header>
      <p className={styles.beta}>
        {m.beta_banner({}, { locale })} <a href={pathOf('disclaimer', locale)}>{m.beta_banner_link({}, { locale })}</a>
      </p>
      {owner && <OwnerShell locale={locale} />}
      <main className={styles.main}>{children}</main>
      <Footer locale={locale} meta={meta} t={t} />
    </>
  );
}

/** The persistent owner banner on every view of the owner site (T-OWN-5); nothing on the public site. */
function OwnerShell({ locale }: { locale: Locale }) {
  const sources = useSources().data;
  const owned = useMemo(() => sources?.sources.filter((s) => s.audience === 'owner'), [sources]);
  return (
    <Suspense fallback={null}>
      <OwnerBanner locale={locale} sources={owned} />
    </Suspense>
  );
}

/**
 * The page links, and on the map the sources from /meta, a source that fills another's series included (FR-3,
 * CH-3). Where a row needs a date, it is the Amsterdam date of `t` in the page's language; a text that another
 * source already showed is not repeated (CH-3 says what CH-1 says).
 */
function Footer({ locale, meta, t }: { locale: Locale; meta: Meta | undefined; t: number | undefined }) {
  const date = t === undefined ? undefined : formatDay(t, locale, ZONE);
  const shown = new Set<string>();
  return (
    <footer className={styles.footer}>
      <p className={styles.disclaimer}>{m.disclaimer({}, { locale })}</p>
      <nav aria-label={m.footer_nav_label({}, { locale })}>
        <ul className={styles.nav}>
          {PAGE_ROUTES.map((r) => (
            <li key={r.id}>
              <a href={r[locale]}>{pageTitle(r.id, locale)}</a>
            </li>
          ))}
        </ul>
      </nav>
      {meta !== undefined && date !== undefined && meta.sources.length > 0 && (
        <>
          <h2>{m.sources_heading({}, { locale })}</h2>
          <ul>
            {meta.sources.flatMap((source) =>
              source.attribution.flatMap((a) => {
                const text = attributionText(a.text, a.needsDate, date);
                const href = httpsHref(a.url);
                const seen = `${a.lang}|${href}|${text}`;
                if (shown.has(seen)) return [];
                shown.add(seen);
                return [
                  <li key={`${source.id}|${a.text}`} lang={a.lang ?? undefined}>
                    {href === undefined ? text : <a href={href}>{text}</a>}
                  </li>,
                ];
              }),
            )}
          </ul>
        </>
      )}
      <MapCredits locale={locale} />
      <p>
        <a href="/third-party-notices.txt">{m.notices_link({}, { locale })}</a>
      </p>
    </footer>
  );
}
