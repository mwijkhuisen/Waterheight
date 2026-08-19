/**
 * One row in a result list -- the equivalent of an npm search result.
 *
 * Name and code lead, the measured quantities read as keyword chips, and the
 * meta line carries freshness in words as well as colour.
 */

import type { Location, QuantityInfo } from '@rws/shared';
import { formatAge, freshnessOf } from '../freshness.js';
import { plural } from '../format.js';
import { Link, locationPath, searchPath } from '../router.js';
import { Badge, Chip, FreshnessTag } from './ui.js';

/** How many quantity chips fit before the row starts to look like a tag cloud. */
const MAX_CHIPS = 5;

export interface LocationRowProps {
  location: Location;
  /** Quantity code -> human label, so chips read "Water level", not "WATHTE". */
  labels: Map<string, string>;
}

export function LocationRow({ location, labels }: LocationRowProps) {
  const state = freshnessOf(location.lastSeenAt);
  const chips = location.quantities.slice(0, MAX_CHIPS);
  const overflow = location.quantities.length - chips.length;

  return (
    <article className="row">
      <h3 className="row__heading">
        <Link className="row__name" to={locationPath(location.code)}>{location.name}</Link>
        <Badge>{location.code}</Badge>
      </h3>

      {chips.length > 0 && (
        <p className="row__chips">
          {chips.map((code) => (
            <Chip key={code} to={searchPath({ grootheid: code })}>
              {labels.get(code) ?? code}
            </Chip>
          ))}
          {overflow > 0 && <span className="row__overflow">+{overflow} more</span>}
        </p>
      )}

      <p className="row__meta">
        <FreshnessTag state={state} label={`published ${formatAge(location.lastSeenAt)}`} />
        <span className="row__sep" aria-hidden="true">·</span>
        <span>{plural(location.quantities.length, 'measurement type')}</span>
        {location.lat !== null && location.lon !== null && (
          <>
            <span className="row__sep" aria-hidden="true">·</span>
            <span className="row__coords">
              {location.lat.toFixed(3)}, {location.lon.toFixed(3)}
            </span>
          </>
        )}
      </p>
    </article>
  );
}

/** Builds the code -> label lookup the rows and facets share. */
export function quantityLabels(quantities: QuantityInfo[]): Map<string, string> {
  return new Map(quantities.map((q) => [q.code, q.label ?? q.code]));
}
