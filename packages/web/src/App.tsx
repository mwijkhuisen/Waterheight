/**
 * Application shell.
 *
 * The site is organised the way a package registry is: a persistent masthead
 * with global search, a routed main column, and a footer that is the same on
 * every page. Each route owns its own data loading, so a deep link lands on a
 * complete page without replaying the navigation that would normally reach it.
 */

import { useEffect } from 'react';
import { RouterProvider, useRoute } from './router.js';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';
import { HomePage } from './pages/HomePage.js';
import { SearchPage } from './pages/SearchPage.js';
import { LocationPage } from './pages/LocationPage.js';
import { MapPage } from './pages/MapPage.js';
import { DocsPage } from './pages/DocsPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';

export function App() {
  return (
    <RouterProvider>
      <Shell />
    </RouterProvider>
  );
}

function Shell() {
  const { path } = useRoute();

  // A new page starts at the top; a query-string change (a filter, a tab) does
  // not, so refining a search never throws the reader back to the masthead.
  useEffect(() => {
    const { hash } = window.location;
    if (hash) {
      document.querySelector(hash)?.scrollIntoView();
      return;
    }
    window.scrollTo(0, 0);
  }, [path]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <main className="app__main" id="main">
        {renderRoute(path)}
      </main>
      <Footer />
    </div>
  );
}

function renderRoute(path: string) {
  if (path === '/') return <HomePage />;
  if (path === '/search') return <SearchPage />;
  if (path === '/map') return <MapPage />;
  if (path === '/docs') return <DocsPage />;

  const location = path.match(/^\/location\/(.+)$/);
  if (location) {
    const code = safeDecode(location[1]!);
    // Remount on code change: every page-level piece of state (tab, period,
    // selected quantity) belongs to one location and must not carry over.
    return <LocationPage key={code} code={code} />;
  }

  return <NotFoundPage />;
}

/** A hand-typed URL can contain a stray %, which decodeURIComponent throws on. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
