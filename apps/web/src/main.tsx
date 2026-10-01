// First: zod must be jitless before any schema exists (see lib/zod.ts).
import './lib/zod.ts';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { queryClient } from './lib/data/api.ts';
import { ensureTemporal } from './lib/time/temporal.ts';
import { baseLocale, isLocale } from './paraglide/runtime.js';
import './styles/base.css';

// The page's static <html lang> decides the locale: no cookie, no storage.
// Temporal (native, or the polyfill chunk where it is missing) is ready before
// the first render; until then the page shows its static text.
const lang = document.documentElement.lang;
const root = document.getElementById('app');
if (root) {
  void ensureTemporal().then(() =>
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App locale={isLocale(lang) ? lang : baseLocale} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}
