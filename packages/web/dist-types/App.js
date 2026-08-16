import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, fetchLocations, fetchQuantities } from './api.js';
import { MapView } from './components/MapView.js';
import { Sidebar } from './components/Sidebar.js';
import { LocationPanel } from './components/LocationPanel.js';
/** Debounce for the search box, so typing does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;
export function App() {
    const [quantities, setQuantities] = useState([]);
    const [compartments, setCompartments] = useState([]);
    const [locations, setLocations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [quantity, setQuantity] = useState(null);
    const [compartment, setCompartment] = useState(null);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [selectedCode, setSelectedCode] = useState(null);
    const [flyTo, setFlyTo] = useState(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    useEffect(() => {
        const id = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(id);
    }, [search]);
    useEffect(() => {
        const controller = new AbortController();
        fetchQuantities(controller.signal)
            .then((res) => {
            setQuantities(res.quantities);
            setCompartments(res.compartments);
        })
            // Filters failing to load is not fatal: the map is still usable.
            .catch(() => { });
        return () => controller.abort();
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        fetchLocations({
            grootheid: quantity ?? undefined,
            compartiment: compartment ?? undefined,
            q: debouncedSearch.trim() || undefined,
        }, controller.signal)
            .then((res) => {
            if (controller.signal.aborted)
                return;
            setLocations(res);
            setLoading(false);
        })
            .catch((err) => {
            if (controller.signal.aborted)
                return;
            setError(err instanceof ApiRequestError
                ? err.message
                : 'Could not reach the API. Is the server running?');
            setLoading(false);
        });
        return () => controller.abort();
    }, [quantity, compartment, debouncedSearch]);
    // Jump the map to the only match, so searching a station lands on it.
    const lastJumped = useRef(null);
    useEffect(() => {
        if (!debouncedSearch.trim() || locations.length === 0)
            return;
        const first = locations[0];
        if (locations.length <= 3 && lastJumped.current !== first.code) {
            lastJumped.current = first.code;
            setFlyTo(first);
        }
    }, [debouncedSearch, locations]);
    const handleSelectFromMap = useCallback((code) => {
        setSelectedCode(code);
        setSheetOpen(false);
    }, []);
    const handleSelectFromList = useCallback((location) => {
        setSelectedCode(location.code);
        setFlyTo(location);
        setSheetOpen(false);
    }, []);
    const selected = useMemo(() => locations.find((l) => l.code === selectedCode) ?? null, [locations, selectedCode]);
    return (_jsxs("div", { className: "app", children: [_jsx("div", { className: `app__sidebar${sheetOpen ? ' app__sidebar--open' : ''}`, children: _jsx(Sidebar, { quantities: quantities, compartments: compartments, selectedQuantity: quantity, selectedCompartment: compartment, search: search, locations: locations, loading: loading, error: error, selectedCode: selectedCode, onQuantityChange: setQuantity, onCompartmentChange: setCompartment, onSearchChange: setSearch, onSelect: handleSelectFromList }) }), _jsxs("main", { className: "app__map", children: [_jsx(MapView, { locations: locations, selectedCode: selectedCode, onSelect: handleSelectFromMap, flyTo: flyTo }), selectedCode && (_jsx("div", { className: "app__panel", children: _jsx(LocationPanel, { code: selectedCode, onClose: () => setSelectedCode(null) }) }))] }), _jsx("button", { type: "button", className: "sheet-toggle", onClick: () => setSheetOpen((open) => !open), "aria-expanded": sheetOpen, children: sheetOpen
                    ? 'Hide filters'
                    : `Filters & search${selected ? '' : ` · ${locations.length}`}` })] }));
}
//# sourceMappingURL=App.js.map