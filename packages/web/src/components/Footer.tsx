/**
 * Site footer: the registry-style link columns, plus live API health.
 *
 * Health is fetched here rather than in the header because it is reference
 * information, not navigation -- it belongs where npm puts its status link.
 */

import { useEffect, useState } from 'react';
import type { HealthResponse } from '@rws/shared';
import { fetchHealth } from '../api.js';
import { formatAge } from '../freshness.js';
import { formatCount } from '../format.js';
import { Link, searchPath } from '../router.js';

export function Footer() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((res) => { if (!controller.signal.aborted) setHealth(res); })
      .catch(() => { if (!controller.signal.aborted) setUnreachable(true); });
    return () => controller.abort();
  }, []);

  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__brand">
          <span className="masthead__mark" aria-hidden="true">rws</span>
          <p className="footer__tagline">
            Every Rijkswaterstaat measurement location in the Netherlands, searchable.
          </p>
        </div>

        <nav className="footer__columns" aria-label="Footer">
          <div className="footer__column">
            <h2 className="footer__heading">Browse</h2>
            <Link to="/search">All locations</Link>
            <Link to={searchPath({ grootheid: 'WATHTE' })}>Water level</Link>
            <Link to={searchPath({ grootheid: 'Q' })}>Discharge</Link>
            <Link to="/map">Map</Link>
          </div>

          <div className="footer__column">
            <h2 className="footer__heading">API</h2>
            <Link to="/docs">Documentation</Link>
            <a href="/api/locations">/api/locations</a>
            <a href="/api/quantities">/api/quantities</a>
            <a href="/api/health">/api/health</a>
          </div>

          <div className="footer__column">
            <h2 className="footer__heading">Source</h2>
            <a href="https://rijkswaterstaatdata.nl/waterdata/" target="_blank" rel="noreferrer noopener">
              Rijkswaterstaat waterdata
            </a>
            <a href="https://waterinfo.rws.nl/" target="_blank" rel="noreferrer noopener">
              waterinfo.rws.nl
            </a>
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
              OpenStreetMap
            </a>
            <a href="https://openfreemap.org/" target="_blank" rel="noreferrer noopener">
              OpenFreeMap tiles
            </a>
          </div>
        </nav>

        <div className="footer__status">
          <h2 className="footer__heading">Status</h2>
          <StatusLine health={health} unreachable={unreachable} />
        </div>
      </div>

      <p className="footer__legal">
        Measurement data © Rijkswaterstaat, published as open data. Basemap ©
        OpenStreetMap contributors, tiles by OpenFreeMap. This site is an independent
        client and is not operated by Rijkswaterstaat.
      </p>
    </footer>
  );
}

function StatusLine({ health, unreachable }: { health: HealthResponse | null; unreachable: boolean }) {
  if (unreachable) {
    return <p className="status status--down"><span className="status__dot" aria-hidden="true" />API unreachable</p>;
  }
  if (!health) {
    return <p className="status status--idle"><span className="status__dot" aria-hidden="true" />Checking…</p>;
  }

  const ok = health.status === 'ok';
  return (
    <>
      <p className={`status status--${ok ? 'ok' : 'degraded'}`}>
        <span className="status__dot" aria-hidden="true" />
        {ok ? 'All systems operational' : 'Degraded — upstream unreachable'}
      </p>
      <p className="footer__note">
        {formatCount(health.locations.active)} active of {formatCount(health.locations.total)} locations
        {health.cache.locationsRefreshedAt
          ? ` · refreshed ${formatAge(health.cache.locationsRefreshedAt)}`
          : ''}
      </p>
    </>
  );
}
