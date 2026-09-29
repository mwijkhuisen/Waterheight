import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { baseLocale, isLocale } from './paraglide/runtime.js';

// The page's static <html lang> decides the locale: no cookie, no storage.
const lang = document.documentElement.lang;
const main = document.getElementById('app');
if (main) {
  createRoot(main).render(
    <StrictMode>
      <App locale={isLocale(lang) ? lang : baseLocale} />
    </StrictMode>,
  );
}
