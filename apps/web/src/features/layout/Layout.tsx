import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAudience, useSources } from '../../lib/data/api.ts';
import { PAGE_ROUTES, pathOf, type Route, type RouteId } from '../../lib/routes.ts';
import { otherLanguageHref } from '../../lib/url/url.ts';
import { useUrlState } from '../../lib/url/useUrlState.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { Logo } from './Logo.tsx';
import styles from './layout.module.css';

// The chrome of every view (P10b T2, P10e): the map, the information pages and the 404 page. A bar that stays at the
// top (sticky): the logo and the site name in its two colours (the map's h1 and a link home elsewhere), the subtitle
// from 100rem, the nine page links (below 80rem folded into a menu button), a compact "bèta" link to the
// disclaimer, the language link to the same page and, on the map, the station search. The owner banner sits
// directly under it on the owner site. On the map nothing follows but the full-screen view (its credits are the
// "Bronnen" disclosure over the map, features/attribution); the pages and the 404 page end in a slim footer.

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
  search,
  children,
}: {
  locale: Locale;
  /** null on the 404 page. */
  route: Route | null;
  /** The station search of the map (a magnifier in the bar), once the stations are known. */
  search?: ReactNode;
  children: ReactNode;
}) {
  const owner = useAudience() === 'owner';
  const [url] = useUrlState();
  const id = route?.id;
  const bar = useRef<HTMLElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The map carries the full title; every other view is "<page> · Rivierkijker" (BRAND.md §2).
    document.title =
      id === 'home'
        ? m.site_title({}, { locale })
        : `${id === undefined ? m.not_found_heading({}, { locale }) : pageTitle(id, locale)} · ${m.heading({}, { locale })}`;
  }, [id, locale]);
  // The real height of the bar and the owner strip (the strip grows when its terms are opened) is --chrome-h: the
  // full-screen map is the viewport minus it, and a drawer or a menu starts under it. Set on <html> by the CSSOM,
  // as the timebar does with --timebar-h (the CSP allows no inline style).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the owner strip exists only on the owner site; observe it once it does
  useEffect(() => {
    const root = document.documentElement;
    // Rounded up (offsetHeight rounds to the nearest pixel, so a fractional bar could make the map a sliver too tall
    // and the page scroll; review round 1).
    const height = (el: HTMLElement | null) => el?.getBoundingClientRect().height ?? 0;
    const measure = () =>
      root.style.setProperty('--chrome-h', `${Math.ceil(height(bar.current) + height(strip.current))}px`);
    measure();
    const size = new ResizeObserver(measure);
    for (const el of [bar.current, strip.current]) if (el !== null) size.observe(el);
    return () => {
      size.disconnect();
      root.style.removeProperty('--chrome-h');
    };
  }, [owner]);
  const other = locale === 'nl' ? 'en' : 'nl';
  const menu = useId();
  // A popover button gets no aria-expanded of its own in every browser: the nav's toggle event sets it.
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <header ref={bar} className={styles.bar}>
        <div className={styles.brand}>
          {id === 'home' ? (
            <h1 className={styles.name}>
              <Name locale={locale} />
            </h1>
          ) : (
            <p className={styles.name}>
              <a href={pathOf('home', locale)}>
                <Name locale={locale} />
              </a>
            </p>
          )}
          <p className={styles.subtitle}>{m.subtitle({}, { locale })}</p>
        </div>
        <button type="button" className={styles.menuButton} popoverTarget={menu} aria-expanded={menuOpen}>
          {m.menu_button({}, { locale })}
        </button>
        {/* Below 80rem a popover (Escape and a click outside close it, the focus returns to the button); from there
            on the same element is simply the row of links. */}
        <nav
          id={menu}
          popover="auto"
          className={styles.nav}
          aria-label={m.footer_nav_label({}, { locale })}
          onToggle={(e) => setMenuOpen(e.newState === 'open')}
        >
          <ul>
            {PAGE_ROUTES.map((r) => (
              <li key={r.id}>
                <a href={r[locale]} aria-current={r.id === id ? 'page' : undefined}>
                  {pageTitle(r.id, locale)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.tools}>
          <a
            href={pathOf('disclaimer', locale)}
            className={styles.beta}
            aria-label={`${m.beta_banner({}, { locale })} ${m.beta_banner_link({}, { locale })}`}
          >
            {m.beta_short({}, { locale })}
          </a>
          <a href={otherLanguageHref(locale, url, id)} hrefLang={other} lang={other}>
            {m.other_language({}, { locale })}
          </a>
          {search}
        </div>
      </header>
      {owner && (
        <div ref={strip} className={styles.owner}>
          <OwnerShell locale={locale} />
        </div>
      )}
      <main className={id === 'home' ? styles.mapMain : styles.main}>{children}</main>
      {id !== 'home' && <Footer locale={locale} />}
    </>
  );
}

/** The logomark and the name in two colours, one word for a screen reader (the mark is decorative). */
function Name({ locale }: { locale: Locale }) {
  return (
    <>
      <Logo variant="light" size={32} />
      <span>
        {m.name_lead({}, { locale })}
        <span className={styles.accent}>{m.name_accent({}, { locale })}</span>
      </span>
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

/** The slim footer of the pages and the 404 page: the disclaimer line and the third-party notices. */
function Footer({ locale }: { locale: Locale }) {
  return (
    <footer className={styles.footer}>
      <p className={styles.disclaimer}>{m.disclaimer({}, { locale })}</p>
      <p>
        <a href="/third-party-notices.txt">{m.notices_link({}, { locale })}</a>
      </p>
    </footer>
  );
}
