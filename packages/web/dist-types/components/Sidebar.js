import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { FRESHNESS_COLOR, FRESHNESS_LABEL, formatAge, freshnessOf } from '../freshness.js';
export function Sidebar(props) {
    const { quantities, compartments, selectedQuantity, selectedCompartment, search, locations, loading, error, selectedCode, } = props;
    const filtered = selectedQuantity
        ? quantities.filter((q) => q.code === selectedQuantity)
        : quantities;
    // Only offer compartments that can still yield results under the current
    // quantity, so the two filters cannot be combined into an empty map.
    const availableCompartments = selectedQuantity
        ? compartments.filter((c) => filtered.some((q) => q.compartments.includes(c.code)))
        : compartments;
    return (_jsxs("aside", { className: "sidebar", "aria-label": "Filters and search", children: [_jsxs("header", { className: "sidebar__header", children: [_jsx("h1", { className: "sidebar__title", children: "Rijkswaterstaat monitoring" }), _jsx("p", { className: "sidebar__subtitle", children: loading
                            ? 'Loading measurement locations…'
                            : `${locations.length.toLocaleString('en-GB')} active location${locations.length === 1 ? '' : 's'}` })] }), _jsxs("div", { className: "field", children: [_jsx("label", { className: "field__label", htmlFor: "search", children: "Search locations" }), _jsx("input", { id: "search", className: "field__input", type: "search", placeholder: "e.g. Vlissingen", value: search, autoComplete: "off", onChange: (e) => props.onSearchChange(e.target.value) })] }), _jsxs("div", { className: "field", children: [_jsx("label", { className: "field__label", htmlFor: "quantity", children: "Measurement type" }), _jsxs("select", { id: "quantity", className: "field__input", value: selectedQuantity ?? '', onChange: (e) => props.onQuantityChange(e.target.value || null), children: [_jsx("option", { value: "", children: "All measurement types" }), quantities.map((q) => (_jsxs("option", { value: q.code, children: [q.label ?? q.code, " (", q.activeLocations, ")"] }, q.code)))] })] }), _jsxs("div", { className: "field", children: [_jsx("label", { className: "field__label", htmlFor: "compartment", children: "Compartment" }), _jsxs("select", { id: "compartment", className: "field__input", value: selectedCompartment ?? '', onChange: (e) => props.onCompartmentChange(e.target.value || null), children: [_jsx("option", { value: "", children: "All compartments" }), availableCompartments.map((c) => (_jsxs("option", { value: c.code, children: [c.label ?? c.code, " (", c.activeLocations, ")"] }, c.code)))] })] }), (selectedQuantity || selectedCompartment || search) && (_jsx("button", { type: "button", className: "button button--ghost", onClick: () => {
                    props.onQuantityChange(null);
                    props.onCompartmentChange(null);
                    props.onSearchChange('');
                }, children: "Clear filters" })), _jsx(Legend, {}), _jsxs("div", { className: "results", "aria-live": "polite", children: [error && (_jsx("p", { className: "notice notice--error", role: "alert", children: error })), loading && !error && _jsx(ResultsSkeleton, {}), !loading && !error && locations.length === 0 && (_jsx("p", { className: "notice", children: "No locations match these filters. Try clearing the search or choosing a different measurement type." })), !loading && !error && locations.length > 0 && (_jsxs("ul", { className: "results__list", children: [locations.slice(0, 200).map((location) => {
                                const state = freshnessOf(location.lastSeenAt);
                                return (_jsx("li", { children: _jsxs("button", { type: "button", className: `result${location.code === selectedCode ? ' result--selected' : ''}`, onClick: () => props.onSelect(location), children: [_jsx("span", { className: "result__dot", style: { background: FRESHNESS_COLOR[state] }, "aria-hidden": "true" }), _jsxs("span", { className: "result__text", children: [_jsx("span", { className: "result__name", children: location.name }), _jsxs("span", { className: "result__meta", children: [location.quantities.length, " type", location.quantities.length === 1 ? '' : 's', ' · ', formatAge(location.lastSeenAt)] })] })] }) }, location.code));
                            }), locations.length > 200 && (_jsxs("li", { className: "results__more", children: ["Showing the first 200 of ", locations.length.toLocaleString('en-GB'), ". All of them are on the map \u2014 zoom in or search to narrow it down."] }))] }))] })] }));
}
function Legend() {
    return (_jsxs("div", { className: "legend", children: [_jsx("h2", { className: "legend__title", children: "Marker colour" }), _jsx("ul", { className: "legend__list", children: ['fresh', 'delayed'].map((state) => (_jsxs("li", { className: "legend__item", children: [_jsx("span", { className: "legend__swatch", style: { background: FRESHNESS_COLOR[state] }, "aria-hidden": "true" }), FRESHNESS_LABEL[state]] }, state))) })] }));
}
function ResultsSkeleton() {
    return (_jsx("ul", { className: "results__list", "aria-hidden": "true", children: Array.from({ length: 6 }, (_, i) => (_jsx("li", { className: "skeleton skeleton--row" }, i))) }));
}
//# sourceMappingURL=Sidebar.js.map