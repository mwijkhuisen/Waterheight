import type { ReactNode } from 'react';
import { pathOf, type RouteId } from '../../../lib/routes.ts';

/** A link to another page of the site in the same language (a full page load: there is no router). */
export function PageLink({ id, locale, children }: { id: RouteId; locale: 'nl' | 'en'; children: ReactNode }) {
  return <a href={pathOf(id, locale)}>{children}</a>;
}
