/** Fallback route. Offers search rather than only apologising. */

import { useDocumentTitle } from '../hooks.js';
import { Link, useRoute } from '../router.js';

export function NotFoundPage() {
  const { path } = useRoute();
  useDocumentTitle('Not found - rws');

  return (
    <div className="page page--narrow">
      <h1 className="pkg__name">Page not found</h1>
      <p className="pkg__summary">
        Nothing is published at <code>{path}</code>.
      </p>
      <p className="readme__text">
        Try <Link to="/search">searching every location</Link>, opening the{' '}
        <Link to="/map">map</Link>, or reading the <Link to="/docs">API docs</Link>.
      </p>
    </div>
  );
}
