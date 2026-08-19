/**
 * API reference.
 *
 * Everything the site renders comes from these six endpoints, so documenting
 * them is what makes the registry usable by something other than this client
 * -- the equivalent of an npm package's readme.
 */

import { useDocumentTitle } from '../hooks.js';
import { Link } from '../router.js';
import { CopyBlock } from '../components/ui.js';

interface Param {
  name: string;
  type: string;
  description: string;
}

interface Endpoint {
  id: string;
  method: 'GET';
  path: string;
  summary: string;
  params?: Param[];
  example: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    id: 'locations',
    method: 'GET',
    path: '/api/locations',
    summary: 'Every active measurement location, optionally filtered. This is what the search page calls.',
    params: [
      { name: 'q', type: 'string', description: 'Free-text match on location name or code.' },
      { name: 'grootheid', type: 'string', description: 'Restrict to locations reporting this measurement type, e.g. WATHTE.' },
      { name: 'compartiment', type: 'string', description: 'Restrict to a compartment, e.g. OW for surface water.' },
      { name: 'bbox', type: 'west,south,east,north', description: 'Bounding box in WGS84 degrees.' },
      { name: 'includeInactive', type: 'boolean', description: 'Include stations that have stopped reporting. Defaults to false.' },
      { name: 'limit', type: 'integer 1–25000', description: 'Cap the number of rows returned.' },
    ],
    example: '/api/locations?q=vlissingen&grootheid=WATHTE',
  },
  {
    id: 'location',
    method: 'GET',
    path: '/api/locations/:code',
    summary: 'One location with the full list of measurement series it publishes, each with the coverage actually stored here.',
    example: '/api/locations/VLISSGN',
  },
  {
    id: 'latest',
    method: 'GET',
    path: '/api/locations/:code/latest',
    summary: 'The most recent reading per series at one location.',
    example: '/api/locations/VLISSGN/latest',
  },
  {
    id: 'observations',
    method: 'GET',
    path: '/api/locations/:code/observations',
    summary:
      'A time series for one location and measurement type. Windows that are not stored locally are fetched from Rijkswaterstaat on demand.',
    params: [
      { name: 'grootheid', type: 'string (required)', description: 'The measurement type to return.' },
      { name: 'compartiment', type: 'string', description: 'Disambiguates two series of the same type in different compartments.' },
      { name: 'from, to', type: 'ISO 8601', description: 'The window. Defaults to the last 48 hours.' },
      { name: 'resolution', type: 'raw | hourly | daily', description: 'Requested resolution. The response reports what was actually served.' },
    ],
    example: '/api/locations/VLISSGN/observations?grootheid=WATHTE&resolution=hourly',
  },
  {
    id: 'quantities',
    method: 'GET',
    path: '/api/quantities',
    summary: 'The catalogue of measurement types and compartments, each with a count of active locations.',
    example: '/api/quantities',
  },
  {
    id: 'health',
    method: 'GET',
    path: '/api/health',
    summary: 'Upstream reachability, cache age, location counts and backfill progress. Exempt from rate limiting.',
    example: '/api/health',
  },
];

export function DocsPage() {
  useDocumentTitle('API documentation - rws');

  return (
    <div className="page page--split">
      <div className="page__main">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Docs</span>
        </nav>

        <header className="pkg__header">
          <h1 className="pkg__name">API</h1>
          <p className="pkg__summary">
            A JSON API over Rijkswaterstaat's measurement network. Read-only, no key required,
            CORS-enabled, and rate limited per client.
          </p>
        </header>

        <section className="readme">
          <h2 className="readme__heading">Getting started</h2>
          <p className="readme__text">
            Every response is JSON. Field names describe this API rather than the upstream
            Rijkswaterstaat service, so <code>grootheid</code> is the only piece of the original
            vocabulary that leaks through — it is the measurement-type code, and{' '}
            <Link to="/docs#quantities">/api/quantities</Link> lists every valid value.
          </p>
          <CopyBlock command={`curl ${origin()}/api/locations?q=vlissingen`} label="example request" />

          <h2 className="readme__heading">Errors</h2>
          <p className="readme__text">
            Failures use one envelope, with the HTTP status carrying the category:
          </p>
          <pre className="code"><code>{`{
  "error": {
    "code": "not_found",
    "message": "No location with code XXX"
  }
}`}</code></pre>
          <p className="readme__text">
            A <code>429</code> means the rate limit was hit; the message names how long to wait
            before retrying. Observation requests can trigger a live upstream fetch, which is why
            they count against that limit like everything else.
          </p>
        </section>

        <section className="readme">
          <h2 className="readme__heading">Endpoints</h2>
          {ENDPOINTS.map((endpoint) => (
            <article key={endpoint.id} className="endpoint" id={endpoint.id}>
              <h3 className="endpoint__signature">
                <span className="endpoint__method">{endpoint.method}</span>
                <code className="endpoint__path">{endpoint.path}</code>
              </h3>
              <p className="readme__text">{endpoint.summary}</p>

              {endpoint.params && (
                <div className="table-wrap">
                  <table className="table table--dense">
                    <thead>
                      <tr>
                        <th scope="col">Parameter</th>
                        <th scope="col">Type</th>
                        <th scope="col">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {endpoint.params.map((param) => (
                        <tr key={param.name}>
                          <th scope="row" className="table__mono">{param.name}</th>
                          <td className="table__mono">{param.type}</td>
                          <td>{param.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="endpoint__try">
                <a href={endpoint.example} target="_blank" rel="noreferrer noopener">
                  Try it: <code>{endpoint.example}</code> ↗
                </a>
              </p>
            </article>
          ))}
        </section>
      </div>

      <aside className="page__aside" aria-label="On this page">
        <div className="facet facet--sticky">
          <h2 className="facet__title">On this page</h2>
          <ul className="toc">
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint.id}>
                <a href={`#${endpoint.id}`}>
                  <span className="endpoint__method">{endpoint.method}</span>
                  <code>{endpoint.path}</code>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function origin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}
