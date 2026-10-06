import { type ComponentType, type LazyExoticComponent, lazy, Suspense } from 'react';
import type { PageId } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

// The information pages (P10b T3): each page's text is a JSX file per language under content/<locale>/ (static prose,
// no markdown, no HTML string: scripts/check-i18n.ts holds them to `react` and ../../parts/* imports), loaded as its
// own lazy chunk, so a page fetches only its own language's text and the map never fetches any. The parts
// (parts/*.tsx) render the data a page shows: sources.json, status.json, the crosswalk, the runtime config.

type Content = LazyExoticComponent<ComponentType>;

const CONTENT: Readonly<Record<PageId, Readonly<Record<Locale, Content>>>> = {
  about: { nl: lazy(() => import('./content/nl/About.tsx')), en: lazy(() => import('./content/en/About.tsx')) },
  sources: { nl: lazy(() => import('./content/nl/Sources.tsx')), en: lazy(() => import('./content/en/Sources.tsx')) },
  method: { nl: lazy(() => import('./content/nl/Method.tsx')), en: lazy(() => import('./content/en/Method.tsx')) },
  disclaimer: {
    nl: lazy(() => import('./content/nl/Disclaimer.tsx')),
    en: lazy(() => import('./content/en/Disclaimer.tsx')),
  },
  colophon: {
    nl: lazy(() => import('./content/nl/Colophon.tsx')),
    en: lazy(() => import('./content/en/Colophon.tsx')),
  },
  privacy: { nl: lazy(() => import('./content/nl/Privacy.tsx')), en: lazy(() => import('./content/en/Privacy.tsx')) },
  status: { nl: lazy(() => import('./content/nl/Status.tsx')), en: lazy(() => import('./content/en/Status.tsx')) },
  accessibility: {
    nl: lazy(() => import('./content/nl/Accessibility.tsx')),
    en: lazy(() => import('./content/en/Accessibility.tsx')),
  },
};

export function Page({ id, locale }: { id: PageId; locale: Locale }) {
  const Text = CONTENT[id][locale];
  return (
    <Suspense fallback={<p role="status">{m.page_loading({}, { locale })}</p>}>
      <Text />
    </Suspense>
  );
}
