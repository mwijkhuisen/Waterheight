import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { baseLocale, isLocale } from '../../../paraglide/runtime.js';
import { Spike } from './Spike.tsx';

// The spike page's entry; StrictMode mounts the map twice on purpose, so the
// protocol refcount and the cleanup are exercised on every load.
const lang = document.documentElement.lang;
const main = document.getElementById('spike');
if (main) {
  createRoot(main).render(
    <StrictMode>
      <Spike locale={isLocale(lang) ? lang : baseLocale} />
    </StrictMode>,
  );
}
