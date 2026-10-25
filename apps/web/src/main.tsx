// First: zod must be jitless before any schema exists (see lib/zod.ts).
import './lib/zod.ts';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { queryClient, runtimeConfigQuery } from './lib/data/api.ts';
import { bootFiles, prefetchStatic } from './lib/data/chain.ts';
import { routeOf } from './lib/routes.ts';
import { ensureTemporal } from './lib/time/temporal.ts';
import { m } from './paraglide/messages.js';
import { baseLocale, isLocale } from './paraglide/runtime.js';
import './styles/base.css';

// The page's static <html lang> decides the locale: no cookie, no storage.
// Temporal (native, or the polyfill chunk where it is missing) is ready before
// the first render; until then the page shows its static text, and if the
// polyfill cannot load, an alert under it.
const lang = document.documentElement.lang;
const locale = isLocale(lang) ? lang : baseLocale;
const root = document.getElementById('app');
if (root) {
  // O4 (#220): the first reads start now, not after Temporal and the first render; the queries take them (chain.ts).
  void queryClient.prefetchQuery(runtimeConfigQuery);
  if (routeOf(location.pathname)?.id === 'home') prefetchStatic(bootFiles(location.search));
  ensureTemporal().then(
    () =>
      createRoot(root).render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <App locale={locale} />
          </QueryClientProvider>
        </StrictMode>,
      ),
    () => {
      const alert = document.createElement('p');
      alert.setAttribute('role', 'alert');
      alert.textContent = m.app_failed({}, { locale });
      root.append(alert);
    },
  );
}
