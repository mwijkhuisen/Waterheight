/**
 * Detail panel for the selected marker.
 *
 * Phase 3 scope: identity, freshness, latest values and what the location
 * measures. The time-series chart and period selector arrive in Phase 5.
 */

import { useEffect, useState } from 'react';
import type { LatestValue, LocationDetail } from '@rws/shared';
import { ApiRequestError, fetchLatest, fetchLocation } from '../api.js';
import {
  FRESHNESS_COLOR,
  FRESHNESS_LABEL,
  formatAge,
  formatTimestamp,
  freshnessOf,
} from '../freshness.js';

export interface LocationPanelProps {
  code: string;
  onClose: () => void;
}

interface PanelState {
  detail: LocationDetail | null;
  latest: LatestValue[];
  loading: boolean;
  error: string | null;
}

export function LocationPanel({ code, onClose }: LocationPanelProps) {
  const [state, setState] = useState<PanelState>({
    detail: null, latest: [], loading: true, error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ detail: null, latest: [], loading: true, error: null });

    Promise.all([
      fetchLocation(code, controller.signal),
      // Latest values are best-effort: a location with nothing ingested yet
      // should still show its identity and measurement types.
      fetchLatest(code, controller.signal).catch(() => [] as LatestValue[]),
    ])
      .then(([detail, latest]) => {
        if (controller.signal.aborted) return;
        setState({ detail, latest, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof ApiRequestError
          ? err.message
          : 'Could not load this location.';
        setState({ detail: null, latest: [], loading: false, error: message });
      });

    return () => controller.abort();
  }, [code]);

  const { detail, latest, loading, error } = state;
  const state_ = detail ? freshnessOf(detail.lastSeenAt) : null;
  const latestByQuantity = new Map(latest.map((l) => [l.quantity, l]));

  return (
    <section className="panel" aria-label="Location details">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">
            {loading ? <span className="skeleton skeleton--title" /> : detail?.name ?? code}
          </h2>
          <p className="panel__code">{code}</p>
        </div>
        <button type="button" className="panel__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      {loading && !error && (
        <div className="panel__body">
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--block" />
        </div>
      )}

      {detail && !loading && (
        <div className="panel__body">
          <div className="panel__status">
            <span
              className="legend__swatch"
              style={{ background: FRESHNESS_COLOR[state_ ?? 'delayed'] }}
              aria-hidden="true"
            />
            <span>
              {FRESHNESS_LABEL[state_ ?? 'delayed']}
              {' — last reported '}
              {formatAge(detail.lastSeenAt)}
            </span>
          </div>
          {/* The exact time is spelled out so the state never rests on colour. */}
          <p className="panel__timestamp">{formatTimestamp(detail.lastSeenAt)}</p>

          <h3 className="panel__section">Latest values</h3>
          {latest.length === 0 ? (
            <p className="notice">
              No measurements stored locally yet. History is fetched on demand;
              the full backfill runs separately.
            </p>
          ) : (
            <dl className="values">
              {latest.map((value) => (
                <div className="values__row" key={value.seriesId}>
                  <dt className="values__label">{value.quantity}</dt>
                  <dd className="values__value">
                    {value.value === null
                      ? <span className="values__gap" title="Gap in the series">no reading</span>
                      : <>{value.value}{value.unit ? ` ${value.unit}` : ''}</>}
                    <span className="values__age">{formatAge(value.timestamp)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <h3 className="panel__section">
            Measures ({detail.measurementTypes.length})
          </h3>
          {detail.measurementTypes.length === 0 ? (
            <p className="notice">This location publishes no measurement types.</p>
          ) : (
            <ul className="types">
              {detail.measurementTypes.map((type) => {
                const hasLatest = latestByQuantity.has(type.quantity);
                return (
                  <li className="types__item" key={`${type.compartment}-${type.quantity}-${type.seriesId}`}>
                    <span className="types__name">{type.quantityLabel ?? type.quantity}</span>
                    <span className="types__meta">
                      {type.quantity}
                      {type.unit ? ` · ${type.unit}` : ''}
                      {type.coverage.points > 0
                        ? ` · ${type.coverage.points.toLocaleString('en-GB')} points stored`
                        : hasLatest ? '' : ' · not backfilled yet'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <a
            className="panel__link"
            href={`https://waterinfo.rws.nl/#/publiek/waterhoogte?locationCode=${encodeURIComponent(code)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            View on waterinfo.rws.nl ↗
          </a>
        </div>
      )}
    </section>
  );
}
