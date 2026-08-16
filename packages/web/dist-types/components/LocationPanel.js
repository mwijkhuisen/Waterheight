import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Detail panel for the selected marker.
 *
 * Phase 3 scope: identity, freshness, latest values and what the location
 * measures. The time-series chart and period selector arrive in Phase 5.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, fetchLatest, fetchLocation } from '../api.js';
import { FRESHNESS_COLOR, FRESHNESS_LABEL, formatAge, formatTimestamp, freshnessOf, } from '../freshness.js';
export function LocationPanel({ code, onClose }) {
    const [state, setState] = useState({
        detail: null, latest: [], loading: true, error: null,
    });
    useEffect(() => {
        const controller = new AbortController();
        setState({ detail: null, latest: [], loading: true, error: null });
        Promise.all([
            fetchLocation(code, controller.signal),
            // Latest values are best-effort: a location with nothing ingested yet
            // should still show its identity and measurement types.
            fetchLatest(code, controller.signal).catch(() => []),
        ])
            .then(([detail, latest]) => {
            if (controller.signal.aborted)
                return;
            setState({ detail, latest, loading: false, error: null });
        })
            .catch((err) => {
            if (controller.signal.aborted)
                return;
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
    return (_jsxs("section", { className: "panel", "aria-label": "Location details", children: [_jsxs("header", { className: "panel__header", children: [_jsxs("div", { children: [_jsx("h2", { className: "panel__title", children: loading ? _jsx("span", { className: "skeleton skeleton--title" }) : detail?.name ?? code }), _jsx("p", { className: "panel__code", children: code })] }), _jsx("button", { type: "button", className: "panel__close", onClick: onClose, "aria-label": "Close details", children: "\u00D7" })] }), error && _jsx("p", { className: "notice notice--error", role: "alert", children: error }), loading && !error && (_jsxs("div", { className: "panel__body", children: [_jsx("span", { className: "skeleton skeleton--line" }), _jsx("span", { className: "skeleton skeleton--line" }), _jsx("span", { className: "skeleton skeleton--block" })] })), detail && !loading && (_jsxs("div", { className: "panel__body", children: [_jsxs("div", { className: "panel__status", children: [_jsx("span", { className: "legend__swatch", style: { background: FRESHNESS_COLOR[state_ ?? 'delayed'] }, "aria-hidden": "true" }), _jsxs("span", { children: [FRESHNESS_LABEL[state_ ?? 'delayed'], ' — last reported ', formatAge(detail.lastSeenAt)] })] }), _jsx("p", { className: "panel__timestamp", children: formatTimestamp(detail.lastSeenAt) }), _jsx("h3", { className: "panel__section", children: "Latest values" }), latest.length === 0 ? (_jsx("p", { className: "notice", children: "No measurements stored locally yet. History is fetched on demand; the full backfill runs separately." })) : (_jsx("dl", { className: "values", children: latest.map((value) => (_jsxs("div", { className: "values__row", children: [_jsx("dt", { className: "values__label", children: value.quantity }), _jsxs("dd", { className: "values__value", children: [value.value === null
                                            ? _jsx("span", { className: "values__gap", title: "Gap in the series", children: "no reading" })
                                            : _jsxs(_Fragment, { children: [value.value, value.unit ? ` ${value.unit}` : ''] }), _jsx("span", { className: "values__age", children: formatAge(value.timestamp) })] })] }, value.seriesId))) })), _jsxs("h3", { className: "panel__section", children: ["Measures (", detail.measurementTypes.length, ")"] }), detail.measurementTypes.length === 0 ? (_jsx("p", { className: "notice", children: "This location publishes no measurement types." })) : (_jsx("ul", { className: "types", children: detail.measurementTypes.map((type) => {
                            const hasLatest = latestByQuantity.has(type.quantity);
                            return (_jsxs("li", { className: "types__item", children: [_jsx("span", { className: "types__name", children: type.quantityLabel ?? type.quantity }), _jsxs("span", { className: "types__meta", children: [type.quantity, type.unit ? ` · ${type.unit}` : '', type.coverage.points > 0
                                                ? ` · ${type.coverage.points.toLocaleString('en-GB')} points stored`
                                                : hasLatest ? '' : ' · not backfilled yet'] })] }, `${type.compartment}-${type.quantity}-${type.seriesId}`));
                        }) })), _jsx("a", { className: "panel__link", href: `https://waterinfo.rws.nl/#/publiek/waterhoogte?locationCode=${encodeURIComponent(code)}`, target: "_blank", rel: "noreferrer noopener", children: "View on waterinfo.rws.nl \u2197" })] }))] }));
}
//# sourceMappingURL=LocationPanel.js.map